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
const cards = { pro_stream: "mimo-v2.6-pro", pro_simple: "mimo-v2.6-pro", flash_stream: "mimo-v2.6-flash", flash_simple: "mimo-v2.6-flash",
  off: "mimo-v2.6-pro", max: "mimo-v2.6-pro", no_usage: "mimo-v2.6-pro", http_error: "mimo-v2.6-pro", embedded_error: "mimo-v2.6-pro" };
const dispatched = Object.keys(cards), ids = [...dispatched, "foreign", "missing", "unpriced", "retired_pro", "retired", "aborted"];
test("registered Xiaomi PAYG streams preserve original grants, retired identities and SQLite accounting", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(p => p.id === "xiaomi");
  assert.deepEqual(provider.models.map(m => m.upstream), ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"]);
  assert.ok(provider.models.every(m => m.pricing === null));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-xiaomi-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs"); let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      const model = id === "retired_pro" ? "mimo-v2.5-pro" : id === "retired" ? "mimo-v2.5" : cards[id] ?? "mimo-v2.6-pro";
      await kv.put(`policies/xiaomi_${id}`, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture",
        providers: [id === "foreign" ? "xiaomi-token-plan" : "xiaomi"], models: ["xiaomi/" + model],
        grantRouting: { eligibleGrants: { xiaomi: ["xiaomi"] }, environmentFallback: false },
        monthlyBudgetMicros: 100, requestCostMicros: id === "unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/xiaomi_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `xiaomi_${id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/xiaomi", JSON.stringify({ providerId: "xiaomi", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-xiaomi-contract.test.ts", import.meta.url), testPath: "extensions/xiaomi/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, XIAOMI_API_KEY: "must-not-fallback", XIAOMI_TOKEN_PLAN_API_KEY: "must-not-fallback" } });
    const upstream = await mf.getWorker("upstream"), calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, dispatched.length, "denied and pre-aborted requests must have zero egress");
    for (const id of dispatched) {
      const matching = calls.filter(c => JSON.stringify(c.body.messages).includes(`xiaomi_${id}`)); assert.equal(matching.length, 1);
      const [call] = matching; assert.equal(call.url, "https://api.xiaomimimo.com/v1/chat/completions");
      assert.equal(call.authorization, `Bearer fixture-upstream-${id}`); assert.equal(call.body.model, cards[id]);
      assert.equal(call.apiKey, null); assert.equal(call.xApiKey, null); assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
      assert.deepEqual(call.body.thinking, { type: id === "off" ? "disabled" : "enabled" });
      assert.equal(call.body.reasoning_effort, id === "off" ? undefined : id === "max" ? "max" : "high");
      assert.ok(call.body.messages.some(m => m.role === "tool" && m.tool_call_id === "callfixture" && m.content === "synthetic-tool-result"));
      assert.ok(call.body.messages.some(m => m.tool_calls?.[0]?.function?.name === "lookup"));
      if (id === "off") assert.ok(call.body.messages.every(m => m.reasoning_content === undefined));
      else assert.ok(call.body.messages.some(m => m.reasoning_content === "synthetic-prior-thinking"));
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      let usage;
      for (let n = 0; n < 150; n++) {
        usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-xiaomi_${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
      assert.equal(event.provider, "xiaomi"); assert.equal(event.model, `xiaomi/${cards[id]}`); assert.equal(event.credential_id, `xiaomi_${id}`);
      const rejected = ["http_error", "embedded_error"].includes(id);
      assert.equal(event.status, rejected ? "provider_error" : "success");
      assert.equal(event.cost_basis, rejected ? "none" : "policy_fixed"); assert.equal(event.actual_cost_micros, rejected ? 0 : 7);
      assert.equal(usage.budget.spentMicros, rejected ? 0 : 7);
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens],
        rejected || id === "no_usage" ? [null, null, null, null] : [300, 20, 320, 256]);
      assert.doesNotMatch(JSON.stringify(usage), /fixture-upstream|synthetic-prior-thinking|synthetic-tool-result|synthetic-answer/);
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) {
      await putGrantCredentials(env, "oauth/xiaomi_" + id + "/xiaomi-token-plan", { provider: "xiaomi-token-plan", enabled: true, kind: "api_key", credential: "tp-fixture-foreign-plan" });
      if (id !== "missing") await putGrantCredentials(env, "oauth/xiaomi_" + id + "/xiaomi", { provider: "xiaomi", enabled: true, kind: "api_key", credential: "fixture-upstream-" + id });
    }
    return new Response(null, { status: 204 });
  }
  return handler.fetch(request, { ...env, XIAOMI_API_KEY: "must-not-fallback", XIAOMI_TOKEN_PLAN_API_KEY: "must-not-fallback", XIAOMI_TOKEN_PLAN_CN_API_KEY: "must-not-fallback" }, context);
} };`;
}
function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json(); calls.push({ url: request.url, authorization: request.headers.get("authorization"), apiKey: request.headers.get("api-key"), xApiKey: request.headers.get("x-api-key"), body });
    const id = request.headers.get("authorization").replace("Bearer fixture-upstream-", "");
    if (id === "http_error") return Response.json({ error: { message: "synthetic provider rejection" } }, { status: 401 });
    const frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const usage = id === "no_usage" ? {} : { usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, prompt_tokens_details: { cached_tokens: 256 } } };
    const wire = id === "embedded_error" ? frame({ error: { code: "synthetic_error", message: "synthetic provider rejection" } })
      : frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] })
        + frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...usage }) + "data: [DONE]\\n\\n";
    const bytes = new TextEncoder().encode(wire); let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
