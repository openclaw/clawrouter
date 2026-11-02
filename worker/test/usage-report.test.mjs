import assert from "node:assert/strict";
import test from "node:test";
import { usageReportFixture } from "./usage-report-fixture.mjs";
import { migrateUsageReport, projectUsageEvent, queryUsageReport, reportingCost } from "../usage-report-store.ts";
import { parseUsageReportQuery, personalUsage, mapUsageShards, mergeUsageReports } from "../usage-report.ts";
import { parseUsageReportRange, usageDateTools } from "../usage-report-range.ts";
const now = Date.parse("2026-11-02T12:00:00Z");
const params = data => new URLSearchParams(data);

test("exact fractional timezone and DST day boundaries, half-open dates and retention clipping", () => {
  const kathmandu = usageDateTools("Asia/Kathmandu");
  assert.equal(kathmandu.midnight("2026-11-01"), Date.parse("2026-10-31T18:15:00Z"));
  const ny = parseUsageReportRange(params({ from: "2026-10-31", to: "2026-11-02", timezone: "America/New_York" }), now);
  assert.deepEqual(ny.buckets.map(b => [b.label, (b.end - b.start) / 3_600_000]), [["2026-10-31", 24], ["2026-11-01", 25]]);
  const spring = parseUsageReportRange(params({ from: "2026-03-08", to: "2026-03-09", timezone: "America/New_York" }), Date.parse("2026-03-10T12:00:00Z"));
  assert.equal(spring.buckets[0].end - spring.buckets[0].start, 23 * 3_600_000);
  const lordHowe = usageDateTools("Australia/Lord_Howe");
  assert.equal(lordHowe.midnight("2026-10-05") - lordHowe.midnight("2026-10-04"), 23.5 * 3_600_000);
  const clipped = parseUsageReportRange(params({ from: "2026-10-03", to: "2026-11-02" }), now);
  assert.equal(clipped.clampedStart, true); assert.equal(clipped.from, now - 30 * 86_400_000);
  assert.equal(parseUsageReportRange(params({}), now).to - parseUsageReportRange(params({}), now).from, 7 * 86_400_000);
  assert.throws(() => parseUsageReportRange(params({ timezone: "+05:45" }), now));
  assert.throws(() => parseUsageReportRange(params({ from: "2026-02-30", to: "2026-03-01" }), now));
  assert.throws(() => parseUsageReportRange(params({ from: "2026-09-01", to: "2026-11-01" }), now));
  assert.throws(() => parseUsageReportRange(params({ from: "2026-10-01T12:00:00", to: "2026-10-02" }), now));
});

test("owner AND tenant AND policy AND key filters precede aggregation and LIMIT; report never reads payload JSON", async () => {
  const f = usageReportFixture(); const ledger = f.open();
  for (let i = 0; i < 9; i++) await f.ingest(ledger, f.event(i, { policy_id: "policy", ...(i === 1 ? { principal_id: "bob@example.com" } : i === 2 ? { tenant_id: "other" } : i === 3 ? { policy_id: "other" } : i === 4 ? { credential_id: "key-b" } : {}), actual_cost_micros: 5 }));
  f.queries.length = 0;
  const report = f.report(f.query(params({ key: "key-a" })));
  assert.equal(report.metrics.calls, 5); assert.equal(report.historyComplete, true);
  assert.equal(report.groups.length, 1); assert.equal("events" in report, false);
  assert.equal(report.metrics.inputReportedCalls, 5);
  assert.ok(f.queries.every(q => !q.includes("event_json") && !q.includes("detail_json")));
  const aggregation = f.queries.find(q => q.includes("WITH filtered"));
  assert.match(aggregation, /INDEXED BY usage_report_owner_range/);
  const plan = f.db.prepare("EXPLAIN QUERY PLAN " + aggregation).all("tenant", "policy", "alice@example.com", report.range.from, report.range.to, "key-a");
  assert.ok(plan.some(p => /SEARCH usage_report_events USING INDEX usage_report_owner_range/.test(p.detail)));
});

