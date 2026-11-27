import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/runway/lifecycle.json", import.meta.url)));
const prefix = "/v1/native/runway", id = wire.created.id, readPath = "/v1/tasks/" + id;
const observation = index => ({ id, ...wire.observations[index].native });
async function setup(t, options = {}) {
  const f = await fixture(t, { ...options, providerId: "runway", compiledProvider: true });
  f.env.RUNWAYML_API_SECRET = "synthetic-environment-key"; f.env.RUNWAY_API_KEY = "synthetic-alias-key";
  f.upstream = request => request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(request.method === "POST" ? wire.created : observation(0));
  f.create = (manifest = false, body = wire.text.body, extra = {}) => f.call(
    manifest ? "/v1/proxy/runway/text_video" : prefix + wire.text.path, manifest ? { body } : body,
    { ...extra, headers: { "Idempotency-Key": "one-runway-job", "X-Runway-Version": "caller-version", ...extra.headers } });
  f.read = (manifest = false, extra = {}) => f.call(
    manifest ? `/v1/proxy/runway/text_task?id=${id}` : prefix + readPath, null, extra);
  f.cancel = (manifest = false) => manifest
    ? f.call("/v1/proxy/runway/text_task_cancel", { method: "DELETE", pathParams: { id }, body: {} })
    : f.call(prefix + readPath, null, { method: "DELETE" });
  t.after(f.drain); return f;
}
async function json(response, status = 200) {
  const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text);
}

for (const [model, duration] of [["gen4.5", 5], ["veo3.1", 4], ["veo3.1_fast", 8]]) for (const manifest of [false, true]) test(`compiled Runway ${model} ${manifest ? "manifest" : "native"}: original versioned lifecycle and one settlement`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  const catalog = await json(await f.call("/v1/catalog", null)), provider = catalog.providers.find(provider => provider.id === "runway");
  assert.equal(catalog.scope.credentialId, "fixture"); assert.ok(provider);
  assert.deepEqual(provider.models.map(model => model.id).sort(), ["runway/gen4.5", "runway/veo3.1", "runway/veo3.1_fast"]);
  assert.ok(provider.offers.some(offer => offer.endpoint === "text_video" && offer.eligible)); assert.equal(f.sent.length, 0);
  const body = { ...wire.text.body, model, duration }, response = await f.create(manifest, body); await json(response); const state = f.state(response);
  assert.deepEqual(await f.sent[0].clone().json(), body); assert.equal(f.sent[0].url, "https://api.dev.runwayml.com" + wire.text.path);
  assert.equal(state.job().managed.requestedVersion, model); assert.equal(state.job().event, null);
  assert.doesNotMatch(JSON.stringify(state.job()), /synthetic-original-key|Synthetic landscape|media\.example/);
  await json(await f.create(!manifest, { ...body, promptText: "changed" }), 409); assert.equal(f.sent.length, 1);
  f.restart(); await json(await f.read(!manifest)); assert.equal(state.job().managed.terminal, null);
  f.upstream = () => Response.json(observation(3)); await json(await f.read(manifest));
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
  for (const request of f.sent) {
    assert.equal(request.headers.get("x-runway-version"), wire.version); assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(new URL(request.url).origin, "https://api.dev.runwayml.com"); assert.equal(request.redirect, "manual");
  }
  assert.ok(f.sent.slice(1).every(request => new URL(request.url).pathname === readPath));
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].provider, "runway"); assert.equal(events[0].actual_cost_micros, 700);
  assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].total_tokens, null);
  assert.equal(state.job().phase, "complete"); assert.deepEqual(state.job().settlements, ["settled", "settled"]);
  const retry = await f.create(!manifest, body); assert.equal(retry.status, 303); assert.equal(retry.headers.get("location"), prefix + readPath);
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
});

for (const manifest of [false, true]) test(`compiled Runway ${manifest ? "manifest" : "native"}: unknown dollar tariff remains zero-egress`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: null });
  assert.equal((await json(await f.create(manifest), 400)).error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});

for (const manifest of [false, true]) test(`compiled Runway ${manifest ? "manifest" : "native"}: DELETE acknowledges observation loss without free generation or replay`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }), response = await f.create(manifest); await json(response); const state = f.state(response);
  const canceled = await f.cancel(!manifest); assert.equal(canceled.status, 204, await canceled.clone().text()); assert.equal(await canceled.text(), "");
  assert.deepEqual(f.sent.map(request => request.method), ["POST", "GET", "DELETE"]);
  assert.equal(f.sent[1].url, "https://api.dev.runwayml.com" + readPath);
  assert.equal(f.sent[2].url, "https://api.dev.runwayml.com" + readPath);
  assert.equal(f.sent[2].headers.get("x-runway-version"), wire.version); assert.equal(f.sent[2].headers.get("authorization"), "Bearer synthetic-original-key");
  assert.equal(state.job().managed.terminal, null); assert.equal(state.job().managed.observationUnavailable, "canceled_or_deleted");
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  assert.equal((await f.events()).length, 1); assert.equal(state.job().phase, "complete");
  assert.equal((await f.read()).status, 410); assert.equal((await f.create()).status, 410);
  f.advance(60 * 60_000); await state.alarm(); assert.equal(f.sent.length, 3);
});

test("compiled Runway raw IDs, foreign callers and rotated original credentials cannot control a job", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }); await json(await f.read(), 409); assert.equal(f.sent.length, 0);
  await json(await f.create()); f.restart();
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" },
    operation: "create", credentialId: "second", credential: f.credential });
  await json(await f.read(true, { headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } }), 409);
  await putGrantCredentials(f.env, grantKey, { provider: "runway", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
  assert.equal((await json(await f.read(), 503)).error.code, "response_owner_unavailable"); assert.equal(f.sent.length, 1);
});

test("compiled Runway rejects unbound assets and unsupported Veo duration before egress", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  for (const [path, body] of [[wire.image.path, wire.image.body], [wire.video.path, wire.video.body], ["/v1/uploads", {}]]) await json(await f.call(prefix + path, body), 404);
  for (const promptImage of ["https://media.example/unowned.png", "data:image/png;base64,AAAA", "runway://unowned"]) await json(await f.create(true, { ...wire.text.body, promptImage }), 400);
  for (const model of ["veo3.1", "veo3.1_fast"]) await json(await f.create(false, { ...wire.text.body, model, duration: 5 }), 400);
  assert.equal(f.sent.length, 0);
});

test("compiled Runway uncertain creation cannot replay or infer a refund", { timeout: 10_000 }, async t => {
  const f = await setup(t); f.upstream = () => { throw new Error("synthetic lost create reply"); };
  const response = await f.create(true), state = f.state(response); await json(response, 503);
  f.restart(); await json(await f.create(), 202); assert.equal(f.sent.length, 1);
  f.advance(60 * 60_000); await state.alarm(); await f.drain();
  assert.equal(state.job().managed.submission, "submission_unknown"); assert.equal(state.job().managed.terminal, null);
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
});
