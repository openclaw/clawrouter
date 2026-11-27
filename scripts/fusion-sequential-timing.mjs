import assert from 'node:assert/strict';

const defaultStrategies = ['strong', 'cascade', 'cheap'];
const dense = (values, message) => {
  for (let i = 0; i < values.length; i++) assert.ok(Object.hasOwn(values, i), message);
};
const duration = value => assert.ok(Number.isFinite(value) && value >= 0, 'invalid_fusion_duration');
const sum = values => values.reduce((total, value) => {
  duration(value);
  const next = total + value;
  duration(next);
  return next;
}, 0);

/** Decompose complete sequential workflows; callers own timing provenance. */
export function summarizeSequentialTiming(records, taskIds, { execution, strategies = defaultStrategies, repeats } = {}) {
  assert.equal(execution, 'sequential', 'sequential_execution_required');
  assert.ok(Array.isArray(strategies) && strategies.length >= 2 && strategies.length <= 8, 'invalid_strategies');
  dense(strategies, 'missing_strategy');
  assert.ok(strategies.every(value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)), 'invalid_strategy');
  assert.equal(new Set(strategies).size, strategies.length, 'duplicate_strategy');
  if (repeats !== undefined) {
    assert.ok(Array.isArray(repeats) && repeats.length > 0 && repeats.length <= 100, 'invalid_repeats');
    dense(repeats, 'missing_repeat');
    assert.ok(repeats.every(value => Number.isSafeInteger(value) && value >= 0), 'invalid_repeat');
    assert.equal(new Set(repeats).size, repeats.length, 'duplicate_repeat');
  }
  assert.ok(Array.isArray(taskIds) && taskIds.length > 0 && taskIds.length <= 100, 'invalid_task_count');
  dense(taskIds, 'missing_task_id');
  assert.ok(taskIds.every(id => typeof id === 'string' && id.length > 0), 'invalid_task_id');
  assert.equal(new Set(taskIds).size, taskIds.length, 'duplicate_task');
  assert.ok(Array.isArray(records) && records.length === taskIds.length * strategies.length * (repeats?.length ?? 1), 'incomplete_timing_cohort');
  dense(records, 'missing_timing_arm');
  const seen = new Set();
  const rows = records.map(row => {
    assert.ok(taskIds.includes(row.caseId), 'unknown_task');
    assert.ok(strategies.includes(row.strategy), 'unknown_strategy');
    if (repeats !== undefined) assert.ok(repeats.includes(row.repeat), 'unknown_repeat');
    const key = JSON.stringify([row.caseId, row.strategy, ...(repeats === undefined ? [] : [row.repeat])]);
    assert.ok(!seen.has(key), 'duplicate_timing_arm');
    seen.add(key);
    assert.equal(row.complete, true, 'complete_workflow_required');
    assert.equal(row.timingReplayed, false, 'original_complete_timing_required');
    duration(row.elapsedMs);
    assert.ok(row.elapsedMs > 0, 'empty_workflow_duration');
    assert.ok(Number.isSafeInteger(row.attempts) && row.attempts > 0, 'invalid_attempt_count');
    assert.ok(Array.isArray(row.callElapsedMs) && row.callElapsedMs.length === row.attempts, 'incomplete_call_timing');
    dense(row.callElapsedMs, 'missing_call_duration');
    const recordedCallMs = sum(row.callElapsedMs);
    assert.ok(recordedCallMs <= row.elapsedMs, 'call_time_exceeds_workflow');
    return { caseId: row.caseId, strategy: row.strategy, ...(repeats === undefined ? {} : { repeat: row.repeat }), calls: row.attempts,
      workflowMs: row.elapsedMs, recordedCallMs, otherWorkflowMs: row.elapsedMs - recordedCallMs };
  });
  const totals = Object.fromEntries(strategies.map(strategy => {
    const selected = rows.filter(row => row.strategy === strategy);
    return [strategy, Object.fromEntries(['calls', 'workflowMs', 'recordedCallMs', 'otherWorkflowMs']
      .map(field => [field, sum(selected.map(row => row[field]))]))];
  }));
  return { uniqueTasks: taskIds.length, ...(repeats === undefined ? {} : { repeatsPerTask: repeats.length }),
    execution: 'sequential', totals, rows };
}
