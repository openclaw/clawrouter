import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const prefix = "/v1/native/vydra", job = "fixture_models_job";
const payload = model => model === "kling" ? { prompt: "Synthetic motion", image_url: "https://assets.example/image.png", video_url: "https://assets.example/motion.mp4" } : { prompt: "Synthetic video" };
async function setup(t, options = {}) {
  const f = await fixture(t, { providerId: "vydra", compiledProvider: true, pooled: true, ...options });
  f.env.VYDRA_API_KEY = "must-not-fallback";
  f.upstream = request => Response.json(request.method === "POST" ? { jobId: job, status: "pending", outputUrl: "https://assets.example/premature.mp4" }
    : { id: job, status: "running", output: { videoUrl: "https://assets.example/premature.mp4" } }, { status: request.method === "POST" ? 202 : 200 });
  f.create = (model, manifest = false, body = payload(model)) => f.call(manifest ? "/v1/proxy/vydra/model_video" : prefix + "/api/v1/models/" + model,
    manifest ? { pathParams: { model }, body } : body, { headers: { "Idempotency-Key": "models-once" } });
  f.read = (manifest = false, extra = {}) => f.call(manifest ? "/v1/proxy/vydra/job?job_id=" + job : prefix + "/api/v1/jobs/" + job, null, extra);
  t.after(f.drain); return f;
}
async function json(response, expected = 200) { const text = await response.text(); assert.equal(response.status, expected, text); return JSON.parse(text); }

for (const model of ["veo3", "kling"]) for (const manifest of [false, true]) test("Models " + model + " " + (manifest ? "manifest" : "native") + ": original create owns shared GET and one settlement", { timeout: 10000 }, async t => {
  const f = await setup(t), created = await f.create(model, manifest), state = f.state(created), body = await json(created, 202);
  assert.equal(body.jobId, job); assert.doesNotMatch(JSON.stringify(body), /premature/);
  assert.equal(f.sent[0].url, "https://www.vydra.ai/api/v1/models/" + model);
  assert.deepEqual(await f.sent[0].clone().json(), payload(model));
  assert.equal(state.job().managed.requestedVersion, model); assert.equal(state.job().managed.terminal, null);
  await json(await f.create(model, !manifest, { ...payload(model), prompt: "changed" }), 409);
  f.restart(); const pending = await json(await f.read(!manifest)); assert.doesNotMatch(JSON.stringify(pending), /premature/);
  assert.equal(state.job().event, null);
  const beforeCancel = f.sent.length;
  await json(await f.call(prefix + "/api/v1/jobs/" + job, null, { method: "DELETE" }), 409);
  assert.equal(f.sent.length, beforeCancel, "Models cannot borrow Jobs DELETE authority");
  f.upstream = () => Response.json({ id: job, model, status: "completed", output: { videoUrl: "https://assets.example/final.mp4" }, creditsCharged: 50 });
  assert.equal((await json(await f.read(manifest))).output.videoUrl, "https://assets.example/final.mp4");
  assert.equal(state.job().managed.terminal, "succeeded");
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30000); await state.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1);
  assert.deepEqual([events[0].actual_cost_micros, events[0].cost_basis, events[0].total_tokens], [700, "policy_fixed", null]);
  assert.equal(state.job().phase, "complete");
  const retry = await f.create(model, !manifest); assert.equal(retry.status, 303); assert.equal(retry.headers.get("location"), prefix + "/api/v1/jobs/" + job);
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
  for (const request of f.sent) { assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key"); assert.equal(request.redirect, "manual"); }
});

test("Models denies unknown-dollar budget before egress", { timeout: 10000 }, async t => {
  const f = await setup(t, { fixed: null });
  assert.equal((await json(await f.create("veo3"), 400)).error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});

test("Models raw/foreign/rotated owners cannot control an original job", { timeout: 10000 }, async t => {
  const f = await setup(t); await json(await f.read(), 409); assert.equal(f.sent.length, 0);
  await json(await f.create("kling"), 202);
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" }, operation: "create", credentialId: "second", credential: f.credential });
  await json(await f.read(true, { headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } }), 409);
  await putGrantCredentials(f.env, grantKey, { provider: "vydra", kind: "api_key", enabled: true, credential: "synthetic-rotated" });
  await json(await f.read(), 503); assert.equal(f.sent.length, 1);
});

test("Models uncertain POST is never replayed or settled as success", { timeout: 10000 }, async t => {
  const f = await setup(t); f.upstream = () => { throw undefined; };
  const response = await f.create("veo3"), state = f.state(response); await json(response, 503);
  f.restart(); await json(await f.create("veo3", true), 202); assert.equal(f.sent.length, 1);
  f.advance(3600000); await state.alarm(); await f.drain();
  assert.equal(state.job().managed.submission, "submission_unknown"); assert.equal(state.job().managed.terminal, null);
  assert.equal(state.job().amount, 700);
});
