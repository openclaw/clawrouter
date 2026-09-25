import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ingestUsage, queue, UsageLedgerObject } from "../ledgers.ts";

const day = 86_400_000, retention = 30 * day, now = Date.parse("2026-09-23T00:00:00Z");

for (const outcome of ["stored", "duplicate", "expired_by_retention"]) {
  test(`ingest client returns a matching ${outcome} receipt and accepts additive fields`, async () => {
    const body = event("receipt"), calls = [];
    const env = { USAGE_LEDGER: { idFromName: name => name, get: name => ({ fetch: async (url, init) => {
      calls.push({ name, url, init });
      return Response.json({ eventId: body.id, outcome, futureField: true });
    } }) } };
    assert.deepEqual(await ingestUsage(env, body), { eventId: body.id, outcome });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "policy:tenant:policy");
    assert.equal(calls[0].url, "https://clawrouter.internal/ingest");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body), body);
  });
}

for (const [label, responseBody, status = 200] of [
  ["empty", null], ["empty 204", null, 204], ["old text acknowledgment", "accepted"], ["malformed JSON", "{"],
  ["null", "null"], ["array", "[]"], ["string", '"accepted"'], ["number", "1"], ["boolean", "true"],
  ["missing identity", JSON.stringify({ outcome: "stored" })],
  ["numeric identity", JSON.stringify({ eventId: 1, outcome: "stored" })],
  ["different identity", JSON.stringify({ eventId: "other", outcome: "stored" })],
  ["missing outcome", JSON.stringify({ eventId: "receipt" })],
  ["unknown outcome", JSON.stringify({ eventId: "receipt", outcome: "accepted" })],
  ["null outcome", JSON.stringify({ eventId: "receipt", outcome: null })],
  ["financial receipt", JSON.stringify({ settled: true })],
]) {
  test(`unconfirmed ${label} success rejects direct ingestion and retries queue delivery`, async () => {
    let writes = 0, acks = 0, retries = 0;
    const body = event("receipt");
    const env = { USAGE_LEDGER: { idFromName: name => name, get: () => ({ fetch: async () => {
      writes++;
      return new Response(responseBody, { status });
    } }) } };
    await assert.rejects(ingestUsage(env, body), { message: "usage ledger did not acknowledge ingestion" });
    assert.equal(writes, 1, "direct ingestion does not retry automatically");
    await queue({ messages: [{ body, ack() { acks++; }, retry() { retries++; } }] }, env);
    assert.equal(writes, 2);
    assert.equal(acks, 0);
    assert.equal(retries, 1);
  });
}

test("an older producer can commit without a receipt; reconstructed redelivery confirms the duplicate", async (t) => {
  const f = fixture(t), original = event("old-producer", now - day);
  let oldProducer = true, acks = 0, retries = 0, writes = 0;
  const outcomes = [];
  const env = { USAGE_LEDGER: { idFromName: name => name, get: () => ({ fetch: async (url, init) => {
    writes++;
    if (oldProducer) {
      // The pre-8c25f81 producer committed with INSERT OR IGNORE before
      // returning bare "accepted". Exercise that write, not a success-only mock.
      const body = JSON.parse(init.body);
      body.occurred_at_ms ||= Date.now();
      body.policy_id ||= body.key_id;
      f.sql.exec("INSERT OR IGNORE INTO usage_events (id, occurred_at_ms, tenant_id, policy_id, provider, status, status_code, input_tokens, output_tokens, total_tokens, actual_cost_micros, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        body.id, body.occurred_at_ms, body.tenant_id, body.policy_id, body.provider, body.status, body.status_code,
        body.input_tokens, body.output_tokens, body.total_tokens, body.actual_cost_micros, JSON.stringify(body));
      f.sql.exec("DELETE FROM usage_events WHERE occurred_at_ms < ?", Date.now() - retention);
      if (!(await f.storage.getAlarm())) await f.storage.setAlarm(Date.now() + day);
      return new Response("accepted");
    }
    const response = await f.ledger.fetch(new Request(url, init));
    outcomes.push((await response.clone().json()).outcome);
    return response;
  } }) } };
  const message = { body: original, ack() { acks++; }, retry() { retries++; } };
  await queue({ messages: [message] }, env);
  assert.equal(writes, 1);
  assert.equal(acks, 0);
  assert.equal(retries, 1);
  const stored = f.rows()[0];
  assert.deepEqual(JSON.parse(stored.event_json), original);
  oldProducer = false;
  f.reconstruct();
  message.body = { ...original, occurred_at_ms: now, actual_cost_micros: 999 };
  await queue({ messages: [message] }, env);
  assert.deepEqual(outcomes, ["duplicate"]);
  assert.equal(writes, 2);
  assert.equal(acks, 1);
  assert.equal(retries, 1);
  assert.deepEqual(f.rows(), [stored]);
});

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
  assert.deepEqual(await ingestUsage(env, replay), { eventId: original.id, outcome: "duplicate" });
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

test("direct and queue callers validate producer receipts without acknowledging failed financial settlement", async (t) => {
  const f = fixture(t), outcomes = [];
  const env = { USAGE_LEDGER: { idFromName: name => name, get: () => ({ fetch: async (url, init) => {
    const response = await f.ledger.fetch(new Request(url, init));
    outcomes.push((await response.clone().json()).outcome);
    return response;
  } }) } };
  assert.deepEqual(await ingestUsage(env, event("same")), { eventId: "same", outcome: "stored" });
  let budgetWrites = 0, budgetAcks = 0, budgetRetries = 0;
  env.BUDGET_LEDGER = { idFromName: name => name, get: () => ({ fetch: async () => {
    budgetWrites++;
    return new Response("unavailable", { status: 503 });
  } }) };
  const budget = { body: { kind: "budget_settlement", ledger: { objectName: "tenant:policy" }, request: { reservationId: "retained-charge", actualCostMicros: 7 } }, ack() { budgetAcks++; }, retry() { budgetRetries++; } };
  let acks = 0, retries = 0;
  for (const body of [event("same"), event("expired", now - retention - 1), { ...event("invalid"), occurred_at_ms: null }]) {
    await queue({ messages: [{ body, ack() { acks++; }, retry() { retries++; } }, budget] }, env);
  }
  assert.deepEqual(outcomes, ["stored", "duplicate", "expired_by_retention", undefined]);
  assert.equal(acks, 2);
  assert.equal(retries, 1);
  assert.equal(budgetWrites, 3);
  assert.equal(budgetAcks, 0);
  assert.equal(budgetRetries, 3);
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
