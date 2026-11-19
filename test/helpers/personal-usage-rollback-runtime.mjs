import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startWorkerdFixture } from "./workerd.mjs";
import { personalUsageBaseline, router, upstream } from "./personal-usage-upgrade.mjs";

const cookie = "clawrouter_session=" + "a".repeat(64);

/**
 * Persisted candidate -> released baseline writer -> candidate, twice, on the
 * same workerd resources. The baseline writes only canonical usage rows; the
 * candidate must notice that gap, serve full history through read-through and
 * let an explicit bounded migration restore the projection, without changing
 * raw events, settings or debits.
 */
export async function provePersonalUsageRollback() {
  const scratch = resolve(".openclaw/tmp");
  await mkdir(scratch, { recursive: true });
  const temporary = await mkdtemp(join(scratch, "rollback-upgrade-"));
  const sources = { baseline: join(temporary, "baseline"), current: resolve(".") };
  await mkdir(sources.baseline);
  const bytes = execFileSync("git", ["archive", personalUsageBaseline, "package.json", "worker", "shared"], { maxBuffer: 32 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", sources.baseline], { input: bytes });
  const now = Date.now(), day = new Date(now);
  const offset = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12) - now;
  const cases = [];
  let worker;
  try {
    for (const historical of [0, 3]) {
      const options = { persistencePath: join(temporary, "state-" + historical), preventEviction: true };
      const start = async kind => {
        await worker?.dispose();
        worker = null;
        worker = await startWorkerdFixture(temporary, router(sources[kind], kind !== "baseline", offset), upstream, options);
      };
      const read = (path, init = {}) => worker.dispatchFetch("https://router.example" + path, { ...init, headers: { cookie, ...init.headers } });
      const json = async path => {
        const response = await read(path), text = await response.text();
        assert.equal(response.status, 200, text);
        return JSON.parse(text);
      };
      const state = () => json("/_proof/state");
      const send = async () => {
        const response = await read("/v1/responses", {
          method: "POST",
          headers: { authorization: "Bearer clawrouter-live-owner-synthetic-key", "content-type": "application/json" },
          body: JSON.stringify({ model: "openai/gpt-6.1-sol", input: "synthetic rollback fixture", max_output_tokens: 32 }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        await response.arrayBuffer();
      };
      const until = async count => {
        const end = Date.now() + 20000;
        for (;;) {
          const current = await state();
          if (current.rawCount === count && current.budget.spentMicros === count * 17) return current;
          assert.ok(Date.now() < end, "baseline queue/debit did not converge");
          await new Promise(done => setTimeout(done, 20));
        }
      };
      const migrate = async apply => {
        const body = JSON.stringify(apply ? { apply: true, batchSize: 2 } : { batchSize: 2 });
        const response = await read("/_proof/migrate", { method: "POST", headers: { "content-type": "application/json" }, body });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      const repair = async () => {
        for (let batches = 1; batches <= 20; batches++) if ((await migrate(true)).complete) return batches;
        throw new Error("bounded explicit migration did not complete");
      };
      const assertUnchanged = (before, after) => {
        assert.equal(after.rawCount, before.rawCount);
        assert.equal(after.rawDigest, before.rawDigest);
        assert.equal(after.budget.spentMicros, before.budget.spentMicros);
        assert.equal(after.settingsDigest, before.settingsDigest);
        assert.deepEqual(after.config, before.config);
      };
      const owned = async expected => {
        const outcome = await json("/v1/session/usage/report?days=7&intent=browse");
        assert.equal(outcome.kind, "complete", JSON.stringify(outcome));
        const report = outcome.value;
        try {
          const range = new URLSearchParams({ from: new Date(report.query.from).toISOString(), to: new Date(report.query.to).toISOString(), timezone: report.query.timezone, cut: report.cut });
          const page = await json("/v1/session/usage/events?" + range);
          assert.equal(page.kind, "complete", JSON.stringify(page));
          const events = page.value;
          assert.equal(report.metrics.calls, expected);
          assert.equal(events.events.length, expected);
          assert.equal(report.coverage.allDiscoveredSourcesAnswered, true);
          assert.equal(report.coverage.historicalLocations, "not_exhaustively_assessed");
          assert.deepEqual(events.coverage, report.coverage);
          assert.equal(events.events.reduce((sum, event) => sum + event.recordedChargeMicros, 0), expected * 17);
          // Projection qualification is private storage evidence, not an assertion
          // that the public response exhaustively covers historical locations.
          const projectionComplete = (await state()).projectionComplete;
          return { report, events, projectionComplete };
        } finally {
          const response = await read("/v1/session/usage/report?" + new URLSearchParams({ cut: report.cut }), { method: "DELETE", headers: { origin: "https://router.example" } });
          assert.equal(response.status, 200, await response.clone().text());
        }
      };

      // Start from an empty candidate shard, or from baseline history that the
      // candidate has explicitly projected.
      await start(historical ? "baseline" : "current");
      assert.equal((await read("/_proof/setup")).status, 200);
      for (let n = 0; n < historical; n++) await send();
      await until(historical);
      if (historical) { await start("current"); await repair(); }
      const initial = await owned(historical);
      assert.equal(initial.projectionComplete, true);
      assert.equal((await state()).projection, historical);

      const cycles = [];
      for (let cycle = 0; cycle < 2; cycle++) {
        const expected = historical + cycle + 1;
        await start("baseline");
        await send();
        const before = await until(expected);
        assert.equal(before.projection, expected - 1, "baseline writes only the canonical ledger");
        await start("current");
        const fallback = await owned(expected);
        assert.equal(fallback.projectionComplete, false);
        const afterRead = await state();
        assertUnchanged(before, afterRead);
        assert.equal(afterRead.projection, before.projection, "reads must not backfill");
        assert.equal((await migrate(false)).dryRun, true);
        const afterPreview = await state();
        assertUnchanged(before, afterPreview);
        assert.equal(afterPreview.projection, before.projection);
        const applyBatches = await repair();
        const indexed = await owned(expected);
        assert.equal(indexed.projectionComplete, true);
        const afterApply = await state();
        assertUnchanged(before, afterApply);
        assert.equal(afterApply.projection, expected);
        assert.deepEqual(indexed.events.events.map(event => event.id).sort(), fallback.events.events.map(event => event.id).sort());
        cycles.push({ canonicalCalls: expected, reportCallsBeforeApply: fallback.report.metrics.calls, eventCallsBeforeApply: fallback.events.events.length, projectionBeforeApply: fallback.projectionComplete, applyBatches, projectionAfterApply: indexed.projectionComplete });
      }
      cases.push({ initialState: historical ? "completed historical projection" : "initially empty projection", cycles });
      await worker.dispose();
      worker = null;
    }
    return { baseline: personalUsageBaseline, cases };
  } finally {
    await worker?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
}
