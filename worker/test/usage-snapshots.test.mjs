import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { UsageLedgerObject, usageSnapshots } from "../ledgers.ts";
import { emptyUsageSnapshot } from "../usage-sharding.ts";
import { legacySnapshot, snapshotRequest, syntheticUsage, usageFixture } from "./usage-snapshot-fixture.mjs";

test("aggregation reads each tenant/policy shard once and never the retired global ledger", async () => {
  const calls = [];
  const env = { USAGE_LEDGER: {
    idFromName: name => name,
    get: name => ({ fetch: async url => {
      calls.push({ name, policy: new URL(url).searchParams.get("policy_id"), events: new URL(url).searchParams.get("events") });
      const snapshot = emptyUsageSnapshot();
      snapshot.summary.requestCount = 1;
      return Response.json(snapshot);
    } }),
  } };
  const summary = await usageSnapshots(env, [
    { tenantId: "one", policyId: "same" },
    { tenantId: "one", policyId: "same" },
    { tenantId: "two", policyId: "same" },
  ], { kind: "admin" });
  assert.deepEqual(calls, [
    { name: "policy:one:same", policy: "same", events: "admin" },
    { name: "policy:two:same", policy: "same", events: "admin" },
  ]);
  assert.equal(summary.summary.requestCount, 2);
  calls.length = 0;
  assert.deepEqual(await usageSnapshots(env, [], { kind: "admin" }), emptyUsageSnapshot());
  assert.deepEqual(calls, []);
});

test("a current shard failure fails the aggregate instead of returning partial totals", async () => {
  const env = { USAGE_LEDGER: {
    idFromName: name => name,
    get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
  } };
  await assert.rejects(usageSnapshots(env, [{ tenantId: "one", policyId: "policy" }], { kind: "admin" }), /503/);
});

test("unpriced SQL totals survive the recent-event limit and duplicate delivery on existing stores", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE usage_events (id TEXT PRIMARY KEY, occurred_at_ms INTEGER NOT NULL, tenant_id TEXT NOT NULL, policy_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, status_code INTEGER, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, actual_cost_micros INTEGER NOT NULL, event_json TEXT NOT NULL)");
  const sql = { exec(query, ...bindings) { const statement = db.prepare(query); if (statement.columns().length) return statement.all(...bindings); statement.run(...bindings); return []; } };
  const ledger = new UsageLedgerObject({ storage: { sql, transactionSync: fn => { db.exec("BEGIN"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } }, getAlarm: async () => 1 } });
  const now = Date.now();
  const base = { type: "clawrouter.usage.v1", tenant_id: "tenant", policy_id: "policy", provider: "openai", status: "success", status_code: 200, input_tokens: 1, output_tokens: 1, total_tokens: 2, actual_cost_micros: 0 };
  const ingest = event => ledger.fetch(new Request("https://ledger/ingest", { method: "POST", body: JSON.stringify(event) }));
  const unknown = { ...base, id: "old-unpriced", occurred_at_ms: now - 2 * 86_400_000, cost_basis: "unpriced_usage" };
  await ingest(unknown); await ingest(unknown);
  await ingest({ ...unknown, id: "historical-denial", cost_basis: "unpriced_service_tier", status: "client_error", status_code: 400 });
  await ingest({ ...unknown, id: "other-policy", policy_id: "other" });
  for (let index = 0; index < 101; index++) await ingest({ ...base, id: `priced-${index}`, occurred_at_ms: now - index, actual_cost_micros: index ? 5 : 0, cost_basis: index ? "manifest_pricing" : "none" });
  const snapshot = await (await ledger.fetch(new Request("https://ledger/snapshot?policy_id=policy&limit=100&events=admin"))).json();
  assert.equal(snapshot.events.length, 100);
  assert.equal(snapshot.events.some(event => event.id === unknown.id), false);
  assert.equal(snapshot.summary.requestCount, 103);
  assert.equal(snapshot.summary.actualCostMicros, 500);
  assert.equal(snapshot.summary.unpricedRequestCount, 1);
  assert.equal(snapshot.providers[0].unpricedRequestCount, 1);
  const oldDay = snapshot.daily.find(day => day.unpricedRequestCount);
  assert.equal(oldDay.unpricedRequestCount, 1);
  assert.equal(oldDay.actualCostMicros, 0);
  assert.equal(snapshot.daily.reduce((total, day) => total + day.unpricedRequestCount, 0), 1);
  assert.deepEqual(db.prepare("PRAGMA table_info(usage_events)").all().map(column => column.name), ["id", "occurred_at_ms", "tenant_id", "policy_id", "provider", "status", "status_code", "input_tokens", "output_tokens", "total_tokens", "actual_cost_micros", "event_json", "grant_key", "grant_lane", "principal_id", "principal_key", "credential_id", "cost_basis", "principal_nontext"]);
});

