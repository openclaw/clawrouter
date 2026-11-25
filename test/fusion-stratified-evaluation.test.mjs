import assert from 'node:assert/strict';
import test from 'node:test';
import { stratifiedFusionEvaluation } from '../scripts/fusion-stratified-evaluation.mjs';

function fixture() {
  const records = [];
  for (const [caseId, trials] of [['a', 3], ['b', 1], ['c', 2]]) {
    for (let trial = 1; trial <= trials; trial++) {
      for (const strategy of ['strong', 'cascade', 'cheap']) {
        records.push({ caseId, domain: `source-${caseId}`, trial, strategy,
          configurationId: `${strategy}-v1`, score: strategy === 'cascade' && caseId === 'a' && trial === 1 ? 0 : 1,
          costMicros: strategy === 'strong' ? 10 : 2, latencyMs: 10, callCount: 1, status: 'completed' });
      }
    }
  }
  return { version: 1, evaluationId: 'example', datasetRevision: 'data-v1', graderRevision: 'grader-v1', split: 'test', records };
}
const partition = () => ({ revision: 'frozen-policy-v1', assignments: [
  { caseId: 'a', stratum: 'admitted' }, { caseId: 'b', stratum: 'admitted' }, { caseId: 'c', stratum: 'bypass' },
] });
const cascade = report => report.strategies.find(row => row.strategy === 'cascade');

test('strata retain every paired trial, overall losses and equal-case weighting', () => {
  const input = fixture(), before = structuredClone(input);
  const result = stratifiedFusionEvaluation(input, 'strong', partition());
  assert.equal(result.partitionRevision, 'frozen-policy-v1');
  assert.deepEqual(result.strata.map(row => row.stratum), ['admitted', 'bypass']);
  assert.equal(cascade(result.overall.report).runs, 6);
  assert.equal(cascade(result.overall.report).cases, 3);
  assert.equal(cascade(result.overall.report).meanScore, (2 / 3 + 1 + 1) / 3);
  const [admitted, bypass] = result.strata;
  assert.equal(cascade(admitted.report).runs, 4);
  assert.equal(cascade(admitted.report).meanScore, (2 / 3 + 1) / 2);
  assert.equal(admitted.report.comparisons.find(row => row.strategy === 'cascade').binaryTaskLoss.casesWithLostBaselineSuccess, 1);
  assert.equal(admitted.sourceClustered.comparisons[0].clusters, 2);
  assert.equal(bypass.sourceClustered.comparisons[0].scoreDelta95, null);
  assert.deepEqual(input, before);
  assert.equal(result.overall.report.comparisons.find(row => row.strategy === 'cascade').binaryTaskLoss.casesWithLostBaselineSuccess, 1);
});

test('cheap baseline and development split use the same complete partition', () => {
  const input = { ...fixture(), split: 'development' };
  assert.throws(() => stratifiedFusionEvaluation(input, 'cheap', partition()), /held-out/);
  const result = stratifiedFusionEvaluation(input, 'cheap', partition(), 'development');
  assert.equal(result.overall.report.baseline, 'cheap');
  assert.deepEqual(result.strata.map(row => row.report.baseline), ['cheap', 'cheap']);
  assert.equal(result.overall.report.comparisons.find(row => row.strategy === 'strong').meanCostRatio, 5);
});

test('missing, duplicate, unknown and malformed assignments fail instead of selecting a subgroup', () => {
  for (const change of [
    p => p.assignments.pop(),
    p => p.assignments.push(p.assignments[0]),
    p => { p.assignments[0].caseId = 'unknown'; },
    p => { p.assignments[0].stratum = ''; },
    p => { p.assignments[0].score = 1; },
    p => { p.revision = ''; },
  ]) {
    const p = partition(); change(p);
    assert.throws(() => stratifiedFusionEvaluation(fixture(), 'strong', p), /Fusion (partition|stratum)/);
  }
});

test('an incomplete arm remains an error even inside a complete partition', () => {
  const input = fixture(); input.records.pop();
  assert.throws(() => stratifiedFusionEvaluation(input, 'strong', partition()), /Incomplete paired runs/);
});
