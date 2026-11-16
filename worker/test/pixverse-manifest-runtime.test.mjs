import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/pixverse/lifecycle.json", import.meta.url)));
const prefix = "/v1/native/pixverse", id = String(wire.text.response.Resp.video_id);
const readPath = wire.retrieve.path.replace("${video_id}", id);
const observation = index => ({ ErrCode: 0, Resp: { video_id: Number(id), ...wire.observations[index].native } });
async function setup(t, options = {}) {
  const f = await fixture(t, { ...options, providerId: "pixverse", compiledProvider: true });
  f.env.PIXVERSE_API_KEY = "synthetic-environment-key";
  f.upstream = request => Response.json(request.method === "POST" ? wire.text.response : observation(0));
  f.create = (manifest = false, body = wire.text.body, extra = {}) => f.call(
    manifest ? "/v1/proxy/pixverse/text_video" : prefix + wire.text.path, manifest ? { body } : body,
    { ...extra, headers: { "Idempotency-Key": "one-pixverse-job", "Ai-trace-id": "caller-trace", ...extra.headers } });
  f.read = (manifest = false, extra = {}) => f.call(
    manifest ? `/v1/proxy/pixverse/video?video_id=${id}` : prefix + readPath, null, extra);
  t.after(f.drain); return f;
}
async function json(response, status = 200) {
  const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text);
}

for (const model of ["v6", "c1"]) for (const manifest of [false, true]) test(`compiled PixVerse ${model} ${manifest ? "manifest" : "native"}: scoped lifecycle keeps original keys and fresh trace IDs`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  const catalog = await json(await f.call("/v1/catalog", null)), provider = catalog.providers.find(provider => provider.id === "pixverse");
  assert.equal(catalog.scope.credentialId, "fixture"); assert.ok(provider);
  assert.deepEqual(provider.models.map(model => model.id).sort(), ["pixverse/c1", "pixverse/v6"]);
  assert.ok(provider.offers.some(offer => offer.endpoint === "text_video" && offer.eligible)); assert.equal(f.sent.length, 0);
  const body = { ...wire.text.body, model };
  const response = await f.create(manifest, body); await json(response); const state = f.state(response);
  assert.deepEqual(await f.sent[0].clone().json(), body);
  assert.equal(f.sent[0].url, "https://app-api.pixverse.ai" + wire.text.path);
  assert.equal(state.job().managed.requestedVersion, model); assert.equal(state.job().event, null);
  assert.doesNotMatch(JSON.stringify(state.job()), /synthetic-original-key|Synthetic landscape|media\.example/);
  await json(await f.create(!manifest, { ...body, prompt: "changed" }), 409); assert.equal(f.sent.length, 1);
  f.restart(); await json(await f.read(!manifest)); assert.equal(state.job().managed.terminal, null);
  f.upstream = () => Response.json(observation(1)); await json(await f.read(manifest));
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
  const traces = f.sent.map(request => request.headers.get("ai-trace-id"));
  assert.equal(new Set(traces).size, f.sent.length);
  for (const [index, request] of f.sent.entries()) {
    assert.match(traces[index], /^[a-f0-9-]{36}$/); assert.notEqual(traces[index], "caller-trace");
    assert.equal(request.headers.get("api-key"), "synthetic-original-key"); assert.equal(request.headers.get("authorization"), null);
    assert.equal(new URL(request.url).origin, "https://app-api.pixverse.ai"); assert.equal(request.redirect, "manual");
  }
  assert.ok(f.sent.slice(1).every(request => new URL(request.url).pathname === readPath));
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].provider, "pixverse"); assert.equal(events[0].actual_cost_micros, 700);
  assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].total_tokens, null);
  assert.equal(state.job().phase, "complete"); assert.deepEqual(state.job().settlements, ["settled", "settled"]);
  const retry = await f.create(!manifest, body); assert.equal(retry.status, 303); assert.equal(retry.headers.get("location"), prefix + readPath);
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
});

for (const manifest of [false, true]) test(`compiled PixVerse ${manifest ? "manifest" : "native"}: unknown dollar tariff remains zero-egress`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: null });
  assert.equal((await json(await f.create(manifest), 400)).error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});

for (const manifest of [false, true]) test(`compiled PixVerse ${manifest ? "manifest" : "native"}: deleted observation freezes one charge without refund or further polls`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }), response = await f.create(manifest); await json(response); const state = f.state(response);
  f.upstream = () => Response.json(observation(4));
  assert.equal((await json(await f.read(!manifest), 410)).error.code, "prediction_observation_unavailable");
  assert.equal(state.job().managed.terminal, null); assert.equal(state.job().managed.observationUnavailable, "deleted");
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  assert.equal((await f.events()).length, 1); assert.equal(state.job().phase, "complete");
  assert.equal((await f.read()).status, 410); assert.equal((await f.create()).status, 410);
  f.advance(60 * 60_000); await state.alarm(); assert.equal(f.sent.length, 2);
});

test("compiled PixVerse raw IDs, foreign callers and rotated original credentials cannot control a job", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }); await json(await f.read(), 409); assert.equal(f.sent.length, 0);
  await json(await f.create()); f.restart();
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" },
    operation: "create", credentialId: "second", credential: f.credential });
  await json(await f.read(true, { headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } }), 409);
  await putGrantCredentials(f.env, grantKey, { provider: "pixverse", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
  assert.equal((await json(await f.read(), 503)).error.code, "response_owner_unavailable"); assert.equal(f.sent.length, 1);
});

test("compiled PixVerse does not activate upload, image creation or caller-supplied image authority", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  await json(await f.call(prefix + wire.upload.path, {}), 404);
  await json(await f.call(prefix + wire.image.path, wire.image.body), 404);
  await json(await f.create(true, { ...wire.text.body, img_id: 123 }), 400);
  assert.equal(f.sent.length, 0);
});

test("compiled PixVerse uncertain creation cannot replay or infer a credit refund", { timeout: 10_000 }, async t => {
  const f = await setup(t); f.upstream = () => { throw new Error("synthetic lost create reply"); };
  const response = await f.create(true), state = f.state(response); await json(response, 503);
  f.restart(); await json(await f.create(), 202); assert.equal(f.sent.length, 1);
  f.advance(60 * 60_000); await state.alarm(); await f.drain();
  assert.equal(state.job().managed.submission, "submission_unknown"); assert.equal(state.job().managed.terminal, null);
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
});
