import assert from 'node:assert/strict';

const strategies = ['strong', 'cascade', 'cheap'];
const totals = rows => ({
  passed: rows.filter(row => row.passed).length,
  costMicros: rows.reduce((sum, row) => sum + row.costMicros, 0),
  elapsedMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0),
});

function summarize(rows) {
  const result = Object.fromEntries(strategies.map(strategy =>
    [strategy, totals(rows.filter(row => row.strategy === strategy))]));
  assert.ok(result.strong.costMicros > 0 && result.strong.elapsedMs > 0, 'missing_strong_denominator');
  result.costRatio = result.cascade.costMicros / result.strong.costMicros;
  result.elapsedRatio = result.cascade.elapsedMs / result.strong.elapsedMs;
  result.falseAccepts = rows.filter(row => row.strategy === 'cascade' && row.publicPassed && !row.passed).length;
  result.strongLosses = rows.filter(row => row.strategy === 'strong' && row.passed
    && !rows.find(peer => peer.repeat === row.repeat && peer.caseId === row.caseId && peer.strategy === 'cascade').passed).length;
  result.efficiencyGate = result.costRatio <= 0.8 && result.elapsedRatio <= 1.2;
  return result;
}

/** Summarize a fixed three-repeat, six-task study without inflating task count. */
export function summarizeRepeatability(records, taskIds) {
  assert.equal(taskIds.length, 6, 'six_tasks_required');
  assert.equal(new Set(taskIds).size, 6, 'duplicate_task');
  assert.equal(records.length, 54, 'complete_three_repeat_study_required');
  const seen = new Set();
  for (const row of records) {
    assert.ok(taskIds.includes(row.caseId), 'unknown_task');
    assert.ok([1, 2, 3].includes(row.repeat), 'unknown_repeat');
    assert.ok(strategies.includes(row.strategy), 'unknown_strategy');
    const key = `${row.repeat}/${row.caseId}/${row.strategy}`;
    assert.ok(!seen.has(key), 'duplicate_outcome');
    seen.add(key);
    for (const field of ['costMicros', 'elapsedMs']) {
      assert.ok(Number.isFinite(row[field]) && row[field] >= 0, 'invalid_measurement');
    }
    assert.ok(Number.isSafeInteger(row.costMicros), 'invalid_cost');
    for (const field of ['publicPassed', 'fullValid', 'fullPassed', 'passed']) {
      assert.equal(typeof row[field], 'boolean', 'invalid_verdict');
    }
    assert.equal(row.passed, row.publicPassed && row.fullValid && row.fullPassed, 'inconsistent_verdict');
  }
  const repeats = [1, 2, 3].map(repeat => ({ repeat,
    ...summarize(records.filter(row => row.repeat === repeat)) }));
  const aggregate = summarize(records);
  const safeEveryRepeat = repeats.every(row => row.falseAccepts === 0 && row.strongLosses === 0);
  const efficientRepeats = repeats.filter(row => row.efficiencyGate).length;
  return {
    independentTasks: 6,
    repeatsPerTask: 3,
    pairedSamples: 18,
    outcomes: 54,
    repeats,
    aggregate,
    efficientRepeats,
    repeatabilityLead: safeEveryRepeat && aggregate.cascade.passed >= aggregate.strong.passed
      && aggregate.cascade.passed > aggregate.cheap.passed && aggregate.efficiencyGate && efficientRepeats >= 2,
    qualifiedProductionGain: false,
  };
}
