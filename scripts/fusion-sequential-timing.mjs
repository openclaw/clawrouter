import assert from 'node:assert/strict';

const strategies = ['strong', 'cascade', 'cheap'];
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
export function summarizeSequentialTiming(records, taskIds, { execution } = {}) {
  assert.equal(execution, 'sequential', 'sequential_execution_required');
  assert.ok(Array.isArray(taskIds) && taskIds.length > 0 && taskIds.length <= 100, 'invalid_task_count');
  dense(taskIds, 'missing_task_id');
  assert.ok(taskIds.every(id => typeof id === 'string' && id.length > 0), 'invalid_task_id');
  assert.equal(new Set(taskIds).size, taskIds.length, 'duplicate_task');
  assert.ok(Array.isArray(records) && records.length === taskIds.length * strategies.length, 'incomplete_timing_cohort');
  dense(records, 'missing_timing_arm');
  const seen = new Set();
  const rows = records.map(row => {
    assert.ok(taskIds.includes(row.caseId), 'unknown_task');
    assert.ok(strategies.includes(row.strategy), 'unknown_strategy');
    const key = JSON.stringify([row.caseId, row.strategy]);
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
    return { caseId: row.caseId, strategy: row.strategy, calls: row.attempts,
      workflowMs: row.elapsedMs, recordedCallMs, otherWorkflowMs: row.elapsedMs - recordedCallMs };
  });
  const totals = Object.fromEntries(strategies.map(strategy => {
    const selected = rows.filter(row => row.strategy === strategy);
    return [strategy, Object.fromEntries(['calls', 'workflowMs', 'recordedCallMs', 'otherWorkflowMs']
      .map(field => [field, sum(selected.map(row => row[field]))]))];
  }));
  return { uniqueTasks: taskIds.length, execution: 'sequential', totals, rows };
}
