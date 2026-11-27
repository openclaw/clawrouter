import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRandomControl } from '../scripts/fusion-random-control.mjs';

function fixture() {
  return { version: 1, evaluationId: 'random-control', datasetRevision: 'fixture-v1',
    graderRevision: 'fixture-v1', split: 'test', records: ['a', 'b'].flatMap(caseId =>
      [['cheap', 10, 0, 5], ['strong', 110, 1, 25], ['candidate', 60, 0.5, 15]]
        .map(([strategy, costMicros, score, latencyMs]) => ({ caseId, domain: 'fixture', trial: 1,
          strategy, configurationId: strategy, costMicros, score, latencyMs, callCount: 1, status: 'completed' }))) };
}
const compare = input => compareRandomControl(input, 'candidate', ['cheap', 'strong']);

test('a cost-matched coin flip explains a candidate score without query routing', () => {
  const result = compare(fixture());
  assert.deepEqual(result.control.weights, [
    { strategy: 'cheap', probability: 0.5 }, { strategy: 'strong', probability: 0.5 }]);
  assert.equal(result.control.meanCostMicros, 60);
  assert.equal(result.control.meanScore, 0.5);
  assert.equal(result.scoreDelta, 0);
  assert.equal(result.latencyDeltaMs, 0);
  assert.equal(result.qualifiedProductionGain, false);
});

test('cheaper fixed controls remain eligible and a better mixture is found among all pairs', () => {
  const input = fixture();
  for (const row of input.records.filter(row => row.strategy === 'cheap')) row.score = 0.8;
  const result = compare(input);
  assert.equal(result.control.meanScore, 0.9);
  assert.equal(result.scoreDelta, -0.4);
  for (const caseId of ['a', 'b']) input.records.push({ ...input.records[0], caseId,
    strategy: 'middle', configurationId: 'middle', costMicros: 20, score: 1 });
  const best = compareRandomControl(input, 'candidate', ['cheap', 'strong', 'middle']);
  assert.deepEqual(best.control.weights, [{ strategy: 'middle', probability: 1 }]);
  assert.equal(best.control.meanCostMicros, 20);
});

test('equal-cost controls and budget endpoints need no division or randomization', () => {
  const input = fixture();
  for (const row of input.records) row.costMicros = 60;
  assert.deepEqual(compare(input).control.weights, [{ strategy: 'strong', probability: 1 }]);
});

test('a budget below every control is explicitly unassessed', () => {
  const input = fixture();
  for (const row of input.records.filter(row => row.strategy === 'candidate')) row.costMicros = 0;
  const result = compare(input);
  assert.equal(result.control, null);
  assert.equal(result.scoreDelta, null);
  assert.equal(result.latencyDeltaMs, null);
});

test('repeats are averaged within case and remain distinct from task count', () => {
  const input = fixture();
  input.records.push(...input.records.filter(row => row.caseId === 'a').map(row =>
    ({ ...row, trial: 2, score: row.strategy === 'candidate' ? 1 : row.score })));
  const result = compare(input);
  assert.equal(result.cases, 2);
  assert.equal(result.pairedSamples, 3);
  assert.equal(result.candidateMeans.score, 0.625);
  assert.equal(result.scoreDelta, 0.125);
});

test('errors remain scored and incomplete pairs or invalid controls fail closed', () => {
  const input = fixture();
  input.records[1].status = 'error'; input.records[1].score = 0;
  assert.equal(compare(input).control.meanScore, 0.25);
  input.records.pop();
  assert.throws(() => compare(input), /Incomplete paired/);
  for (const controls of [['cheap'], ['cheap', 'cheap'], ['cheap', 'candidate'],
    ['cheap', 'unknown'], ['cheap', , 'strong']]) {
    assert.throws(() => compareRandomControl(fixture(), 'candidate', controls));
  }
  assert.throws(() => compareRandomControl(fixture(), 'unknown', ['cheap', 'strong']), /known baseline/);
});
