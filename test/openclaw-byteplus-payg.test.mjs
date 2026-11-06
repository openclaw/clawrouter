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
const models = ["dola-seed-2-1-turbo-260628", "seed-2-0-code-preview-260328", "glm-5-2-260617", "deepseek-v4-pro-260425", "deepseek-v4-flash-260425"];
const closed = ["glm-4-7-251222"];
const cards = Object.fromEntries(models.flatMap((model, i) => [[`m${i}_stream`, model], [`m${i}_simple`, model]]));
Object.assign(cards, { roundtrip: "deepseek-v4-pro-260425", no_usage: models[0], http_error: models[0], embedded_error: models[0], cancel: models[0] });
const dispatched = Object.keys(cards), ids = [...dispatched, "foreign", "missing", "unpriced", "revoked", "aborted", ...closed.map((_, i) => `closed${i}`)];
const key = id => `clawrouter-live-byte_${id}-fixture-secret`;
test("registered ClawRouter catalog routes BytePlus PAYG turns with original grants and SQLite accounting", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(p => p.id === "byteplus");
  assert.deepEqual(provider.models.filter(m => m.capabilities.includes("llm.chat")).map(m => m.upstream), models);
  assert.ok(provider.models.every(m => m.pricing === null));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-byteplus-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs"); let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      const model = id.startsWith("closed") ? closed[Number(id.slice(6))] : cards[id] ?? models[0];
      await kv.put(`policies/byte_${id}`, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture", providers: [id === "foreign" ? "volcengine" : "byteplus"], models: [`byteplus/${model}`],
        grantRouting: { eligibleGrants: { byteplus: ["byteplus"] }, environmentFallback: false }, monthlyBudgetMicros: 100, requestCostMicros: id === "unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/byte_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `byte_${id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/byteplus", JSON.stringify({ providerId: "byteplus", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-byteplus-payg-contract.test.ts", import.meta.url),
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, BYTEPLUS_API_KEY: "must-not-fallback", VOLCANO_ENGINE_API_KEY: "must-not-fallback", VOLCENGINE_PLAN_API_KEY: "must-not-fallback", BYTEPLUS_PLAN_API_KEY: "must-not-fallback", ARK_API_KEY: "must-not-fallback" } });
    // The actual client omits closed rows. Separately prove its raw Worker
    // denial rather than inventing an executable client catalog entry.
    for (const [i, model] of closed.entries()) {
      const response = await fetch(origin + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key(`closed${i}`)}`, "content-type": "application/json" }, body: JSON.stringify({ model: `byteplus/${model}`, messages: [] }) });
      assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "model_capability_unsupported");
    }
    const observation = await (await fetch(origin + "/fixture/state")).json();
    assert.ok(observation.catalog.length >= dispatched.length, "catalog HTTP is counted separately from inference");
    assert.ok(observation.catalog.every(c => c.proxyKey && c.path === "/v1/catalog"));
    assert.ok(observation.incoming.every(c => c.proxyKey && c.path === "/v1/chat/completions"));
    for (const [id, status, code] of [["foreign", 403, "provider_not_allowed"], ["missing", 503, "upstream_grant_pool_unavailable"], ["unpriced", 400, "pricing_required"], ["revoked", 503, "upstream_grant_pool_unavailable"]]) {
      assert.deepEqual(observation.denials.filter(row => row.id === id).map(({ status, code }) => ({ status, code })), [{ status, code }], id);
    }
    const upstream = await mf.getWorker("upstream"); let calls;
    for (let n = 0; n < 150; n++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const call = calls.find(c => c.id === "cancel"); if (call?.cancelled || call?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancelled = calls.find(c => c.id === "cancel");
    assert.ok(cancelled?.cancelled || cancelled?.aborted, "actual post-header cancellation must reach upstream transport");
    assert.notEqual(cancelled.fixtureExpired, true, "fixture expiry is not caller cancellation");
    assert.equal(calls.length, dispatched.length + 1, "one POST per turn; two explicit tool turns; no denied egress or retry");
    for (const id of dispatched) {
      const expected = id === "roundtrip" ? 2 : 1, matching = calls.filter(c => c.id === id); assert.equal(matching.length, expected, id);
      const incoming = observation.incoming.filter(c => c.id === id); assert.equal(incoming.length, expected, id);
      for (const c of incoming) assert.equal(c.model, `byteplus/${cards[id]}`);
      for (const call of matching) {
        assert.equal(call.url, "https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions"); assert.equal(call.authorization, `Bearer fixture-upstream-${id}`);
        assert.equal(call.apiKey, null); assert.equal(call.xApiKey, null); assert.equal(call.body.model, cards[id]); assert.equal(call.body.stream, true);
        assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
        assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback|fixture-foreign/);
      }
      if (id === "roundtrip") {
        const [first, second] = matching;
        assert.ok(!first.body.messages.some(m => m.role === "tool"));
        assert.equal(first.body.tools[0].function.name, "lookup");
        // The registered generic replay policy normalizes both paired IDs.
        assert.ok(second.body.messages.some(m => m.role === "tool" && m.tool_call_id === "callfixture" && m.content === "synthetic-tool-result"));
        assert.ok(second.body.messages.some(m => m.reasoning_content === "synthetic-reasoning"));
        const replayCall = second.body.messages.flatMap(m => m.tool_calls ?? []);
        assert.deepEqual(replayCall, [{ id: "callfixture", type: "function", function: { name: "lookup", arguments: '{"value":"fixture"}' } }]);
      }
      let usage;
      for (let n = 0; n < 150; n++) {
        usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer ${key(id)}` } })).json();
        if (usage.usage.events.length === expected) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, expected, id); const rejected = ["http_error", "embedded_error"].includes(id);
      assert.equal(usage.budget.spentMicros, rejected ? 0 : 7 * expected, id);
      for (const event of usage.usage.events) {
        assert.equal(event.provider, "byteplus"); assert.equal(event.model, `byteplus/${cards[id]}`); assert.equal(event.credential_id, `byte_${id}`);
        assert.equal(event.status, id === "http_error" || id === "cancel" ? "client_error" : id === "embedded_error" ? "provider_error" : "success", id);
        assert.equal(event.actual_cost_micros, rejected ? 0 : 7); assert.equal(event.cost_basis, rejected ? "none" : "policy_fixed");
        assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], rejected || ["cancel", "no_usage"].includes(id) ? [null, null, null, null] : [100, 20, 120, 40], id);
      }
      assert.doesNotMatch(JSON.stringify(usage), /fixture-upstream|synthetic-reasoning|synthetic-tool-result|synthetic-answer/);
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
const catalog = [], incoming = [], denials = [];
export default { ...handler, async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/state") return Response.json({ catalog, incoming, denials });
  if (path === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) {
      for (const foreign of ["volcengine", "byteplus-plan", "volcengine-plan"]) await putGrantCredentials(env, "oauth/byte_" + id + "/" + foreign, { provider: foreign, enabled: true, kind: "api_key", credential: "fixture-foreign-product" });
      if (id !== "missing") await putGrantCredentials(env, "oauth/byte_" + id + "/byteplus", { provider: "byteplus", enabled: true, kind: "api_key", credential: "fixture-upstream-" + id });
    }
    return new Response(null, { status: 204 });
  }
  if (path === "/fixture/revoke") { await revokeGrantCredentials(env, "oauth/byte_revoked/byteplus"); return new Response(null, { status: 204 }); }
  const id = ${JSON.stringify(ids)}.find(id => request.headers.get("authorization") === "Bearer clawrouter-live-byte_" + id + "-fixture-secret");
  if (path === "/v1/catalog") catalog.push({ id, path, proxyKey: !!id });
  if (path === "/v1/chat/completions") incoming.push({ id, path, proxyKey: (request.headers.get("authorization") ?? "").startsWith("Bearer clawrouter-live-byte_"), model: (await request.clone().json()).model });
  const response = await handler.fetch(request, { ...env, BYTEPLUS_API_KEY: "must-not-fallback", VOLCANO_ENGINE_API_KEY: "must-not-fallback", ARK_API_KEY: "must-not-fallback", VOLCENGINE_PLAN_API_KEY: "must-not-fallback", BYTEPLUS_PLAN_API_KEY: "must-not-fallback" }, context);
  if (path === "/v1/chat/completions" && ["foreign", "missing", "unpriced", "revoked"].includes(id)) {
    const body = await response.clone().json(); denials.push({ id, status: response.status, code: body.error?.code });
  }
  return response;
} };`;
}
function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json(), id = request.headers.get("authorization").replace("Bearer fixture-upstream-", "");
    const call = { id, url: request.url, authorization: request.headers.get("authorization"), apiKey: request.headers.get("api-key"), xApiKey: request.headers.get("x-api-key"), body }; calls.push(call);
    if (id === "http_error") return Response.json({ error: { message: "synthetic provider rejection" } }, { status: 401 });
    const frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const toolTurn = id === "roundtrip" && !body.messages.some(m => m.role === "tool");
    const usage = id === "no_usage" ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } } };
    const first = frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "synthetic-reasoning", ...(toolTurn ? {} : { content: "synthetic-answer" }) }, finish_reason: null }] });
    const tools = toolTurn ? frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{\\\"value\\\":" } }] }, finish_reason: null }] })
      + frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\\\"fixture\\\"}" } }] }, finish_reason: null }] }) : "";
    const wire = id === "embedded_error" ? frame({ error: { code: "synthetic_error", message: "synthetic provider rejection" } }) : first + tools + (id === "cancel" ? "" : frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: toolTurn ? "tool_calls" : "stop" }], ...usage }) + "data: [DONE]\\n\\n");
    const bytes = new TextEncoder().encode(wire); let offset = 0, beats = 0, timer, wake;
    request.signal.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); wake?.(); }, { once: true });
    return new Response(new ReadableStream({ pull(c) {
      if (offset === bytes.length) {
        if (id !== "cancel") { c.close(); return; }
        // Existing post-header fixture contract: a bounded real timer keeps the
        // request live; expiry is explicitly rejected as cancellation evidence.
        return new Promise(resolve => { wake = resolve; timer = setTimeout(() => {
          if (++beats > 200) { call.fixtureExpired = true; c.close(); } else c.enqueue(new TextEncoder().encode(": fixture heartbeat\\n\\n")); resolve();
        }, 50); });
      }
      const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end;
    }, cancel() { call.cancelled = true; clearTimeout(timer); wake?.(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
