import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeRepeatability } from '../scripts/fusion-repeatability-summary.mjs';

const ids = Array.from({ length: 6 }, (_, i) => `task-${i}`);
function fixture(taskIds = ids) {
  return [1, 2, 3].flatMap(repeat => taskIds.flatMap(caseId => ['strong', 'cascade', 'cheap'].map(strategy => ({
    repeat, caseId, strategy, costMicros: strategy === 'strong' ? 100 : 50,
    elapsedMs: 100, publicPassed: strategy !== 'cheap', fullValid: true,
    fullPassed: strategy !== 'cheap', passed: strategy !== 'cheap',
  }))));
}

test('repeatability keeps six tasks distinct from eighteen paired samples', () => {
  const result = summarizeRepeatability(fixture(), ids);
  assert.equal(result.uniqueTasks, 6);
  assert.equal(result.pairedSamples, 18);
  assert.equal(result.aggregate.cascade.passed, 18);
  assert.equal(result.repeatabilityLead, true);
  assert.equal(result.qualifiedProductionGain, false);
});

test('an explicitly sized study keeps twelve tasks distinct from thirty-six pairs', () => {
  const taskIds = Array.from({ length: 12 }, (_, i) => `task-${i}`);
  const records = fixture(taskIds).map(row => ({ ...row, normalizedMicros: row.costMicros }));
  const options = { expectedTasks: 12, costBasis: 'invoice-and-cache-neutral-v1' };
  const result = summarizeRepeatability(records, taskIds, options);
  assert.equal(result.uniqueTasks, 12);
  assert.equal(result.pairedSamples, 36);
  assert.equal(result.outcomes, 108);
  assert.equal(result.repeatabilityLead, true);
  assert.equal(result.qualifiedProductionGain, false);
  assert.throws(() => summarizeRepeatability(records, taskIds), /task_count_mismatch/);
  assert.throws(() => summarizeRepeatability(records.slice(1), taskIds, options), /complete/);
});

test('normalized costs are mandatory and can veto apparent invoice savings', () => {
  const options = { costBasis: 'invoice-and-cache-neutral-v1' };
  const records = fixture().map(row => ({ ...row,
    normalizedMicros: row.strategy === 'cascade' ? 81 : row.costMicros }));
  const result = summarizeRepeatability(records, ids, options);
  assert.equal(result.aggregate.costRatio, 0.5);
  assert.equal(result.aggregate.normalizedCostRatio, 0.81);
  assert.equal(result.efficientRepeats, 0);
  assert.equal(result.repeatabilityLead, false);
  assert.throws(() => summarizeRepeatability(fixture(), ids, options), /invalid_normalized_cost/);
  records[0].normalizedMicros = -1;
  assert.throws(() => summarizeRepeatability(records, ids, options), /invalid_normalized_cost/);
});

test('invalid declarations and zero normalized denominators fail closed', () => {
  for (const expectedTasks of [0, -1, 1.5, NaN, 101]) {
    assert.throws(() => summarizeRepeatability(fixture(), ids, { expectedTasks }), /invalid_task_count/);
  }
  assert.throws(() => summarizeRepeatability(fixture(), ids, { costBasis: 'unknown' }), /invalid_cost_basis/);
  const records = fixture().map(row => ({ ...row, normalizedMicros: 0 }));
  assert.throws(() => summarizeRepeatability(records, ids, { costBasis: 'invoice-and-cache-neutral-v1' }), /denominator/);
});

test('incomplete, duplicated or invalid observations cannot qualify', () => {
  assert.throws(() => summarizeRepeatability(fixture().slice(1), ids), /complete/);
  const duplicate = fixture(); duplicate[0] = duplicate[1];
  assert.throws(() => summarizeRepeatability(duplicate, ids), /duplicate/);
  const invalid = fixture(); invalid[0].elapsedMs = NaN;
  assert.throws(() => summarizeRepeatability(invalid, ids), /invalid_measurement/);
  const verdict = fixture(); verdict[0].fullPassed = false;
  assert.throws(() => summarizeRepeatability(verdict, ids), /inconsistent_verdict/);
});

test('one false acceptance vetoes an otherwise efficient aggregate', () => {
  const records = fixture();
  records[1].passed = false; records[1].fullPassed = false;
  const result = summarizeRepeatability(records, ids);
  assert.equal(result.aggregate.falseAccepts, 1);
  assert.equal(result.aggregate.strongLosses, 1);
  assert.equal(result.repeatabilityLead, false);
});

test('aggregate savings cannot hide failure in two of three repeats', () => {
  const records = fixture();
  for (const row of records) {
    if (row.strategy === 'cascade') row.costMicros = row.repeat === 3 ? 1 : 81;
  }
  const result = summarizeRepeatability(records, ids);
  assert.ok(result.aggregate.costRatio < 0.8);
  assert.equal(result.efficientRepeats, 1);
  assert.equal(result.repeatabilityLead, false);
});

test('quality must beat cheap and latency has its own gate', () => {
  const sameQuality = fixture();
  for (const row of sameQuality) row.publicPassed = row.fullPassed = row.passed = true;
  assert.equal(summarizeRepeatability(sameQuality, ids).repeatabilityLead, false);
  const slow = fixture();
  for (const row of slow) if (row.strategy === 'cascade') row.elapsedMs = 121;
  assert.equal(summarizeRepeatability(slow, ids).repeatabilityLead, false);
});
