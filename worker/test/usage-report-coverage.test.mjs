import assert from "node:assert/strict";
import test from "node:test";
import { usageReportFixture } from "./usage-report-fixture.mjs";
import { insertUsageReportEvent } from "../usage-report-store.ts";

const now = Date.now();
const stored = f => f.db.prepare("SELECT * FROM usage_events ORDER BY rowid").all();
const coverage = f => f.db.prepare("SELECT * FROM usage_report_coverage WHERE id = 1").get();
const applyAll = (f, batchSize = 2) => { let result; for (let i = 0; i < 100; i++) { result = f.migrate({ apply: true, batchSize }); if (result.complete) return result; } assert.fail("migration did not finish"); };

for (const initiallyEmpty of [true, false]) test("rollback raw-only ingest invalidates " + (initiallyEmpty ? "empty" : "completed") + " projection without mutating raw history", async () => {
  const f = usageReportFixture(now);
  if (!initiallyEmpty) f.insert(f.event(1));
  const ledger = f.open();
  if (!initiallyEmpty) applyAll(f);
  assert.equal(f.report().projectionComplete, true);
  const old = f.event(2, { actual_cost_micros: 23 });
  f.insert(old); // Original 6fceb88 writer: only canonical rows, counters/triggers survive rollback.
  const raw = stored(f);
  f.queries.length = 0;
  const report = f.report(), events = f.events();
  assert.equal(report.metrics.calls, initiallyEmpty ? 1 : 2);
  assert.equal(report.projectionComplete, false); assert.equal(report.historySource, "retained_ledger");
  assert.equal(report.historyComplete, true); assert.ok(events.events.some(event => event.id === old.id));
  assert.ok(f.queries.every(sql => !/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i.test(sql)));
  assert.deepEqual(stored(f), raw);
  const dirty = coverage(f);
  await f.ingest(ledger, { ...old, actual_cost_micros: 999 });
  assert.deepEqual(coverage(f), dirty); // A duplicate cannot acknowledge somebody else's gap.
  await f.ingest(ledger, f.event(3));
  assert.equal(f.report().projectionComplete, false); assert.equal(f.report().metrics.calls, initiallyEmpty ? 2 : 3);
  const before = coverage(f), migration = f.db.prepare("SELECT * FROM usage_report_migration").get();
  const preview = f.migrate({ batchSize: 1 });
  assert.equal(preview.examined, 1); assert.equal(preview.complete, false);
  assert.deepEqual(coverage(f), before); assert.deepEqual(f.db.prepare("SELECT * FROM usage_report_migration").get(), migration);
  const first = f.migrate({ apply: true, batchSize: 1 }); assert.equal(first.lastRowid, 1);
  const pinnedUpper = first.upperRowid;
  await f.ingest(ledger, f.event(4));
  const second = f.migrate({ apply: true, batchSize: 1 });
  assert.equal(second.lastRowid, 2); assert.equal(second.upperRowid, pinnedUpper);
  applyAll(f, 1);
  assert.equal(f.report().projectionComplete, true); assert.equal(f.report().metrics.calls, initiallyEmpty ? 3 : 4);
  assert.equal(f.events().events.find(event => event.id === old.id).recordedChargeMicros, 23);
  assert.deepEqual(stored(f).filter(row => row.id === old.id), raw.filter(row => row.id === old.id));
});

test("deletion, equal MAX/count and reused rowids cannot hide a gap or retain an orphan", () => {
  const f = usageReportFixture(now); for (let i = 1; i <= 3; i++) f.insert(f.event(i)); f.open(); applyAll(f);
  const max = f.db.prepare("SELECT MAX(rowid) AS n, COUNT(*) AS c FROM usage_events").get();
  f.db.exec("DELETE FROM usage_events WHERE rowid = 3");
  f.insert(f.event(4)); // SQLite reuses 3; both MAX and count are unchanged.
  assert.deepEqual(f.db.prepare("SELECT MAX(rowid) AS n, COUNT(*) AS c FROM usage_events").get(), max);
  assert.equal(f.report().projectionComplete, false); assert.equal(f.report().metrics.calls, 3);
  assert.deepEqual(new Set(f.events().events.map(event => event.id)), new Set(["event-1", "event-2", "event-4"]));
  assert.equal(f.db.prepare("SELECT id FROM usage_report_events WHERE id = 'event-3'").get(), undefined);
  const first = f.migrate({ apply: true, batchSize: 1 }); assert.equal(first.lastRowid, 1); assert.equal(first.upperRowid, 3);
  // A raw replacement below the already-visited watermark must restart, not extend the old round.
  f.db.exec("DELETE FROM usage_events WHERE rowid = 1"); f.insert(f.event(5));
  f.db.exec("UPDATE usage_events SET rowid = 1 WHERE id = 'event-5'");
  const fresh = f.migrate({ apply: true, batchSize: 1 }); assert.equal(fresh.lastRowid, 1);
  applyAll(f, 1); assert.equal(f.report().projectionComplete, true);
  assert.deepEqual(new Set(f.events().events.map(event => event.id)), new Set(["event-2", "event-4", "event-5"]));
});

