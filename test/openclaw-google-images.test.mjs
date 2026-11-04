import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "9ce99ae1521b2d23e85c27688d9db45a31dbe472";
const models = ["gemini-3.1-flash-image", "gemini-3-pro-image"];
const charged = ["model0_text", "model0_edit", "model1_text", "model1_edit", "incomplete"];
const ids = [...charged, "unpriced", "aborted"];
const modelFor = id => id.startsWith("model1") ? models[1] : models[0];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=";

for (const dispatch of ["native", "manifest"]) test(`actual Google image ${dispatch} consumer through Worker/SQLite`, { skip: !source, timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-google-image-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(dispatch), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/gimage_${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: ["google-gemini"], models: ["google/" + modelFor(id)], tenantId: "fixture",
        grantRouting: { eligibleGrants: { "google-gemini": ["google-gemini"] }, environmentFallback: false },
        monthlyBudgetMicros: 100, requestCostMicros: id === "unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/gimage_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `gimage_${id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/google-gemini", JSON.stringify({ providerId: "google-gemini", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const catalog = await (await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-gimage_model0_text-fixture-secret" } })).json();
    const offers = catalog.providers.find(p => p.id === "google-gemini").offers;
    assert.ok(offers.some(o => o.endpoint === "image_generate" && o.modelId === "google/" + models[0] && o.routeKind === dispatch && o.eligible));
    if (dispatch === "manifest") assert.ok(offers.every(o => o.routeKind !== "native"));
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-google-images-contract.test.ts", import.meta.url), testPath: "extensions/clawrouter/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, GOOGLE_API_KEY: "must-not-fallback", GEMINI_API_KEY: "must-not-fallback" } });
    const upstream = await mf.getWorker("upstream"), calls = await (await upstream.fetch("https://fixture.example/state")).json();
    assert.equal(calls.length, charged.length, "unknown-price, invalid and pre-aborted requests are zero-egress; paid failures never replay");
    for (const id of charged) {
      const matching = calls.filter(c => c.body.contents[0].parts.some(p => p.text === `synthetic gimage_${id}`)); assert.equal(matching.length, 1);
      const [call] = matching;
      assert.equal(call.url, `https://generativelanguage.googleapis.com/v1beta/models/${modelFor(id)}:generateContent`);
      assert.equal(call.headers["x-goog-api-key"], `fixture-upstream-${id}`);
      assert.equal(call.headers.authorization, undefined);
      assert.deepEqual(call.body.generationConfig, { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "1K" } });
      const images = call.body.contents.flatMap(c => c.parts.filter(p => p.inlineData));
      assert.deepEqual(images, id.endsWith("edit") ? [{ inlineData: { mimeType: "image/png", data: png } }] : []);
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
      let usage;
      for (let n = 0; n < 150; n++) {
        usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer clawrouter-live-gimage_${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, 1); const [event] = usage.usage.events;
      assert.equal(event.model, "google/" + modelFor(id)); assert.equal(event.capability, "image.generate");
      assert.equal(event.credential_id, `gimage_${id}`); assert.equal(event.status, id === "incomplete" ? "provider_error" : "success");
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7); assert.equal(usage.budget.spentMicros, 7);
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], [null, null, null]);
    }
  } finally { await mf?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
function routerFixture(dispatch) {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { snapshot } from "./worker/providers.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
// A separate isolate uses the supported manifest-only endpoint declaration.
// Eligibility and catalog contents are still constructed by the real Worker.
if (${JSON.stringify(dispatch)} === "manifest") snapshot.providers.find(p => p.id === "google-gemini").endpoints.find(e => e.id === "image_generate").native_proxy = false;
export default { ...handler, async fetch(request, env, context) {
  if (new URL(request.url).pathname === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) await putGrantCredentials(env, "oauth/gimage_" + id + "/google-gemini", { provider: "google-gemini", kind: "api_key", enabled: true, credential: "fixture-upstream-" + id });
    return new Response(null, { status: 204 });
  }
  return handler.fetch(request, { ...env, GOOGLE_API_KEY: "must-not-fallback" }, context);
} };`;
}
function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json(); calls.push({ url: request.url, headers: Object.fromEntries(request.headers), body });
    const incomplete = JSON.stringify(body).includes("gimage_incomplete");
    const payload = { candidates: [{ ...(incomplete ? {} : { finishReason: "STOP" }), content: { parts: [{ inlineData: { mimeType: "image/png", data: ${JSON.stringify(png)} } }] } }] };
    const bytes = new TextEncoder().encode(JSON.stringify(payload)); let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end; } } }), { headers: { "content-type": "application/json" } });
  } };`;
}
