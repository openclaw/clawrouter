import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacySnapshot, snapshotRequest, syntheticUsage, usageFixture } from "../worker/test/usage-snapshot-fixture.mjs";

// Synthetic data only. External-volume scratch avoids filling the internal disk.
const count = Number(process.env.USAGE_BENCH_EVENTS ?? 1_000_000), now = Date.parse("2026-11-05T12:00:00Z"), samples = 5;
const scratchRoot = process.env.USAGE_BENCH_SCRATCH ?? tmpdir();
const scratch = await mkdtemp(join(scratchRoot, "usage-rollup-bench-"));
const realNow = Date.now, log = console.log;
Date.now = () => now;
const f = usageFixture(join(scratch, "ledger.sqlite"), true);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const usedMs = start => { const used = process.cpuUsage(start); return (used.user + used.system) / 1_000; };
async function measure(fn) {
  const cpu = [], wall = [];
  for (let index = 0; index < samples; index++) {
    const startCpu = process.cpuUsage(), startWall = performance.now();
    await fn();
    wall.push(performance.now() - startWall); cpu.push(usedMs(startCpu));
  }
  return { cpuMs: +median(cpu).toFixed(2), wallMs: +median(wall).toFixed(2) };
}
function eventAt(index) {
  const event = syntheticUsage(index, now), owner = index % 100;
  return { ...event, occurred_at_ms: now - 1 - Math.floor(index * (30 * 86_400_000 - 1) / count),
    principal_id: owner < 90 ? (owner % 2 ? `User-${owner}@example.test` : ` user-${owner}@EXAMPLE.TEST `) : event.principal_id,
    credential_id: `credential-${owner}` };
}
try {
  log(`Seeding ${count.toLocaleString()} projected events on external-volume SQLite`);
  f.db.exec("BEGIN");
  let bytes = 0;
  for (let index = 0; index < count; index++) { const event = eventAt(index); bytes += Buffer.byteLength(JSON.stringify(event)); f.insert(event); }
  f.db.exec("COMMIT");
  log("Creating additive schema and indexes");
  const schemaStart = process.cpuUsage(), ledger = f.open(), schemaCpuMs = usedMs(schemaStart);
  // Model a deployed #337 shard whose attribution migration has completed.
  f.db.exec("UPDATE usage_attribution_migration SET last_rowid = upper_rowid, complete = 1");
  const scopes = [{ kind: "principal", id: "user-1@example.test" }, { kind: "admin" }];
  const read = async scope => (await ledger.fetch(snapshotRequest(scope))).json();
  log("Computing independent legacy answers");
  const expected = scopes.map(scope => legacySnapshot(f.db, scope, now));
  const before = [];
  log("Measuring projected aggregate snapshots");
  for (const [i, scope] of scopes.entries()) {
    assert.deepEqual(await read(scope), expected[i]);
    before.push(await measure(() => read(scope)));
  }
  const batches = [];
  log("Measuring bounded alarm batches");
  console.log = () => {};
  while (!f.db.prepare("SELECT complete FROM usage_rollup_migration").get().complete) {
    const start = process.cpuUsage(); await ledger.alarm(); batches.push(usedMs(start)); f.queries.length = 0;
  }
  console.log = log;
  log("Measuring completed rollup snapshots");
  const results = [];
  for (const [i, scope] of scopes.entries()) {
    assert.deepEqual(await read(scope), expected[i]);
    const after = await measure(() => read(scope));
    results.push({ scope: scope.kind, before: before[i], after, cpuSpeedup: +(before[i].cpuMs / after.cpuMs).toFixed(2) });
  }
  // Same ingest path and retained DB; only the new triggers differ. Remove each
  // sample outside timing. Existing reporting triggers remain installed throughout.
  const triggerSql = f.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'usage_rollup_%'").all().map(row => row.sql);
  async function ingestSample(label) {
    const events = Array.from({ length: 200 }, (_, i) => ({ ...eventAt(i), id: `bench-${label}-${i}`, occurred_at_ms: now + i }));
    const start = process.cpuUsage();
    for (const event of events) assert.equal((await ledger.fetch(new Request("https://ledger/ingest", { method: "POST", body: JSON.stringify(event) }))).status, 200);
    const cpuMsPerInsert = usedMs(start) / events.length;
    f.db.prepare("DELETE FROM usage_events WHERE id LIKE ?").run(`bench-${label}-%`);
    f.queries.length = 0;
    return cpuMsPerInsert;
  }
  const ingest = { without: [], with: [] };
  log("Measuring paired ingest overhead");
  for (let round = 0; round < 5; round++) {
    for (const row of f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'usage_rollup_%'").all()) f.db.exec(`DROP TRIGGER ${row.name}`);
    ingest.without.push(await ingestSample(`off-${round}`));
    for (const sql of triggerSql) f.db.exec(sql);
    ingest.with.push(await ingestSample(`on-${round}`));
  }
  const without = median(ingest.without), withRollups = median(ingest.with);
  log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, events: count, averageEventBytes: Math.round(bytes / count), samples, statistic: "median; process CPU and wall milliseconds; external-volume SQLite; before is projected #337 aggregate SQL", schemaCpuMs: +schemaCpuMs.toFixed(2), rollupRows: f.db.prepare("SELECT COUNT(*) AS n FROM usage_rollups").get().n, backfill: { batches: batches.length, rowsPerBatch: 2_000, medianCpuMs: +median(batches).toFixed(2), maxCpuMs: +Math.max(...batches).toFixed(2), projectedThreeMillionMinutes: 3_000_000 / 2_000 * 0.5 / 60 }, ingest: { withoutRollupCpuMs: +without.toFixed(4), withRollupCpuMs: +withRollups.toFixed(4), addedCpuMs: +(withRollups - without).toFixed(4), overheadPercent: +((withRollups / without - 1) * 100).toFixed(2), samples: ingest }, results }, null, 2));
} finally {
  console.log = log; f.db.close(); Date.now = realNow; await rm(scratch, { recursive: true, force: true });
}
