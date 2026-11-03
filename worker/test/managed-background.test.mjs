import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
const { BackgroundStore, backgroundObservationMs, backgroundReplayMs } = await import("../background-store.ts");
const { ResponsesScopeStore } = await import("../responses-scope.ts");
const { createProxyAccounting } = await import("../proxy-accounting.ts");
const { planBudgetReservation } = await import("../accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { managedPredictionKey } = await import("../managed-prediction-identity.ts");
const { identityKey } = await import("../http-continuation.ts");
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const owner = { providerId: "replicate", endpointId: "predictions", grantKey: "oauth/fixture/replicate", lineage: "original-lineage", routeSha256: "a".repeat(64), policyGeneration: "g1" };
const auth = { policyId: "fixture", credentialId: "caller", principalId: null, authType: "proxy_key", policy: { monthlyBudgetMicros: 10_000, generation: "g1", requestCostMicros: 700 } };
const cost = { reserveMicros: 700, basis: "policy_fixed", inputTokens: null, outputTokens: null };

function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  let now = Date.parse("2026-11-03T00:00:00Z"), sequence = 0, scheduled = null;
  t.mock.method(Date, "now", () => now);
  const storage = {
    sql: { exec(query, ...bindings) { const stmt = db.prepare(query); if (stmt.columns().length) return stmt.all(...bindings); stmt.run(...bindings); return []; } },
    transactionSync(fn) { db.exec("BEGIN"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } },
    async getAlarm() { return scheduled; }, async setAlarm(value) { scheduled = value; }, async deleteAlarm() { scheduled = null; },
  };
  const budget = sqlBudgetNamespace(t), reserveCalls = [];
  const env = { BUDGET_LEDGER: { idFromName: name => name, get: name => ({ fetch(url, init) { reserveCalls.push(new URL(url).pathname); return budget.get(name).fetch(url, init); } }) } };
  let store = new BackgroundStore(storage.sql, id => storage.sql.exec("UPDATE http_continuations SET background_closed = 1 WHERE background_job_id = ?", id)), scope = new ResponsesScopeStore(storage, env);
  const admission = () => {
    const facts = createProxyAccounting({ env, context: {}, auth, cost, selection: { provider: { id: "replicate" }, model: null, capability: "image.generate", endpoint: { request_format: "replicate.prediction" }, body: { input: { prompt: "private-input-must-not-persist" } } }, request: correlateIngressRequest(new Request("https://router.example/v1/native/replicate/v1/predictions")).request }).facts;
    return { id: `bg_${(++sequence).toString(16).padStart(32, "0")}`, admittedAt: now, owner, facts,
      plan: planBudgetReservation(auth, "image.generate", cost, { providerId: "replicate", monthlyBudgetMicros: 10_000 }, now),
      route: { pathParams: {}, organization: null, project: null }, stream: false,
      managed: { protocol: "replicate.predictions", idempotencyKey: "b".repeat(64), requestDigest: "c".repeat(64), requestedVersion: "d".repeat(64) } };
  };
  return { db, storage, admission, reserveCalls, get store() { return store; },
    call: body => scope.fetch(new Request("https://scope/responses-background", { method: "POST", body: JSON.stringify(body) })),
    continuation: body => scope.continuation(new Request("https://scope/http-continuations", { method: "POST", body: JSON.stringify(body) })),
    restart() { store = new BackgroundStore(storage.sql, id => storage.sql.exec("UPDATE http_continuations SET background_closed = 1 WHERE background_job_id = ?", id)); scope = new ResponsesScopeStore(storage, env); }, advance(ms) { now += ms; } };
}
function dispatch(f, id) {
  const job = f.store.beginDispatch(id, null);
  for (let i = 0; i < job.legs.length; i++) { f.store.beginReserve(id, i); f.store.reserved(id, i, true); f.store.dispatched(id, i); }
  return f.store.beginEgress(id);
}
const outcome = () => ({ occurredAtMs: Date.now(), statusCode: 200, status: "success", billable: true, tokens: null, contentRef: null });

