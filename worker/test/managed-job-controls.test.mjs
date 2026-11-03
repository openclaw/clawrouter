import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture } from "./managed-runtime-fixture.mjs";
const { managedLifecycleAdapter } = await import("../managed-lifecycle-adapters.ts");
const { googleOmniVideoManagedAdapter: codec } = await import("../managed-google-omni.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google-omni/video.json", import.meta.url)));
const adapter = managedLifecycleAdapter("replicate.predictions"), path = "/v1/native/replicate/interactions";
const control = `${path}/${wire.pending.id}`;
const overrides = new WeakMap();
function override(t, name, value) {
  let originals = overrides.get(t);
  if (!originals) {
    originals = new Map(); overrides.set(t, originals);
    t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(adapter, key, descriptor); else delete adapter[key]; } });
  }
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(adapter, name));
  Object.defineProperty(adapter, name, { configurable: true, writable: true, value });
}
async function setup(t, options = {}) {
  // Exercise the actual source codec through the existing registered controller;
  // this seam does not activate a Google declaration or registry entry.
  const f = await fixture(t, { ...options, configure(provider) {
    const create = provider.endpoints.find(e => e.id === "predictions"), get = provider.endpoints.find(e => e.id === "prediction"), cancel = provider.endpoints.find(e => e.id === "prediction_cancel");
    create.path = "/interactions";
    for (const [endpoint, suffix] of [[get, ""], [cancel, "/cancel"]]) {
      endpoint.path = "/interactions/${interaction_id}" + suffix; endpoint.path_params = ["interaction_id"]; endpoint.path_param_styles = {};
    }
    provider.base_urls = { default: "https://generativelanguage.googleapis.com/v1beta" };
  } });
  for (const key of ["prepare", "identify", "validateId", "control", "read", "rewrite"]) override(t, key, codec[key]);
  override(t, "retainedParams", ["background", "store"]);
  override(t, "allowedControls", params => {
    assert.ok(["true", "false"].includes(params.background) && ["true", "false"].includes(params.store));
    assert.ok(params.background !== "true" || params.store === "true");
    return params.store !== "true" ? [] : params.background === "true" ? ["retrieve", "cancel"] : ["retrieve"];
  });
  f.upstream = () => Response.json(wire.retrieved);
  return f;
}
const body = flags => ({ ...wire.requests[0], ...flags });

