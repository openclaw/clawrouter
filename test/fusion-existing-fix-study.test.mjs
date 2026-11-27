import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const raw = readFileSync(new URL('../docs/fusion-existing-fix-study.json', import.meta.url), 'utf8');
const study = JSON.parse(raw);
const rows = Object.fromEntries(study.rows.map(row => [row.strategy, row]));

test('fresh comparison accounts for every call and retains the independent cheap control', () => {
  assert.deepEqual(study.order, ['cheap', 'strong', 'cascade']);
  assert.equal(study.rows.length, 3);
  for (const row of study.rows) {
    assert.equal(row.costMicros, row.calls.reduce((sum, call) => sum + call.costMicros, 0));
    assert.equal(row.normalizedMicros, row.calls.reduce((sum, call) => sum + call.normalizedMicros, 0));
    assert.equal(row.fullPassed, true); assert.equal(row.fullTests, 10);
    assert.equal(row.fullFailures, 0); assert.equal(row.fullSkipped, 0);
  }
  assert.equal(study.rows.reduce((sum, row) => sum + row.calls.length, 0), study.newModelCalls);
  assert.equal(study.newModelCalls, 4);
  assert.equal(study.rows.reduce((sum, row) => sum + row.costMicros, 0), study.newModelCostMicros);
  assert.equal(study.newModelCostMicros, 21674);
  assert.equal(study.reusedModelCalls, 0); assert.equal(study.independentControlDraws, true);
  assert.deepEqual(rows.cascade.calls.map(call => call.publicPassed), [false, true]);
  assert.equal(rows.cheap.calls[0].publicPassed, true);
});

test('failed cost/time and incremental-quality gates cannot be described as a cascade lead', () => {
  assert.ok(rows.cascade.costMicros > rows.strong.costMicros);
  assert.ok(rows.cascade.normalizedMicros > rows.strong.normalizedMicros);
  assert.ok(rows.cascade.workflowMs > rows.strong.workflowMs * 1.2);
  assert.equal(study.gates.qualityPreserved, true);
  for (const key of ['incrementalQualityOverCheap', 'costGate', 'normalizedCostGate', 'timeGate',
    'productionQualified', 'populationQualified', 'developmentLead']) assert.equal(study.gates[key], false);
  assert.equal(study.independentPopulationConfirmation, false);
  assert.equal(study.hiddenGradingAfterAllInference, true);
  assert.deepEqual(study.taskSelection, { screened: 6, partitionExcluded: 4, nativeCountExcluded: 1, qualified: 1, replacementCases: 0 });
  assert.equal(study.qualification.expectedFull, study.qualification.expectedPublic + study.qualification.expectedHidden);
  for (const digest of Object.values(study.provenance)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(raw, /\/Users\/|\/home\/|api[_-]?key|authorization/i);
});
