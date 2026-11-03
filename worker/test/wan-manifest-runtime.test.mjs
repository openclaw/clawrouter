import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/wan/lifecycle.json", import.meta.url)));
const prefix = "/v1/native/alibaba", id = wire.create.response.output.task_id;
const readPath = wire.retrieve.path.replace("${task_id}", id);

// The shipped declaration runs through the real Worker and SQLite owners.
// Actual OpenClaw video consumers and input-asset modes remain separate proof.
async function setup(t, options = {}) {
  const f = await fixture(t, { ...options, providerId: "alibaba", compiledProvider: true });
  f.env.MODELSTUDIO_API_KEY = "synthetic-standard-key";
  f.env.QWEN_API_KEY = "must-not-borrow";
  f.env.DASHSCOPE_API_KEY = "must-not-borrow";
  f.upstream = request => Response.json(request.method === "POST" ? wire.create.response : observation(0));
  f.create = (manifest = false, body = wire.create.body, extra = {}) => f.call(
    manifest ? "/v1/proxy/alibaba/video" : prefix + wire.create.path, manifest ? { body } : body,
    { ...extra, headers: { "Idempotency-Key": "one-wan-job", "x-api-key": "must-not-forward", ...extra.headers } });
  f.read = (manifest = false, extra = {}) => f.call(
    manifest ? `/v1/proxy/alibaba/task?task_id=${id}` : prefix + readPath, null, extra);
  t.after(f.drain); return f;
}
const observation = index => ({ output: { task_id: id, ...wire.observations[index].native } });
async function json(response, status = 200) {
  const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text);
}

for (const manifest of [false, true]) test(`compiled Wan ${manifest ? "manifest" : "native"}: catalog to original task survives restart and settles once`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  const catalog = await json(await f.call("/v1/catalog", null));
  const provider = catalog.providers.find(provider => provider.id === "alibaba");
  assert.equal(catalog.scope.credentialId, "fixture"); assert.ok(provider);
  assert.deepEqual(provider.models.map(model => model.id), ["alibaba/wan2.6-t2v"]);
  assert.ok(provider.offers.some(offer => offer.endpoint === "video" && offer.eligible));
  assert.equal(f.sent.length, 0);
  const response = await f.create(manifest); await json(response); const state = f.state(response);
  assert.equal(f.sent[0].url, "https://dashscope-intl.aliyuncs.com" + wire.create.path);
  assert.equal(f.sent[0].headers.get("x-dashscope-async"), "enable");
  assert.deepEqual(await f.sent[0].clone().json(), wire.create.body);
  assert.equal(state.job().managed.requestedVersion, "wan2.6-t2v");
  assert.equal(state.job().managed.upstreamId, id); assert.equal(state.job().event, null);
  assert.doesNotMatch(JSON.stringify(state.job()), /synthetic-original-key|Synthetic quiet landscape|media\.example/);
  await json(await f.create(!manifest, { ...wire.create.body, input: { prompt: "changed" } }), 409);
  assert.equal(f.sent.length, 1); f.restart();
  await json(await f.read(!manifest)); assert.equal(state.job().managed.terminal, null);
  f.upstream = () => Response.json(observation(1)); await json(await f.read(manifest));
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
  for (const request of f.sent) {
    assert.equal(new URL(request.url).origin, "https://dashscope-intl.aliyuncs.com");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.redirect, "manual");
  }
  assert.ok(f.sent.slice(1).every(request => new URL(request.url).pathname === readPath));
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].provider, "alibaba"); assert.equal(events[0].actual_cost_micros, 700);
  assert.equal(events[0].cost_basis, "policy_fixed"); assert.equal(events[0].total_tokens, null);
  assert.equal(state.job().phase, "complete"); assert.deepEqual(state.job().settlements, ["settled", "settled"]);
  const retry = await f.create(!manifest); assert.equal(retry.status, 303);
  assert.equal(retry.headers.get("location"), prefix + readPath);
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
});

for (const manifest of [false, true]) test(`compiled Wan ${manifest ? "manifest" : "native"}: unknown tariffs reject hard-dollar admission with zero egress`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: null });
  assert.equal((await json(await f.create(manifest), 400)).error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});

for (const manifest of [false, true]) test(`compiled Wan ${manifest ? "manifest" : "native"}: UNKNOWN freezes observation loss without refund, polling or replay`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }), response = await f.create(manifest); await json(response); const state = f.state(response);
  f.upstream = () => Response.json(observation(4));
  assert.equal((await json(await f.read(!manifest), 410)).error.code, "prediction_observation_unavailable");
  assert.equal(state.job().managed.terminal, null); assert.equal(state.job().managed.observationUnavailable, "expired_or_unknown");
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  assert.equal((await f.events()).length, 1); assert.equal(state.job().phase, "complete");
  assert.equal((await f.read()).status, 410); assert.equal((await f.create()).status, 410);
  f.advance(60 * 60_000); await state.alarm(); assert.equal(f.sent.length, 2);
});

test("compiled Wan raw task IDs, foreign callers and rotated original grants cannot authorize reads", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }); await json(await f.read(), 409); assert.equal(f.sent.length, 0);
  await json(await f.create()); f.restart();
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" },
    operation: "create", credentialId: "second", credential: f.credential });
  await json(await f.read(true, { headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } }), 409);
  await putGrantCredentials(f.env, grantKey, { provider: "alibaba", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
  assert.equal((await json(await f.read(), 503)).error.code, "response_owner_unavailable");
  assert.equal(f.sent.length, 1);
});

test("compiled Wan rejects Coding Plan credentials and unbound input assets before dispatch", { timeout: 10_000 }, async t => {
  const f = await setup(t); f.env.MODELSTUDIO_API_KEY = "sk-sp-synthetic-plan";
  assert.equal((await json(await f.create(), 503)).error.code, "managed_dispatch_unavailable");
  assert.equal(f.sent.length, 0); f.env.MODELSTUDIO_API_KEY = "synthetic-standard-key";
  for (const manifest of [false, true]) {
    const body = { model: "wan2.6-i2v", input: { prompt: "synthetic", img_url: "data:image/png;base64,AAAA" } };
    const response = await f.create(manifest, body, { headers: { "Idempotency-Key": "asset-" + manifest } });
    assert.ok([400, 403].includes(response.status), await response.text());
  }
  assert.equal(f.sent.length, 0);
});

test("compiled Wan uncertain creation is never replayed and cannot imply a free request", { timeout: 10_000 }, async t => {
  const f = await setup(t); f.upstream = () => { throw new Error("synthetic lost create reply"); };
  const response = await f.create(true), state = f.state(response); await json(response, 503);
  f.restart(); await json(await f.create(), 202); assert.equal(f.sent.length, 1);
  f.advance(60 * 60_000); await state.alarm(); await f.drain();
  assert.equal(state.job().managed.submission, "submission_unknown"); assert.equal(state.job().managed.terminal, null);
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
});