for (const pooled of [false, true]) test(`unary/no-store completes once without advertising or dispatching controls (${pooled ? "pooled" : "environment"})`, async t => {
  const f = await setup(t, { pooled }), input = body({ background: false, store: false });
  const created = await f.call(path, input, { headers: { "Idempotency-Key": "unary-job" } });
  assert.equal(created.status, 200, await created.clone().text()); const state = f.state(created);
  assert.deepEqual(state.job().managed.route.pathParams, { background: "false", store: "false" });
  assert.deepEqual(await f.sent[0].json(), { ...input, background: false, store: false, stream: false });
  assert.equal(f.sent[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  for (const [route, method] of [[control, "GET"], [control + "/cancel", "POST"]]) assert.equal((await f.call(route, null, { method })).status, 409);
  const again = await f.call(path, input, { headers: { "Idempotency-Key": "unary-job" } });
  assert.equal(again.status, 202); assert.equal(again.headers.get("location"), null);
  f.restart(); f.advance(5000); await state.alarm(); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal((await f.events()).length, 1); assert.equal(state.job().amount, 700);
});

test("stored unary allows GET but rejects cancel before preflight; caller flags cannot promote it", async t => {
  const f = await setup(t, { pooled: true });
  const created = await f.call(path, body({ background: false, store: true })); assert.equal(created.status, 200, await created.clone().text());
  assert.equal((await f.call(control, null)).status, 200);
  const canceled = await f.call(control + "/cancel", null, { method: "POST" }); assert.equal(canceled.status, 409);
  assert.equal((await f.call(control + "/cancel?background=true&store=true", null, { method: "POST" })).status, 400);
  assert.equal(f.sent.length, 2); assert.ok(f.sent.every(request => request.headers.get("authorization") === "Bearer synthetic-original-key"));
});

test("background flags survive restart and original-credential cancellation settles once", async t => {
  const f = await setup(t, { pooled: true });
  f.upstream = request => Response.json(request.url.endsWith("/cancel") ? { ...wire.pending, status: "cancelled" } : wire.pending);
  const created = await f.call(path, body({ background: true, store: true })); assert.equal(created.status, 200, await created.clone().text()); const state = f.state(created);
  f.restart(); const canceled = await f.call(control + "/cancel", null, { method: "POST" });
  assert.equal(canceled.status, 200, await canceled.clone().text()); assert.equal((await canceled.json()).status, "cancelled");
  assert.deepEqual(f.sent.map(request => request.method), ["POST", "GET", "POST"]);
  assert.equal(state.job().managed.terminal, "canceled"); assert.equal(state.job().amount, 700);
  assert.ok(f.sent.every(request => request.headers.get("authorization") === "Bearer synthetic-original-key"));
  f.loseUsageAck(); await state.alarm(); f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  assert.equal((await f.events()).length, 1); assert.deepEqual(state.job().settlements, ["settled", "settled"]);
});

for (const status of ["requires_action", "requires_continuation", "incomplete"]) for (const source of ["create", "collector", "cancel"]) test(`${status} during ${source} freezes uncertainty without replay, cancel or an hour of polls`, async t => {
  const f = await setup(t), uncertain = { ...wire.pending, status };
  f.upstream = request => Response.json(source === "create" || request.method === "GET" ? uncertain : wire.pending);
  f.loseUsageAck();
  const input = body({ background: true, store: true });
  const created = await f.call(path, input, { headers: { "Idempotency-Key": "one-uncertain-job" } });
  assert.equal(created.status, source === "create" ? 410 : 200, await created.clone().text()); const state = f.state(created);
  if (source === "collector") { f.advance(5000); await state.alarm(); }
  if (source === "cancel") assert.equal((await f.call(control + "/cancel", null, { method: "POST" })).status, 410);
  assert.equal(state.job().managed.observationUnavailable, "expired_or_unknown"); assert.equal(state.job().managed.terminal, null);
  f.restart(); f.advance(30_000); await state.alarm(); await f.drain();
  const events = await f.events(); assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 700); assert.equal(events[0].cost_basis, "policy_fixed");
  assert.equal((await f.call(path, input, { headers: { "Idempotency-Key": "one-uncertain-job" } })).status, 410);
  assert.equal((await f.call(control, null)).status, 410);
  f.advance(60 * 60_000); await state.alarm();
  assert.equal(f.sent.length, source === "create" ? 1 : 2); assert.equal(f.sent.filter(request => request.method === "POST").length, 1);
});

test("changing retained flags or adapter control permissions cannot reuse an existing route pin", async t => {
  const f = await setup(t), created = await f.call(path, body({ background: false, store: true }));
  assert.equal(created.status, 200); const state = f.state(created);
  const job = state.job(); job.managed.route.pathParams.background = "true";
  state.state.db.prepare("UPDATE responses_background SET job_json = ? WHERE job_id = ?").run(JSON.stringify(job), state.id);
  const canceled = await f.call(control + "/cancel", null, { method: "POST" }); assert.ok([409, 503].includes(canceled.status));
  assert.equal(f.sent.length, 1);
});

for (const actions of [["cancel"], ["retrieve", "retrieve"], ["result"], ["download"], Promise.resolve(["retrieve"])]) test(`invalid per-job controls fail before admission: ${String(actions)}`, async t => {
  const f = await setup(t); override(t, "allowedControls", () => actions);
  const response = await f.call(path, body({ background: false, store: true })); assert.equal(response.status, 400);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});

for (const scenario of ["undeclared", "missing", "oversized", "mutating"]) test(`retained flags reject ${scenario} adapter state before reservation`, async t => {
  const f = await setup(t), prepare = adapter.prepare;
  if (scenario === "mutating") override(t, "allowedControls", params => { params.background = "true"; return ["retrieve", "cancel"]; });
  else override(t, "prepare", (...args) => {
    const result = prepare(...args);
    if (scenario === "undeclared") result.pathParams.other_job = "unowned";
    if (scenario === "missing") delete result.pathParams.store;
    if (scenario === "oversized") result.pathParams.store = "a".repeat(1025);
    return result;
  });
  const response = await f.call(path, body({ background: false, store: true })); assert.equal(response.status, 400);
  assert.equal(f.sent.length, 0); assert.equal(f.budgetCalls.length, 0);
});