test("atomic idempotent projection and explicit allowlist; reported zero is not missing", async () => {
  const f = usageReportFixture(); const ledger = f.open();
  const event = f.event(1, { policy_id: "policy", input_tokens: null, output_tokens: 0, reasoning_output_tokens: 4, session_id: "private-session", content_ref: "private-content", grant_key: "private-credential", actual_cost_micros: 7 });
  assert.equal((await (await f.ingest(ledger, event)).json()).outcome, "stored");
  await f.ingest(ledger, { ...event, actual_cost_micros: 999 });
  assert.equal(f.report().metrics.calls, 1);
  assert.equal(f.report().metrics.inputReportedCalls, 0); assert.equal(f.report().metrics.outputReportedCalls, 1);
  const detail = f.events().events[0]; assert.equal(detail.reasoningOutputTokens, null); assert.equal(f.report().metrics.reasoningReportedCalls, 0);
  assert.equal(JSON.parse(f.db.prepare("SELECT event_json FROM usage_events WHERE id = ?").get(event.id).event_json).reasoning_output_tokens, 4); assert.equal(detail.recordedChargeMicros, 7);
  for (const secret of ["private-session", "private-content", "private-credential"]) assert.ok(!JSON.stringify(detail).includes(secret));
  const original = f.state.storage.sql.exec;
  f.state.storage.sql.exec = (q, ...args) => { if (q.startsWith("INSERT OR IGNORE INTO usage_report_events")) throw new Error("projection failed"); return original(q, ...args); };
  await assert.rejects(f.ingest(ledger, { ...event, id: "rollback" }));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE id = 'rollback'").get().n, 0);
});

test("utility is only known request format and its costs/tokens and success/error/denied calls remain included", async () => {
  const f = usageReportFixture(); const ledger = f.open();
  for (const [i, format] of ["openai.models", "anthropic.models", "openai.responses_input_tokens", "anthropic.count_tokens", "openai.moderations", "future.utility"].entries()) {
    await f.ingest(ledger, f.event(i + 1, { policy_id: "policy", request_format: format, input_tokens: 10, output_tokens: 2, actual_cost_micros: 3, status: i === 1 ? "provider_error" : i === 2 ? "denied" : "success" }));
  }
  const report = f.report(); assert.equal(report.metrics.calls, 6); assert.equal(report.metrics.utilityCalls, 5); assert.equal(report.metrics.generationCalls, 1);
  assert.equal(report.metrics.successfulCalls, 4); assert.equal(report.metrics.errorCalls, 1); assert.equal(report.metrics.deniedCalls, 1);
  assert.equal(report.metrics.inputTokens, 60); assert.equal(report.costs.reduce((n, c) => n + c.amountMicros, 0), 18);
});

