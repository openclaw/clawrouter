import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/queue-lifecycle.json", import.meta.url)));
const prefix = "/v1/native/fal", params = { owner: "fal-ai", app: "flux", variant: "schnell" };
const controls = { owner: params.owner, app: params.app, request_id: wire.requestId };

// Consume the shipped declaration without synthesizing endpoints or auth.
// These are deterministic Worker/SQLite tests, not client or live-provider proof.
async function setup(t, options = {}) {
  const f = await fixture(t, { ...options, providerId: "fal", compiledProvider: true });
  f.env.FAL_KEY = "synthetic-fal-environment";
  f.env.FAL_API_KEY = "synthetic-wrong-alias";
  f.upstream = request => Response.json(request.method === "POST" ? wire.observations.queued : wire.observations.running);
  f.create = (manifest = false, body = wire.submit.body, extra = {}) => f.call(
    manifest ? "/v1/proxy/fal/queue" : prefix + wire.submit.path,
    manifest ? { body, pathParams: params } : body,
    { ...extra, headers: { "Idempotency-Key": "one-job", "x-api-key": "synthetic-caller-key", ...extra.headers } });
  f.control = (action = "status", manifest = false, extra = {}) => action === "cancel" && manifest
    ? f.call("/v1/proxy/fal/queue_cancel", { method: "PUT", body: {}, pathParams: controls }, extra)
    : f.call(
    manifest ? `/v1/proxy/fal/queue_${action}?${new URLSearchParams(controls)}` : prefix + wire.controls[action].path,
    null, { method: action === "cancel" ? "PUT" : "GET", ...extra });
  t.after(f.drain);
  return f;
}

async function json(response, status = 200) {
  const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text);
}

for (const manifest of [false, true]) test(`compiled fal ${manifest ? "manifest" : "native"}: catalog, owned lifecycle and lost settlement ACK preserve one request`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  const catalog = await json(await f.call("/v1/catalog", null));
  assert.equal(catalog.scope.credentialId, "fixture");
  const provider = catalog.providers.find(provider => provider.id === "fal");
  assert.ok(provider); assert.deepEqual(provider.models, []);
  assert.ok(provider.offers.some(offer => offer.endpoint === "queue" && offer.eligible && offer.modelId === null));
  assert.doesNotMatch(JSON.stringify(catalog), /synthetic-(?:original-key|fal-environment|wrong-alias)/);
  assert.equal(f.sent.length, 0);

  const created = await f.create(manifest), body = await json(created), state = f.state(created);
  assert.equal(body.status_url, prefix + wire.controls.status.path);
  assert.equal(body.response_url, prefix + wire.controls.result.path);
  assert.equal(body.cancel_url, prefix + wire.controls.cancel.path);
  assert.deepEqual(await f.sent[0].clone().json(), wire.submit.body);
  assert.equal(state.job().managed.providerId, "fal");
  assert.equal(state.job().managed.upstreamId, wire.requestId);
  assert.equal(state.job().event, null);
  assert.doesNotMatch(JSON.stringify(state.job()), /synthetic-original-key|A synthetic blue square/);
  await json(await f.create(!manifest, { ...wire.submit.body, num_images: 2 }), 409);
  assert.equal(f.sent.length, 1);
  f.restart(); await json(await f.control("status", !manifest));
  assert.equal(state.job().managed.terminal, null);
  f.upstream = request => Response.json(request.url.endsWith("/status") ? wire.observations.completed : wire.results.success.body);
  await json(await f.control("status", manifest));
  assert.equal(state.job().managed.terminal, "succeeded");
  assert.deepEqual(f.sent.map(request => new URL(request.url).pathname),
    [wire.submit.path, wire.controls.status.path, wire.controls.status.path, wire.controls.result.path]);
  for (const request of f.sent) {
    assert.equal(new URL(request.url).origin, "https://queue.fal.run");
    assert.equal(request.headers.get("authorization"), "Key synthetic-original-key");
    assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.redirect, "manual");
  }
  assert.equal(f.sent[0].headers.get("x-fal-no-retry"), "1");
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
  assert.equal(events[0].total_tokens, null); assert.equal(state.job().phase, "complete");
  assert.deepEqual(state.job().settlements, ["settled", "settled"]);
  const retry = await f.create(!manifest); assert.equal(retry.status, 303);
  assert.equal(retry.headers.get("location"), prefix + wire.controls.status.path);
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
  assert.equal(f.budgetCalls.filter(call => call.path === "/reserve").length, 2);
});

