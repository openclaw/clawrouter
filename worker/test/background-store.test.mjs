import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { planBudgetReservation } from "../accounting.ts";
const { BackgroundStore, backgroundObservationMs, backgroundAutoRetryMs, backgroundReplayMs } = await import("../background-store.ts");
const { createProxyAccounting } = await import("../proxy-accounting.ts");

const owner = { providerId: "fixture", endpointId: "create", grantKey: "oauth/fixture/key", lineage: "lineage", routeSha256: "a".repeat(64), policyGeneration: "generation" };
const auth = { policyId: "policy", credentialId: "key", principalId: null, authType: "proxy_key", policy: { monthlyBudgetMicros: 500, generation: "generation" } };
const cost = { reserveMicros: 100, basis: "manifest_pricing", inputTokens: 40, outputTokens: 60 };

function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  let now = Date.parse("2026-09-25T00:00:00Z"); t.mock.method(Date, "now", () => now);
  const sql = { exec(query, ...bindings) { const statement = db.prepare(query); if (statement.columns().length) return statement.all(...bindings); statement.run(...bindings); return []; } };
  let store = new BackgroundStore(sql), sequence = 0;
  const admission = () => {
    const facts = createProxyAccounting({ env: {}, context: {}, auth, cost, selection: { provider: { id: "fixture" }, model: null, capability: "llm.responses", endpoint: { request_format: "openai.responses" }, body: {} }, request: new Request("https://router.example/v1/responses", { headers: { "x-request-id": "fixture-request" } }) }).facts;
    return { id: `bg_${(++sequence).toString(16).padStart(32, "0")}`, admittedAt: now, owner, facts, plan: planBudgetReservation(auth, "llm.responses", cost, { providerId: "fixture", monthlyBudgetMicros: 500 }, now), route: { pathParams: {}, organization: "fixture-org", project: "fixture-project" }, stream: true };
  };
  return { db, get store() { return store; }, admission, restart() { store = new BackgroundStore(sql); }, advance(ms) { now += ms; } };
}

function dispatch(f, id) {
  for (let i = 0; i < 2; i++) { f.store.beginReserve(id, i); f.store.reserved(id, i, true); f.store.dispatched(id, i); }
  return f.store.beginEgress(id);
}
const outcome = () => ({ occurredAtMs: Date.now(), statusCode: 200, status: "success", billable: true, tokens: null, contentRef: null });

test("collection cadence preserves monotonic claims and stale retries cannot shorten a reconstructed outbox", t => {
  const f = fixture(t), input = f.admission(); f.store.admit(input); dispatch(f, input.id); f.store.identity(input.id, "response-fixture");
  for (let n = 1; n <= 12; n++) {
    f.advance(5_000); const [claim] = f.store.claim(Date.now()); assert.equal(claim.attempts, n);
    f.store.retry(input.id, null, n); assert.equal(f.store.nextDeadline(), Date.now() + 5_000);
  }
  f.restart(); f.advance(5_000); const [old] = f.store.claim(Date.now());
  f.store.retry(input.id, "observation_unavailable", old.attempts);
  assert.equal(f.store.nextDeadline(), Date.now() + 30_000);
  f.advance(30_000); const [fresh] = f.store.claim(Date.now());
  const frozen = f.store.freeze(input.id, outcome()); f.store.retry(input.id, "accounting_unavailable", fresh.attempts);
  f.restart(); const current = f.store.get(input.id);
  assert.equal(current.nextAttemptAt, Date.now() + 3_600_000);
  f.store.retry(input.id, null, old.attempts);
  assert.deepEqual(f.store.get(input.id), current); assert.deepEqual(current.event, frozen.event);
  assert.deepEqual(current.legs.map(leg => leg.intent), input.plan.legs);
});

