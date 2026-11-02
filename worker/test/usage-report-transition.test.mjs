import assert from "node:assert/strict";
import test from "node:test";
import { usageReportFixture } from "./usage-report-fixture.mjs";
import { projectUsageEvent, queryUsageReport, queryUsageEvents, insertUsageReportEvent } from "../usage-report-store.ts";
import { knownBasisClasses } from "../usage-report-cost.ts";
import { parseUsageReportQuery } from "../usage-report.ts";

const now = Date.parse("2026-11-02T12:00:00Z");
const params = values => new URLSearchParams(values);
const content = ({ historySource, projectionComplete, historyComplete, ...report }) => report;

test("baseline indexed originals survive first candidate read, sparse projection and migration without duplicates or writes", async () => {
  const f = usageReportFixture(now);
  for (let i = 0; i < 12; i++) f.insert(f.event(i + 1, { policy_id: "policy", model: "model-" + i % 3, credential_id: i % 2 ? "key-b" : "key-a", occurred_at_ms: now - (i + 1) * 86400000, input_tokens: 100, output_tokens: 20, actual_cost_micros: 7, cost_basis: "manifest_pricing" }));
  for (const [i, extra] of [{ principal_id: "bob@example.com" }, { tenant_id: "other" }, { policy_id: "other" }, { principal_id: null, credential_id: "key-a" }].entries()) f.insert(f.event(i + 101, { policy_id: "policy", ...extra }));
  const original = f.db.prepare("SELECT * FROM usage_events ORDER BY id").all();
  const ledger = f.open();
  const q = f.query(params({ days: "30", groupBy: "model" }));
  f.queries.length = 0;
  const before = f.report(q), list = f.events(q, 100);
  assert.equal(before.metrics.calls, 12); assert.equal(before.metrics.inputTokens, 1200); assert.equal(before.metrics.outputTokens, 240);
  assert.deepEqual(before.groups.map(g => [g.value, g.metrics.calls]), [["model-0", 4], ["model-1", 4], ["model-2", 4]]);
  assert.equal(before.buckets.reduce((sum, b) => sum + b.metrics.calls, 0), 12);
  assert.equal(before.historyComplete, true); assert.equal(before.projectionComplete, false); assert.equal(before.historySource, "retained_ledger");
  assert.equal(list.events.length, 12); assert.equal(list.historySource, "retained_ledger");
  assert.equal(f.report({ ...q, filters: { key: "not-owned" } }).metrics.calls, 0);
  assert.equal(f.report({ ...q, filters: { key: "key-a" } }).metrics.calls, 6);
  assert.equal(f.events({ ...q, filters: { key: "key-b" } }, 100).events.length, 6);
  assert.ok(f.queries.every(sql => !/^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE)\b/i.test(sql)));
  assert.ok(f.queries.every(sql => !/DISTINCT.*principal|json_each|usage_report_events.*UNION/i.test(sql)));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_report_events").get().n, 0);
  assert.equal(f.migrate({ batchSize: 2 }).dryRun, true);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_report_events").get().n, 0);
  f.migrate({ apply: true, batchSize: 2 });
  // Arbitrary sparse migrated rows, and a future-ingested row, coexist safely.
  insertUsageReportEvent(f.state.storage.sql, JSON.parse(original.find(row => row.id === "event-8").event_json));
  assert.deepEqual(content(f.report(q)), content(before));
  assert.deepEqual(f.events(q, 100).events, list.events);
  const newEvent = f.event(500, { policy_id: "policy", occurred_at_ms: now - 100, model: "new" });
  await f.ingest(ledger, newEvent);
  const withNew = f.report(q), withNewList = f.events(q, 100).events;
  assert.equal(withNew.metrics.calls, 13); assert.equal(withNewList.length, 13);
  while (!f.migrate({ apply: true, batchSize: 2 }).complete) { /* explicit bounded offline batches */ }
  const complete = f.report(q);
  assert.equal(complete.historyComplete, true); assert.equal(complete.projectionComplete, true); assert.equal(complete.historySource, "projection");
  assert.deepEqual(content(complete), content(withNew)); assert.deepEqual(f.events(q, 100).events, withNewList);
  assert.deepEqual(f.db.prepare("SELECT * FROM usage_events WHERE id != ? ORDER BY id").all(newEvent.id), original);
});

