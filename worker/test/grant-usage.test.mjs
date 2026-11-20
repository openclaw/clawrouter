import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { UsageLedgerObject } from "../ledgers.ts";
import { sqliteStorage } from "./sqlite-storage.mjs";

const dayMs = 86_400_000;

function fixture() {
  const db = new DatabaseSync(":memory:"), storage = sqliteStorage(db);
  // Match the lazy SqlStorage cursor; the common fixture materializes rows.
  storage.sql.exec = (query, ...bindings) => {
    const statement = db.prepare(query);
    if (statement.columns().length) return statement.iterate(...bindings);
    statement.run(...bindings);
    return [];
  };
  const ledger = new UsageLedgerObject({ storage });
  const insert = db.prepare("INSERT INTO usage_events (id, occurred_at_ms, tenant_id, policy_id, provider, status, input_tokens, output_tokens, actual_cost_micros, event_json, grant_key, grant_lane) VALUES (?, ?, 'tenant', ?, ?, 'success', ?, ?, ?, ?, ?, ?)");
  return {
    db,
    insert(event) {
      insert.run(event.id, event.at, event.policy ?? "policy", event.provider ?? "anthropic", event.input ?? null, event.output ?? null, event.cost ?? 0,
        JSON.stringify({ model: event.model ?? null, cached_input_tokens: event.cache ?? null, cache_write_input_tokens: event.write ?? null }), event.grant ?? null, event.lane ?? null);
    },
    report: () => ledger.fetch(new Request("https://ledger/grant-usage?policy_id=policy&days=7")),
  };
}

test("grant usage preserves totals, identities, binary ordering and inclusive time bounds", async t => {
  const now = Date.parse("2026-11-07T12:00:00Z"), since = now - 7 * dayMs;
  t.mock.method(Date, "now", () => now);
  const f = fixture(); t.after(() => f.db.close());
  const events = [
    { id: "first", at: now, grant: "a", lane: "subscription", model: "model", input: 2, output: 3, cache: 4, write: 1 },
    { id: "second", at: now - 1, grant: "a", lane: "subscription", model: "model", output: 2, cache: "12x", cost: 7 },
    { id: "missing-model", at: now, grant: "a", lane: "subscription" },
    { id: "bmp", at: since, grant: "b", model: "\ue000", input: 1 },
    { id: "astral", at: since, grant: "b", model: "\u{10000}", input: 1 },
    { id: "old", at: since - 1, input: 999 },
    { id: "future", at: now + 1, input: 999 },
    { id: "other", at: now, policy: "other", input: 999 },
  ];
  for (const event of events) f.insert(event);
  const response = await f.report(), report = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(report.daily.map(row => [row.day, row.grantKey, row.model]), [
    ["2026-10-31", "b", "\ue000"], ["2026-10-31", "b", "\u{10000}"], ["2026-11-07", "a", null], ["2026-11-07", "a", "model"],
  ]);
  assert.deepEqual(report.grants, [
    { provider: "anthropic", grantKey: "b", grantLane: null, requests: 2, inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
    { provider: "anthropic", grantKey: "a", grantLane: "subscription", requests: 3, inputTokens: 2, outputTokens: 5, cacheReadTokens: 16, cacheWriteTokens: 1, costMicros: 7 },
  ]);
  assert.deepEqual(report.lanes, report.grants.map(({ grantKey, ...row }) => row));
  assert.equal(report.since, since); assert.equal(report.until, now);
});

test("grant usage accepts 8192 groups and refuses another without partial totals", async t => {
  const f = fixture(); t.after(() => f.db.close());
  const now = Date.now() - 1000;
  f.db.exec("BEGIN");
  for (let index = 0; index < 8192; index++) f.insert({ id: String(index), at: now, model: String(index) });
  f.db.exec("COMMIT");
  const accepted = await f.report();
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).daily.length, 8192);
  f.insert({ id: "overflow", at: now, model: "overflow" });
  const rejected = await f.report();
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).error.code, "usage_range_too_large");
});