test("original intent and each acknowledgement survive reconstruction before any egress permission", t => {
  const f = fixture(t), input = f.admission(); f.store.admit(input);
  assert.deepEqual(f.store.beginReserve(input.id, 0), input.plan.legs[0]); f.restart();
  assert.equal(f.store.get(input.id).legs[0].reserve, "sent");
  assert.throws(() => f.store.beginEgress(input.id), error => error.code === "background_request_invalid");
  assert.deepEqual(f.store.beginReserve(input.id, 0), input.plan.legs[0]);
  f.store.reserved(input.id, 0, true); f.store.dispatched(input.id, 0); f.restart();
  assert.throws(() => f.store.beginEgress(input.id), error => error.code === "background_request_invalid");
  f.store.beginReserve(input.id, 1); f.store.reserved(input.id, 1, false);
  const frozen = f.store.freeze(input.id, { ...outcome(), billable: false, statusCode: 402, status: "denied" });
  assert.equal(frozen.event.actual_cost_micros, 0);
  assert.deepEqual(frozen.settlements, ["pending", "settled"], "only a definitive first-send denial has no receipt to settle");
  assert.equal(frozen.legs[0].intent.request.windowKey, input.plan.legs[0].request.windowKey);
  assert.equal(frozen.legs[0].uncertainReserve, true);
});

test("unknown reserve remains a required financial sink even after a later explicit denial", t => {
  const f = fixture(t), input = f.admission(); f.store.admit(input);
  f.store.beginReserve(input.id, 0); f.restart(); f.store.beginReserve(input.id, 0); f.store.reserved(input.id, 0, false);
  const frozen = f.store.freeze(input.id, { ...outcome(), billable: false });
  assert.deepEqual(frozen.settlements, ["pending", "settled"]);
  f.store.acknowledge(input.id, frozen.event.id, 0, "missing");
  f.store.acknowledge(input.id, frozen.event.id, "usage", "expired_by_retention");
  assert.equal(f.store.get(input.id).phase, "outbox");
  assert.deepEqual(f.store.get(input.id).settlements, ["missing", "settled"]);
});

test("terminal receipt freezes once, erases collection scalars and completes only after all three sink ACKs", t => {
  const f = fixture(t), input = f.admission(); f.store.admit(input); dispatch(f, input.id);
  f.store.identity(input.id, "response-fixture");
  const frozen = f.store.freeze(input.id, outcome()); f.restart();
  assert.equal(frozen.event.actual_cost_micros, 100); assert.equal(frozen.event.cost_basis, "manifest_reservation");
  assert.equal(frozen.route, null); assert.equal(frozen.responseId, null); assert.equal(frozen.facts, null);
  f.advance(10_000);
  assert.deepEqual(f.store.freeze(input.id, { ...outcome(), billable: false }).event, frozen.event);
  f.store.acknowledge(input.id, frozen.event.id, 0, "settled"); f.restart();
  f.store.acknowledge(input.id, frozen.event.id, 1, "conflict");
  f.store.acknowledge(input.id, frozen.event.id, "usage", "stored");
  assert.equal(f.store.get(input.id).phase, "outbox");
  f.store.acknowledge(input.id, frozen.event.id, 1, "settled");
  const done = f.store.get(input.id);
  assert.equal(done.phase, "complete"); assert.equal(done.eventId, frozen.event.id);
  assert.equal("event" in done, false); assert.equal("legs" in done, false); assert.equal("owner" in done, false);
  f.store.acknowledge(input.id, frozen.event.id, "usage", "duplicate");
  assert.deepEqual(f.store.get(input.id), done);
});

test("one-hour uncertainty retains the dispatched bound and does not invent a generation terminal", t => {
  const f = fixture(t), input = f.admission(); f.store.admit(input); dispatch(f, input.id);
  assert.equal(f.store.nextDeadline(), input.admittedAt + backgroundObservationMs, "no response ID means no synthetic poll or generation retry");
  f.advance(backgroundObservationMs - 1); assert.deepEqual(f.store.claim(Date.now()), []);
  f.advance(1); const [job] = f.store.claim(Date.now());
  assert.equal(job.event.actual_cost_micros, 100); assert.equal(job.event.cost_basis, "manifest_reservation");
  assert.equal(job.event.status_code, null); assert.equal(job.lastError, "observation_expired");
  assert.equal(job.responseId, null); assert.equal(job.route, null);
});