test("same scoped key admits one job and reservation plan across concurrent retries and restart", async t => {
  const f = fixture(t), first = f.admission(), second = f.admission();
  const results = await Promise.all([first, second].map(admission => f.call({ action: "managed_admit", admission }).then(response => response.json())));
  assert.deepEqual(results.map(value => value.created).sort(), [false, true]);
  assert.ok(results.every(value => value.job.id === first.id));
  assert.equal(f.reserveCalls.filter(path => path === "/reserve").length, 2);
  f.restart();
  const retry = await (await f.call({ action: "managed_admit", admission: f.admission() })).json();
  assert.equal(retry.created, false); assert.equal(retry.job.eventId, first.facts.event.id);
  assert.deepEqual(retry.job.legs.map(leg => leg.intent), first.plan.legs);
  assert.deepEqual(retry.job.owner, owner);
  assert.equal(retry.job.managed.requestedVersion, first.managed.requestedVersion);
  assert.equal(JSON.stringify(retry.job).includes("private-input-must-not-persist"), false);
  assert.equal(f.reserveCalls.filter(path => path === "/reserve").length, 2);
  const changed = f.admission(); changed.managed.requestDigest = "e".repeat(64);
  await assert.rejects(f.call({ action: "managed_admit", admission: changed }), error => error.code === "idempotency_conflict");
  const rotated = f.admission(); rotated.owner = { ...owner, policyGeneration: "g2" };
  await assert.rejects(f.call({ action: "managed_admit", admission: rotated }), error => error.code === "background_owner_changed");
  assert.equal(f.reserveCalls.filter(path => path === "/reserve").length, 2);
});

test("uncertain create persists before egress, cannot dispatch again and expires at the original fixed tariff", t => {
  const f = fixture(t), input = f.admission(); f.store.admitManaged(input);
  assert.throws(() => f.store.beginEgress(input.id));
  dispatch(f, input.id); f.restart();
  const unknown = f.store.get(input.id);
  assert.equal(unknown.managed.submission, "submission_unknown"); assert.equal(unknown.responseId, null);
  assert.throws(() => f.store.beginDispatch(input.id, null));
  assert.equal(f.store.admitManaged(f.admission()).created, false);
  assert.equal(f.store.nextDeadline(), input.admittedAt + backgroundObservationMs);
  f.advance(backgroundObservationMs); const [expired] = f.store.claim(Date.now());
  assert.equal(expired.managed.submission, "submission_unknown"); assert.equal(expired.managed.terminal, null);
  assert.equal(expired.event.actual_cost_micros, 700); assert.equal(expired.event.cost_basis, "policy_fixed");
  assert.equal(expired.lastError, "observation_expired"); assert.equal(expired.event.status_code, null);
});

