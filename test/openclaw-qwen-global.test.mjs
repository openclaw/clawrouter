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
const models = ["qwen3.5-plus", "qwen3.6-flash", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max", "qwen3.8-flash", "MiniMax-M2.5", "glm-5", "kimi-k2.5"];
const blocked = ["qwen3-max-2026-01-23", "qwen3-coder-next", "qwen3-coder-plus", "glm-4.7"];
const cards = Object.fromEntries(models.flatMap((model, i) => [[`m${i}_stream`, model], [`m${i}_simple`, model]]));
Object.assign(cards, { effort_low: "qwen3.8-max", effort_medium: "qwen3.8-flash", effort_off: "qwen3.8-max",
  no_usage: "qwen3.7-plus", http_error: "qwen3.7-plus", embedded_error: "qwen3.7-plus" });
const dispatched = Object.keys(cards), ids = [...dispatched, "foreign", "missing", "unpriced", "foreign_model", "aborted", ...blocked.map((_, i) => `closed${i}`)];
test("registered Qwen global standard streams preserve original grants, selected identities and SQLite accounting", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(p => p.id === "qwen");
  assert.deepEqual(provider.models.filter(m => m.capabilities.includes("llm.chat")).map(m => m.upstream), models);
  assert.ok(provider.models.every(m => m.pricing === null));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-qwen-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs"); let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      const model = id === "foreign_model" ? "not-selected" : id.startsWith("closed") ? blocked[Number(id.slice(6))] : cards[id] ?? models[0];
      await kv.put(`policies/qwen_${id}`, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture",
        providers: [id === "foreign" ? "qwen-cn" : "qwen"], models: ["qwen/" + model],
        grantRouting: { eligibleGrants: { qwen: ["qwen"] }, environmentFallback: false },
        monthlyBudgetMicros: 100, requestCostMicros: id === "unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/qwen_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `qwen_${id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/qwen", JSON.stringify({ providerId: "qwen", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-qwen-global-contract.test.ts", import.meta.url), testPath: "extensions/qwen/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, QWEN_API_KEY: "must-not-fallback", QWEN_CODING_GLOBAL_API_KEY: "must-not-fallback" } });
    const upstream = await mf.getWorker("upstream"), calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, dispatched.length, "denied and pre-aborted requests must have zero egress");
    for (const id of dispatched) {
      const matching = calls.filter(c => JSON.stringify(c.body.messages).includes(`qwen_${id}`)); assert.equal(matching.length, 1);
      const [call] = matching; assert.equal(call.url, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
      assert.equal(call.authorization, `Bearer fixture-upstream-${id}`); assert.equal(call.body.model, cards[id]);
      assert.equal(call.apiKey, null); assert.equal(call.xApiKey, null); assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
      const thinkingModel = !["qwen3.5-plus", "glm-5", "kimi-k2.5"].includes(cards[id]);
      assert.equal(call.body.enable_thinking, thinkingModel ? id !== "effort_off" : undefined, id);
      if (["qwen3.8-max", "qwen3.8-flash"].includes(cards[id])) {
        assert.equal(call.body.reasoning_effort, id === "effort_off" ? undefined : id === "effort_low" ? "low" : id === "effort_medium" ? "medium" : "xhigh", id);
      } else assert.equal(call.body.reasoning_effort, undefined, id);
      assert.ok(call.body.messages.some(m => m.role === "tool" && m.tool_call_id === "callfixture" && m.content === "synthetic-tool-result"), id);
      assert.ok(call.body.messages.some(m => m.tool_calls?.[0]?.function?.name === "lookup"), id);
      // The actual registered host strips these two non-reasoning rows; Kimi's
      // explicit replay contract retains history despite its old reasoning flag.
      if (["qwen3.5-plus", "glm-5"].includes(cards[id])) {
        assert.ok(call.body.messages.every(m => m.reasoning_content === undefined), id);
        assert.ok(!JSON.stringify(call.body.messages).includes("synthetic-prior-thinking"), id);
      } else assert.ok(call.body.messages.some(m => m.reasoning_content === "synthetic-prior-thinking"), id);
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      let usage;
      for (let n = 0; n < 150; n++) {
        usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-qwen_${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
      assert.equal(event.provider, "qwen"); assert.equal(event.model, `qwen/${cards[id]}`); assert.equal(event.credential_id, `qwen_${id}`);
      const rejected = ["http_error", "embedded_error"].includes(id);
      assert.equal(event.status_code, id === "http_error" ? 401 : 200, id);
      assert.equal(event.status, id === "http_error" ? "client_error" : id === "embedded_error" ? "provider_error" : "success", id);
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
      for (const foreign of ["qwen-cn", "qwen-coding-global", "qwen-coding-cn", "qwen-token-plan", "qwen-token-plan-cn"]) await putGrantCredentials(env, "oauth/qwen_" + id + "/" + foreign, { provider: foreign, enabled: true, kind: "api_key", credential: "fixture-foreign-product" });
      if (id !== "missing") await putGrantCredentials(env, "oauth/qwen_" + id + "/qwen", { provider: "qwen", enabled: true, kind: "api_key", credential: "fixture-upstream-" + id });
    }
    return new Response(null, { status: 204 });
  }
  return handler.fetch(request, { ...env, QWEN_API_KEY: "must-not-fallback", QWEN_CODING_GLOBAL_API_KEY: "must-not-fallback", QWEN_CN_API_KEY: "must-not-fallback", QWEN_CODING_CN_API_KEY: "must-not-fallback", QWEN_TOKEN_PLAN_API_KEY: "must-not-fallback", QWEN_TOKEN_PLAN_CN_API_KEY: "must-not-fallback", DASHSCOPE_API_KEY: "must-not-fallback" }, context);
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