test("snapshots equal the legacy SQL before and after bounded attribution backfill", async (t) => {
  const now = Date.parse("2026-10-25T12:00:00Z"); t.mock.method(Date, "now", () => now);
  const f = usageFixture(); t.after(() => f.db.close());
  f.db.exec("BEGIN");
  for (let index = 0; index < 12_001; index++) f.insert(syntheticUsage(index, now));
  // Include the rolling/daily cutoff difference, and rows outside retention.
  for (const [id, occurred_at_ms] of [["rolling-only", now - 30 * 86_400_000 + 1], ["expired", now - 31 * 86_400_000]]) {
    f.insert({ ...syntheticUsage(1, now), id, occurred_at_ms });
  }
  f.db.exec("COMMIT");
  const scopes = [{ kind: "admin" }, { kind: "principal", id: " ALICE@example.com " }, { kind: "principal", id: "\u2003İDA@EXAMPLE.COM\u00a0" }, { kind: "credential", id: "credential-0" }, { kind: "principal", id: "invalid" }, { kind: "principal", id: "missing@example.com" }];
  const expected = scopes.map(scope => legacySnapshot(f.db, scope, now));
  let ledger = f.open();
  for (const [index, scope] of scopes.entries()) {
    assert.deepEqual(await (await ledger.fetch(snapshotRequest(scope))).json(), expected[index]);
    const marker = f.db.prepare("SELECT * FROM usage_attribution_migration").get();
    assert.equal(marker.last_rowid, (index + 1) * 2_000);
    assert.equal(marker.complete, 0);
    ledger = f.open(); // Progress survives reconstruction.
  }
  assert.equal(f.alarm(), now + 60_000);
  // New ingests are projected immediately, including reused rowids and rows
  // above the fixed upper bound after retention deletes the previous last row.
  const fresh = { ...syntheticUsage(1, now), id: "during-backfill", occurred_at_ms: now };
  await ledger.fetch(new Request("https://ledger/ingest", { method: "POST", body: JSON.stringify(fresh) }));
  const upper = f.db.prepare("SELECT upper_rowid FROM usage_attribution_migration").get().upper_rowid;
  assert.equal(f.db.prepare("SELECT rowid FROM usage_events WHERE id = ?").get(fresh.id).rowid, upper);
  await ledger.fetch(new Request("https://ledger/ingest", { method: "POST", body: JSON.stringify({ ...fresh, id: "above-backfill" }) }));
  assert.ok(f.db.prepare("SELECT rowid FROM usage_events WHERE id = 'above-backfill'").get().rowid > upper);
  while (!f.db.prepare("SELECT complete FROM usage_attribution_migration").get().complete) await ledger.alarm();
  for (const scope of scopes) {
    f.queries.length = 0;
    assert.deepEqual(await (await ledger.fetch(snapshotRequest(scope))).json(), legacySnapshot(f.db, scope, now));
    assert.ok(f.queries.every(query => !/json_extract|json_type|json_each/i.test(query)), "completed snapshots never parse JSON in SQL");
    assert.ok(f.queries.every(query => !query.includes("SELECT rowid, event_json")), "completion marker prevents another scan");
  }
  f.queries.length = 0;
  ledger = f.open(); await ledger.alarm();
  assert.ok(f.queries.every(query => !/SELECT rowid, event_json|MAX\(rowid\)/.test(query)), "completed reconstruction and alarms never restart backfill");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE principal_id = ' Alice@Example.com ' AND principal_key = 'alice@example.com'").get().n > 0, true);
});

