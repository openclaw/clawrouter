import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const paid = ["complete", "image", "fixed", "error", "cancel"];
const denied = ["foreign", "budget", "model_denied"];
const ids = [...paid, ...denied];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

export function registerGoogleTextContract({ modelId, expectedMicros, basis }) {
  test("actual registered Google " + modelId + " through Worker and SQLite", { skip: !source, timeout: 300_000 }, async t => {
    const provider = snapshot.providers.find(row => row.id === "google-gemini");
    const selected = provider.models.find(row => row.upstream === modelId);
    assert.ok(selected); assert.equal(selected.pricing.defaultMaxOutputTokens, 65536);
    const temporary = await mkdtemp(join(tmpdir(), "clawrouter-google-text-"));
    const { startWorkerdFixture } = await import("./workerd.mjs"); let mf;
    try {
      mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(modelId));
      const kv = await mf.getKVNamespace("POLICY_KV", "router");
      for (const id of ids) {
        const policyId = "google_" + id;
        await kv.put("policies/" + policyId, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture",
          providers: [id === "foreign" ? "openai" : "google-gemini"], models: [id === "model_denied" ? "google/gemini-3.5-flash" : selected.id],
          monthlyBudgetMicros: id === "budget" ? 1 : 10000000, requestCostMicros: ["fixed", "error", "cancel"].includes(id) ? 7 : null,
          budgetMode: "reserve", retainRequestContent: false, grantRouting: { eligibleGrants: { "google-gemini": ["google"] }, environmentFallback: false } }));
        await kv.put("credentials/" + policyId, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId, policyGeneration: "fixture" }));
      }
      const origin = String(await mf.ready).replace(/\/$/, "");
      assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
      const catalog = await (await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-google_complete-fixture-secret" } })).json();
      assert.deepEqual(catalog.providers.find(row => row.id === "google-gemini").models.map(row => row.id), [selected.id]);
      await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("../fixtures/openclaw-google-text-contract.test.ts", import.meta.url),
        testPath: "extensions/google/worker-contract.test.ts", env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CONTRACT_MODEL: modelId,
          GOOGLE_API_KEY: "must-not-fallback", GEMINI_API_KEY: "must-not-fallback" } });
      const upstream = await mf.getWorker("upstream"); let calls;
      for (let attempt = 0; attempt < 150; attempt++) {
        calls = await (await upstream.fetch("https://fixture.example/state")).json();
        if (calls.some(call => JSON.stringify(call.body).includes("google_cancel") && (call.cancelled || call.aborted))) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(calls.length, paid.length, "denials are zero-egress and paid outcomes never replay");
      for (const id of paid) {
        const matching = calls.filter(call => JSON.stringify(call.body).includes("fixture google_" + id));
        assert.equal(matching.length, 1, id); const [call] = matching;
        assert.equal(call.method, "POST");
        assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models/" + modelId + ":streamGenerateContent?alt=sse");
        assert.equal(call.headers["x-goog-api-key"], "fixture-upstream-" + id);
        assert.equal(call.body.model, undefined); assert.equal(call.body.generationConfig.maxOutputTokens, 128);
        assert.ok(call.body.tools.flatMap(tool => tool.functionDeclarations ?? []).some(fn => fn.name === "lookup"));
        const parts = call.body.contents.flatMap(content => content.parts);
        assert.ok(parts.some(part => part.functionCall?.name === "lookup"));
        assert.ok(parts.some(part => part.functionResponse?.name === "lookup" && JSON.stringify(part).includes("synthetic-tool-result")));
        assert.deepEqual(parts.filter(part => part.inlineData).map(part => part.inlineData), id === "image" ? [{ mimeType: "image/png", data: png }] : []);
        assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
        if (id === "cancel") { assert.ok(call.cancelled || call.aborted); assert.notEqual(call.fixtureExpired, true); }
        let usage;
        for (let attempt = 0; attempt < 150; attempt++) {
          usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer clawrouter-live-google_" + id + "-fixture-secret" } })).json();
          if (usage.usage.events.length === 1) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
        const fixed = ["fixed", "error", "cancel"].includes(id), complete = !["error", "cancel"].includes(id);
        assert.equal(event.provider, "google-gemini"); assert.equal(event.model, selected.id);
        assert.equal(event.credential_id, "google_" + id); assert.equal(event.policy_id, "google_" + id);
        assert.equal(event.actual_cost_micros, fixed ? 7 : expectedMicros); assert.equal(usage.budget.spentMicros, fixed ? 7 : expectedMicros);
        assert.equal(event.cost_basis, fixed ? "policy_fixed" : basis);
        assert.equal(event.status, id === "error" ? "provider_error" : id === "cancel" ? "client_error" : "success");
        assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], complete ? [1000, 100, 1100] : [null, null, null]);
        if (complete) assert.equal(event.cached_input_tokens, 500);
      }
      for (const id of denied) {
        const usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: "Bearer clawrouter-live-google_" + id + "-fixture-secret" } })).json();
        assert.equal(usage.budget.spentMicros, 0);
        assert.ok(usage.usage.events.every(event => event.actual_cost_micros === 0));
      }
    } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
  });
}

