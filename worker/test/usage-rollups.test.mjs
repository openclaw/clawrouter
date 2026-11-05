import assert from "node:assert/strict";
import test from "node:test";
import { backfillUsageRollups, usageRollupProgress } from "../usage-rollups.ts";
import { mergeUsageSnapshots, usageCutoffs } from "../usage-sharding.ts";
import { normalizeEmail } from "../utils.ts";
import { legacySnapshot, snapshotRequest, syntheticUsage, usageFixture } from "./usage-snapshot-fixture.mjs";

const day = 86_400_000, now = Date.parse("2026-11-05T12:34:56.789Z");
const scopes = [{ kind: "admin" }, { kind: "principal", id: " ALICE@example.com " }, { kind: "principal", id: "\u2003İDA@EXAMPLE.COM\u00a0" }, { kind: "credential", id: "credential-0" }, { kind: "principal", id: "invalid" }];
const ingest = (ledger, event) => ledger.fetch(new Request("https://ledger/ingest", { method: "POST", body: JSON.stringify(event) }));
function update(f, id, change) {
  const event = { ...JSON.parse(f.db.prepare("SELECT event_json FROM usage_events WHERE id = ?").get(id).event_json), ...change };
  const p = typeof event.principal_id === "string" ? event.principal_id : null;
  f.db.prepare("UPDATE usage_events SET occurred_at_ms=?, policy_id=?, provider=?, status=?, input_tokens=?, output_tokens=?, total_tokens=?, actual_cost_micros=?, event_json=?, principal_id=?, principal_key=?, credential_id=?, cost_basis=?, principal_nontext=? WHERE id=?")
    .run(event.occurred_at_ms, event.policy_id, event.provider, event.status, event.input_tokens, event.output_tokens, event.total_tokens, event.actual_cost_micros, JSON.stringify(event), p, p === null ? null : normalizeEmail(p), typeof event.credential_id === "string" ? event.credential_id : null, event.cost_basis ?? null, event.principal_id != null && p === null ? 1 : 0, id);
}
function assertCoveredRows(f) {
  const p = usageRollupProgress(f.state.storage.sql), expected = new Map();
  const attribution = f.db.prepare("SELECT * FROM usage_attribution_migration").get();
  for (const row of f.db.prepare("SELECT rowid, * FROM usage_events WHERE ? = 1 OR rowid <= ? OR rowid > ?").all(p.complete, p.last_rowid, p.upper_rowid)) {
    const pending = !attribution.complete && row.rowid > attribution.last_rowid && row.rowid <= attribution.upper_rowid;
    const event = JSON.parse(row.event_json), principal = row.principal_key ?? row.principal_id ?? (pending && typeof event.principal_id === "string" ? event.principal_id : null);
    const credential = row.credential_id ?? (pending && typeof event.credential_id === "string" ? event.credential_id : null);
    const key = JSON.stringify([row.policy_id, Math.trunc(row.occurred_at_ms / day) * day, row.provider, JSON.stringify(principal), JSON.stringify(credential), pending ? (event.principal_id != null && typeof event.principal_id !== "string" ? 1 : 0) : row.principal_nontext]);
    const counts = expected.get(key) ?? [0,0,0,0,0,0,0,0];
    const amounts = [1, row.status === "success" ? 1 : 0, row.status !== "success" ? 1 : 0, row.total_tokens ?? 0, row.actual_cost_micros ?? 0, (pending ? event.cost_basis : row.cost_basis) === "unpriced_usage" ? 1 : 0, row.input_tokens ?? 0, row.output_tokens ?? 0];
    amounts.forEach((value, i) => counts[i] += value); expected.set(key, counts);
  }
  const actual = new Map(f.db.prepare("SELECT * FROM usage_rollups").all().map(row => [JSON.stringify([row.policy_id, row.day_start_ms, row.provider, row.principal_key, row.credential_key, row.principal_nontext]), [row.request_count, row.success_count, row.error_count, row.total_tokens, row.actual_cost_micros, row.unpriced_request_count, row.input_tokens, row.output_tokens]]));
  assert.deepEqual(actual, expected);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_rollups WHERE request_count <= 0").get().n, 0);
}
async function assertSnapshots(f, ledger) {
  for (const policies of [["policy"], ["policy", "other"], []]) {
    const expected = scopes.map(scope => legacySnapshot(f.db, scope, now, policies));
    const actual = [];
    for (const [i, scope] of scopes.entries()) {
      actual.push(await (await ledger.fetch(snapshotRequest(scope, policies))).json());
      assert.deepEqual(actual[i], expected[i]);
    }
    assert.deepEqual(mergeUsageSnapshots([actual[0], actual[0]], 7), mergeUsageSnapshots([expected[0], expected[0]], 7));
    assert.deepEqual(mergeUsageSnapshots([actual[1], actual[1]], 7), mergeUsageSnapshots([expected[1], expected[1]], 7));
  }
}

