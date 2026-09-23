import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ingestUsage, queue, UsageLedgerObject } from "../ledgers.ts";

const day = 86_400_000, retention = 30 * day, now = Date.parse("2026-09-23T00:00:00Z");

test("stored receipts survive lost acknowledgment and reconstruction without replacing the first event", async (t) => {
  const f = fixture(t), original = event("first", now - day);
  let loseAck = true;
  const env = { USAGE_LEDGER: { idFromName: name => name, get: name => ({ fetch: async (url, init) => {
    assert.equal(name, "policy:tenant:policy");
    const response = await f.ledger.fetch(new Request(url, init));
    if (loseAck) { loseAck = false; throw new Error("fixture lost acknowledgment"); }
    return response;
  } }) } };
  await assert.rejects(ingestUsage(env, original), /lost acknowledgment/);
  const stored = f.rows()[0];
  assert.deepEqual(JSON.parse(stored.event_json), original);
  f.reconstruct();
  const replay = { ...original, occurred_at_ms: now, actual_cost_micros: 999, status: "provider_error" };
  assert.deepEqual(await receipt(f, replay), { eventId: original.id, outcome: "duplicate" });
  assert.deepEqual(f.rows(), [stored]);
  await ingestUsage(env, replay);
  assert.deepEqual(f.rows(), [stored]);
});

test("stored is confirmed by a returned SQLite row and preserves the supplied timestamp", async (t) => {
  const f = fixture(t), body = event("stored", now - 123);
  assert.deepEqual(await receipt(f, body), { eventId: body.id, outcome: "stored" });
  assert.equal(f.rows()[0].occurred_at_ms, body.occurred_at_ms);
  assert.deepEqual(JSON.parse(f.rows()[0].event_json), body);
});

test("one captured cutoff retains the exact boundary and excludes only older new events", async (t) => {
  const f = fixture(t), cutoff = now - retention;
  for (const delta of [-1, 0, 1]) {
    assert.deepEqual(await receipt(f, event(`boundary-${delta}`, cutoff + delta)), { eventId: `boundary-${delta}`, outcome: delta < 0 ? "expired_by_retention" : "stored" });
  }
  assert.deepEqual(f.rows().map(row => row.occurred_at_ms).sort(), [cutoff, cutoff + 1]);
  let clockReads = 0;
  t.mock.method(Date, "now", () => now + clockReads++);
  assert.deepEqual(await receipt(f, event("single-cutoff", cutoff)), { eventId: "single-cutoff", outcome: "stored" });
  assert.equal(clockReads, 1);
});

test("timestamp zero and legacy policy fallback remain valid without a current-time default", async (t) => {
  const f = fixture(t, retention);
  for (const policy_id of [undefined, ""]) {
    const body = { ...event(`legacy-${String(policy_id)}`, 0), policy_id, key_id: "legacy-policy" };
    assert.equal((await receipt(f, body)).outcome, "stored");
  }
  for (const row of f.rows()) {
    assert.equal(row.occurred_at_ms, 0);
    assert.equal(row.policy_id, "legacy-policy");
    assert.equal(JSON.parse(row.event_json).policy_id, "legacy-policy");
    assert.equal(JSON.parse(row.event_json).occurred_at_ms, 0);
  }
});

test("retained duplicates win over replay expiry while cleanup prevents expired resurrection", async (t) => {
  const f = fixture(t), original = event("retained", now);
  await receipt(f, original);
  const row = f.rows()[0];
  assert.deepEqual(await receipt(f, { ...original, occurred_at_ms: 0 }), { eventId: original.id, outcome: "duplicate" });
  assert.deepEqual(f.rows(), [row]);
  f.now += retention + 1;
  assert.deepEqual(await receipt(f, original), { eventId: original.id, outcome: "expired_by_retention" });
  assert.deepEqual(f.rows(), []);
  assert.equal((await receipt(f, { ...original, occurred_at_ms: f.now })).outcome, "stored");
});

test("malformed receipt identity or timestamp is rejected before cleanup or insertion", async (t) => {
  const f = fixture(t);
  const invalid = [null, [], "event", {}, ...[undefined, null, "", 1, false].map(id => ({ ...event("valid"), id })), ...[undefined, null, "123", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN].map(occurred_at_ms => ({ ...event("valid"), occurred_at_ms }))];
  f.sql.exec = () => assert.fail("invalid input must not touch SQL");
  for (const body of invalid) {
    const response = await f.call(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: "invalid_usage_event", message: "id must be a nonempty string and occurred_at_ms must be a nonnegative safe integer" } });
  }
  await assert.rejects(f.ledger.fetch(new Request("https://ledger/ingest", { method: "POST", body: "{" })), SyntaxError);
});

test("safe timestamp and nonempty ID bounds are not narrowed by receipt validation", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await receipt(f, event(" ", Number.MAX_SAFE_INTEGER)), { eventId: " ", outcome: "stored" });
  assert.equal(f.rows()[0].occurred_at_ms, Number.MAX_SAFE_INTEGER);
});

