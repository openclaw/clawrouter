import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSequentialTiming } from '../scripts/fusion-sequential-timing.mjs';

const fixture = () => ['strong', 'cascade', 'cheap'].map((strategy, i) => ({
  caseId: 'case-a', strategy, complete: true, timingReplayed: false, elapsedMs: [100, 130, 70][i],
  attempts: [1, 2, 1][i], callElapsedMs: [[80], [30, 40], [30]][i],
}));
const summarize = rows => summarizeSequentialTiming(rows, ['case-a'], { execution: 'sequential' });

test('includes every sequential call and separates remaining workflow time', () => {
  const rows = fixture(), original = structuredClone(rows);
  const result = summarize(rows);
  assert.deepEqual(result.totals.strong, { calls: 1, workflowMs: 100, recordedCallMs: 80, otherWorkflowMs: 20 });
  assert.deepEqual(result.totals.cascade, { calls: 2, workflowMs: 130, recordedCallMs: 70, otherWorkflowMs: 60 });
  assert.deepEqual(rows, original);
  assert.equal(result.uniqueTasks, 1);
  assert.equal(result.rows.length, 3);
  // Faster model calls can still produce a slower complete workflow.
  assert.ok(result.totals.cascade.recordedCallMs < result.totals.strong.recordedCallMs);
  assert.ok(result.totals.cascade.workflowMs > result.totals.strong.workflowMs);
});

test('requires explicit sequential execution instead of inferring non-overlap', () => {
  assert.throws(() => summarizeSequentialTiming(fixture(), ['case-a']), /sequential_execution_required/);
  assert.throws(() => summarizeSequentialTiming(fixture(), ['case-a'], { execution: 'parallel' }), /sequential_execution_required/);
});

test('rejects incomplete, duplicate, or undeclared cohort members', () => {
  assert.throws(() => summarize(fixture().slice(1)), /incomplete_timing_cohort/);
  const duplicated = fixture(); duplicated[2] = duplicated[0];
  assert.throws(() => summarize(duplicated), /duplicate_timing_arm/);
  const unknown = fixture(); unknown[0].caseId = 'case-b';
  assert.throws(() => summarize(unknown), /unknown_task/);
  assert.throws(() => summarizeSequentialTiming([], ['case-a', 'case-a'], { execution: 'sequential' }), /duplicate_task/);
});

test('rejects missing calls and replayed or unknown workflow timing', () => {
  for (const mutate of [
    row => { row.callElapsedMs = []; },
    row => { row.attempts = 2; },
    row => { row.attempts = 0; },
    row => { row.complete = false; },
    row => { delete row.complete; },
    row => { row.timingReplayed = true; },
    row => { delete row.timingReplayed; },
  ]) {
    const rows = fixture(); mutate(rows[0]);
    assert.throws(() => summarize(rows));
  }
});

test('rejects invalid durations and overlapping or mismatched time domains', () => {
  for (const value of [-1, NaN, Infinity, '80']) {
    const rows = fixture(); rows[0].callElapsedMs = [value];
    assert.throws(() => summarize(rows), /invalid_fusion_duration/);
  }
  const overlap = fixture(); overlap[1].callElapsedMs = [100, 40];
  assert.throws(() => summarize(overlap), /call_time_exceeds_workflow/);
  const zero = fixture(); zero[0].elapsedMs = 0;
  assert.throws(() => summarize(zero), /empty_workflow_duration/);
});

test('aggregates the complete declared task set without dropping failed attempts', () => {
  const second = fixture().map(row => ({ ...row, caseId: 'case-b' }));
  const result = summarizeSequentialTiming([...fixture(), ...second], ['case-a', 'case-b'], { execution: 'sequential' });
  assert.deepEqual(result.totals.cascade, { calls: 4, workflowMs: 260, recordedCallMs: 140, otherWorkflowMs: 120 });
  assert.equal(result.rows.length, 6);
});

test('rejects sparse task, arm and call arrays instead of counting holes as zero', () => {
  assert.throws(() => summarizeSequentialTiming(fixture(), new Array(1), { execution: 'sequential' }), /missing_task_id/);
  assert.throws(() => summarize(new Array(3)), /missing_timing_arm/);
  const missingArm = fixture(); delete missingArm[1];
  assert.throws(() => summarize(missingArm), /missing_timing_arm/);
  const missingCall = fixture(); missingCall[1].callElapsedMs = new Array(2);
  assert.throws(() => summarize(missingCall), /missing_call_duration/);
  const partialCall = fixture(); delete partialCall[1].callElapsedMs[1];
  assert.throws(() => summarize(partialCall), /missing_call_duration/);
});

const repeated = () => [0, 1, 2].flatMap(repeat => fixture().map(row => ({
  ...row, repeat, strategy: row.strategy === 'cheap' ? 'compact' : row.strategy,
})));
const repeatedOptions = { execution: 'sequential', strategies: ['strong', 'cascade', 'compact'], repeats: [0, 1, 2] };

test('keeps repeated compact controls separate without counting them as new tasks', () => {
  const result = summarizeSequentialTiming(repeated(), ['case-a'], repeatedOptions);
  assert.equal(result.uniqueTasks, 1);
  assert.equal(result.repeatsPerTask, 3);
  assert.equal(result.rows.length, 9);
  assert.deepEqual(result.totals.compact, { calls: 3, workflowMs: 210, recordedCallMs: 90, otherWorkflowMs: 120 });
  assert.deepEqual(result.rows.filter(row => row.strategy === 'compact').map(row => row.repeat), [0, 1, 2]);
  assert.equal(Object.hasOwn(summarize(fixture()), 'repeatsPerTask'), false);
});

test('requires every declared task, repeat and strategy exactly once', () => {
  const run = rows => summarizeSequentialTiming(rows, ['case-a'], repeatedOptions);
  assert.throws(() => run(repeated().slice(1)), /incomplete_timing_cohort/);
  const duplicate = repeated(); duplicate[3] = duplicate[0];
  assert.throws(() => run(duplicate), /duplicate_timing_arm/);
  const unknownRepeat = repeated(); unknownRepeat[0].repeat = 3;
  assert.throws(() => run(unknownRepeat), /unknown_repeat/);
  const missingRepeat = repeated(); delete missingRepeat[0].repeat;
  assert.throws(() => run(missingRepeat), /unknown_repeat/);
  const unknownStrategy = repeated(); unknownStrategy[0].strategy = 'cheap';
  assert.throws(() => run(unknownStrategy), /unknown_strategy/);
});

test('rejects ambiguous or sparse declared strategies and repeats', () => {
  for (const strategies of [[], ['strong'], ['strong', 'strong'], ['strong', ''], new Array(2)]) {
    assert.throws(() => summarizeSequentialTiming(repeated(), ['case-a'], { ...repeatedOptions, strategies }));
  }
  for (const repeats of [[], [0, 0], [-1], [1.5], new Array(3)]) {
    assert.throws(() => summarizeSequentialTiming(repeated(), ['case-a'], { ...repeatedOptions, repeats }));
  }
});
