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
const provider = snapshot.providers.find(provider => provider.id === "minimax");
const endpoint = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");
const modelId = "minimax/MiniMax-M2.7-highspeed";
const charged = ["minimax_stream", "minimax_simple", "minimax_observed", "minimax_error", "minimax_cancel"];
const denied = ["minimax_foreign", "minimax_unpriced", "minimax_provider_budget", "minimax_model_denied"];
const ids = [...charged, ...denied];

test("actual registered MiniMax M2.7 highspeed explicit Chat client through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const model = provider.models.find(model => model.id === modelId);
  assert.equal(model.pricing, null);
  assert.equal(model.nativeCapabilities, undefined);
  assert.equal(model.availability.status, "deprecated");
  assert.equal(model.availability.servingModel, undefined);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-minimax-highspeed-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture",
        providers: [id === "minimax_foreign" ? "openai" : "minimax"],
        models: [id === "minimax_model_denied" ? "minimax/MiniMax-M2.7" : modelId],
        grantRouting: { eligibleGrants: { minimax: ["minimax"] }, environmentFallback: false },
        tenantId: "fixture", monthlyBudgetMicros: id === "minimax_provider_budget" ? null : 100,
        requestCostMicros: ["minimax_unpriced", "minimax_provider_budget"].includes(id) ? null : 7,
        budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/minimax", JSON.stringify({ providerId: "minimax", enabled: true, monthlyBudgetMicros: 100 }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const catalogResponse = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-minimax_stream-fixture-secret" } });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json(), visible = catalog.providers.find(row => row.id === "minimax");
    assert.equal(catalog.scope.credentialId, "minimax_stream");
    assert.deepEqual(visible.models.map(row => row.id), [modelId]);
    assert.equal(visible.models[0].availability.status, "deprecated");
    assert.ok(visible.offers.some(offer => offer.modelId === modelId && offer.routeKind === "native" && offer.eligible));

    await runOpenClawConsumer(t, { source, sourceHead,
      fixture: new URL("./fixtures/openclaw-minimax-highspeed-contract.test.ts", import.meta.url),
      testPath: "extensions/minimax/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, MINIMAX_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" } });
    const upstream = await mf.getWorker("upstream");
    let calls;
    for (let attempt = 0; attempt < 150; attempt++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const call = calls.find(call => (JSON.stringify(call.body?.messages) ?? "").includes("minimax_cancel"));
      if (call?.cancelled || call?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancelled = calls.find(call => (JSON.stringify(call.body?.messages) ?? "").includes("minimax_cancel"));
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
      assert.equal(call.body.model, "MiniMax-M2.7-highspeed");
      assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
      assert.equal(call.body.tools[0].function.name, "lookup");
      assert.ok(call.body.messages.some(message => ["system", "developer"].includes(message.role) && message.content === "Synthetic instructions"));
      assert.ok(call.body.messages.some(message => message.tool_calls?.[0]?.function?.name === "lookup"));
      assert.ok(call.body.messages.some(message => message.role === "tool" && message.tool_call_id === "callfixture" && message.content === "synthetic-tool-result"));
      assert.ok(call.body.messages.every(message => message.reasoning_content === undefined), "registered hybrid Chat replay deliberately drops thinking history");
      const imageUrls = call.body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "image_url").map(part => part.image_url.url) : []);
      assert.deepEqual(imageUrls, []);
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);

      let usage;
      for (let attempt = 0; attempt < 150; attempt++) {
        usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
      assert.equal(usage.budget.spentMicros, 7);
      assert.equal(event.provider, "minimax"); assert.equal(event.model, modelId);
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      assert.equal(event.status, id === "minimax_error" ? "provider_error" : id === "minimax_cancel" ? "client_error" : "success");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], id === "minimax_observed" ? [4, 3, 7] : [null, null, null]);
      assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|fixture-upstream|must-not-fallback/);
    }
    for (const id of denied) {
      const usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
      if (id === "minimax_provider_budget") {
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

test("highspeed JSON native and manifest routes preserve identity and unknown-price admission", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-highspeed-wire-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ["minimax_stream", "minimax_simple", "minimax_unpriced", "minimax_provider_budget"]) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: ["minimax"], models: [modelId], tenantId: "fixture",
        grantRouting: { eligibleGrants: { minimax: ["minimax"] }, environmentFallback: false },
        monthlyBudgetMicros: id === "minimax_provider_budget" ? null : 100,
        requestCostMicros: ["minimax_unpriced", "minimax_provider_budget"].includes(id) ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/minimax", JSON.stringify({ providerId: "minimax", enabled: true, monthlyBudgetMicros: 100 }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const paths = ["/v1/native/minimax/v1/chat/completions", "/v1/proxy/minimax/chat_completions"];
    for (const [index, path] of paths.entries()) {
      const id = index ? "minimax_simple" : "minimax_stream";
      const body = { model: modelId, messages: [{ role: "user", content: `synthetic ${id}` }], max_tokens: 128, stream: false };
      const wire = JSON.stringify(index ? { body } : body);
      const response = await fetch(origin + path, { method: "POST", headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret`, "content-type": "application/json" }, body: wire });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify({ path, status: response.status, error: result.error }));
      assert.equal(result.choices[0].message.content, "synthetic-answer");
      let usage;
      for (let attempt = 0; attempt < 100; attempt++) {
        usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
      assert.equal(event.model, modelId); assert.equal(event.status, "success");
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      assert.equal(usage.budget.spentMicros, 7);
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [4, 3, 7]);
      for (const denied of ["minimax_unpriced", "minimax_provider_budget"]) {
        const denial = await fetch(origin + path, { method: "POST", headers: { authorization: `Bearer clawrouter-live-${denied}-fixture-secret`, "content-type": "application/json" }, body: wire });
        assert.equal(denial.status, 400); assert.equal((await denial.json()).error.code, "pricing_required");
      }
    }
    const calls = await (await (await mf.getWorker("upstream")).fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, 2, "caller/provider hard-dollar denials have zero egress on both routes");
    for (const [index, call] of calls.entries()) {
      assert.equal(call.body.model, "MiniMax-M2.7-highspeed");
      assert.equal(call.url, "https://api.minimax.io/v1/chat/completions");
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-minimax_" + (index ? "simple" : "stream"));
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) await putGrantCredentials(env, "oauth/" + id + "/minimax", { provider: "minimax", kind: "api_key", enabled: true, credential: "fixture-upstream-" + id });
    return new Response(null, { status: 204 });
  }
  return handler.fetch(request, { ...env, MINIMAX_API_KEY: "must-not-fallback" }, context);
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
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } });
    const input = JSON.stringify(body.messages), frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const failed = input.includes("minimax_error"), cancel = input.includes("minimax_cancel");
    const first = frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] });
    const wire = first + (failed ? frame({ error: { message: "synthetic-upstream-error", code: "server_error" } })
      : cancel ? "" : frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(input.includes("minimax_observed") ? { usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } } : {}) }) + "data: [DONE]\\n\\n");
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