test("seeded equality across cursor stages, alias scopes, NULL counters, mutations and retention", async t => {
  t.mock.method(Date, "now", () => now);
  t.mock.method(console, "log", () => {});
  const f = usageFixture(); t.after(() => f.db.close());
  let seed = 337357;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  f.db.exec("BEGIN");
  for (let i = 0; i < 6_001; i++) {
    const event = { ...syntheticUsage(i, now), occurred_at_ms: now - random(31 * day), provider: ["openai", "anthropic", "google"][random(3)], status: ["success", "server_error", "client_error"][random(3)], input_tokens: random(4) ? random(500) : null, output_tokens: random(4) ? random(100) : null, total_tokens: random(4) ? random(600) : null, cost_basis: ["unpriced_usage", "unpriced_service_tier", "none", "manifest_pricing", null][random(5)] };
    f.insert(event);
  }
  const cutoffs = usageCutoffs(now);
  for (const [i, at] of [cutoffs.rolling - 1, cutoffs.rolling, cutoffs.rolling + 1, cutoffs.daily - 1, cutoffs.daily, cutoffs.daily + 1, now + day].entries()) f.insert({ ...syntheticUsage(1, now), id: `boundary-${i}`, occurred_at_ms: at });
  f.db.exec("COMMIT");
  let ledger = f.open();
  await assertSnapshots(f, ledger); assertCoveredRows(f);
  for (let stage = 0; stage < 5; stage++) {
    backfillUsageRollups(f.state.storage.sql, f.state.storage.transactionSync);
    assertCoveredRows(f);
    const { last_rowid: cursor, upper_rowid: upper } = usageRollupProgress(f.state.storage.sql);
    const rows = f.db.prepare("SELECT rowid, id FROM usage_events ORDER BY rowid").all();
    for (const row of [rows.find(r => r.rowid <= cursor), rows.find(r => r.rowid > cursor && r.rowid <= upper)].filter(Boolean)) {
      update(f, row.id, { policy_id: "other", principal_id: stage % 2 ? null : "\u2003İDA@EXAMPLE.COM\u00a0", credential_id: "credential-0", provider: "google", actual_cost_micros: 123, cost_basis: "unpriced_usage" });
      assertCoveredRows(f);
      f.db.prepare("DELETE FROM usage_events WHERE id = ?").run(row.id); assertCoveredRows(f);
    }
    const fresh = { ...syntheticUsage(1, now), id: `fresh-${stage}`, occurred_at_ms: now - stage };
    await ingest(ledger, fresh); await ingest(ledger, { ...fresh, actual_cost_micros: 999 });
    assertCoveredRows(f);
    ledger = f.open();
    await assertSnapshots(f, ledger); assertCoveredRows(f);
  }
  while (!usageRollupProgress(f.state.storage.sql).complete) await ledger.alarm();
  await assertSnapshots(f, ledger); assertCoveredRows(f);
  f.queries.length = 0;
  await ledger.fetch(snapshotRequest(scopes[0]));
  const reads = f.queries.filter(q => /^SELECT/i.test(q) && /FROM usage_events/i.test(q));
  assert.ok(reads.every(q => /^SELECT event_json .* LIMIT \?$/i.test(q)), reads.join("\n"));
});