test("cost classes preserve actual basis and keep unknown debits separate from no-charge; all lanes", () => {
  const f = usageReportFixture();
  for (const [basis, expected] of Object.entries({ manifest_pricing: "calculated", realtime_modality_usage: "calculated", realtime_input_transcription_usage: "calculated", policy_fixed: "fixed", request_character_estimate: "estimated", manifest_reservation: "estimated", manifest_rate_upper_bound: "upper_bound", partial_usage: "partial", unpriced_usage: "unknown", flat_fallback: "unknown", unknown_future: "unknown", none: "no_charge" })) {
    const e = f.event(1, { cost_basis: basis, actual_cost_micros: 0 }); assert.equal(reportingCost(e).costClass, expected);
    if (expected === "unknown") assert.equal(projectUsageEvent(e).reportingCostMicros, null);
  }
  assert.equal(reportingCost(f.event(1, { cost_basis: "none", actual_cost_micros: 8 })).costClass, "unknown");
  const estimate = projectUsageEvent(f.event(1, { cost_basis: "unpriced_usage", actual_cost_micros: 0, reporting_estimated_cost_micros: 15, reporting_estimate_reason: "cache_write_unreported_max_rate_allocation" }));
  assert.equal(estimate.costClass, "estimated"); assert.equal(estimate.reportingCostMicros, 15); assert.equal(estimate.recordedChargeMicros, 0); assert.equal(estimate.estimateReason, "cache_write_unreported_max_rate_allocation");
  assert.equal(reportingCost(f.event(1, { cost_basis: "unknown_future", actual_cost_micros: 3, reporting_estimated_cost_micros: 15, reporting_estimate_reason: "must-not-override-recorded-debit" })).costClass, "unknown");
  assert.equal(reportingCost(f.event(1, { cost_basis: "policy_fixed", actual_cost_micros: 7, reporting_estimated_cost_micros: 15, reporting_estimate_reason: "unused" })).amount, 7);
  assert.equal(projectUsageEvent(f.event(1, { request_format: "anthropic.messages", capability: "llm.count_tokens" })).callKind, "utility");
  assert.equal(projectUsageEvent(f.event(1, { request_format: "unknown.utility", capability: "llm.count_tokens" })).callKind, "generation");
  for (const [lane, expected] of [["api_key", "api"], ["environment", "api"], ["subscription", "subscription"], [null, "unattributed"]]) assert.equal(reportingCost(f.event(1, { grant_lane: lane })).lane, expected);
});

