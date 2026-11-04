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
const provider = snapshot.providers.find(provider => provider.id === "particle");
const endpoint = provider.endpoints.find(endpoint => endpoint.request_format === "openai.chat_completions");
const models = ["particle-ai/particle-1"];
const charged = ["particle_catalog", "particle_off", "particle_low", "particle_high", "particle_max", "particle_observed", "particle_error", "particle_cancel"];
const ids = [...charged, "particle_unpriced", "particle_foreign", "particle_empty"];

test("actual OpenClaw Particle configured native client through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  assert.ok(endpoint);
  assert.deepEqual(provider.models.map(model => [model.id, model.upstream]), [["particle/particle-ai/particle-1", "particle-1"]]);
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-particle-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [id === "particle_foreign" ? "openai" : "particle"], models: id === "particle_empty" ? ["particle/unlisted-fixture"] : models.map(id => `particle/${id}`), tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "particle_unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/particle", JSON.stringify({ providerId: "particle", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const catalogResponse = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-particle_catalog-fixture-secret" } });
    assert.equal(catalogResponse.status, 200); const catalog = await catalogResponse.json();
    assert.equal(catalog.scope.credentialId, "particle_catalog");
    const visible = catalog.providers.find(row => row.id === "particle"); assert.ok(visible);
    assert.deepEqual(visible.models.map(row => row.id).sort(), models.map(id => "particle/" + id).sort());
    assert.ok(models.every(id => visible.offers.some(offer => offer.modelId === "particle/" + id && offer.routeKind === "native" && offer.eligible)));

    await runOpenClawConsumer(t, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-particle-contract.test.ts", import.meta.url),
      testPath: "extensions/particle/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, PARTICLE_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" },
    });
    const upstream = await mf.getWorker("upstream");
    let calls;
    for (let attempt = 0; attempt < 150; attempt++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const cancelled = calls.find(call => call.body && JSON.stringify(call.body.messages).includes("particle_cancel"));
      if (cancelled?.cancelled || cancelled?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancelled = calls.find(call => call.body && JSON.stringify(call.body.messages).includes("particle_cancel"));
    assert.ok(cancelled?.cancelled || cancelled?.aborted, "actual client abort must cancel the upstream transport");
    assert.notEqual(cancelled.fixtureExpired, true, "fixture timeout is not caller cancellation");
    const catalogCalls = calls.filter(call => call.method === "GET");
    assert.equal(catalogCalls.length, 2, "actual strict discovery filters the original credential and retains an empty catalog");
    for (const call of catalogCalls) {
      assert.equal(call.url, provider.base_urls.default + "/models");
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-particle");
    }
    calls = calls.filter(call => call.method === "POST");
    assert.equal(calls.length, charged.length, "invalid keys, foreign grants and unknown-price hard budgets must not dispatch; errors must not replay");
    for (const call of calls) {
      assert.equal(call.url, provider.base_urls.default.replace(/\/$/, "") + endpoint.path);
      assert.equal(call.headers.authorization, "Bearer fixture-upstream-particle");
      const id = charged.find(id => JSON.stringify(call.body.messages).includes(id)); assert.ok(id);
      const expected = "particle-1";
      assert.equal(call.body.model, expected);
      assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens, 128);
      assert.equal(call.body.max_completion_tokens, undefined);
      const efforts = { particle_off: "none", particle_low: "low", particle_high: "high", particle_max: "max" };
      if (id in efforts) assert.equal(call.body.reasoning_effort, efforts[id]);
      assert.equal(call.body.tools[0].function.strict, undefined);
      assert.ok(call.body.messages.some(message => message.reasoning_content === "synthetic-prior-thinking"));
      assert.equal(call.body.prompt_cache_key, "synthetic-cache-affinity");
      assert.equal(call.body.prompt_cache_retention, undefined);
      assert.equal(call.body.tools[0].function.name, "lookup");
      assert.ok(call.body.messages.some(message => ["system", "developer"].includes(message.role) && message.content === "Synthetic instructions"), "the actual native serializer retains system instructions");
      assert.ok(call.body.messages.some(message => message.role === "tool" && message.tool_call_id === "callfixture" && message.content === "synthetic-tool-result"));
      assert.ok(call.body.messages.some(message => message.tool_calls?.[0]?.function?.name === "lookup"));
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
    }
    for (const id of charged) {
      let usage;
      for (let attempt = 0; attempt < 150; attempt++) {
        usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === (id === "particle_catalog" ? 2 : 1)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const events = usage.usage.events.filter(event => event.capability === "llm.chat");
      assert.equal(events.length, 1);
      assert.equal(usage.usage.events.length, id === "particle_catalog" ? 2 : 1);
      if (id === "particle_catalog") {
        const discovery = usage.usage.events.find(event => event.capability === "models.list");
        assert.equal(discovery.actual_cost_micros, 0); assert.equal(discovery.reserved_cost_micros, 0);
      }
      const [event] = events;
      assert.equal(usage.budget.spentMicros, 7);
      assert.equal(event.provider, "particle"); assert.equal(event.model, `particle/${models[0]}`);
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      assert.equal(event.status, id === "particle_error" ? "provider_error" : id === "particle_cancel" ? "client_error" : "success");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], id === "particle_observed" ? [4, 3, 7] : [null, null, null]);
      assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|fixture-upstream|must-not-fallback/);
    }
    for (const id of ["particle_empty", "particle_unpriced", "particle_foreign"]) {
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
import { putGrantCredentials } from "./worker/grant-credentials.ts";
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) await putGrantCredentials(env, "oauth/" + id + "/particle", { provider: "particle", kind: "api_key", enabled: true, credential: "fixture-upstream-particle" });
    return new Response(null, { status: 204 });
  }
  return handler.fetch(request, { ...env, PARTICLE_API_KEY: "must-not-fallback" }, context);
} };`;
}

function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = request.method === "POST" ? await request.json() : null;
    const call = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body }; calls.push(call);
    if (request.method === "GET") return Response.json({ object: "list", data: ["particle-ai/particle-1", "foreign-fixture"].map(id => ({ id, object: "model", owned_by: "particle" })) });
    const input = JSON.stringify(body.messages), frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const failed = input.includes("particle_error"), cancel = input.includes("particle_cancel");
    const first = frame({ id: "chat_fixture", object: "chat.completion.chunk", model: "particle-ai/particle-1", choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] });
    const wire = first + (failed ? frame({ error: { message: "synthetic-upstream-error", code: "server_error" } })
      : cancel ? "" : frame({ id: "chat_fixture", object: "chat.completion.chunk", model: "particle-ai/particle-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(input.includes("particle_observed") ? { usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } } : {}) }) + "data: [DONE]\\n\\n");
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
