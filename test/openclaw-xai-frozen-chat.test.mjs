import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const provider = snapshot.providers.find(provider => provider.id === "xai");
const endpoint = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");
const models = ["grok-4.6", "grok-4.5", "grok-build-0.1", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning"];
const modelFor = id => "xai/" + models[id.startsWith("xai_model") ? Number(id.slice("xai_model".length)) : 0];
const modelId = modelFor("xai_model0");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const charged = [...models.map((_, index) => `xai_model${index}`), "xai_image", "xai_low", "xai_xhigh", "xai_error", "xai_cancel"];
const denied = ["xai_foreign", "xai_unpriced", "xai_provider_budget", "xai_model_denied"];
const ids = [...charged, ...denied];

test("actual registered frozen xAI explicit Chat client through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const model = provider.models.find(model => model.id === modelId);
  assert.equal(model.pricing, null);
  assert.equal(model.nativeCapabilities.endpoints.chat_completions.contextWindow, 500_000);
  assert.equal(model.nativeCapabilities.endpoints.chat_completions.maxOutputTokens, undefined);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-xai-frozen-chat-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture",
        providers: [id === "xai_foreign" ? "openai" : "xai"],
        models: id === "xai_model_denied" ? ["xai/grok-4.3"] : ["xai_unpriced", "xai_provider_budget"].includes(id) ? models.map(model => "xai/" + model) : [modelFor(id)],
        grantRouting: { eligibleGrants: { xai: ["xai"] }, environmentFallback: false },
        tenantId: "fixture", monthlyBudgetMicros: id === "xai_provider_budget" ? null : 100,
        requestCostMicros: ["xai_unpriced", "xai_provider_budget"].includes(id) ? null : 7,
        budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/xai", JSON.stringify({ providerId: "xai", enabled: true, monthlyBudgetMicros: 100 }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const catalogResponse = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-xai_model0-fixture-secret" } });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json(), visible = catalog.providers.find(row => row.id === "xai");
    assert.equal(catalog.scope.credentialId, "xai_model0");
    assert.deepEqual(visible.models.map(row => row.id), [modelId]);
    assert.ok(visible.offers.some(offer => offer.modelId === modelId && offer.routeKind === "native" && offer.eligible));

    await runOpenClawConsumer(t, { source, sourceHead,
      fixture: new URL("./fixtures/openclaw-xai-frozen-chat-contract.test.ts", import.meta.url),
      testPath: "extensions/xai/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, XAI_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" } });
    const upstream = await mf.getWorker("upstream");
    let calls;
    for (let attempt = 0; attempt < 150; attempt++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const call = calls.find(call => (JSON.stringify(call.body?.messages) ?? "").includes("xai_cancel"));
      if (call?.cancelled || call?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancelled = calls.find(call => (JSON.stringify(call.body?.messages) ?? "").includes("xai_cancel"));
    assert.ok(cancelled?.cancelled || cancelled?.aborted, "post-delivery SDK cancellation must reach upstream");
    assert.notEqual(cancelled.fixtureExpired, true, "the fixture lifetime is not caller cancellation");
    assert.equal(calls.length, charged.length, "denials have zero egress; paid errors and cancellation never replay");
    for (const id of charged) {
      const matching = calls.filter(call => (JSON.stringify(call.body?.messages) ?? "").includes(id));
      assert.equal(matching.length, 1, id);
      const [call] = matching;
      assert.equal(call.method, "POST", "static client selection must not invent live discovery");
      assert.equal(call.url, provider.base_urls.default + endpoint.path);
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-" + id);
      assert.equal(call.body.model, modelFor(id).slice(4));
      assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
      assert.equal(call.body.tools[0].function.name, "x_search");
      assert.ok(call.body.messages.some(message => ["system", "developer"].includes(message.role) && message.content === "Synthetic instructions"));
      assert.ok(call.body.messages.some(message => message.tool_calls?.[0]?.function?.name === "x_search"));
      assert.ok(call.body.messages.some(message => message.role === "tool" && message.tool_call_id === "callfixture" && message.content === "synthetic-tool-result"));
      assert.ok(call.body.messages.every(message => message.reasoning_content === undefined), "registered OpenAI-compatible Chat replay deliberately drops thinking history");
      const imageUrls = call.body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "image_url").map(part => part.image_url.url) : []);
      assert.deepEqual(imageUrls, id === "xai_image" ? ["data:image/png;base64," + png] : []);
      if (id === "xai_low" || id === "xai_xhigh") assert.equal(call.body.reasoning_effort, id.slice(4));
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);

      let usage;
      for (let attempt = 0; attempt < 150; attempt++) {
        usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
      assert.equal(usage.budget.spentMicros, 7);
      assert.equal(event.provider, "xai"); assert.equal(event.model, modelFor(id));
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      assert.equal(event.status, id === "xai_error" ? "provider_error" : id === "xai_cancel" ? "client_error" : "success");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], ["xai_error", "xai_cancel"].includes(id) ? [null, null, null] : [11, 3, 14]);
      assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|fixture-upstream|must-not-fallback/);
    }
    for (const id of denied) {
      const usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
      if (id === "xai_provider_budget") {
        // Only the provider has a hard cap; an absent caller ledger is not zero spend.
        assert.equal(usage.budget.configured, false);
        assert.equal(usage.budget.ledger, "unmetered");
        assert.equal(usage.budget.limitMicros, null);
        assert.equal(usage.budget.spentMicros, null);
        assert.equal(usage.budget.remainingMicros, null);
      } else assert.equal(usage.budget.spentMicros, 0, id);
      assert.ok(usage.usage.events.every(event => event.actual_cost_micros === 0), id);
    }
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("frozen xAI JSON native and manifest routes keep original identity and conservative accounting", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-xai-wire-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    const jsonIds = models.map((_, index) => `xai_model${index}`);
    for (const id of [...jsonIds, "xai_unpriced", "xai_provider_budget"]) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: ["xai"], models: models.map(model => "xai/" + model), tenantId: "fixture",
        grantRouting: { eligibleGrants: { xai: ["xai"] }, environmentFallback: false },
        monthlyBudgetMicros: id === "xai_provider_budget" ? null : 100,
        requestCostMicros: ["xai_unpriced", "xai_provider_budget"].includes(id) ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/xai", JSON.stringify({ providerId: "xai", enabled: true, monthlyBudgetMicros: 100 }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const paths = ["/v1/native/xai/v1/chat/completions", "/v1/proxy/xai/chat_completions"];
    for (const [route, path] of paths.entries()) for (const id of jsonIds) {
      const body = { model: modelFor(id), messages: [{ role: "user", content: `synthetic ${id}` }], max_tokens: 128, stream: false };
      const wire = JSON.stringify(route ? { body } : body);
      const response = await fetch(origin + path, { method: "POST", headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret`, "content-type": "application/json" }, body: wire });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify({ path, model: modelFor(id), error: result.error }));
      assert.equal(result.choices[0].message.content, "synthetic-answer");
      let usage;
      for (let attempt = 0; attempt < 100; attempt++) {
        usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === route + 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, route + 1);
      assert.equal(usage.budget.spentMicros, 7 * (route + 1));
      for (const event of usage.usage.events) {
        assert.equal(event.model, modelFor(id)); assert.equal(event.status, "success");
        assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
        assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [11, 3, 14]);
      }
      for (const denied of ["xai_unpriced", "xai_provider_budget"]) {
        const denial = await fetch(origin + path, { method: "POST", headers: { authorization: `Bearer clawrouter-live-${denied}-fixture-secret`, "content-type": "application/json" }, body: wire });
        assert.equal(denial.status, 400); assert.equal((await denial.json()).error.code, "pricing_required");
      }
    }
    const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, 10, "all five models deny unpriced caller/provider budgets on both routes before egress");
    for (const [index, call] of calls.entries()) {
      assert.equal(call.body.model, models[index % models.length]);
      assert.equal(call.url, "https://api.x.ai/v1/chat/completions");
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-" + jsonIds[index % models.length]);
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) await putGrantCredentials(env, "oauth/" + id + "/xai", { provider: "xai", kind: "api_key", enabled: true, credential: "fixture-upstream-" + id });
    return new Response(null, { status: 204 });
  }
  return handler.fetch(request, { ...env, XAI_API_KEY: "must-not-fallback" }, context);
} };`;
}

function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = request.method === "POST" ? await request.json() : null;
    const call = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body }; calls.push(call);
    if (!body) return new Response(null, { status: 404 });
    if (body.stream !== true) return Response.json({ id: "chat_fixture", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "synthetic-answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } });
    const input = JSON.stringify(body.messages), frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const failed = input.includes("xai_error"), cancel = input.includes("xai_cancel");
    const first = frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] });
    const wire = first + (failed ? frame({ error: { message: "synthetic-upstream-error", code: "server_error" } })
      : cancel ? "" : frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }) + "data: [DONE]\\n\\n");
    const bytes = new TextEncoder().encode(wire); let offset = 0, beats = 0, timer, wake;
    request.signal.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); wake?.(); }, { once: true });
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) {
        if (!cancel) { controller.close(); return; }
        return new Promise(resolve => { wake = resolve; timer = setTimeout(() => {
          if (++beats > 200) { call.fixtureExpired = true; controller.close(); }
          else controller.enqueue(new TextEncoder().encode(": fixture heartbeat\\n\\n"));
          resolve();
        }, 50); });
      }
      const end = Math.min(offset + 7, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
    }, cancel() { call.cancelled = true; clearTimeout(timer); wake?.(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