test("retained report is one indexed owner/time range; unrelated bloat never parses JSON or expands owner work", () => {
  const f = usageReportFixture(now);
  for (let i = 0; i < 7; i++) f.insert(f.event(i + 1, { policy_id: "policy" }));
  f.open();
  let visited = 0, pagePayloads = 0;
  f.db.function("owner_scan_probe", id => { assert.ok(id.startsWith("event-")); visited++; return 1; });
  const exec = f.state.storage.sql.exec;
  let aggregate;
  f.state.storage.sql.exec = (sql, ...bindings) => {
    if (sql.includes("FROM usage_events INDEXED BY usage_events_policy_principal WHERE")) sql = sql.replace("FROM usage_events INDEXED BY usage_events_policy_principal WHERE", "FROM usage_events INDEXED BY usage_events_policy_principal WHERE owner_scan_probe(id) AND");
    const rows = exec(sql, ...bindings);
    if (sql.includes("SELECT dimension, dimension_value")) aggregate = { sql, bindings };
    if (sql.includes("SELECT ledger.event_json FROM page") || sql.startsWith("SELECT event_json FROM usage_events")) { pagePayloads = rows.length; assert.ok(pagePayloads <= 3); }
    return rows;
  };
  assert.equal(f.report().metrics.calls, 7); assert.equal(visited, 7);
  const plan = f.db.prepare("EXPLAIN QUERY PLAN " + aggregate.sql).all(...aggregate.bindings).map(row => row.detail);
  assert.ok(plan.some(detail => /SEARCH usage_events USING INDEX usage_events_policy_principal \(policy_id=\? AND principal_key=\? AND occurred_at_ms>\? AND occurred_at_ms<\?\)/.test(detail)), plan.join("\n"));
  assert.equal(plan.filter(detail => detail.includes("SEARCH usage_events USING INDEX usage_events_policy_principal")).length, 1);
  f.state.storage.transactionSync(() => {
    for (let i = 0; i < 12000; i++) f.insert(f.event(1000 + i, { id: "unrelated-" + i, policy_id: "policy", principal_id: "bob@example.com", occurred_at_ms: now - 1000 }));
    // Poison every unrelated payload; any accidental JSON parse outside owner scope fails.
    f.db.exec("UPDATE usage_events SET event_json = 'not-json' WHERE principal_key = 'bob@example.com'");
  });
  visited = 0; assert.equal(f.report().metrics.calls, 7); assert.equal(visited, 7);
  visited = 0; const page = f.events(f.query(), 2); assert.equal(page.events.length, 3); assert.equal(pagePayloads, 3); assert.ok(visited <= 4, "only the keyset page plus ordering lookahead is visited");
  const eventSql = f.queries.findLast(sql => sql.startsWith("SELECT event_json FROM usage_events"));
  assert.match(eventSql, /ORDER BY occurred_at_ms DESC, id COLLATE BINARY DESC LIMIT \?/);
  const eventPlan = f.db.prepare("EXPLAIN QUERY PLAN " + eventSql).all("tenant", "policy", "alice@example.com", f.query().range.from, f.query().range.to, 3).map(row => row.detail);
  assert.ok(eventPlan.some(detail => /SEARCH usage_events USING INDEX usage_events_policy_principal/.test(detail)), eventPlan.join("\n"));
});

