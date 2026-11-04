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
const provider = snapshot.providers.find(provider => provider.id === "abliteration");
const endpoint = provider.endpoints.find(endpoint => endpoint.request_format === "openai.chat_completions");
const models = ["abliterated-model-large-flash", "abliterated-model-large-v2", "abliterated-model", "abliterated-model-large"];
const efforts = [["off", "low", "high", "max"], ["off", "low", "high", "max"], ["off", "minimal", "low", "medium", "high", "xhigh", "max"], ["off", "high", "max"]];
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const effortCases = efforts.flatMap((levels, i) => levels.map(level => ({ id: `abliteration_m${i}_${level}`, model: models[i], effort: level === "off" ? (i === 1 ? "low" : "none") : level })));
const charged = [...effortCases.map(row => row.id), "abliteration_simple", "abliteration_notools", "abliteration_image0", "abliteration_image2", "abliteration_observed", "abliteration_cached", "abliteration_error", "abliteration_cancel"];
const modelFor = id => effortCases.find(row => row.id === id)?.model ?? (/^abliteration_image[02]$/.test(id) ? models[Number(id.at(-1))] : models[0]);
const ids = [...charged, "abliteration_unpriced", "abliteration_foreign", "abliteration_revoked"];

test("actual OpenClaw Abliteration configured native client through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  assert.ok(endpoint);
  assert.deepEqual(provider.models.map(model => [model.id, model.upstream]), models.map(id => ["abliteration/" + id, id]));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-abliteration-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [id === "abliteration_foreign" ? "openai" : "abliteration"], models: models.map(id => `abliteration/${id}`), tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "abliteration_unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false, grantRouting: { eligibleGrants: { abliteration: ["abliteration"] }, environmentFallback: false } }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/abliteration", JSON.stringify({ providerId: "abliteration", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const catalogResponse = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-abliteration_m0_high-fixture-secret" } });
    assert.equal(catalogResponse.status, 200); const catalog = await catalogResponse.json();
    assert.equal(catalog.scope.credentialId, "abliteration_m0_high");
    const visible = catalog.providers.find(row => row.id === "abliteration"); assert.ok(visible);
    assert.deepEqual(visible.models.map(row => row.id).sort(), models.map(id => "abliteration/" + id).sort());
    assert.ok(models.every(id => visible.offers.some(offer => offer.modelId === "abliteration/" + id && offer.routeKind === "native" && offer.eligible)));

    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-abliteration-contract.test.ts", import.meta.url),
      testPath: "extensions/abliteration/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, ABLIT_KEY: "must-not-fallback", ABLITERATION_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" },
    });
    const upstream = await mf.getWorker("upstream");
    let calls;
    for (let attempt = 0; attempt < 150; attempt++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const cancelled = calls.find(call => call.body && JSON.stringify(call.body.messages).includes("abliteration_cancel"));
      if (cancelled?.cancelled || cancelled?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancelled = calls.find(call => call.body && JSON.stringify(call.body.messages).includes("abliteration_cancel"));
    assert.ok(cancelled?.cancelled || cancelled?.aborted, "actual client abort must cancel the upstream transport");
    assert.notEqual(cancelled.fixtureExpired, true, "fixture timeout is not caller cancellation");
    assert.equal(calls.filter(call => call.method === "GET").length, 0, "the actual registered catalog remains static");
    calls = calls.filter(call => call.method === "POST");
    assert.equal(calls.length, charged.length, "invalid keys, foreign grants and unknown-price hard budgets must not dispatch; errors must not replay");
    for (const call of calls) {
      assert.equal(call.url, provider.base_urls.default.replace(/\/$/, "") + endpoint.path);
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-abliteration");
      const id = charged.find(id => JSON.stringify(call.body.messages).includes(id)); assert.ok(id);
      const expected = modelFor(id);
      assert.equal(call.body.model, expected);
      assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens, 128);
      assert.equal(call.body.max_completion_tokens, undefined);
      assert.equal(call.body.reasoning_effort, effortCases.find(row => row.id === id)?.effort ?? "high");
      assert.ok(call.body.messages.some(message => message.reasoning_content === "synthetic-prior-thinking"), "the registered host and actual serializer preserve reasoning history");
      if (id.startsWith("abliteration_image")) assert.ok(call.body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url" && part.image_url.url === "data:image/png;base64," + image)));
      assert.equal(call.body.prompt_cache_key, "synthetic-cache-affinity");
      assert.equal(call.body.prompt_cache_retention, undefined);
      assert.ok(call.body.messages.some(message => ["system", "developer"].includes(message.role) && message.content === "Synthetic instructions"));
      if (id === "abliteration_notools") {
        assert.equal(call.body.tools, undefined);
        assert.ok(call.body.messages.some(message => message.role === "assistant" && message.content === '[tool call id=callfixture name=lookup] {}'));
        assert.ok(call.body.messages.some(message => message.role === "user" && message.content === '[tool result id=callfixture name=lookup] synthetic-tool-result'));
        assert.ok(call.body.messages.every(message => message.tool_calls === undefined && message.role !== "tool"));
      } else {
        assert.equal(call.body.tools[0].function.name, "lookup");
        assert.ok(call.body.messages.some(message => message.role === "tool" && message.tool_call_id === "callfixture" && message.content === "synthetic-tool-result"));
        assert.ok(call.body.messages.some(message => message.tool_calls?.[0]?.function?.name === "lookup"));
      }
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
    }
    for (const id of charged) {
      let usage;
      for (let attempt = 0; attempt < 150; attempt++) {
        usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const events = usage.usage.events.filter(event => event.capability === "llm.chat");
      assert.equal(events.length, 1);
      assert.equal(usage.usage.events.length, 1);
      const [event] = events;
      assert.equal(usage.budget.spentMicros, 7);
      assert.equal(event.provider, "abliteration"); assert.equal(event.model, `abliteration/${modelFor(id)}`);
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      assert.equal(event.status, id === "abliteration_error" ? "provider_error" : id === "abliteration_cancel" ? "client_error" : "success");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], id === "abliteration_observed" ? [4, 3, 7] : id === "abliteration_cached" ? [100, 20, 120] : [null, null, null]);
      assert.equal(event.cached_input_tokens, id === "abliteration_cached" ? 40 : null);
      assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|fixture-upstream|must-not-fallback/);
    }
    for (const id of ["abliteration_revoked", "abliteration_unpriced", "abliteration_foreign"]) {
      const usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
      assert.equal(usage.budget.spentMicros, 0);
      assert.ok(usage.usage.events.every(event => event.actual_cost_micros === 0));
    }
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) await putGrantCredentials(env, "oauth/" + id + "/abliteration", { provider: "abliteration", kind: "api_key", enabled: true, credential: "fixture-upstream-abliteration" });
    await revokeGrantCredentials(env, "oauth/abliteration_revoked/abliteration");
    return new Response(null, { status: 204 });
  }
  return handler.fetch(request, { ...env, ABLIT_KEY: "must-not-fallback", ABLITERATION_API_KEY: "must-not-fallback" }, context);
} };`;
}

function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = request.method === "POST" ? await request.json() : null;
    const call = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body }; calls.push(call);
    const input = JSON.stringify(body.messages), frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const failed = input.includes("abliteration_error"), cancel = input.includes("abliteration_cancel");
    const first = frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] });
    const wire = first + (failed ? frame({ error: { message: "synthetic-upstream-error", code: "server_error" } })
      : cancel ? "" : frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(input.includes("abliteration_observed") ? { usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } } : input.includes("abliteration_cached") ? { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 6 } } } : {}) }) + "data: [DONE]\\n\\n");
    const bytes = new TextEncoder().encode(wire); let offset = 0, beats = 0, timer, wake;
    request.signal.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); wake?.(); }, { once: true });
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) {
        if (!cancel) { controller.close(); return; }
        // Heartbeats keep the synthetic request live and make downstream
        // disconnection observable. The bound never substitutes for an abort.
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
