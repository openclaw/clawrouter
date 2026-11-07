import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startWorkerdFixture } from "../../test/helpers/workerd.mjs";
import { requireBaselineCommit } from "../../test/helpers/personal-usage-baseline.mjs";
import { personalUsageBaseline } from "../../test/helpers/personal-usage-upgrade.mjs";

const release = "080831563e0adfcdc1b79cad14613249694d60c9"; // v0.4.0, actual release writer.
const now = Date.parse("2036-11-05T12:00:00Z"); // Alarms run only when explicitly invoked by the fixture.
function router(source) { return `
 import { UsageLedgerObject as Base, BudgetLedgerObject } from "${source}/worker/ledgers.ts";
 export { BudgetLedgerObject };
 export class PolicyBindingIndexObject { fetch() { return new Response('unused'); } }
 export class GrantCredentialObject { fetch() { return new Response('unused'); } }
 Date.now = () => ${now};
 export class UsageLedgerObject extends Base {
  constructor(state) { super(state); this.fixtureStorage = state.storage; }
  async fetch(request) {
   const path = new URL(request.url).pathname, sql = this.fixtureStorage.sql;
   if (path === '/seed') {
    const { count, start = 0 } = await request.json();
    for (let i = start; i < start + count; i++) {
     const event = { type:'clawrouter.usage.v1', id:'event-'+i, occurred_at_ms:${now}-1000-i,
      tenant_id:'tenant', policy_id:'policy', provider:i%2?'openai':'anthropic', status:i%7?'success':'server_error', status_code:i%7?200:500,
      input_tokens:i%10, output_tokens:2, total_tokens:i%10+2, actual_cost_micros:i%5, cost_basis:i%3?'manifest_pricing':'unpriced_usage',
      principal_id:i%2?' Alice@Example.com ':null, credential_id:'credential-0' };
     const response = await super.fetch(new Request('https://ledger/ingest',{method:'POST',body:JSON.stringify(event)}));
     if (!response.ok) throw new Error(await response.text());
    }
    return Response.json({seeded:count});
   }
   if (path === '/step') { await super.alarm(); return Response.json({stepped:true}); }
   if (path === '/fail-batch') {
    sql.exec("CREATE TRIGGER fixture_reset BEFORE UPDATE ON usage_rollup_migration BEGIN SELECT RAISE(ABORT, 'synthetic reset'); END");
    let failed = false;
    try { await super.alarm(); } catch { failed = true; }
    sql.exec('DROP TRIGGER fixture_reset');
    return Response.json({failed});
   }
   if (path === '/delete') { sql.exec('DELETE FROM usage_events WHERE id = ?', (await request.json()).id); return Response.json({deleted:true}); }
   if (path === '/state') {
    const tables = [...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'")].map(r=>r.name);
    const progress = tables.includes('usage_rollup_migration') ? [...sql.exec('SELECT * FROM usage_rollup_migration')][0] : null;
    const totals = tables.includes('usage_rollups') ? [...sql.exec('SELECT COALESCE(SUM(request_count),0) AS count FROM usage_rollups')][0].count : null;
    const groups = tables.includes('usage_rollups') ? [...sql.exec('SELECT principal_key, credential_key, SUM(request_count) AS count FROM usage_rollups GROUP BY 1, 2')] : [];
    return Response.json({ count:[...sql.exec('SELECT COUNT(*) AS n FROM usage_events')][0].n, progress, totals, groups, databaseSize:sql.databaseSize });
   }
   return super.fetch(request);
  }
 }
 export default { fetch(request, env) { return env.USAGE_LEDGER.get(env.USAGE_LEDGER.idFromName('synthetic')).fetch(request); } };
`; }

test("persisted release writer → mid-backfill restart/reset → completed rollback writer retains exact rollups", { timeout: 120_000 }, async t => {
  if (!requireBaselineCommit(t, release) || !requireBaselineCommit(t, personalUsageBaseline)) return;
  const scratch = process.env.CLAWROUTER_TEST_SCRATCH ?? tmpdir();
  const temporary = await mkdtemp(join(scratch, "usage-rollup-runtime-"));
  const baseline = join(temporary, "release"); await mkdir(baseline);
  const archive = execFileSync("git", ["archive", release, "package.json", "worker", "shared"], { maxBuffer: 32 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", baseline], { input: archive });
  const rollback = join(temporary, "rollback"); await mkdir(rollback);
  execFileSync("tar", ["-xf", "-", "-C", rollback], { input: execFileSync("git", ["archive", personalUsageBaseline, "package.json", "worker", "shared"], { maxBuffer: 32 * 1024 * 1024 }) });
  await symlink(resolve("node_modules"), join(rollback, "node_modules"), "dir");
  let worker;
  t.after(async () => { await worker?.dispose(); await rm(temporary, { recursive: true, force: true }); });
  const start = async source => {
    await worker?.dispose(); worker = null;
    worker = await startWorkerdFixture(temporary, router(source), "export default { fetch() { return new Response('unused'); } };", { persistencePath: join(temporary, "state"), preventEviction: true });
  };
  const read = async (path, body) => {
    const response = await worker.dispatchFetch("https://ledger" + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
  };
  const snapshot = () => read("/snapshot?policy_id=policy&events=admin");
  const releaseShape = value => JSON.parse(JSON.stringify(value, (key, child) => key === "principals" || key === "unpricedRequestCount" ? undefined : child));
  await start(baseline);
  await read("/seed", { count: 4_501 });
  const before = await snapshot(); assert.equal(before.summary.requestCount, 4501);
  await start(resolve("."));
  assert.equal((await read("/state")).progress.last_rowid, 0);
  assert.deepEqual(releaseShape(await snapshot()), releaseShape(before));
  await read("/step");
  const partial = await read("/state"); assert.equal(partial.progress.last_rowid, 2000); assert.equal(partial.progress.complete, 0);
  await start(resolve("."));
  assert.deepEqual(await read("/state"), partial);
  assert.deepEqual(await read("/fail-batch"), { failed: true });
  assert.deepEqual((await read("/state")).progress, partial.progress);
  assert.equal((await read("/state")).totals, partial.totals, JSON.stringify({ before: partial, after: await read("/state") }));
  // Old-code deletes on both sides of the cursor and a new old-code insert.
  await start(rollback);
  await read("/delete", { id: "event-10" }); await read("/delete", { id: "event-3000" });
  await read("/seed", { count: 1, start: 5000 });
  const duringRollback = await snapshot(); assert.equal(duringRollback.summary.requestCount, 4500);
  await start(resolve("."));
  assert.deepEqual(await snapshot(), duringRollback);
  for (let i = 0; i < 30; i++) {
    await read("/step");
    if ((await read("/state")).progress.complete) break;
  }
  const complete = await read("/state"); assert.equal(complete.progress.complete, 1); assert.equal(complete.totals, 4500);
  // Completion is gated on attribution, so owner-event queries are indexed too.
  assert.deepEqual(await snapshot(), duringRollback);
  await start(rollback);
  await read("/delete", { id: "event-20" }); await read("/seed", { count: 1, start: 5001 });
  const afterRollback = await snapshot();
  await start(resolve("."));
  assert.equal((await read("/state")).progress.complete, 1);
  assert.deepEqual(await snapshot(), afterRollback);
});