test("historical projection defaults dry-run, resumes bounded batches and never changes ledger/charge payload", () => {
  const f = usageReportFixture();
  for (let i = 0; i < 5; i++) f.insert(f.event(i + 1, { policy_id: "policy", metadata: "private" }));
  const before = f.db.prepare("SELECT * FROM usage_events ORDER BY rowid").all();
  const dry = f.migrate({ batchSize: 2 }); assert.equal(dry.dryRun, true); assert.equal(dry.examined, 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'usage_report_events'").get().n, 0);
  const ledger = f.open(); assert.ok(ledger); assert.equal(f.report().metrics.calls, 0); assert.equal(f.report().historyComplete, false);
  const a = f.migrate({ apply: true, batchSize: 2 }); assert.equal(a.complete, false); assert.equal(f.report().metrics.calls, 2);
  const preview = f.migrate({ batchSize: 2 }); assert.equal(preview.lastRowid, 4); assert.equal(f.report().metrics.calls, 2);
  f.migrate({ apply: true, batchSize: 2 }); const final = f.migrate({ apply: true, batchSize: 2 }); assert.equal(final.complete, true);
  assert.equal(f.report().metrics.calls, 5); assert.equal(f.report().historyComplete, true);
  assert.deepEqual(f.db.prepare("SELECT * FROM usage_events ORDER BY rowid").all().map(row => Object.fromEntries(Object.keys(before[0]).map(k => [k, row[k]]))), before.map(row => ({ ...row })));
  assert.equal(f.migrate({ apply: true }).examined, 0);
});

test("migration projection and progress rollback together on failure", () => {
  const f = usageReportFixture(); for (let i = 1; i < 4; i++) f.insert(f.event(i, { policy_id: "policy" })); f.open();
  const original = f.state.storage.sql.exec;
  const sql = { exec(q, ...bindings) { if (q.startsWith("INSERT OR IGNORE INTO usage_report_events") && bindings[0] === "event-2") throw new Error("disk"); return original(q, ...bindings); } };
  assert.throws(() => migrateUsageReport(sql, f.state.storage.transactionSync, { apply: true }));
  assert.equal(f.report().metrics.calls, 0); assert.equal(f.db.prepare("SELECT last_rowid FROM usage_report_migration").get().last_rowid, 0);
});

test("at most 100 lexical groups with honest truncation and complete totals/buckets", () => {
  const f = usageReportFixture(); for (let i = 1; i <= 130; i++) f.insert(f.event(i, { policy_id: "policy", model: "model-" + String(i).padStart(3, "0") })); f.open(); f.migrate({ apply: true });
  const report = f.report(); assert.equal(report.groups.length, 100); assert.equal(report.groupsTruncated, true);
  assert.equal(report.metrics.calls, 130); assert.equal(report.buckets.reduce((n, b) => n + b.metrics.calls, 0), 130);
  assert.equal(report.groups.at(-1).value, "model-100");
});

function envFor(fixtures, failing) {
  return { USAGE_LEDGER: { idFromName: n => n, get: n => ({ async fetch(url, init) { if (n === failing) return new Response("unavailable", { status: 503 }); return fixtures.get(n).open().fetch(new Request(url, init)); } }) } };
}
test("cross-shard global keyset pagination handles equal timestamps, query/owner binding and fail-closed shards", async () => {
  const f = usageReportFixture(); const g = usageReportFixture(f.now);
  const at = f.now - 1000;
  for (const [fixture, policy, ids] of [[f, "policy", ["a", "c", "e"]], [g, "policy2", ["b", "d", "f"]]]) {
    const ledger = fixture.open(); for (const id of ids) await fixture.ingest(ledger, fixture.event(1, { id, policy_id: policy, occurred_at_ms: at }));
  }
  const env = envFor(new Map([["policy:tenant:policy", f], ["policy:tenant:policy2", g]]));
  const policies = [{ tenantId: "tenant", policyId: "policy" }, { tenantId: "tenant", policyId: "policy2" }];
  const p = params({ limit: "2" }); const ids = [];
  do { const page = await personalUsage(env, policies, "alice@example.com", p, true, f.now); ids.push(...page.events.map(e => e.id)); if (page.nextCursor) p.set("cursor", page.nextCursor); else break; } while (ids.length < 20);
  assert.deepEqual(ids, ["f", "e", "d", "c", "b", "a"]);
  await assert.rejects(personalUsage(env, policies, "bob@example.com", p, true, f.now), /cursor/);
  p.set("model", "different"); await assert.rejects(personalUsage(env, policies, "alice@example.com", p, true, f.now), /cursor/);
  await assert.rejects(personalUsage(envFor(new Map([["policy:tenant:policy", f]]), "policy:tenant:policy2"), policies, "alice@example.com", params({}), false, f.now), /unavailable/);
  const combined = await personalUsage(env, policies, "alice@example.com", params({}), false, f.now); assert.equal(combined.metrics.calls, 6);
});

test("all exact filters, query validation, half-open timestamps and SQL injection-safe values", async () => {
  const f = usageReportFixture(); const ledger = f.open(); const at = f.now - 2000;
  await f.ingest(ledger, f.event(1, { policy_id: "policy", occurred_at_ms: at, provider: "openai", model: "m", credential_id: "k", status: "denied", cost_basis: "policy_fixed", grant_lane: "subscription" }));
  const q = f.query(params({ model: "m", provider: "openai", key: "k", status: "denied", costClass: "fixed", lane: "subscription" })); assert.equal(f.report(q).metrics.calls, 1);
  assert.equal(f.report(f.query(params({ model: "m' OR 1=1 --" }))).metrics.calls, 0);
  const range = f.query(params({ from: new Date(at - 1).toISOString(), to: new Date(at).toISOString() })); assert.equal(f.report(range).metrics.calls, 0);
  for (const p of [{ principal: "bob@example.com" }, { groupBy: "identity" }, { limit: "101" }, { costClass: "free" }, { lane: "pool" }]) assert.throws(() => parseUsageReportQuery(params(p), f.now));
  assert.throws(() => parseUsageReportQuery(new URLSearchParams("model=a&model=b"), f.now));
});

test("bounded fan-out observes every shard once and limits concurrency to eight", async () => {
  let active = 0, maximum = 0, visited = 0;
  const policies = Array.from({ length: 23 }, (_, i) => ({ tenantId: "tenant", policyId: String(i) }));
  const values = await mapUsageShards([...policies, policies[0]], async p => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 1)); visited++; active--; return p.policyId; });
  assert.equal(visited, 23); assert.equal(maximum, 8); assert.equal(values.length, 23);
});


