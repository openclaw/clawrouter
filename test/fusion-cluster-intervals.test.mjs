import assert from 'node:assert/strict';
import test from 'node:test';
import { clusteredFusionIntervals } from '../scripts/fusion-cluster-intervals.mjs';
import { evaluateFusion } from '../scripts/evaluate-fusion.mjs';

function fixture(count = 20) {
  const records = [];
  for (let i = 0; i < count; i++) {
    const positive = i >= count / 2;
    for (const strategy of ['strong', 'cascade']) records.push({
      caseId: `case-${i}`, domain: positive ? 'source-b' : 'source-a', trial: 1,
      strategy, configurationId: `${strategy}-v1`, score: Number(strategy === 'strong' ? !positive : positive),
      costMicros: strategy === 'strong' ? 10 : 5, latencyMs: strategy === 'strong' ? 100 : 120,
      callCount: 1, status: 'completed',
    });
  }
  return { version: 1, evaluationId: 'cluster-test', datasetRevision: 'fixed-v1', graderRevision: 'binary-v1', split: 'test', records };
}

test('related cases move together instead of manufacturing independent evidence', () => {
  const input = fixture(), report = clusteredFusionIntervals(input, 'strong'), row = report.comparisons[0];
  assert.equal(row.cases, 20);
  assert.equal(row.clusters, 2);
  assert.deepEqual([row.scoreDelta95.low, row.scoreDelta95.high], [-1, 1]);
  assert.ok(evaluateFusion(input, 'strong').comparisons[0].scoreDelta95.low > -1);
  assert.deepEqual([row.costRatio95.low, row.costRatio95.high], [.5, .5]);
  assert.deepEqual([row.latencyRatio95.low, row.latencyRatio95.high], [1.2, 1.2]);
  assert.deepEqual(report, clusteredFusionIntervals(input, 'strong'));
  assert.deepEqual(report, clusteredFusionIntervals({ ...input, records: [...input.records].reverse() }, 'strong'));
});

test('repeated trials and differently sized domains preserve equal task weighting', () => {
  const input = fixture(4);
  input.records = input.records.filter(row => row.caseId !== 'case-3');
  input.records.push(...input.records.filter(row => row.caseId === 'case-0').map(row => ({ ...row, trial: 2 })));
  const row = clusteredFusionIntervals(input, 'strong').comparisons[0];
  assert.equal(row.cases, 3);
  assert.equal(row.clusters, 2);
  assert.deepEqual([row.costDelta95.low, row.costDelta95.high], [-5, -5]);
  assert.deepEqual([row.latencyDelta95.low, row.latencyDelta95.high], [20, 20]);
  const singleTrial = { ...input, records: input.records.filter(row => row.trial === 1) };
  assert.deepEqual(row, clusteredFusionIntervals(singleTrial, 'strong').comparisons[0]);
});

test('a single source cannot establish uncertainty even with many tasks', () => {
  const input = fixture(); input.records.forEach(row => { row.domain = 'same-source'; });
  const row = clusteredFusionIntervals(input, 'strong').comparisons[0];
  assert.equal(row.clusters, 1);
  for (const key of ['scoreDelta95', 'costDelta95', 'costRatio95', 'latencyDelta95', 'latencyRatio95']) assert.equal(row[key], null);
});

test('cluster draws weight the sampled tasks, not the sampled domain means', () => {
  const input = fixture(8);
  input.records = input.records.filter(row => row.caseId !== 'case-7');
  for (const row of input.records) {
    const index = Number(row.caseId.slice(5));
    row.domain = index < 4 ? 'large-source' : `source-${index}`;
    if (row.strategy === 'cascade') row.costMicros = index < 4 ? 20 : 0;
  }
  const row = clusteredFusionIntervals(input, 'strong').comparisons[0];
  assert.equal(row.clusters, 4);
  assert.equal(row.scoreDelta95.low, -11 / 13);
  assert.equal(row.costRatio95.high, 24 / 13);
});

test('undefined ratio draws remain null and validation retains failed measurements', () => {
  const input = fixture(4);
  input.records.filter(row => row.strategy === 'strong' && row.domain === 'source-a').forEach(row => { row.costMicros = 0; row.latencyMs = 0; });
  const row = clusteredFusionIntervals(input, 'strong').comparisons[0];
  assert.equal(row.costRatio95, null);
  assert.equal(row.latencyRatio95, null);
  assert.ok(row.costDelta95);
  const failed = input.records.find(row => row.strategy === 'cascade');
  Object.assign(failed, { status: 'error', score: 0, costMicros: 25 });
  assert.ok(clusteredFusionIntervals(input, 'strong').comparisons[0].costDelta95.high > 0);
  input.records.pop();
  assert.throws(() => clusteredFusionIntervals(input, 'strong'), /Incomplete paired/);
});