test("prediction binding and collector identity commit atomically in a separate namespace", async t => {
  const f = fixture(t), input = f.admission(); f.store.admitManaged(input); dispatch(f, input.id);
  const upstreamId = "resp_shared", key = await managedPredictionKey(upstreamId);
  assert.notEqual(key, await identityKey({ kind: "response", value: upstreamId }));
  const binding = { action: "managed_bind", id: input.id, responseId: upstreamId };
  f.db.exec("CREATE TRIGGER reject_job_write BEFORE UPDATE ON responses_background BEGIN SELECT RAISE(ABORT, 'fixture storage refusal'); END");
  await assert.rejects(f.call(binding), /fixture storage refusal/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM http_continuations").get().n, 0);
  assert.equal(f.store.get(input.id).responseId, null);
  f.db.exec("DROP TRIGGER reject_job_write");
  assert.deepEqual(await (await f.call(binding)).json(), { bound: true }); f.restart();
  const row = f.db.prepare("SELECT * FROM http_continuations WHERE binding_key = ?").get(key);
  assert.equal(row.background_job_id, input.id); assert.deepEqual(JSON.parse(row.owner_json), owner);
  assert.equal(f.store.get(input.id).managed.submission, "bound");
  assert.equal(f.store.get(input.id).managed.upstreamId, upstreamId);
  assert.deepEqual(await (await f.call(binding)).json(), { bound: true }, "lost publication ACK retries the local commit only");
  await assert.rejects(f.call({ ...binding, responseId: "different" }), error => error.code === "background_identity_conflict");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM http_continuations").get().n, 1);
  const another = f.admission(); another.managed.idempotencyKey = null; f.store.admitManaged(another); dispatch(f, another.id);
  await assert.rejects(f.call({ ...binding, id: another.id }), error => error.code === "background_binding_conflict");
  assert.equal(f.store.get(another.id).responseId, null);
  await assert.rejects(f.call({ action: "identity", id: another.id, responseId: "unbound" }), error => error.code === "background_protocol_conflict");
});

for (const terminal of ["succeeded", "failed", "canceled", "aborted"]) test(`${terminal} freezes once; partial output and stale attempts never settle`, async t => {
  const f = fixture(t), input = f.admission(); f.store.admitManaged(input); dispatch(f, input.id);
  await f.call({ action: "managed_bind", id: input.id, responseId: "prediction_fixture" });
  for (const status of ["starting", "processing"]) f.store.observeManaged(input.id, "prediction_fixture", status, 200);
  assert.equal(f.store.get(input.id).event, null);
  f.advance(5000); const [claim] = f.store.claim(Date.now());
  f.store.observeManaged(input.id, "prediction_fixture", terminal, 200, claim.attempts - 1);
  assert.equal(f.store.get(input.id).event, null);
  assert.throws(() => f.store.observeManaged(input.id, "different", terminal, 200));
  f.store.observeManaged(input.id, "prediction_fixture", terminal, 200, claim.attempts);
  const frozen = f.store.get(input.id); assert.equal(frozen.event.actual_cost_micros, 700); assert.equal(frozen.event.cost_basis, "policy_fixed");
  assert.equal(frozen.managed.terminal, terminal); assert.equal(frozen.responseId, null);
  assert.equal(f.db.prepare("SELECT background_closed FROM http_continuations").get().background_closed, 1);
  f.store.observeManaged(input.id, "prediction_fixture", terminal === "succeeded" ? "canceled" : "succeeded", 200);
  f.restart(); assert.deepEqual(f.store.get(input.id).event, frozen.event);
  f.store.acknowledge(input.id, frozen.event.id, 0, "settled");
  f.store.acknowledge(input.id, frozen.event.id, 1, "unavailable");
  f.store.acknowledge(input.id, frozen.event.id, "usage", "stored");
  assert.equal(f.store.get(input.id).phase, "outbox");
  f.restart(); f.store.acknowledge(input.id, frozen.event.id, 1, "settled");
  const done = f.store.get(input.id); assert.equal(done.phase, "complete"); assert.deepEqual(done.managed, frozen.managed);
  assert.equal(f.store.admitManaged(f.admission()).job.id, input.id); assert.equal("facts" in done, false);
});

test("managed replay guards cannot be evicted by capacity before their fixed expiry", t => {
  const f = fixture(t);
  let first;
  for (let n = 0; n < 64; n++) {
    const input = f.admission(); input.managed.idempotencyKey = n.toString(16).padStart(64, "0"); input.plan = { reservedMicros: 0, legs: [] };
    first ??= input; f.store.admitManaged(input);
    const frozen = f.store.freeze(input.id, { ...outcome(), billable: false });
    f.store.acknowledge(input.id, frozen.event.id, "usage", "stored");
  }
  assert.equal(f.store.admitManaged(first).created, false);
  assert.throws(() => f.store.admitManaged(f.admission()), error => error.code === "background_capacity");
  f.advance(backgroundReplayMs); const next = f.admission(); next.managed.idempotencyKey = first.managed.idempotencyKey;
  assert.equal(f.store.admitManaged(next).created, true);
  assert.equal(f.store.get(first.id), null);
});

test("unknown prices, malformed metadata and raw idempotency keys fail before reservation", async t => {
  const f = fixture(t);
  const bad = [input => { input.facts.fixed = null; input.facts.cost = { ...cost, basis: "flat_fallback", reserveMicros: 1 }; },
    input => { input.managed.idempotencyKey = "raw-caller-key"; }, input => { input.managed.input = "private-input"; },
    input => { input.managed.requestedVersion = "x".repeat(257); }, input => { input.plan.reservedMicros = 1; }];
  for (const mutate of bad) { const input = f.admission(); mutate(input); await assert.rejects(f.call({ action: "managed_admit", admission: input })); }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM responses_background").get().n, 0);
  assert.deepEqual(f.reserveCalls, []);
  for (const id of ["", "../escape", "a".repeat(129), "query?x=1"]) assert.throws(() => managedPredictionKey(id));
});