test("SQL scalar projection exactly matches JS classification, counters, filters and migrated reports", () => {
  const f = usageReportFixture(now), records = [];
  const add = extra => records.push(f.event(records.length + 1, { policy_id: "policy", grant_lane: "api_key", actual_cost_micros: 7, input_tokens: 100, output_tokens: 20, ...(Object.values(extra).includes(Number.MAX_SAFE_INTEGER) ? { model: "wide" } : {}), ...extra }));
  for (const cost_basis of [...Object.keys(knownBasisClasses), "partial", "partial_usage", "unpriced_usage", "unpriced_modifier", "flat_fallback", "unknown", null]) {
    for (const actual_cost_micros of [0, 7, null, -1, 1.5, "7", Number.MAX_SAFE_INTEGER + 1]) add({ cost_basis, actual_cost_micros });
  }
  for (const reporting_known_cost_micros of [null, 0, 3, 7, 8, -1, 1.5, "3", true, Number.MAX_SAFE_INTEGER + 1]) add({ cost_basis: "unpriced_usage", reporting_known_cost_micros });
  for (const reporting_estimated_cost_micros of [0, 5, null, -1, "5", true, 1.5, Number.MAX_SAFE_INTEGER + 1]) for (const reporting_estimate_reason of ["reason", "", null, 1, "\0reason"]) add({ cost_basis: "unpriced_usage", actual_cost_micros: 0, reporting_estimated_cost_micros, reporting_estimate_reason });
  for (const field of ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"]) for (const value of [0, 3, null, -1, 1.5, "3", true, 101, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) add({ [field]: value });
  for (const grant_lane of ["environment", "subscription", null, "other"]) add({ grant_lane });
  for (const extra of [{ cached_input_tokens: 80, cache_write_input_tokens: 30 }, { cached_input_tokens: 40, cache_write_input_tokens: 60 }, { request_format: "anthropic.messages", capability: "llm.count_tokens" }, { request_format: "openai.models" }, { model: null, credential_id: null }]) add(extra);
  // SQL NOT NULL canonical columns are bookkeeping; raw JSON remains the retained evidence.
  for (const event of records) { f.insert({ ...event, actual_cost_micros: typeof event.actual_cost_micros === "number" && Number.isFinite(event.actual_cost_micros) ? event.actual_cost_micros : 0 }); f.db.prepare("UPDATE usage_events SET event_json = ? WHERE id = ?").run(JSON.stringify(event), event.id); }
  f.open();
  const all = { ...f.query(), filters: { model: "synthetic-model" } };
  const fallback = f.report(all);
  for (const event of records) {
    const detail = projectUsageEvent(event), q = { ...f.query(), filters: { model: undefined } };
    // Isolate each row with a one-millisecond half-open range.
    q.range = { ...q.range, from: event.occurred_at_ms, to: event.occurred_at_ms + 1, buckets: [] };
    const row = queryUsageReport(f.state.storage.sql, q).rows.find(row => row.dimension === "total");
    assert.equal(row.costClass, detail.costClass, event.id); assert.equal(row.lane, detail.lane, event.id); assert.equal(row.amountMicros, detail.reportingCostMicros ?? 0, event.id);
    for (const [key, coverage] of [["inputTokens", "inputReportedCalls"], ["outputTokens", "outputReportedCalls"], ["cachedInputTokens", "cacheReadReportedCalls"], ["cacheWriteInputTokens", "cacheWriteReportedCalls"], ["reasoningOutputTokens", "reasoningReportedCalls"]]) { assert.equal(row[key], detail[key] ?? 0, event.id + key); assert.equal(row[coverage], detail[key] === null ? 0 : 1, event.id + coverage); }
    const filtered = queryUsageEvents(f.state.storage.sql, { ...q, filters: { costClass: detail.costClass, lane: detail.lane } }, 1).events;
    assert.deepEqual(filtered, [detail]);
    assert.equal(queryUsageEvents(f.state.storage.sql, { ...q, filters: { costClass: detail.costClass === "unknown" ? "fixed" : "unknown" } }, 1).events.length, 0);
  }
  f.migrate({ apply: true, batchSize: 2000 });
  assert.deepEqual(content(f.report(all)), content(fallback));
});

test("retained event keysets are stable at equal timestamps and filters precede bounded pages", () => {
  const f = usageReportFixture(now), at = now - 1000;
  for (const id of ["a", "b", "😀", "z", "drop"]) f.insert(f.event(1, { id, policy_id: "policy", occurred_at_ms: at, model: id === "drop" ? "excluded" : "kept", cost_basis: "unpriced_usage", actual_cost_micros: 9 }));
  f.open(); const q = { ...f.query(), filters: { model: "kept", costClass: "unknown" } }, ids = []; let before;
  for (let i = 0; i < 5; i++) { const page = f.events(q, 1, before).events; if (!page.length) break; ids.push(page[0].id); before = { at: page[0].occurredAt, id: page[0].id }; }
  assert.deepEqual(ids, ["😀", "z", "b", "a"]);
  for (const e of f.events(q, 100).events) { assert.equal(e.reportingCostMicros, null); assert.equal(e.recordedChargeMicros, 9); }
});

test("public preset whitelist admits only server-validated days and exact returned bounds remain reusable", () => {
  for (const days of ["7", "30"]) {
    const query = parseUsageReportQuery(params({ days }), now);
    const exact = parseUsageReportQuery(params({ from: new Date(query.range.from).toISOString(), to: new Date(query.range.to).toISOString() }), now);
    assert.equal(exact.range.from, query.range.from); assert.equal(exact.range.to, query.range.to);
  }
  for (const days of ["0", "8", "31", "7.0", "07"]) assert.throws(() => parseUsageReportQuery(params({ days }), now));
});


test("direct readers reject unbounded ledger ranges and never invent ownership for unindexed older rows", () => {
  const f = usageReportFixture(now);
  f.insert(f.event(1, { policy_id: "policy" }));
  f.db.prepare("UPDATE usage_events SET principal_key = NULL").run();
  f.db.prepare("UPDATE usage_attribution_migration SET complete = 0, upper_rowid = 1").run();
  f.open(); f.queries.length = 0;
  const report = f.report();
  assert.equal(report.metrics.calls, 0); assert.equal(report.historyComplete, false); assert.equal(report.projectionComplete, false); assert.equal(report.historySource, "retained_ledger");
  assert.equal(f.events().events.length, 0);
  assert.ok(f.queries.every(sql => !/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i.test(sql)));
  const q = f.query(); q.range = { ...q.range, from: now - 31 * 86400000 };
  assert.throws(() => queryUsageReport(f.state.storage.sql, q), /bounded retained range/);
  assert.throws(() => queryUsageEvents(f.state.storage.sql, q, 1), /bounded retained range/);
});
