import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { finalizeAccounting, markBudgetDispatched, reserveBudget, settleBudget } from "../accounting.ts";
import { BudgetLedgerObject, queue } from "../ledgers.ts";

const minute = 60_000, day = 86_400_000;
const auth = { policyId: "fixture", policy: { tenantId: "tenant", monthlyBudgetMicros: 100 } };
const connection = { providerId: "openai", monthlyBudgetMicros: 100 };
const cost = { reserveMicros: 75, basis: "manifest_pricing" };
const event = { id: "fixture-event", type: "clawrouter.usage.v1", tenant_id: "tenant", policy_id: "fixture", request_id: "fixture-request" };

test("live work keeps both charges after lease expiry and settles exactly once", async (t) => {
  const f = fixture(t);
  const reserved = await reserveBudget(f.env, auth, "llm.responses", cost, connection);
  await markBudgetDispatched(f.env, reserved);
  f.advance(15 * minute);
  for (const row of reserved.reservations) {
    assert.equal((await f.call(row.objectName, "/dispatch", row)).status, 409);
    assert.equal(f.rows(row.objectName)[0].settled, 2);
    assert.equal(f.rows(row.objectName)[0].reserved_micros, 75);
  }
  await assert.rejects(reserveBudget(f.env, auth, "llm.responses", { ...cost, reserveMicros: 26 }, connection), error => error.code === "budget_exhausted");
  assert.equal(await finalizeAccounting(f.env, reserved, 60, event), true);
  await settleBudget(f.env, reserved, 60);
  for (const row of reserved.reservations) {
    assert.equal(f.rows(row.objectName)[0].reserved_micros, 60);
    assert.equal(f.rows(row.objectName)[0].settled, 1);
    assert.equal((await f.call(row.objectName, "/settle", { reservationId: row.reservationId, actualCostMicros: 59 })).status, 409);
    assert.equal((await f.call(row.objectName, "/dispatch", row)).status, 409);
  }
  assert.deepEqual(f.messages, [event]);
});

test("abandoned pre-dispatch work becomes an idempotent zero receipt", async (t) => {
  const f = fixture(t);
  const reserved = await reserveBudget(f.env, auth, "llm.responses", cost, connection);
  f.advance(15 * minute);
  await assert.rejects(markBudgetDispatched(f.env, reserved));
  await settleBudget(f.env, reserved, 0);
  for (const row of reserved.reservations) {
    assert.equal(f.rows(row.objectName)[0].settled, 1);
    assert.equal(f.rows(row.objectName)[0].reserved_micros, 0);
    assert.equal((await f.call(row.objectName, "/settle", { reservationId: row.reservationId, actualCostMicros: 1 })).status, 409);
  }
  await assert.doesNotReject(reserveBudget(f.env, auth, "llm.responses", { ...cost, reserveMicros: 100 }, connection));
  assert.deepEqual(f.messages, []);
});

test("dispatch rechecks expiry after body parsing, not only fetch-entry maintenance", async (t) => {
  const f = fixture(t);
  const reserved = await reserveBudget(f.env, auth, "llm.responses", cost);
  const row = reserved.reservations[0];
  const request = new Request("https://budget/dispatch", { method: "POST", body: JSON.stringify(row) });
  request.json = async () => { f.advance(15 * minute); return row; };
  assert.equal((await f.object(row.objectName).ledger.fetch(request)).status, 409);
  assert.equal(f.rows(row.objectName)[0].dispatch_started, 0);
});

for (const failedOwner of ["tenant:fixture", "provider:openai"]) {
  test(`delayed ${failedOwner} settlement recovery preserves debt and independent settlement`, async (t) => {
    const f = fixture(t);
    const reserved = await reserveBudget(f.env, auth, "llm.responses", cost, connection);
    await markBudgetDispatched(f.env, reserved);
    f.failures.set(failedOwner, "/settle");
    assert.equal(await finalizeAccounting(f.env, reserved, 40, event), true);
    assert.equal(f.rows(failedOwner)[0].reserved_micros, 75);
    const other = reserved.reservations.find(row => row.objectName !== failedOwner);
    assert.equal(f.rows(other.objectName)[0].reserved_micros, 40);
    f.advance(4 * day);
    f.failures.clear();
    const job = f.messages.find(message => message.kind === "budget_settlement");
    const message = queued(job);
    await queue({ messages: [message] }, f.env);
    await queue({ messages: [message] }, f.env);
    assert.equal(message.acks, 2);
    assert.equal(message.retries, 0);
    assert.equal(f.rows(failedOwner)[0].reserved_micros, 40);
    assert.equal(f.rows(other.objectName)[0].reserved_micros, 40);
  });

  test(`lost ${failedOwner} dispatch acknowledgment can recover both zero rollbacks`, async (t) => {
    const f = fixture(t);
    const reserved = await reserveBudget(f.env, auth, "llm.responses", cost, connection);
    f.lostAcks.set(failedOwner, "/dispatch");
    await assert.rejects(markBudgetDispatched(f.env, reserved));
    for (const row of reserved.reservations) assert.equal(f.rows(row.objectName)[0].dispatch_started, 1);
    f.lostAcks.clear();
    f.failures.set(failedOwner, "/settle");
    await settleBudget(f.env, reserved, 0);
    f.advance(20 * minute);
    f.failures.clear();
    const message = queued(f.messages[0]);
    await queue({ messages: [message] }, f.env);
    assert.equal(message.acks, 1);
    for (const row of reserved.reservations) assert.equal(f.rows(row.objectName)[0].reserved_micros, 0);
  });
}

