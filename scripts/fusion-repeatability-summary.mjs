import assert from 'node:assert/strict';

const strategies = ['strong', 'cascade', 'cheap'];
const totals = (rows, normalized) => ({
  passed: rows.filter(row => row.passed).length,
  costMicros: rows.reduce((sum, row) => sum + row.costMicros, 0),
  ...(normalized ? { normalizedMicros: rows.reduce((sum, row) => sum + row.normalizedMicros, 0) } : {}),
  elapsedMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0),
});

function summarize(rows, normalized, maxElapsedRatio = 1.2) {
  const result = Object.fromEntries(strategies.map(strategy =>
    [strategy, totals(rows.filter(row => row.strategy === strategy), normalized)]));
  assert.ok(result.strong.costMicros > 0 && result.strong.elapsedMs > 0, 'missing_strong_denominator');
  result.costRatio = result.cascade.costMicros / result.strong.costMicros;
  if (normalized) {
    assert.ok(result.strong.normalizedMicros > 0, 'missing_normalized_denominator');
    result.normalizedCostRatio = result.cascade.normalizedMicros / result.strong.normalizedMicros;
  }
  result.elapsedRatio = result.cascade.elapsedMs / result.strong.elapsedMs;
  result.falseAccepts = rows.filter(row => row.strategy === 'cascade' && row.publicPassed && !row.passed).length;
  result.strongLosses = rows.filter(row => row.strategy === 'strong' && row.passed
    && !rows.find(peer => peer.repeat === row.repeat && peer.caseId === row.caseId && peer.strategy === 'cascade').passed).length;
  result.efficiencyGate = result.costRatio <= 0.8 && result.elapsedRatio <= maxElapsedRatio
    && (!normalized || result.normalizedCostRatio <= 0.8);
  return result;
}

function validateStudy(records, taskIds, expectedTasks, costBasis, draws, incompleteMessage) {
  assert.ok(Number.isSafeInteger(expectedTasks) && expectedTasks > 0 && expectedTasks <= 100, 'invalid_task_count');
  assert.ok(['invoice-v1', 'invoice-and-cache-neutral-v1'].includes(costBasis), 'invalid_cost_basis');
  const normalized = costBasis === 'invoice-and-cache-neutral-v1';
  assert.equal(taskIds.length, expectedTasks, 'declared_task_count_mismatch');
  assert.ok(taskIds.every(id => typeof id === 'string' && id.length > 0), 'invalid_task_id');
  assert.equal(new Set(taskIds).size, expectedTasks, 'duplicate_task');
  assert.equal(records.length, expectedTasks * strategies.length * draws.length, incompleteMessage);
  const seen = new Set();
  for (const row of records) {
    assert.ok(taskIds.includes(row.caseId), 'unknown_task');
    assert.ok(draws.includes(row.repeat), 'unknown_repeat');
    assert.ok(strategies.includes(row.strategy), 'unknown_strategy');
    const key = `${row.repeat}/${row.caseId}/${row.strategy}`;
    assert.ok(!seen.has(key), 'duplicate_outcome');
    seen.add(key);
    for (const field of ['costMicros', 'elapsedMs']) {
      assert.ok(Number.isFinite(row[field]) && row[field] >= 0, 'invalid_measurement');
    }
    assert.ok(Number.isSafeInteger(row.costMicros), 'invalid_cost');
    if (normalized) assert.ok(Number.isSafeInteger(row.normalizedMicros) && row.normalizedMicros >= 0, 'invalid_normalized_cost');
    for (const field of ['publicPassed', 'fullValid', 'fullPassed', 'passed']) {
      assert.equal(typeof row[field], 'boolean', 'invalid_verdict');
    }
    assert.equal(row.passed, row.publicPassed && row.fullValid && row.fullPassed, 'inconsistent_verdict');
  }
  return normalized;
}

/** Summarize three fixed repeats without counting repeated tasks as new tasks. */
export function summarizeRepeatability(records, taskIds, { expectedTasks = 6, costBasis = 'invoice-v1' } = {}) {
  const normalized = validateStudy(records, taskIds, expectedTasks, costBasis, [1, 2, 3],
    'complete_three_repeat_study_required');
  const repeats = [1, 2, 3].map(repeat => ({ repeat,
    ...summarize(records.filter(row => row.repeat === repeat), normalized) }));
  const aggregate = summarize(records, normalized);
  const safeEveryRepeat = repeats.every(row => row.falseAccepts === 0 && row.strongLosses === 0);
  const efficientRepeats = repeats.filter(row => row.efficiencyGate).length;
  return {
    uniqueTasks: expectedTasks,
    repeatsPerTask: 3,
    pairedSamples: expectedTasks * 3,
    outcomes: expectedTasks * 9,
    ...(normalized ? { costBasis } : {}),
    repeats,
    aggregate,
    efficientRepeats,
    repeatabilityLead: safeEveryRepeat && aggregate.cascade.passed >= aggregate.strong.passed
      && aggregate.cascade.passed > aggregate.cheap.passed && aggregate.efficiencyGate && efficientRepeats >= 2,
    qualifiedProductionGain: false,
  };
}

/** Summarize one draw on every declared task, independent of accounting batches. */
export function summarizeTransfer(records, taskIds, { expectedTasks = 30, maxElapsedRatio = 1.2 } = {}) {
  assert.ok(Number.isFinite(maxElapsedRatio) && maxElapsedRatio > 0 && maxElapsedRatio <= 1.2,
    'invalid_elapsed_ceiling');
  const costBasis = 'invoice-and-cache-neutral-v1';
  validateStudy(records, taskIds, expectedTasks, costBasis, [undefined],
    'complete_single_draw_study_required');
  const aggregate = summarize(records, true, maxElapsedRatio);
  return {
    uniqueTasks: expectedTasks,
    drawsPerTask: 1,
    pairedSamples: expectedTasks,
    outcomes: expectedTasks * strategies.length,
    costBasis,
    aggregate,
    transferLead: aggregate.falseAccepts === 0 && aggregate.strongLosses === 0
      && aggregate.cascade.passed >= aggregate.strong.passed
      && aggregate.cascade.passed > aggregate.cheap.passed && aggregate.efficiencyGate,
    qualifiedProductionGain: false,
  };
}
