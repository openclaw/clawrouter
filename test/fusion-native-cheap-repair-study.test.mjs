import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { analyzeCheapRepair } from '../scripts/fusion-cheap-repair-analysis.mjs';

const study = JSON.parse(readFileSync(new URL('../docs/fusion-native-cheap-repair-study.json', import.meta.url)));

test('cheap-repair evidence reconciles all paired calls, native counts and campaign spending', () => {
  assert.equal(study.cases.length, 30);
  assert.equal(study.workflows.length, 90);
  assert.equal(study.workflows.reduce((sum, row) => sum + row.steps.length, 0), 110);
  const cases = new Map(study.cases.map(row => [row.id, row]));
  for (const row of study.workflows) {
    const item = cases.get(row.caseId);
    const sequence = study.method[row.strategy === 'cascade' ? 'candidate' : row.strategy];
    assert.ok(row.steps.length >= 1 && row.steps.length <= 3);
    assert.equal(row.costMicros, row.steps.reduce((sum, step) => sum + step.costMicros, 0));
    for (const [index, step] of row.steps.entries()) {
      const role = sequence[index];
      assert.equal(step.model, study.method.models[role]);
      const tariff = study.method.tariffsUsdPerMillionTokens[role];
      assert.ok(Number.isSafeInteger(step.inputTokens) && step.inputTokens >= 0);
      assert.ok(Number.isSafeInteger(step.outputTokens) && step.outputTokens >= 0);
      assert.equal(step.costMicros, Math.ceil(step.inputTokens * tariff.input + step.outputTokens * tariff.output));
      if (index < row.steps.length - 1) assert.equal(step.publicPassed, false);
      if (step.publicValid) assert.equal(step.publicAssertions, item.publicAssertions);
      if (step.publicPassed) assert.equal(step.publicValid, true);
    }
    assert.equal(row.publicPassed, row.steps.at(-1).publicPassed);
    if (row.fullValid) assert.equal(row.fullAssertions, item.fullAssertions);
    else assert.equal(row.fullAssertions, null);
    if (row.fullPassed) assert.ok(row.fullValid && row.publicPassed);
  }
  const actual = study.workflows.reduce((sum, row) => sum + row.costMicros, 0);
  assert.equal(actual, study.accounting.actualCostMicros);
  assert.ok(actual <= study.accounting.maximumReservationMicros);
  assert.equal(actual + study.accounting.priorCostMicros, study.accounting.campaignCostMicros);
  assert.ok(study.accounting.campaignCostMicros <= study.accounting.campaignBudgetMicros);
  assert.deepEqual(analyzeCheapRepair(study), study.summary);
  assert.equal(study.summary.passesDevelopmentGate, false);
  assert.equal(study.summary.productionQualified, false);
});

test('paired analysis refuses duplicate or absent controls', () => {
  for (const workflows of [study.workflows.slice(1), [...study.workflows, study.workflows[0]]]) {
    assert.throws(() => analyzeCheapRepair({ ...study, workflows }));
  }
});

test('quality regression against strong alone still rejects a cheap candidate', () => {
  const cases = [{ id: 'one', repository: 'example/repo' }];
  const workflows = ['cascade', 'baseline', 'strong'].map(strategy => ({
    caseId: 'one', strategy, fullPassed: strategy === 'strong', publicPassed: strategy === 'strong',
    costMicros: strategy === 'cascade' ? 1 : 100, workflowMs: 1,
  }));
  const result = analyzeCheapRepair({ cases, workflows });
  assert.deepEqual(result.regressionCaseIds, ['one']);
  assert.equal(result.passesDevelopmentGate, false);
});

test('a false acceptance rejects an otherwise cheap and fast candidate', () => {
  const cases = [{ id: 'one', repository: 'example/repo' }];
  const workflows = ['cascade', 'baseline', 'strong'].map(strategy => ({
    caseId: 'one', strategy, fullPassed: false, publicPassed: strategy === 'cascade',
    costMicros: strategy === 'cascade' ? 1 : 100, workflowMs: 1,
  }));
  assert.equal(analyzeCheapRepair({ cases, workflows }).passesDevelopmentGate, false);
});
