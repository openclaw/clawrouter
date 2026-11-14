import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { putGrantCredentials } = await import("../grant-credentials.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/vydra/jobs.json", import.meta.url)));
const prefix = "/v1/native/vydra", id = wire.submission.id;

// Real Worker/SQLite with the shipped Jobs declaration. The separate Models
// API and actual OpenClaw media consumers are not certified by this fixture.
async function setup(t, options = {}) {
  const f = await fixture(t, { ...options, providerId: "vydra", compiledProvider: true });
  f.env.VYDRA_API_KEY = "synthetic-environment-key";
  f.upstream = request => Response.json(request.method === "POST" ? wire.submission : wire.responses.partial,
    { status: request.method === "POST" ? 201 : 200 });
  f.create = (manifest = false, body = wire.request.body, extra = {}) => f.call(
    manifest ? "/v1/proxy/vydra/jobs" : prefix + wire.request.path, manifest ? { body } : body,
    { ...extra, headers: { "Idempotency-Key": "one-job", "x-api-key": "synthetic-caller-key", ...extra.headers } });
  f.read = (manifest = false, extra = {}) => f.call(
    manifest ? `/v1/proxy/vydra/job?job_id=${id}` : prefix + wire.read.path, null, extra);
  f.cancel = manifest => manifest
    ? f.call("/v1/proxy/vydra/cancel_job", { method: "DELETE", pathParams: { job_id: id }, body: {} })
    : f.call(prefix + wire.cancel.path, null, { method: "DELETE" });
  t.after(f.drain); return f;
}
async function json(response, status = 200) {
  const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text);
}

for (const manifest of [false, true]) test(`compiled Vydra ${manifest ? "manifest" : "native"}: catalog, immediate create output and terminal GET retain one durable settlement`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true });
  const catalog = await json(await f.call("/v1/catalog", null)), provider = catalog.providers.find(provider => provider.id === "vydra");
  assert.equal(catalog.scope.credentialId, "fixture"); assert.ok(provider); assert.deepEqual(provider.models, []);
  assert.ok(provider.offers.some(offer => offer.endpoint === "jobs" && offer.eligible && offer.modelId === null));
  assert.equal(f.sent.length, 0);
  f.upstream = () => Response.json({ ...wire.submission, status: "completed", output: wire.responses.completed.output }, { status: 201 });
  const response = await f.create(manifest), body = await json(response, 201), state = f.state(response);
  assert.equal(f.sent[0].url, "https://www.vydra.ai/api/v1/jobs");
  assert.deepEqual(await f.sent[0].clone().json(), wire.request.body);
  assert.equal(state.job().managed.requestedVersion, "generate_video"); assert.equal(state.job().managed.upstreamId, id);
  assert.equal(state.job().managed.terminal, null); assert.equal(state.job().event, null);
  assert.doesNotMatch(JSON.stringify(body), /untrusted\.example/);
  assert.doesNotMatch(JSON.stringify(state.job()), /synthetic-original-key|A synthetic blue square|media\.example/);
  await json(await f.create(!manifest, { ...wire.request.body, input: { prompt: "changed" } }), 409);
  assert.equal(f.sent.length, 1); f.restart();
  f.upstream = () => Response.json(wire.responses.partial); await json(await f.read(!manifest));
  assert.equal(state.job().managed.terminal, null);
  const terminal = structuredClone(wire.responses.completed); if (manifest) delete terminal.creditsCharged;
  f.upstream = () => Response.json(terminal); await json(await f.read(manifest));
  assert.equal(state.job().managed.terminal, "succeeded"); assert.equal(state.job().amount, 700);
  for (const request of f.sent) {
    assert.equal(new URL(request.url).origin, "https://www.vydra.ai");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(request.headers.get("x-api-key"), null); assert.equal(request.redirect, "manual");
  }
  assert.ok(f.sent.slice(1).every(request => new URL(request.url).pathname === wire.read.path));
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
  assert.equal(events[0].total_tokens, null); assert.equal(state.job().phase, "complete");
  assert.deepEqual(state.job().settlements, ["settled", "settled"]);
  const retry = await f.create(!manifest); assert.equal(retry.status, 303);
  assert.equal(retry.headers.get("location"), prefix + wire.read.path);
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
});

