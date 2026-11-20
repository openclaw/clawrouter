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
const cards = { preview: "hy3-preview", hy3: "hy3", hy4: "hy4-preview", off: "hy3", low: "hy3" };
const charged = Object.keys(cards), ids = [...charged, "foreign", "unpriced", "aborted"];
test("registered Tencent TokenHub selected/served identity and accounting through Worker/SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(p => p.id === "tencent-tokenhub");
  assert.ok(Object.values(cards).every(id => provider.models.some(m => m.upstream === id)), "declaration snapshot must qualify first");
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-tencent-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/tencent_${id}`, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture",
        providers: [id === "foreign" ? "tencent-tokenplan" : "tencent-tokenhub"], models: ["tencent-tokenhub/" + (cards[id] ?? "hy3")],
        grantRouting: { eligibleGrants: { "tencent-tokenhub": ["tencent-tokenhub"] }, environmentFallback: false },
        monthlyBudgetMicros: 100, requestCostMicros: id === "unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/tencent_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `tencent_${id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/tencent-tokenhub", JSON.stringify({ providerId: "tencent-tokenhub", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-tencent-contract.test.ts", import.meta.url), testPath: "extensions/tencent/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, TOKENHUB_API_KEY: "must-not-fallback", TOKENPLAN_API_KEY: "must-not-fallback" } });
    const upstream = await mf.getWorker("upstream"), calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, charged.length, "invalid/foreign-product/unknown-price/pre-aborted calls have zero egress");
    for (const id of charged) {
      const matching = calls.filter(c => JSON.stringify(c.body.messages).includes(`tencent_${id}`)); assert.equal(matching.length, 1);
      const [call] = matching;
      assert.equal(call.url, "https://tokenhub.tencentmaas.com/v1/chat/completions");
      assert.equal(call.authorization, `Bearer fixture-upstream-${id}`);
      assert.equal(call.body.model, cards[id], "the deprecated preview must not silently become the static replacement");
      assert.equal(call.body.stream, true); assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
      assert.equal(call.body.reasoning_effort, id === "off" ? "none" : "high");
      assert.ok(call.body.messages.some(m => m.role === "tool" && m.tool_call_id === "callfixture" && m.content === "synthetic-tool-result"));
      assert.ok(call.body.messages.some(m => m.tool_calls?.[0]?.function?.name === "lookup"));
      if (id !== "off") assert.ok(call.body.messages.some(m => m.reasoning_content === "synthetic-prior-thinking"), "positive registered replay must reach the original upstream unchanged");
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      let usage;
      for (let n = 0; n < 150; n++) {
        usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-tencent_${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
      assert.equal(event.provider, "tencent-tokenhub"); assert.equal(event.model, `tencent-tokenhub/${cards[id]}`);
      assert.equal(event.credential_id, `tencent_${id}`); assert.equal(event.status, "success");
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7); assert.equal(usage.budget.spentMicros, 7);
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], [300, 20, 320, 256]);
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) await putGrantCredentials(env, "oauth/tencent_" + id + "/tencent-tokenhub", { provider: "tencent-tokenhub", enabled: true, kind: "api_key", credential: "fixture-upstream-" + id });
    return new Response(null, { status: 204 });
  }
  return handler.fetch(request, { ...env, TOKENHUB_API_KEY: "must-not-fallback", TOKENPLAN_API_KEY: "must-not-fallback" }, context);
} };`;
}
function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json(); calls.push({ url: request.url, authorization: request.headers.get("authorization"), body });
    const frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const served = body.model === "hy3-preview" ? "hy3" : body.model;
    const wire = frame({ id: "chat_fixture", model: served, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] })
      + frame({ id: "chat_fixture", model: served, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, prompt_tokens_details: { cached_tokens: 256 } } }) + "data: [DONE]\\n\\n";
    const bytes = new TextEncoder().encode(wire); let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