test("empty retained range is a zero report, missing counters have zero coverage, and unsafe aggregate sums fail closed", () => {
  const f = usageReportFixture(); f.open();
  const report = f.report(f.query(params({ from: "2026-01-01", to: "2026-01-02" })));
  assert.equal(report.metrics.calls, 0); assert.equal(report.buckets.length, 0); assert.deepEqual(report.costs, []);
  const query = f.query();
  const row = { ...report.metrics, calls: Number.MAX_SAFE_INTEGER, dimension: "total", value: null, lane: "api", costClass: "fixed", amountMicros: 0 };
  assert.throws(() => mergeUsageReports([{ rows: [row, { ...row, calls: 1 }], historyComplete: false, groupsTruncated: false }], query), /numeric bounds/);
});

test("a silently skipped reporting insert cannot acknowledge or leave the original usage row", async () => {
  const f = usageReportFixture(); const ledger = f.open(), original = f.state.storage.sql.exec;
  f.state.storage.sql.exec = (q, ...bindings) => q.startsWith("INSERT OR IGNORE INTO usage_report_events") ? [] : original(q, ...bindings);
  await assert.rejects(f.ingest(ledger, f.event(1, { policy_id: "policy" })), /confirm reporting projection/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 0);
});


test("SQL buckets use exact DST/fractional boundaries and provider/key dimensions preserve null groups", async (t) => {
  t.mock.method(Date, "now", () => now);
  const f = usageReportFixture(), ledger = f.open();
  const cases = [
    ["2026-11-01T04:00:00Z", "openai", "key-a"],
    ["2026-11-01T06:30:00Z", "anthropic", null],
    ["2026-11-02T05:00:00Z", "openai", "key-a"],
    ["2026-11-01T03:59:59.999Z", "openai", "key-a"],
  ];
  for (const [i, [time, provider, credential_id]] of cases.entries()) await f.ingest(ledger, f.event(i + 1, { policy_id: "policy", occurred_at_ms: Date.parse(time), provider, credential_id }));
  const range = { from: "2026-11-01", to: "2026-11-02", timezone: "America/New_York" };
  const report = f.report(f.query(params({ ...range, groupBy: "provider" })));
  assert.equal(report.metrics.calls, 2); assert.equal(report.buckets.length, 1); assert.equal(report.buckets[0].metrics.calls, 2); assert.equal((report.buckets[0].end - report.buckets[0].start) / 3600000, 25);
  assert.deepEqual(report.groups.map(g => g.value), ["anthropic", "openai"]);
  assert.deepEqual(f.report(f.query(params({ ...range, groupBy: "key" }))).groups.map(g => g.value), [null, "key-a"]);
  const g = usageReportFixture(), owner = g.open();
  for (const [i, time] of ["2026-10-31T18:15:00Z", "2026-11-01T18:14:59.999Z", "2026-11-01T18:15:00Z"].entries()) await g.ingest(owner, g.event(i + 1, { policy_id: "policy", occurred_at_ms: Date.parse(time) }));
  const fractional = g.report(g.query(params({ from: "2026-11-01", to: "2026-11-02", timezone: "Asia/Kathmandu" })));
  assert.equal(fractional.metrics.calls, 2); assert.equal(fractional.buckets[0].start, Date.parse("2026-10-31T18:15:00Z")); assert.equal(fractional.buckets[0].end, Date.parse("2026-11-01T18:15:00Z"));
});