test("ingest projects raw attribution and normalized keys without changing stored events", async (t) => {
  const now = Date.now(), f = usageFixture(); t.after(() => f.db.close());
  const ledger = f.open();
  for (const [index, principal_id] of [" Alice@Example.com ", "\u2003İDA@EXAMPLE.COM\u00a0", "invalid", "", null, undefined, 42].entries()) {
    const event = { ...syntheticUsage(index, now), principal_id, id: `ingest-${index}` };
    const payload = JSON.stringify(event);
    await ledger.fetch(new Request("https://ledger/ingest", { method: "POST", body: payload }));
    const row = f.db.prepare("SELECT principal_id, principal_key, credential_id, cost_basis, principal_nontext, event_json FROM usage_events WHERE id = ?").get(event.id);
    assert.equal(row.event_json, payload);
    assert.equal(row.principal_id, typeof principal_id === "string" ? principal_id : null);
    assert.equal(row.principal_key, ["alice@example.com", "i\u0307da@example.com", null, null, null, null, null][index]);
    assert.equal(row.credential_id, event.credential_id);
    assert.equal(row.cost_basis, event.cost_basis);
    assert.equal(row.principal_nontext, principal_id != null && typeof principal_id !== "string" ? 1 : 0);
  }
  const indexes = f.db.prepare("PRAGMA index_list(usage_events)").all();
  for (const [name, columns] of [["usage_events_policy_principal", ["policy_id", "principal_key", "occurred_at_ms"]], ["usage_events_policy_credential", ["policy_id", "credential_id", "occurred_at_ms"]]]) {
    assert.ok(indexes.some(index => index.name === name));
    assert.deepEqual(f.db.prepare(`PRAGMA index_info(${name})`).all().map(column => column.name), columns);
  }
  for (const [condition, index] of [["principal_key = ?", "usage_events_policy_principal"], ["principal_id IS NULL AND principal_nontext = 0 AND credential_id = ?", "usage_events_policy_credential"]]) {
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT event_json FROM usage_events WHERE policy_id = ? AND occurred_at_ms >= ? AND ${condition} ORDER BY occurred_at_ms DESC LIMIT 100`).all("policy", now - 30 * 86_400_000, "synthetic");
    assert.ok(plan.some(row => row.detail.includes(index)), `${index} serves owner-filtered events`);
  }
});

test("owner filtering precedes LIMIT on pending and indexed rows", async (t) => {
  const now = Date.now(), f = usageFixture(); t.after(() => f.db.close());
  for (let index = 0; index < 4_101; index++) f.insert({ ...syntheticUsage(index, now), policy_id: "policy", principal_id: "bob@example.com" });
  for (let index = 0; index < 3; index++) f.insert({ ...syntheticUsage(index, now), id: `alice-${index}`, policy_id: "policy", principal_id: " Alice@Example.com ", occurred_at_ms: now - 3 * 86_400_000 - index });
  const ledger = f.open(), scope = { kind: "principal", id: "alice@example.com" };
  for (let pass = 0; pass < 3; pass++) {
    const result = await (await ledger.fetch(snapshotRequest(scope, ["policy"], 2))).json();
    assert.deepEqual(result.events.map(event => event.id), ["alice-0", "alice-1"]);
    assert.equal(result.personal.summary.requestCount, 3);
  }
});

test("failed backfill rolls back both projections and its durable cursor", async (t) => {
  const now = Date.now(), f = usageFixture(); t.after(() => f.db.close());
  for (let index = 0; index < 5; index++) f.insert(syntheticUsage(index, now));
  let ledger = f.open(), updates = 0;
  const exec = f.state.storage.sql.exec;
  f.state.storage.sql.exec = (query, ...bindings) => {
    if (query.startsWith("UPDATE usage_events SET principal_id") && ++updates === 3) throw new Error("synthetic storage failure");
    return exec(query, ...bindings);
  };
  await assert.rejects(ledger.fetch(snapshotRequest({ kind: "admin" })), /synthetic storage failure/);
  assert.equal(f.db.prepare("SELECT last_rowid FROM usage_attribution_migration").get().last_rowid, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE credential_id IS NOT NULL").get().n, 0);
  f.state.storage.sql.exec = exec; ledger = f.open();
  assert.deepEqual(await (await ledger.fetch(snapshotRequest({ kind: "admin" }))).json(), legacySnapshot(f.db, { kind: "admin" }, now));
});