for (const manifest of [false, true]) test(`compiled Vydra ${manifest ? "manifest" : "native"}: unknown dollar conversion is zero-egress under hard budgets`, { timeout: 10_000 }, async t => {
  const f = await setup(t, { fixed: null });
  const body = await json(await f.create(manifest), 400); assert.equal(body.error.code, "pricing_required");
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0); assert.deepEqual(await f.events(), []);
});

for (const manifest of [false, true]) test(`compiled Vydra ${manifest ? "manifest" : "native"}: cancel/refund ACK requires original GET and cannot invent a dollar refund`, { timeout: 10_000 }, async t => {
  const f = await setup(t), response = await f.create(manifest), state = f.state(response); await json(response, 201);
  f.upstream = request => Response.json(request.method === "DELETE" ? wire.cancel.response : wire.responses.partial);
  await json(await f.cancel(manifest));
  assert.deepEqual(f.sent.map(request => request.method), ["POST", "GET", "DELETE", "GET"]);
  assert.equal(state.job().managed.terminal, null); assert.equal(state.job().event, null);
  f.upstream = () => Response.json(manifest ? wire.responses.cancelled : wire.responses.completed);
  await json(await f.read(!manifest));
  assert.equal(state.job().managed.terminal, manifest ? "canceled" : "succeeded");
  await state.alarm(); await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
  assert.equal(f.sent.filter(request => request.method === "DELETE").length, 1);
});

test("compiled Vydra raw IDs, foreign callers and rotated original grants cannot authorize control", { timeout: 10_000 }, async t => {
  const f = await setup(t, { pooled: true }); await json(await f.read(), 409); assert.equal(f.sent.length, 0);
  await json(await f.create(), 201); f.restart();
  await f.authority("/credentials/mutate", { scope: "admin", actor: { auth: "admin_token", email: "fixture@example.com", role: "admin" },
    operation: "create", credentialId: "second", credential: f.credential });
  await json(await f.read(true, { headers: { authorization: "Bearer clawrouter-live-second-fixture-secret" } }), 409);
  await putGrantCredentials(f.env, grantKey, { provider: "vydra", kind: "api_key", enabled: true, credential: "synthetic-replacement" });
  const denied = await json(await f.read(), 503); assert.equal(denied.error.code, "response_owner_unavailable");
  assert.equal(f.sent.length, 1);
});

for (const field of ["workflow", "workflowSlug"]) test(`compiled Vydra changed ${field} cannot settle another workflow`, { timeout: 10_000 }, async t => {
  const f = await setup(t), response = await f.create(), state = f.state(response); await json(response, 201);
  f.upstream = () => Response.json({ ...wire.responses.completed, [field]: "different_workflow" });
  const denied = await json(await f.read(), 503); assert.equal(denied.error.code, "response_owner_unavailable");
  assert.equal(state.job().managed.terminal, null); assert.equal(state.job().event, null);
  f.advance(60 * 60_000); await state.alarm(); await f.drain();
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
  assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
});

test("compiled Vydra uncertain create cannot replay or borrow a Models response identity", { timeout: 10_000 }, async t => {
  const f = await setup(t);
  await json(await f.call(prefix + "/api/v1/models/veo3", { prompt: "A paper boat" }), 404);
  assert.equal(f.sent.length, 0);
  f.upstream = () => { throw new Error("synthetic lost create reply"); };
  const response = await f.create(true), state = f.state(response); await json(response, 503);
  f.restart(); await json(await f.create(false), 202); assert.equal(f.sent.length, 1);
  f.advance(60 * 60_000); await state.alarm(); await f.drain();
  assert.equal(state.job().managed.submission, "submission_unknown"); assert.equal(state.job().managed.terminal, null);
  assert.equal(state.job().amount, 700); assert.equal(state.job().basis, "policy_fixed");
});
