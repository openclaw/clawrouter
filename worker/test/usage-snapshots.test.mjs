import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { UsageLedgerObject, usageSnapshots } from "../ledgers.ts";
import { emptyUsageSnapshot } from "../usage-sharding.ts";

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
  const ledger = new UsageLedgerObject({ storage: { sql, getAlarm: async () => 1 } });
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
  assert.deepEqual(db.prepare("PRAGMA table_info(usage_events)").all().map(column => column.name), ["id", "occurred_at_ms", "tenant_id", "policy_id", "provider", "status", "status_code", "input_tokens", "output_tokens", "total_tokens", "actual_cost_micros", "event_json"]);
});