test("late settlement retains its original month and does not consume the next month", async (t) => {
  const f = fixture(t, Date.parse("2026-09-30T23:59:00Z"));
  const name = "tenant:fixture", oldWindow = "tenant/fixture/2026-09", nextWindow = "tenant/fixture/2026-10";
  const request = { policyId: "tenant/fixture", limitMicros: 100, costMicros: 75, reservationId: "old", windowKey: oldWindow, capability: "llm.responses" };
  await f.call(name, "/reserve", request);
  await f.call(name, "/dispatch", request);
  f.advance(20 * minute);
  await f.call(name, "/reserve", { ...request, reservationId: "next", windowKey: nextWindow, costMicros: 100 });
  await f.call(name, "/settle", { reservationId: "old", actualCostMicros: 60 });
  const charges = new Map(f.rows(name).map(row => [row.window_key, row.reserved_micros]));
  assert.equal(charges.get(oldWindow), 60);
  assert.equal(charges.get(nextWindow), 100);
});

test("existing reservations migrate conservatively without resetting balances", async (t) => {
  const f = fixture(t), name = "legacy";
  const { db } = f.object(name, db => {
    db.exec("CREATE TABLE budget_reservations (reservation_id TEXT PRIMARY KEY, window_key TEXT NOT NULL, policy_id TEXT NOT NULL, reserved_micros INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, settled INTEGER NOT NULL)");
    db.prepare("INSERT INTO budget_reservations VALUES (?, ?, ?, ?, ?, ?)").run("legacy-live", "window", "policy", 75, Date.now() - 20 * minute, 0);
    db.prepare("INSERT INTO budget_reservations VALUES (?, ?, ?, ?, ?, ?)").run("legacy-final", "window", "policy", 10, Date.now(), 1);
    db.exec("CREATE TABLE budget_windows (window_key TEXT PRIMARY KEY, policy_id TEXT NOT NULL, spent_micros INTEGER NOT NULL)");
    db.prepare("INSERT INTO budget_windows VALUES (?, ?, ?)").run("window", "policy", 5);
  });
  const status = await f.call(name, "/status?policy_id=policy&window_key=window&limit_micros=100");
  assert.equal((await status.json()).spentMicros, 90);
  assert.equal(f.rows(name).find(row => row.reservation_id === "legacy-live").settled, 2);
  assert.ok(f.rows(name).every(row => row.dispatch_started === 1));
  assert.equal((await f.call(name, "/settle", { reservationId: "legacy-live", actualCostMicros: 40 })).status, 200);
  assert.equal(db.prepare("SELECT spent_micros FROM budget_windows").get().spent_micros, 5);
  // A reservation inserted by an older binary also defaults to may-have-dispatched.
  db.prepare("INSERT INTO budget_reservations (reservation_id, window_key, policy_id, reserved_micros, created_at_ms, settled) VALUES (?, ?, ?, ?, ?, 0)").run("older-writer", "window", "policy", 7, Date.now() - 20 * minute);
  await f.call(name, "/status?policy_id=policy&window_key=window&limit_micros=100");
  assert.equal(f.rows(name).find(row => row.reservation_id === "older-writer").reserved_micros, 7);
});

test("all final receipt states expire after 45 days and missing settlement never succeeds", async (t) => {
  const f = fixture(t), name = "tenant:fixture";
  for (const reservationId of ["abandoned", "conservative", "final"]) {
    await f.call(name, "/reserve", { reservationId, policyId: "policy", windowKey: "window", limitMicros: 100, costMicros: 10, capability: "llm.responses" });
    if (reservationId !== "abandoned") await f.call(name, "/dispatch", { reservationId });
  }
  await f.call(name, "/settle", { reservationId: "final", actualCostMicros: 5 });
  f.advance(20 * minute);
  await f.object(name).ledger.alarm();
  assert.deepEqual(f.rows(name).map(row => row.settled).sort(), [1, 1, 2]);
  f.advance(45 * day);
  await f.object(name).ledger.alarm();
  assert.deepEqual(f.rows(name), []);
  const message = queued({ kind: "budget_settlement", ledger: { objectName: name }, request: { reservationId: "conservative", actualCostMicros: 7 } });
  await queue({ messages: [message] }, f.env);
  assert.equal(message.acks, 0);
  assert.equal(message.retries, 1);
});

function queued(body) {
  return { body, acks: 0, retries: 0, ack() { this.acks++; }, retry() { this.retries++; } };
}

function fixture(t, initialNow = Date.parse("2026-09-23T00:00:00Z")) {
  let now = initialNow;
  t.mock.method(Date, "now", () => now);
  const objects = new Map(), messages = [], failures = new Map(), lostAcks = new Map();
  function object(name, seed) {
    if (!objects.has(name)) {
      const db = new DatabaseSync(":memory:");
      t.after(() => db.close());
      seed?.(db);
      const sql = { exec(query, ...bindings) { const statement = db.prepare(query); if (statement.columns().length) return statement.all(...bindings); statement.run(...bindings); return []; } };
      objects.set(name, { db, ledger: new BudgetLedgerObject({ storage: { sql, getAlarm: async () => 1 } }) });
    }
    return objects.get(name);
  }
  const env = {
    BUDGET_LEDGER: { idFromName: name => name, get: name => ({ fetch: async (url, init) => {
      if (failures.get(name) === new URL(url).pathname) throw new Error("fixture ledger unavailable");
      const response = await object(name).ledger.fetch(new Request(url, init));
      if (lostAcks.get(name) === new URL(url).pathname) throw new Error("fixture acknowledgment lost after write");
      return response;
    } }) },
    USAGE_QUEUE: { send: async message => messages.push(message) },
  };
  return { env, messages, failures, lostAcks, object, advance: delta => { now += delta; }, rows: name => object(name).db.prepare("SELECT * FROM budget_reservations ORDER BY reservation_id").all(), call: (name, path, body) => object(name).ledger.fetch(new Request(`https://budget${path}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined)) };
}
