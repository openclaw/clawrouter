import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const raw = readFileSync(new URL('../docs/fusion-fractional-score-study.json', import.meta.url), 'utf8');
const study = JSON.parse(raw);
const rows = Object.fromEntries(study.rows.map(row => [row.strategy, row]));

test('fractional-score study retains false acceptance and complete call accounting', () => {
  assert.deepEqual(study.order, ['cheap', 'strong', 'cascade']);
  assert.equal(study.rows.length, 3);
  for (const row of study.rows) {
    assert.equal(row.costMicros, row.calls.reduce((sum, call) => sum + call.costMicros, 0));
    assert.equal(row.normalizedMicros, row.calls.reduce((sum, call) => sum + call.normalizedMicros, 0));
    assert.equal(row.calls.length, 1);
    assert.equal(row.publicPassed, true);
    assert.equal(row.calls[0].publicPassed, true);
    assert.equal(row.fullTests, 23);
    assert.equal(row.fullSkipped, 0);
  }
  assert.equal(study.newModelCalls, study.rows.reduce((sum, row) => sum + row.calls.length, 0));
  assert.equal(study.newModelCalls, 3);
  assert.equal(study.newModelCostMicros, study.rows.reduce((sum, row) => sum + row.costMicros, 0));
  assert.equal(study.newModelCostMicros, 12567);
  assert.equal(study.falseAccepts, study.rows.filter(row => row.publicPassed && !row.fullPassed).length);
  assert.equal(study.falseAccepts, 2);
  for (const name of ['cheap', 'cascade']) {
    assert.equal(rows[name].fullPassed, false);
    assert.equal(rows[name].fullFailures, 1);
  }
  assert.equal(rows.strong.fullPassed, true);
  assert.equal(rows.strong.fullFailures, 0);
});

test('resource savings cannot override the failed quality gate', () => {
  assert.ok(rows.cascade.costMicros <= rows.strong.costMicros * 0.8);
  assert.ok(rows.cascade.normalizedMicros <= rows.strong.normalizedMicros * 0.8);
  assert.ok(rows.cascade.workflowMs <= rows.strong.workflowMs * 1.2);
  for (const key of ['costGate', 'normalizedCostGate', 'timeGate']) assert.equal(study.gates[key], true);
  for (const key of ['qualityPreserved', 'incrementalQualityOverCheap', 'developmentLead',
    'populationQualified', 'productionQualified']) assert.equal(study.gates[key], false);
  assert.equal(study.reusedModelCalls, 0);
  assert.equal(study.independentControlDraws, true);
  assert.equal(study.hiddenGradingAfterAllInference, true);
  assert.equal(study.independentPopulationConfirmation, false);
  assert.equal(study.qualification.expectedFull, study.qualification.expectedPublic + study.qualification.expectedHidden);
  for (const digest of Object.values(study.provenance)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(raw, /\/Users\/|\/home\/|api[_-]?key|authorization/i);
});
