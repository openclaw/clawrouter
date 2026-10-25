import assert from "node:assert/strict";
import { legacySnapshot, snapshotRequest, syntheticUsage, usageFixture } from "../worker/test/usage-snapshot-fixture.mjs";

// Synthetic, deterministic data; no upstream calls. Run with Node >=24.
const count = 100_000, now = Date.parse("2026-10-25T12:00:00Z"), samples = 5;
const realNow = Date.now;
Date.now = () => now;
const f = usageFixture();
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function measure(fn) {
  const cpu = [], wall = [];
  for (let index = 0; index < samples; index++) {
    const startCpu = process.cpuUsage(), startWall = performance.now();
    await fn();
    const used = process.cpuUsage(startCpu);
    wall.push(performance.now() - startWall); cpu.push((used.user + used.system) / 1_000);
  }
  return { cpuMs: +median(cpu).toFixed(2), wallMs: +median(wall).toFixed(2) };
}
try {
  f.db.exec("BEGIN");
  let bytes = 0;
  for (let index = 0; index < count; index++) {
    const event = syntheticUsage(index, now);
    bytes += Buffer.byteLength(JSON.stringify(event)); f.insert(event);
  }
  f.db.exec("COMMIT");
  const scopes = [{ kind: "principal", id: "alice@example.com" }, { kind: "admin" }];
  const expected = scopes.map(scope => legacySnapshot(f.db, scope, now));
  const before = [];
  for (const scope of scopes) before.push(await measure(() => Response.json(legacySnapshot(f.db, scope, now)).json()));
  const schemaStart = process.cpuUsage();
  const ledger = f.open();
  const schemaUsed = process.cpuUsage(schemaStart);
  const batches = [], read = async scope => (await ledger.fetch(snapshotRequest(scope))).json();
  while (!f.db.prepare("SELECT complete FROM usage_attribution_migration").get().complete) {
    const start = process.cpuUsage();
    await ledger.alarm();
    const used = process.cpuUsage(start); batches.push((used.user + used.system) / 1_000);
    f.queries.length = 0;
  }
  const results = [];
  for (const [index, scope] of scopes.entries()) {
    assert.deepEqual(await read(scope), expected[index]);
    const after = await measure(() => read(scope));
    results.push({ scope: scope.kind, before: before[index], after, cpuSpeedup: +(before[index].cpuMs / after.cpuMs).toFixed(2) });
  }
  assert.ok(f.queries.every(query => !/json_extract|json_type|json_each/i.test(query)));
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, events: count, averageEventBytes: Math.round(bytes / count), samples, statistic: "median; process CPU and wall milliseconds; warm in-memory SQLite", schemaCpuMs: +((schemaUsed.user + schemaUsed.system) / 1_000).toFixed(2), backfill: { batches: batches.length, rowsPerBatch: 2_000, medianCpuMs: +median(batches).toFixed(2), maxCpuMs: +Math.max(...batches).toFixed(2) }, results }, null, 2));
} finally {
  f.db.close(); Date.now = realNow;
}
