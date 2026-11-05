import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeOpportunity } from '../scripts/fusion-opportunity.mjs';

const row = (caseId, strategy, score, costMicros = 10) => ({ caseId, domain: 'regression', strategy,
  score, costMicros, trial: 1, status: 'completed', configurationId: strategy });
const source = records => ({ version: 1, evaluationId: 'fixture', datasetRevision: 'data',
  graderRevision: 'grader', split: 'development', records });

test('hindsight ceiling separates complementary wins from cases no worker solves', () => {
  const a = source([row('first', 'a', 1), row('second', 'a', 0), row('third', 'a', 0)]);
  const b = source([row('first', 'b', 0, 30), row('second', 'b', 1, 30), row('third', 'b', 0, 30)]);
  const result = analyzeOpportunity([a, b], ['a', 'b']);
  assert.equal(result.oracleSolved, 2);
  assert.equal(result.bestFixedSolved, 1);
  assert.equal(result.potentialAdditionalSolved, 1);
  assert.equal(result.allCandidatesCostMicros, 120);
  assert.deepEqual(result.allFailCases, ['third']);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].digest.length, 64);
});

test('missing pairs, duplicate rows, mixed splits and corrupt outcomes fail closed', () => {
  const paired = [row('first', 'a', 0), row('first', 'b', 1)];
  assert.throws(() => analyzeOpportunity([source(paired.slice(0, 1))], ['a', 'b']), /incomplete/);
  assert.throws(() => analyzeOpportunity([source([...paired, paired[0]])], ['a', 'b']), /conflicting/);
  assert.throws(() => analyzeOpportunity([source(paired), { ...source([]), split: 'test' }], ['a', 'b']), /mixed/);
  assert.throws(() => analyzeOpportunity([source([{ ...paired[0], score: 0.5 }, paired[1]])], ['a', 'b']), /invalid/);
  assert.throws(() => analyzeOpportunity([source([{ ...paired[0], status: 'error', score: 1 }, paired[1]])], ['a', 'b']), /invalid/);
  assert.throws(() => analyzeOpportunity([source(paired)], ['a', 'a']), /invalid/);
  assert.throws(() => analyzeOpportunity([source(paired.map(r => ({ ...r, costMicros: Number.MAX_SAFE_INTEGER })))], ['a', 'b']), /overflow/);
});

test('other trials and strategies cannot silently change the selected experiment', () => {
  const result = analyzeOpportunity([source([row('first', 'a', 1), row('first', 'b', 0),
    { ...row('first', 'a', 0), trial: 2 }, row('first', 'unselected', 1)])], ['a', 'b']);
  assert.equal(result.cases, 1);
  assert.equal(result.oracleSolved, 1);
  assert.deepEqual(result.rows[0].solvedBy, ['a']);
});
