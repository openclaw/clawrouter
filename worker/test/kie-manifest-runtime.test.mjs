import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/kie/jobs.json", import.meta.url)));
const prefix = "/v1/native/kie", id = wire.submission.data.taskId;

// No synthesized endpoints, model lookup or input remapping: use the shipped
// Market declaration and deterministic upstream fixtures through Worker/SQLite.
async function setup(t, options = {}) {
  const f = await fixture(t, { ...options, providerId: "kie", compiledProvider: true });
  f.env.KIE_API_KEY = "synthetic-environment-key";
  f.upstream = request => Response.json(request.method === "POST" ? wire.submission : wire.responses.partial);
  f.create = (manifest = false, body = wire.request.body, extra = {}) => f.call(
    manifest ? "/v1/proxy/kie/create_task" : prefix + wire.request.path,
    manifest ? { body } : body,
    { ...extra, headers: { "Idempotency-Key": "one-job", "x-api-key": "synthetic-caller-key", ...extra.headers } });
  f.read = (manifest = false, extra = {}) => f.call(
    manifest ? `/v1/proxy/kie/record_info?taskId=${id}` : prefix + wire.read.path, null, extra);
  t.after(f.drain); return f;
}
async function json(response, status = 200) {
  const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text);
}

for (const manifest of [false, true]) test(`compiled Kie ${manifest ? "manifest" : "native"}: catalog-selected Market input, partial output and durable settlement retain native identity`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  const catalog = await json(await f.call("/v1/catalog", null)), provider = catalog.providers.find(provider => provider.id === "kie");
  assert.equal(catalog.scope.credentialId, "fixture"); assert.ok(provider); assert.deepEqual(provider.models, []);
  assert.ok(provider.offers.some(offer => offer.endpoint === "create_task" && offer.eligible && offer.modelId === null));
  assert.equal(f.sent.length, 0);
  const response = await f.create(manifest), state = f.state(response); await json(response);
  assert.equal(f.sent[0].url, "https://api.kie.ai/api/v1/jobs/createTask");
  assert.deepEqual(await f.sent[0].clone().json(), wire.request.body);
  assert.equal(state.job().managed.requestedVersion, "kling-2.6/text-to-video");
  assert.equal(state.job().managed.upstreamId, id);
  assert.doesNotMatch(JSON.stringify(state.job()), /synthetic-original-key|A synthetic blue square/);
  await json(await f.create(!manifest, { ...wire.request.body, input: { ...wire.request.body.input, duration: "10" } }), 409);
  assert.equal(f.sent.length, 1); f.restart();
  const partial = await json(await f.read(!manifest)); assert.equal(partial.data.state, "generating");
  assert.equal(state.job().managed.terminal, null); assert.equal(state.job().event, null);
  const terminal = structuredClone(wire.responses.success);
  if (manifest) { delete terminal.data.model; delete terminal.data.creditsConsumed; }
  f.upstream = () => Response.json(terminal); await json(await f.read(manifest));
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
  for (const request of f.sent) {
    assert.equal(new URL(request.url).origin, "https://api.kie.ai");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.redirect, "manual");
  }
  assert.ok(f.sent.slice(1).every(request => new URL(request.url).search === `?taskId=${id}`));
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
  assert.equal(events[0].total_tokens, null); assert.equal(state.job().phase, "complete");
  assert.deepEqual(state.job().settlements, ["settled", "settled"]);
  const retry = await f.create(!manifest); assert.equal(retry.status, 303);
  assert.equal(retry.headers.get("location"), prefix + wire.read.path);
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
});

for (const manifest of [false, true]) test(`compiled Kie ${manifest ? "manifest" : "native"}: unknown whole-job price is zero-egress under hard budgets`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: null });
  const body = await json(await f.create(manifest), 400); assert.equal(body.error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});

test("compiled Kie original caller, query and grant binding cannot become raw-ID access or cancellation", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  await json(await f.read(), 409); assert.equal(f.sent.length, 0); await json(await f.create()); f.restart();
  for (const suffix of ["&taskId=other", "&model=other", "&callback=other"]) {
    await json(await f.call(prefix + wire.read.path + suffix, null), 400);
  }
  await json(await f.call(prefix + wire.read.path, null, { method: "DELETE" }), 405);
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" },
    operation: "create", credentialId: "second", credential: f.credential });
  await json(await f.read(true, { headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } }), 409);
  await putGrantCredentials(f.env, grantKey, { provider: "kie", kind: "api_key", enabled: true, credential: "synthetic-rotated-key" });
  const denied = await json(await f.read(), 503); assert.equal(denied.error.code, "response_owner_unavailable");
  assert.equal(f.sent.length, 1);
});

for (const invalid of ["authError", "foreignModel"]) test(`compiled Kie ${invalid} observation cannot settle a false success or authorize replay`, { timeout: 10_000 }, async t => {
  const f = await setup(t), response = await f.create(), state = f.state(response); await json(response);
  f.upstream = () => Response.json(invalid === "authError" ? wire.responses.authError
    : { ...wire.responses.success, data: { ...wire.responses.success.data, model: "foreign/model" } });
  const denied = await json(await f.read(), 503); assert.equal(denied.error.code, "response_owner_unavailable");
  assert.equal(state.job().managed.terminal, null); assert.equal(state.job().event, null);
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
  f.advance(60 * 60_000); await state.alarm(); await f.drain();
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
});

test("compiled Kie uncertain create cannot replay after restart or turn native credits into dollars", { timeout: 10_000 }, async t => {
  const f = await setup(t); f.upstream = () => { throw new Error("synthetic lost submit reply"); };
  const response = await f.create(true), state = f.state(response); await json(response, 503);
  f.restart(); await json(await f.create(false), 202); assert.equal(f.sent.length, 1);
  f.advance(60 * 60_000); await state.alarm(); await f.drain();
  assert.equal(state.job().managed.submission, "submission_unknown"); assert.equal(state.job().managed.terminal, null);
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
});

test("compiled Kie rejects unqualified defaults, unowned images and callback/native-type substitutions before egress", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  for (const body of [
    { model: "bytedance/seedance-1.5-pro", input: { prompt: "A paper boat", duration: 5 } },
    { model: "kling-2.6/image-to-video", input: { prompt: "A paper boat", image_url: "https://assets.example/unowned.png" } },
    { ...wire.request.body, callBackUrl: "https://other.example/callback" },
    { ...wire.request.body, input: { ...wire.request.body.input, duration: 5 } },
    { ...wire.request.body, input: { ...wire.request.body.input, sound: "false" } },
  ]) await json(await f.create(true, body), 400);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});