test("key reporting uses personal credential IDs only; dashboard sessions never become policy keys", async () => {
  const f = usageReportFixture(), ledger = f.open();
  for (const [i, credential_id] of ["personal-key-a", "personal-key-b", null].entries()) await f.ingest(ledger, f.event(i + 1, { policy_id: "policy", key_id: "policy-fallback", credential_id, grant_key: "upstream-handle" }));
  assert.deepEqual(f.report(f.query(params({ groupBy: "key" }))).groups.map(g => g.value), [null, "personal-key-a", "personal-key-b"]);
  assert.equal(f.report(f.query(params({ key: "policy-fallback" }))).metrics.calls, 0);
  assert.equal(f.report(f.query(params({ key: "personal-key-a" }))).metrics.calls, 1);
  const details = f.events().events; assert.deepEqual(details.map(e => e.keyId).sort(), ["personal-key-a", "personal-key-b", null].sort()); assert.ok(!JSON.stringify(details).includes("upstream-handle"));
});

test("unpriced positive recorded components are partial, realtime measurements calculated, reservation estimates not qualified bounds", () => {
  const f = usageReportFixture();
  for (const cost_basis of ["unpriced_usage", "unpriced_request", "unpriced_modifier", "unpriced_service_tier"]) {
    assert.deepEqual(reportingCost(f.event(1, { grant_lane: "api_key", cost_basis, actual_cost_micros: 7, reporting_estimated_cost_micros: 99, reporting_estimate_reason: "estimate" })), { lane: "api", costClass: "partial", amount: 7 });
  }
  for (const cost_basis of ["realtime_modality_usage", "realtime_input_transcription_usage"]) assert.equal(reportingCost(f.event(1, { cost_basis, actual_cost_micros: 7 })).costClass, "calculated");
  assert.equal(reportingCost(f.event(1, { cost_basis: "manifest_reservation", actual_cost_micros: 7 })).costClass, "estimated");
  assert.equal(reportingCost(f.event(1, { cost_basis: "realtime_full_context_bound", actual_cost_micros: 7 })).costClass, "upper_bound");
});

test("migration dry-run summarizes lane/class counts and proposed amounts separately from raw debit without event payloads", () => {
  const f = usageReportFixture();
  const records = [
    { grant_lane: "api_key", cost_basis: "unpriced_usage", actual_cost_micros: 5 },
    { grant_lane: "environment", cost_basis: "unpriced_modifier", actual_cost_micros: 7, reporting_estimated_cost_micros: 99, reporting_estimate_reason: "not-used" },
    { grant_lane: "subscription", cost_basis: "unpriced_usage", actual_cost_micros: 0, reporting_estimated_cost_micros: 11, reporting_estimate_reason: "missing-counter-estimate" },
    { grant_lane: null, cost_basis: "unrecognized_future", actual_cost_micros: 3 },
    { grant_lane: "api_key", cost_basis: "none", actual_cost_micros: 0 },
    { grant_lane: null, cost_basis: "unpriced_usage", actual_cost_micros: 0, model: "openai/gpt-6.1-sol", pricing_ref: "retained-reference-without-recorded-estimate" },
  ];
  records.forEach((extra, i) => f.insert(f.event(i + 1, { policy_id: "policy", session_id: "private-session", content_ref: "private-content", ...extra })));
  const before = f.db.prepare("SELECT event_json FROM usage_events ORDER BY rowid").all().map(r => r.event_json);
  const preview = f.migrate();
  assert.deepEqual(preview.effects, [
    { lane: "api", costClass: "no_charge", calls: 1, proposedReportingMicros: 0, recordedChargeMicros: 0 },
    { lane: "api", costClass: "partial", calls: 2, proposedReportingMicros: 12, recordedChargeMicros: 12 },
    { lane: "subscription", costClass: "estimated", calls: 1, proposedReportingMicros: 11, recordedChargeMicros: 0 },
    { lane: "unattributed", costClass: "unknown", calls: 2, proposedReportingMicros: null, recordedChargeMicros: 3 },
  ]);
  assert.ok(!JSON.stringify(preview).includes("private")); assert.ok(!JSON.stringify(preview).includes("alice@example.com")); assert.ok(!JSON.stringify(preview).includes("event-"));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'usage_report_events'").get().n, 0);
  assert.deepEqual(f.migrate({ apply: true }).effects, preview.effects);
  assert.deepEqual(f.db.prepare("SELECT event_json FROM usage_events ORDER BY rowid").all().map(r => r.event_json), before);
});