test("first coverage rollout distrusts legacy complete markers and repairs stale/orphan projection rows in bounded batches", () => {
  const f = usageReportFixture(now); const event = f.event(1, { actual_cost_micros: 31 }); f.insert(event); f.open(); applyAll(f);
  // Reproduce a pre-trigger database carrying a complete marker and an inconsistent projection.
  for (const row of f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'usage_report_%'").all()) f.db.exec('DROP TRIGGER "' + row.name + '"');
  f.db.exec("DROP TABLE usage_report_coverage");
  f.db.exec("DELETE FROM usage_events");
  f.insert(f.event(2));
  insertUsageReportEvent(f.state.storage.sql, f.event(3));
  insertUsageReportEvent(f.state.storage.sql, f.event(4));
  const raw = stored(f); f.open();
  assert.equal(f.report().projectionComplete, false); assert.equal(f.report().metrics.calls, 1);
  const a = f.migrate({ apply: true, batchSize: 1 }); assert.equal(a.complete, false);
  assert.ok(f.db.prepare("SELECT COUNT(*) AS n FROM usage_report_events").get().n >= 1);
  applyAll(f, 1);
  assert.equal(f.report().projectionComplete, true); assert.deepEqual(f.events().events.map(event => event.id), ["event-2"]);
  assert.deepEqual(stored(f), raw);
});

test("canonical UPDATE invalidates coverage and explicit apply refreshes rather than ignoring the old projection", () => {
  const f = usageReportFixture(now); const event = f.event(1); f.insert(event); f.open(); applyAll(f);
  const changed = { ...event, actual_cost_micros: 97 };
  f.db.prepare("UPDATE usage_events SET event_json = ?, actual_cost_micros = ? WHERE id = ?").run(JSON.stringify(changed), 97, event.id);
  assert.equal(f.report().projectionComplete, false); assert.equal(f.events().events[0].recordedChargeMicros, 97);
  const raw = stored(f); applyAll(f); assert.equal(f.events().events[0].recordedChargeMicros, 97); assert.deepEqual(stored(f), raw);
});

test("coverage check is constant-size singleton indexed lookup; dirty reports keep the canonical owner index", () => {
  const f = usageReportFixture(now); f.open(); f.insert(f.event(1)); f.queries.length = 0; f.report();
  const check = f.queries.find(sql => sql.includes("usage_report_coverage"));
  assert.ok(check); assert.doesNotMatch(check, /usage_events|COUNT\(|MAX\(|NOT EXISTS/i);
  const plan = f.db.prepare("EXPLAIN QUERY PLAN " + check).all().map(row => row.detail);
  assert.ok(plan.every(detail => /SEARCH .* USING INTEGER PRIMARY KEY/.test(detail)), plan.join("\n"));
  assert.ok(f.queries.some(sql => sql.includes("usage_events INDEXED BY usage_events_policy_principal")));
});


test("ignored raw duplicates and failed paired writes cannot acknowledge or erase a previous gap", async () => {
  const f = usageReportFixture(now), ledger = f.open(); f.insert(f.event(1));
  const dirty = coverage(f), raw = stored(f);
  f.db.exec("INSERT OR IGNORE INTO usage_events SELECT * FROM usage_events");
  assert.deepEqual(coverage(f), dirty); assert.deepEqual(stored(f), raw);
  const original = f.state.storage.sql.exec;
  f.state.storage.sql.exec = (sql, ...bindings) => {
    if (sql.startsWith("INSERT OR IGNORE INTO usage_report_events")) throw new Error("projection interrupted");
    return original(sql, ...bindings);
  };
  await assert.rejects(f.ingest(ledger, f.event(2)), /projection interrupted/);
  assert.deepEqual(coverage(f), dirty); assert.deepEqual(stored(f), raw);
  f.state.storage.sql.exec = original;
  await f.ingest(ledger, f.event(2)); assert.equal(f.report().projectionComplete, false);
  const before = coverage(f), progress = f.db.prepare("SELECT * FROM usage_report_migration").get();
  f.state.storage.sql.exec = (sql, ...bindings) => {
    if (sql.startsWith("UPDATE usage_report_coverage SET round_generation")) throw new Error("checkpoint interrupted");
    return original(sql, ...bindings);
  };
  assert.throws(() => f.migrate({ apply: true, batchSize: 1 }), /checkpoint interrupted/);
  assert.deepEqual(coverage(f), before); assert.deepEqual(f.db.prepare("SELECT * FROM usage_report_migration").get(), progress);
  assert.equal(f.db.prepare("SELECT id FROM usage_report_events WHERE id = 'event-1'").get(), undefined);
  f.state.storage.sql.exec = original; applyAll(f, 1); assert.equal(f.report().projectionComplete, true);
});

test("paired retention preserves clean coverage, never clears dirty coverage, and does not project history", async t => {
  const f = usageReportFixture(now), ledger = f.open(); await f.ingest(ledger, f.event(1));
  assert.equal(f.report().projectionComplete, true);
  t.mock.method(Date, "now", () => now + 31 * 86400000);
  await ledger.alarm();
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_report_events").get().n, 0);
  assert.equal(f.report().projectionComplete, true);
  f.insert(f.event(2, { occurred_at_ms: Date.now() - 1000 })); const dirty = coverage(f);
  await ledger.alarm();
  assert.equal(f.report().projectionComplete, false); assert.deepEqual(coverage(f), dirty);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_report_events").get().n, 0);
});

test("pre-trigger stale projection with expired metadata is refreshed, not pruned after replacement", () => {
  const f = usageReportFixture(now); f.insert(f.event(1)); f.open(); applyAll(f);
  for (const row of f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'usage_report_%'").all()) f.db.exec('DROP TRIGGER "' + row.name + '"');
  f.db.exec("DROP TABLE usage_report_coverage");
  f.db.prepare("UPDATE usage_report_events SET occurred_at_ms = ?, detail_json = '{}'").run(now - 31 * 86400000);
  f.open(); applyAll(f, 2);
  assert.equal(f.report().projectionComplete, true); assert.equal(f.report().metrics.calls, 1);
  assert.equal(f.events().events[0].id, "event-1");
});