test("automatic and manual replay deadlines are fixed at admission, with usage expiry never a financial ACK", t => {
  const f = fixture(t), input = f.admission(); f.store.admit(input); dispatch(f, input.id);
  const frozen = f.store.freeze(input.id, outcome());
  f.advance(backgroundAutoRetryMs - 1); assert.equal(f.store.claim(Date.now()).length, 1);
  f.advance(1); assert.deepEqual(f.store.claim(Date.now()), []);
  f.advance(23 * 86_400_000); const [manual] = f.store.claim(Date.now(), input.id);
  assert.deepEqual(manual.event, frozen.event);
  f.store.acknowledge(input.id, frozen.event.id, "usage", "expired_by_retention");
  assert.equal(f.store.get(input.id).phase, "outbox");
  f.advance(backgroundReplayMs - 30 * 86_400_000);
  assert.deepEqual(f.store.claim(Date.now(), input.id), []);
  const expired = f.store.get(input.id);
  assert.equal(expired.phase, "expired"); assert.deepEqual(expired.settlements, ["pending", "pending"]);
  assert.equal(expired.usage, "expired_by_retention"); assert.equal(expired.replayUntil, input.admittedAt + backgroundReplayMs);
});

test("16 active and 64 total rows include summaries and never evict unresolved financial work", t => {
  const f = fixture(t), active = [];
  for (let i = 0; i < 16; i++) { const input = f.admission(); active.push(input.id); f.store.admit(input); }
  assert.throws(() => f.store.admit(f.admission()), error => error.code === "background_capacity");
  for (const id of active) f.store.freeze(id, { ...outcome(), billable: false });
  for (let i = 16; i < 64; i++) { const input = f.admission(); f.store.admit(input); f.store.freeze(input.id, { ...outcome(), billable: false }); }
  assert.throws(() => f.store.admit(f.admission()), error => error.code === "background_capacity");
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM responses_background").get().count, 64);
  const oldest = f.store.get(active[0]); f.store.acknowledge(oldest.id, oldest.event.id, "usage", "duplicate");
  assert.equal(f.store.get(oldest.id).phase, "complete");
  f.store.admit(f.admission());
  assert.equal(f.store.get(oldest.id), null);
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM responses_background").get().count, 64);
  assert.ok(f.store.get(active[1]), "the neighboring unresolved row is retained");
});

test("an owner offline across the seven-day cutoff schedules retirement, not another past-due retry", t => {
  const f = fixture(t), input = f.admission(); f.store.admit(input); dispatch(f, input.id);
  const frozen = f.store.freeze(input.id, outcome());
  f.advance(6 * 86_400_000); assert.equal(f.store.claim(Date.now()).length, 1);
  f.store.retry(input.id, "accounting_unavailable", f.store.get(input.id).attempts);
  f.advance(2 * 86_400_000); f.restart();
  assert.deepEqual(f.store.claim(Date.now()), []);
  assert.equal(f.store.nextDeadline(), input.admittedAt + backgroundReplayMs);
  assert.deepEqual(f.store.claim(Date.now(), input.id)[0].event, frozen.event, "manual replay remains available without extending either cutoff");
  assert.equal(f.store.nextDeadline(), input.admittedAt + backgroundReplayMs);
});

test("byte bounds apply before admission and every later terminal write", t => {
  const f = fixture(t), input = f.admission();
  const large = structuredClone(input); large.facts.event.model = "x".repeat(65536);
  assert.throws(() => f.store.admit(large), error => error.code === "background_metadata_too_large");
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM responses_background").get().count, 0);
  f.store.admit(input); dispatch(f, input.id);
  assert.throws(() => f.store.freeze(input.id, { ...outcome(), contentRef: "x".repeat(65536) }), error => error.code === "background_metadata_too_large");
  assert.equal(f.store.get(input.id).event, null);
  assert.equal(f.store.get(input.id).phase, "observing");
});
