import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeRepeatability } from '../scripts/fusion-repeatability-summary.mjs';

const ids = Array.from({ length: 6 }, (_, i) => `task-${i}`);
function fixture() {
  return [1, 2, 3].flatMap(repeat => ids.flatMap(caseId => ['strong', 'cascade', 'cheap'].map(strategy => ({
    repeat, caseId, strategy, costMicros: strategy === 'strong' ? 100 : 50,
    elapsedMs: 100, publicPassed: strategy !== 'cheap', fullValid: true,
    fullPassed: strategy !== 'cheap', passed: strategy !== 'cheap',
  }))));
}

test('repeatability keeps six tasks distinct from eighteen paired samples', () => {
  const result = summarizeRepeatability(fixture(), ids);
  assert.equal(result.independentTasks, 6);
  assert.equal(result.pairedSamples, 18);
  assert.equal(result.aggregate.cascade.passed, 18);
  assert.equal(result.repeatabilityLead, true);
  assert.equal(result.qualifiedProductionGain, false);
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