function routerFixture() {
  return 'import handler from "./worker/index.ts"; export * from "./worker/index.ts";\n'
    + 'import { putGrantCredentials } from "./worker/grant-credentials.ts";\n'
    + 'export default { ...handler, async fetch(request, env, context) { if (new URL(request.url).pathname === "/fixture/grants") {'
    + 'for (const id of ' + JSON.stringify(ids) + ') await putGrantCredentials(env, "oauth/google_" + id + "/google", { provider: "google-gemini", kind: "api_key", enabled: true, credential: "fixture-upstream-" + id });'
    + 'return new Response(null, { status: 204 }); } return handler.fetch(request, { ...env, GOOGLE_API_KEY: "must-not-fallback" }, context); } };';
}
function upstreamFixture(modelId) {
  return 'const modelId = ' + JSON.stringify(modelId) + '; const calls = []; export default { async fetch(request) {'
    + 'if (request.url === "https://fixture.example/state") return Response.json(calls); const body = await request.json();'
    + 'const call = { method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body }; calls.push(call);'
    + 'const text = JSON.stringify(body), cancel = text.includes("google_cancel"), failed = text.includes("google_error");'
    + 'const frame = value => "data: " + JSON.stringify(value) + "\\n\\n";'
    + 'const first = { modelVersion: modelId, candidates: [{ index: 0, content: { role: "model", parts: [{ text: "synthetic-thinking", thought: true }, { text: "synthetic-answer" }] } }] };'
    + 'const last = { modelVersion: modelId, candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [] } }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 500, candidatesTokenCount: 90, thoughtsTokenCount: 10, totalTokenCount: 1100, serviceTier: "standard" } };'
    + 'const bytes = new TextEncoder().encode(frame(first) + (cancel ? "" : failed ? frame({error:{code:500,status:"INTERNAL",message:"synthetic-upstream-error"}}) : frame(last)));'
    + 'let offset = 0, timer, wake, beats = 0; request.signal.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); wake?.(); }, {once:true});'
    + 'return new Response(new ReadableStream({ pull(controller) { if (offset < bytes.length) { const end = Math.min(offset + 7, bytes.length); controller.enqueue(bytes.slice(offset,end)); offset=end; return; }'
    + 'if (!cancel) { controller.close(); return; } return new Promise(resolve => { wake=resolve; timer=setTimeout(() => { if (++beats > 200) { call.fixtureExpired=true; controller.close(); } else controller.enqueue(new TextEncoder().encode(": fixture heartbeat\\n\\n")); resolve(); },50); }); },'
    + 'cancel() { call.cancelled=true; clearTimeout(timer); wake?.(); } }, {highWaterMark:0}), {headers:{"content-type":"text/event-stream"}}); } };';
}