test("SQL failures other than the event-ID conflict do not produce a success receipt", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.call({ ...event("missing-tenant"), tenant_id: null }), /NOT NULL constraint failed/);
  f.db.exec("CREATE UNIQUE INDEX fixture_unique_tenant ON usage_events (tenant_id)");
  await receipt(f, event("first"));
  await assert.rejects(f.call(event("other-id")), /UNIQUE constraint failed/);
  assert.deepEqual(f.rows().map(row => row.id), ["first"]);
});

test("a silently skipped insert cannot claim stored without row evidence", async (t) => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fixture_skip BEFORE INSERT ON usage_events BEGIN SELECT RAISE(IGNORE); END");
  await assert.rejects(f.call(event("skipped")), /usage ledger did not confirm insertion/);
  assert.deepEqual(f.rows(), []);
});

for (const failedQuery of ["DELETE FROM usage_events", "SELECT id FROM usage_events WHERE", "INSERT INTO usage_events"]) {
  test(`failed ${failedQuery} yields no definitive receipt and can retry`, async (t) => {
    const f = fixture(t), execute = f.sql.exec;
    f.sql.exec = (query, ...bindings) => {
      if (query.startsWith(failedQuery)) throw new Error("fixture SQL unavailable");
      return execute(query, ...bindings);
    };
    await assert.rejects(f.call(event("retry")), /SQL unavailable/);
    assert.deepEqual(f.rows(), []);
    f.sql.exec = execute;
    assert.equal((await receipt(f, event("retry"))).outcome, "stored");
  });
}

for (const method of ["getAlarm", "setAlarm"]) {
  test(`failed ${method} yields no definitive receipt and reconstructed retry deduplicates`, async (t) => {
    const f = fixture(t), body = event("alarm-retry");
    f.storage.getAlarm = async () => null;
    const original = f.storage[method];
    f.storage[method] = async () => { throw new Error("fixture alarm unavailable"); };
    await assert.rejects(f.call(body), /alarm unavailable/);
    const row = f.rows()[0];
    assert.ok(row);
    f.storage[method] = original;
    f.reconstruct();
    assert.deepEqual(await receipt(f, body), { eventId: body.id, outcome: "duplicate" });
    assert.deepEqual(f.rows(), [row]);
  });
}

test("receipt publication waits for alarm completion", async (t) => {
  const f = fixture(t);
  f.storage.getAlarm = async () => null;
  let release, entered, complete = false;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.storage.setAlarm = async at => { assert.equal(at, now + day); entered(); await held; };
  const pending = f.call(event("held")).then(response => { complete = true; return response; });
  await started;
  assert.equal(complete, false);
  assert.equal(f.rows().length, 1);
  release();
  assert.deepEqual(await (await pending).json(), { eventId: "held", outcome: "stored" });
});

test("existing status-only direct and queue callers accept all producer receipts", async (t) => {
  const f = fixture(t), outcomes = [];
  const env = { USAGE_LEDGER: { idFromName: name => name, get: () => ({ fetch: async (url, init) => {
    const response = await f.ledger.fetch(new Request(url, init));
    outcomes.push((await response.clone().json()).outcome);
    return response;
  } }) } };
  await ingestUsage(env, event("same"));
  let acks = 0, retries = 0;
  for (const body of [event("same"), event("expired", now - retention - 1), { ...event("invalid"), occurred_at_ms: null }]) {
    await queue({ messages: [{ body, ack() { acks++; }, retry() { retries++; } }] }, env);
  }
  assert.deepEqual(outcomes, ["stored", "duplicate", "expired_by_retention", undefined]);
  assert.equal(acks, 2);
  assert.equal(retries, 1);
  assert.deepEqual(f.rows().map(row => row.id), ["same"]);
});

function event(id, occurred_at_ms = now) {
  return { id, type: "clawrouter.usage.v1", occurred_at_ms, tenant_id: "tenant", policy_id: "policy", key_id: "policy", provider: "openai", status: "success", status_code: 200, input_tokens: 3, output_tokens: 2, total_tokens: 5, actual_cost_micros: 7 };
}

async function receipt(f, body) {
  const response = await f.call(body);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  return response.json();
}

function fixture(t, initialNow = now) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = { exec(query, ...bindings) { const statement = db.prepare(query); if (statement.columns().length) return statement.all(...bindings); statement.run(...bindings); return []; } };
  const storage = { sql, getAlarm: async () => 1, setAlarm: async () => {} };
  const f = { db, sql, storage, now: initialNow, ledger: new UsageLedgerObject({ storage }), reconstruct() { this.ledger = new UsageLedgerObject({ storage }); }, rows: () => db.prepare("SELECT * FROM usage_events ORDER BY id").all(), call: body => f.ledger.fetch(new Request("https://ledger/ingest", { method: "POST", body: JSON.stringify(body) })) };
  t.mock.method(Date, "now", () => f.now);
  return f;
}
