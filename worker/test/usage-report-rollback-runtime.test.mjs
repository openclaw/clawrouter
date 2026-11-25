import assert from "node:assert/strict";
import test from "node:test";
import { requireBaselineCommit } from "../../test/helpers/personal-usage-baseline.mjs";
import { personalUsageBaseline } from "../../test/helpers/personal-usage-upgrade.mjs";
import { provePersonalUsageRollback } from "../../test/helpers/personal-usage-rollback-runtime.mjs";

test("persisted candidate/baseline/candidate keeps empty and completed projection history after old-writer gaps", { timeout: 120000 }, async t => {
  if (!requireBaselineCommit(t, personalUsageBaseline)) return;
  const proof = await provePersonalUsageRollback();
  assert.equal(proof.cases.length, 2);
  for (const entry of proof.cases) {
    assert.equal(entry.cycles.length, 2);
    for (const cycle of entry.cycles) {
      assert.equal(cycle.reportCallsBeforeApply, cycle.canonicalCalls);
      assert.equal(cycle.eventCallsBeforeApply, cycle.canonicalCalls);
      assert.equal(cycle.projectionBeforeApply, false);
      assert.equal(cycle.projectionAfterApply, true);
    }
  }
});