test("batch failure rolls back additions and cursor; rowid reuse and rowid-changing UPDATE stay exact", async t => {
  t.mock.method(Date, "now", () => now);
  const f = usageFixture(); t.after(() => f.db.close());
  for (let i = 0; i < 4_100; i++) f.insert(syntheticUsage(i, now));
  let ledger = f.open();
  const exec = f.state.storage.sql.exec;
  f.state.storage.sql.exec = (query, ...args) => {
    if (query.startsWith("UPDATE usage_rollup_migration SET")) throw new Error("synthetic reset after additions");
    return exec(query, ...args);
  };
  assert.throws(() => backfillUsageRollups(f.state.storage.sql, f.state.storage.transactionSync), /synthetic reset/);
  assert.deepEqual({ ...usageRollupProgress(f.state.storage.sql) }, { last_rowid: 0, upper_rowid: 4100, complete: 0 });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM usage_rollups").get().n, 0);
  f.state.storage.sql.exec = exec; ledger = f.open();
  backfillUsageRollups(f.state.storage.sql, f.state.storage.transactionSync);
  // Move counted and pending rows across the cursor in both directions.
  f.db.exec("UPDATE usage_events SET rowid = 5000 WHERE rowid = 3000; UPDATE usage_events SET rowid = 3000 WHERE rowid = 1000");
  assertCoveredRows(f);
  // Old writer's omitted-column insert reuses an unprocessed rowid.
  f.db.exec("DELETE FROM usage_events WHERE rowid >= 4000");
  f.insert({ ...syntheticUsage(1, now), id: "old-writer-reuse", occurred_at_ms: now });
  assert.ok(f.db.prepare("SELECT rowid FROM usage_events WHERE id = 'old-writer-reuse'").get().rowid <= 4100);
  assertCoveredRows(f);
  while (!usageRollupProgress(f.state.storage.sql).complete) await ledger.alarm();
  await assertSnapshots(f, ledger); assertCoveredRows(f);
  // After completion, legacy inserts and deletes still run the stored triggers.
  f.insert({ ...syntheticUsage(1, now), id: "old-writer-complete", occurred_at_ms: now });
  update(f, "old-writer-complete", {});
  assertCoveredRows(f);
  f.db.exec("DELETE FROM usage_events"); assertCoveredRows(f);
  f.insert({ ...syntheticUsage(1, now), id: "reused-first-row", occurred_at_ms: now });
  update(f, "reused-first-row", {});
  assertCoveredRows(f);
});

test("completed projections remain authoritative when UPDATE sets nullable attribution and cost basis", async t => {
  t.mock.method(Date, "now", () => now);
  t.mock.method(console, "log", () => {});
  const f = usageFixture(); t.after(() => f.db.close());
  f.insert({ ...syntheticUsage(1, now), id: "nullable-update", cost_basis: "unpriced_usage" });
  const ledger = f.open(); await ledger.alarm();
  assert.equal((await (await ledger.fetch(snapshotRequest(scopes[0]))).json()).summary.unpricedRequestCount, 1);
  // The old completed SQL reads these projected columns, not stale event JSON.
  f.db.exec("UPDATE usage_events SET cost_basis = NULL, principal_id = NULL, principal_key = NULL, principal_nontext = 0 WHERE id = 'nullable-update'");
  const admin = await (await ledger.fetch(snapshotRequest(scopes[0]))).json();
  assert.equal(admin.summary.unpricedRequestCount, 0);
  assert.equal(admin.principals[0].principalId, null);
  assert.equal(admin.principals[0].credentialId, "credential-1");
  const personal = await (await ledger.fetch(snapshotRequest(scopes[1]))).json();
  assert.equal(personal.personal.summary.requestCount, 0);
  for (const scope of [...scopes, { kind: "credential", id: "credential-1" }]) {
    f.db.exec("UPDATE usage_rollup_migration SET complete = 0");
    const scan = await (await ledger.fetch(snapshotRequest(scope))).text();
    f.db.exec("UPDATE usage_rollup_migration SET complete = 1");
    assert.equal(await (await ledger.fetch(snapshotRequest(scope))).text(), scan);
  }
  assertCoveredRows(f);
});

test("the sub-second migration alarm never counts the whole table", async t => {
  t.mock.method(Date, "now", () => now);
  const logs = [];
  t.mock.method(console, "log", line => logs.push(JSON.parse(line)));
  const f = usageFixture(); t.after(() => f.db.close());
  f.db.exec("BEGIN");
  for (let i = 0; i < 2_500; i++) f.insert({ ...syntheticUsage(i, now), id: `count-${i}` });
  f.db.exec("COMMIT");
  const ledger = f.open(), counts = () => f.queries.filter(query => /COUNT\(\*\) AS row_count/.test(query)).length;
  let migrating = 0;
  while (!usageRollupProgress(f.state.storage.sql).complete) {
    await ledger.alarm();
    if (usageRollupProgress(f.state.storage.sql).complete) break;
    migrating++;
    assert.equal(counts(), 0);
    assert.equal(f.alarm(), now + 500);
  }
  assert.ok(migrating > 0, "the fixture must exercise at least one migrating alarm");
  await ledger.alarm();
  assert.ok(counts() > 0, "the idle maintenance alarm still reports table size");
  assert.equal(f.alarm(), now + 86_400_000);
  assert.ok(logs.every(entry => entry.event === "usage_rollup_maintenance" && !JSON.stringify(entry).includes("count-")));
});