test("empty shard starts history-complete while preexisting history stays pending without automatic projection", async () => {
  const fresh = usageReportFixture(); let ledger = fresh.open();
  assert.equal(fresh.db.prepare("SELECT upper_rowid FROM usage_report_migration").get().upper_rowid, 0);
  assert.equal(fresh.report().historyComplete, true);
  await fresh.ingest(ledger, fresh.event(1, { policy_id: "policy" })); ledger = fresh.open(); await ledger.alarm();
  assert.equal(fresh.report().historyComplete, true); assert.equal(fresh.report().metrics.calls, 1);
  const historical = usageReportFixture(); historical.insert(historical.event(1, { policy_id: "policy" })); ledger = historical.open(); await ledger.alarm();
  assert.equal(historical.report().historyComplete, false); assert.equal(historical.report().metrics.calls, 0);
  assert.equal(historical.db.prepare("SELECT complete FROM usage_report_migration").get().complete, 0);
  assert.equal(historical.migrate().dryRun, true); assert.equal(historical.report().historyComplete, false);
  historical.migrate({ apply: true }); assert.equal(historical.report().historyComplete, true); assert.equal(historical.report().metrics.calls, 1);
});


test("projection validates reasoning/output subsets and disjoint cache allocations without changing raw history", () => {
  const f = usageReportFixture();
  const records = [
    { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40, cache_write_input_tokens: 60, reasoning_output_tokens: 20 },
    { input_tokens: 100, output_tokens: 20, cached_input_tokens: 101, cache_write_input_tokens: 10, reasoning_output_tokens: 21 },
    { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80, cache_write_input_tokens: 30, reasoning_output_tokens: 0 },
    { input_tokens: null, output_tokens: null, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 },
    { input_tokens: 100, output_tokens: 0, cached_input_tokens: -1, cache_write_input_tokens: 101, reasoning_output_tokens: 4 },
  ];
  records.forEach((extra, i) => f.insert(f.event(i + 1, { policy_id: "policy", ...extra })));
  const before = f.db.prepare("SELECT event_json FROM usage_events ORDER BY id").all().map(r => r.event_json);
  f.open(); f.migrate({ apply: true });
  const details = f.events().events.sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(details.map(e => [e.cachedInputTokens, e.cacheWriteInputTokens, e.reasoningOutputTokens]), [[40, 60, 20], [null, 10, null], [null, null, 0], [null, null, null], [null, null, null]]);
  const metrics = f.report().metrics;
  assert.equal(metrics.cachedInputTokens, 40); assert.equal(metrics.cacheWriteInputTokens, 70); assert.equal(metrics.reasoningOutputTokens, 20);
  assert.equal(metrics.cacheReadReportedCalls, 1); assert.equal(metrics.cacheWriteReportedCalls, 2); assert.equal(metrics.reasoningReportedCalls, 2);
  assert.deepEqual(f.db.prepare("SELECT event_json FROM usage_events ORDER BY id").all().map(r => r.event_json), before);
  for (const field of ["reasoning_output_tokens", "cached_input_tokens", "cache_write_input_tokens"]) for (const invalid of [-1, 0.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    const detail = projectUsageEvent(f.event(1, { input_tokens: 100, output_tokens: 20, [field]: invalid }));
    assert.equal(detail[{ reasoning_output_tokens: "reasoningOutputTokens", cached_input_tokens: "cachedInputTokens", cache_write_input_tokens: "cacheWriteInputTokens" }[field]], null);
  }
});
