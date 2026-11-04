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
const cases = ["global37", "global35", "cn37", "cn35", "low", "max", "image"];
const ids = [...cases, "unpriced", "foreign"];
const region = id => id.startsWith("cn") ? "stepfun-cn" : "stepfun";
const model = id => id.endsWith("35") ? "step-3.5-flash" : "step-3.7-flash";

test("registered StepFun standard clients preserve explicit region and original grant through Worker/SQLite", { skip: !source, timeout: 300_000 }, async t => {
  assert.ok(snapshot.providers.some(p => p.id === "stepfun-cn"), "the exact regional snapshot must qualify before execution");
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-stepfun-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      const provider = region(id);
      await kv.put(`policies/stepfun_${id}`, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture",
        providers: [id === "foreign" ? "stepfun-plan" : provider], models: [`${provider}/${model(id)}`],
        grantRouting: { eligibleGrants: { [provider]: [provider] }, environmentFallback: false },
        monthlyBudgetMicros: 100, requestCostMicros: id === "unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/stepfun_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `stepfun_${id}`, policyGeneration: "fixture" }));
    }
    for (const providerId of ["stepfun", "stepfun-cn"]) await kv.put(`connections/${providerId}`, JSON.stringify({ providerId, enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-stepfun-contract.test.ts", import.meta.url), testPath: "extensions/stepfun/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, STEPFUN_API_KEY: "must-not-fallback", STEPFUN_CN_API_KEY: "must-not-fallback", STEPFUN_PLAN_API_KEY: "must-not-fallback" } });
    const upstream = await mf.getWorker("upstream"), calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, cases.length, "invalid, foreign-product and unknown-price calls must have zero egress");
    for (const id of cases) {
      const matching = calls.filter(c => JSON.stringify(c.body.messages).includes(`stepfun_${id}`)); assert.equal(matching.length, 1);
      const [call] = matching, provider = region(id);
      assert.equal(call.url, (provider === "stepfun-cn" ? "https://api.stepfun.com/v1" : "https://api.stepfun.ai/v1") + "/chat/completions");
      assert.equal(call.authorization, `Bearer fixture-upstream-${provider}-${id}`);
      assert.equal(call.body.model, model(id)); assert.equal(call.body.stream, true);
      assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
      assert.ok(call.body.messages.some(m => m.role === "tool" && m.tool_call_id === "callfixture" && m.content === "synthetic-tool-result"));
      assert.ok(call.body.messages.some(m => m.tool_calls?.[0]?.function?.name === "lookup"));
      if (model(id) === "step-3.7-flash") {
        assert.equal(call.body.store, undefined); assert.equal(call.body.stream_options, undefined);
        assert.equal(call.body.tools[0].function.strict, undefined);
        assert.equal(call.body.reasoning_effort, id === "low" ? "low" : "high");
        assert.ok(call.body.messages.every(m => m.role !== "developer"));
      }
      const images = call.body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === "image_url") : []);
      assert.equal(images.length, id === "image" ? 1 : 0);
      if (id === "image") assert.equal(images[0].image_url.url, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=");
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      let usage;
      for (let n = 0; n < 150; n++) {
        usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-stepfun_${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
      assert.equal(event.provider, provider); assert.equal(event.model, `${provider}/${model(id)}`);
      assert.equal(event.credential_id, `stepfun_${id}`); assert.equal(event.status, "success");
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
    for (const id of ${JSON.stringify(ids)}) { const provider = (${region.toString()})(id);
      await putGrantCredentials(env, "oauth/stepfun_" + id + "/" + provider, { provider, enabled: true, kind: "api_key", credential: "fixture-upstream-" + provider + "-" + id }); }
    return new Response(null, { status: 204 });
  }
  return handler.fetch(request, { ...env, STEPFUN_API_KEY: "must-not-fallback", STEPFUN_CN_API_KEY: "must-not-fallback", STEPFUN_PLAN_API_KEY: "must-not-fallback" }, context);
} };`;
}
function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json(); calls.push({ url: request.url, authorization: request.headers.get("authorization"), body });
    const frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const wire = frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }], usage: { prompt_tokens: 300, completion_tokens: 6, total_tokens: 306, cached_tokens: 256 } })
      + frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, cached_tokens: 256 } }) + "data: [DONE]\\n\\n";
    const bytes = new TextEncoder().encode(wire); let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