test("compiled fal caller, path and original credential boundaries deny controls before egress", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  await json(await f.control(), 409); assert.equal(f.sent.length, 0);
  await json(await f.create()); f.restart();
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" },
    operation: "create", credentialId: "second", credential: f.credential });
  await json(await f.control("status", true, { headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } }), 409);
  await json(await f.call((prefix + wire.controls.status.path).replace("/flux/", "/other/"), null), 409);
  assert.equal(f.sent.length, 1);
  await putGrantCredentials(f.env, grantKey, { provider: "fal", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
  const denied = await json(await f.control(), 503);
  assert.equal(denied.error.code, "response_owner_unavailable");
  assert.equal(f.sent.length, 1); assert.deepEqual(await f.events(), []);
});

for (const manifest of [false, true]) test(`compiled fal ${manifest ? "manifest" : "native"}: unknown whole-job price rejects hard budgets with zero egress`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: null });
  const body = await json(await f.create(manifest), 400);
  assert.equal(body.error.code, "pricing_required"); assert.equal(f.sent.length, 0);
  assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});

test("compiled fal cancellation follows original reads and cannot turn a terminal result error into free generation", { timeout: 10_000 }, async t => {
  const f = await setup(t), response = await f.create(), state = f.state(response); await json(response);
  let canceled = false;
  f.upstream = request => {
    if (request.method === "PUT") { canceled = true; return Response.json({ status: "CANCELLATION_REQUESTED" }, { status: 202 }); }
    return request.url.endsWith("/status") ? Response.json(canceled ? wire.observations.completed : wire.observations.running)
      : Response.json(wire.results.failed.body, { status: 422 });
  };
  await json(await f.control("cancel", true), 202);
  assert.deepEqual(f.sent.map(request => request.method), ["POST", "GET", "PUT", "GET", "GET"]);
  assert.ok(f.sent.every(request => request.headers.get("authorization") === "Key synthetic-fal-environment"));
  assert.equal(state.job().managed.terminal, "failed"); assert.equal(state.job().amount, 700);
  await state.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
});

test("compiled fal uncertain submission survives restart without replay or fabricated usage", { timeout: 10_000 }, async t => {
  const f = await setup(t); f.upstream = () => { throw new Error("synthetic lost submission response"); };
  const response = await f.create(true), state = f.state(response); await json(response, 503);
  f.restart(); await json(await f.create(false), 202); assert.equal(f.sent.length, 1);
  f.advance(60 * 60_000); await state.alarm(); await f.drain();
  assert.equal(state.job().managed.submission, "submission_unknown"); assert.equal(state.job().managed.terminal, null);
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
});

test("compiled fal keeps unqualified quality, deep paths and non-prompt MiniMax inputs closed", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  for (const [pathParams, body] of [
    [{ owner: "xai", app: "grok-imagine-image", variant: "quality" }, { prompt: "A paper boat" }],
    [{ owner: "fal-ai", app: "minimax", variant: "video-01-live" }, { prompt: "A paper boat", image_url: "https://assets.example/input.png" }],
    [{ owner: "fal-ai", app: "kling-video", variant: "v2.1/master/text-to-video" }, { prompt: "A paper boat" }],
  ]) await json(await f.call("/v1/proxy/fal/queue", { body, pathParams }), 400);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});

for (const manifest of [false, true]) test(`compiled fal ${manifest ? "manifest" : "native"}: frozen MiniMax prompt-only input reaches its exact selected route`, { timeout: 10_000 }, async t => {
  const f = await setup(t), pathParams = { owner: "fal-ai", app: "minimax", variant: "video-01-live" };
  const body = { prompt: "A paper boat on a quiet pond" };
  const response = await f.call(manifest ? "/v1/proxy/fal/queue" : prefix + "/fal-ai/minimax/video-01-live",
    manifest ? { body, pathParams } : body);
  const output = await json(response), state = f.state(response);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, "https://queue.fal.run/fal-ai/minimax/video-01-live");
  assert.deepEqual(await f.sent[0].clone().json(), body);
  assert.equal(state.job().managed.requestedVersion, "fal-ai/minimax/video-01-live");
  assert.equal(output.status_url, `${prefix}/fal-ai/minimax/requests/${wire.requestId}/status`);
  assert.doesNotMatch(JSON.stringify(state.job()), /paper boat/);
});
