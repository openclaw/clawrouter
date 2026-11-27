import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const bytes = readFileSync(new URL('../docs/fusion-native-three-attempt-study.json', import.meta.url), 'utf8');
const study = JSON.parse(bytes);
const strategies = ['cascade', 'cheap', 'strong'];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

function validateRows(cohort, count) {
  assert.equal(cohort.cases.length, count);
  const cases = new Map(cohort.cases.map(row => [row.id, row]));
  assert.equal(cases.size, count);
  assert.equal(cohort.workflows.length, count * 9);
  const keys = new Set();
  for (const row of cohort.workflows) {
    const item = cases.get(row.caseId);
    assert.ok(item);
    assert.ok([1, 2, 3].includes(row.trial));
    assert.ok(strategies.includes(row.strategy));
    const key = JSON.stringify([row.caseId, row.trial, row.strategy]);
    assert.ok(!keys.has(key));
    keys.add(key);
    assert.ok(row.steps.length >= 1 && row.steps.length <= 3);
    assert.ok(Number.isFinite(row.workflowMs) && row.workflowMs > 0);
    assert.equal(row.costMicros, row.steps.reduce((sum, step) => sum + step.costMicros, 0));
    for (const [index, step] of row.steps.entries()) {
      const model = row.strategy === 'cascade' ? (index === 0 ? 'cheap' : 'strong') : row.strategy;
      assert.equal(step.model, study.method.models[model]);
      assert.equal(step.phase, ['initial', 'fallback', 'fallback-repair'][index]);
      for (const name of ['inputTokens', 'outputTokens', 'costMicros']) {
        assert.ok(Number.isSafeInteger(step[name]) && step[name] >= 0);
      }
      const tariff = study.method.tariffsUsdPerMillionTokens[model];
      assert.equal(step.costMicros, Math.ceil(step.inputTokens * tariff.input + step.outputTokens * tariff.output));
      if (index < row.steps.length - 1) assert.equal(step.publicPassed, false);
      if (step.publicValid) assert.equal(step.publicAssertions, item.publicAssertions);
      if (step.publicPassed) {
        assert.equal(step.publicValid, true);
        assert.equal(step.sourceRejected, false);
        assert.equal(step.syntaxPassed, true);
      }
    }
    assert.equal(row.publicPassed, row.steps.at(-1).publicPassed);
    if (row.fullValid) assert.equal(row.fullAssertions, item.fullAssertions);
    else assert.equal(row.fullAssertions, null);
    if (row.fullPassed) assert.equal(row.fullValid, true);
  }
  const summary = {};
  for (const strategy of strategies) {
    const rows = cohort.workflows.filter(row => row.strategy === strategy);
    assert.equal(rows.length, count * 3);
    summary[strategy] = {
      passed: rows.filter(row => row.publicPassed && row.fullValid && row.fullPassed).length,
      falseAccepts: rows.filter(row => row.publicPassed && !(row.fullValid && row.fullPassed)).length,
      rescues: rows.filter(row => row.fullPassed && row.steps.length > 1).length,
      costMicros: rows.reduce((sum, row) => sum + row.costMicros, 0),
      meanWorkflowMs: rows.reduce((sum, row) => sum + row.workflowMs, 0) / rows.length,
    };
  }
  return summary;
}

test('all native confirmation rows reconcile to charges, test counts and paired outcomes', () => {
  const actual = validateRows(study, 30);
  assert.equal(new Set(study.cases.map(row => row.repository)).size, 14);
  for (const [framework, count] of Object.entries({ tape: 12, mocha: 8, node: 10 })) {
    assert.equal(study.cases.filter(row => row.framework === framework).length, count);
  }
  for (const arm of strategies) {
    for (const name of ['passed', 'falseAccepts', 'costMicros', 'meanWorkflowMs']) {
      near(actual[arm][name], study.summary.arms[arm][name]);
    }
    assert.equal(study.summary.arms[arm].workflows, 90);
  }
  assert.deepEqual(strategies.map(arm => actual[arm].passed), [90, 85, 90]);
  assert.deepEqual(strategies.map(arm => actual[arm].rescues), [22, 16, 2]);
  assert.equal(study.workflows.reduce((sum, row) => sum + row.steps.length, 0), 324);
  const saving = 1 - actual.cascade.costMicros / actual.strong.costMicros;
  const slowdown = actual.cascade.meanWorkflowMs / actual.strong.meanWorkflowMs - 1;
  near(saving, study.summary.costSaving);
  near(slowdown, study.summary.meanSlowdown);
  assert.equal(study.summary.pointEstimateGatesPassed,
    actual.cascade.passed >= Math.max(actual.cheap.passed, actual.strong.passed)
    && actual.cascade.falseAccepts === 0 && saving >= 0.2 && slowdown <= 0.2);
  const thirds = study.workflows.filter(row => row.strategy === 'cascade' && row.steps.length === 3);
  assert.equal(thirds.length, 2);
  assert.ok(thirds.every(row => row.steps[1].syntaxPassed === false && row.fullPassed));
  assert.equal(strategies.reduce((sum, arm) => sum + actual[arm].costMicros, 0), study.accounting.newCostMicros);
});

test('transfer smoke remains separate and retains the cheap-only match', () => {
  const actual = validateRows(study.transfer, 3);
  const mainIds = new Set(study.cases.map(row => row.id));
  assert.ok(study.transfer.cases.every(row => !mainIds.has(row.id)));
  assert.equal(new Set(study.transfer.cases.map(row => row.repository)).size, 1);
  for (const arm of strategies) {
    for (const [name, value] of Object.entries(actual[arm])) near(value, study.transfer.summary[arm][name]);
    assert.equal(actual[arm].passed, 9);
    assert.equal(actual[arm].falseAccepts, 0);
    assert.equal(actual[arm].rescues, 0);
  }
  assert.equal(strategies.reduce((sum, arm) => sum + actual[arm].costMicros, 0), study.transfer.newCostMicros);
  assert.equal(study.accounting.priorCostMicros + study.accounting.newCostMicros, study.accounting.cumulativeCostMicros);
  assert.equal(study.accounting.cumulativeCostMicros + study.transfer.newCostMicros, study.transfer.cumulativeCostMicros);
  assert.ok(study.accounting.newCostMicros <= study.accounting.maximumReservedMicros);
  assert.ok(study.transfer.cumulativeCostMicros <= 400_000_000);
});

test('evidence preserves complete batch provenance, failed predecessor and qualification limits', () => {
  assert.equal(study.schema, 'fusion-native-three-attempt-study-v1');
  assert.equal(study.productionQualified, false);
  assert.equal(study.populationLatencyQualified, false);
  assert.equal(study.previouslyExposed, true);
  assert.equal(study.transfer.productionQualified, false);
  assert.equal(study.method.maximumCallsPerWorkflow, 3);
  assert.equal(study.method.syntaxPreflight, true);
  assert.equal(study.method.allInferenceBeforeFinalGrading, true);
  assert.equal(study.method.cacheReadsAndWrites, false);
  assert.equal(study.predecessor.maximumCallsPerWorkflow, 2);
  assert.equal(study.predecessor.syntaxPreflight, false);
  assert.equal(study.predecessor.summary.cascade.passed, 88);
  assert.equal(study.predecessor.summary.strong.passed, 90);
  assert.equal(study.predecessor.summary.cheap.missingTimings, 2);
  assert.equal(study.predecessor.summary.cheap.meanWorkflowMs, null);
  assert.ok(study.bootstrap.slowdown95[1] > 0.2);
  assert.equal(study.bootstrap.unit, 'task; retains all repeats and arms');
  assert.equal(study.bootstrap.draws, 10000);
  assert.equal(study.bootstrap.seed, 20261128);
  assert.deepEqual(study.bootstrap.qualityDifference95, [0, 0]);
  assert.equal(study.cases.filter(row => row.holdoutGroups.every(group => group.unchanged)).length, 28);
  assert.ok(study.cases.every(row => row.holdoutGroups.length === 1));
  assert.equal(study.batchProofs.length, 4);
  assert.deepEqual(study.batchProofs.map(row => row.index), [0, 1, 2, 3]);
  const covered = study.batchProofs.flatMap(row => row.caseIds);
  assert.equal(covered.length, 30);
  assert.deepEqual([...covered].sort(), study.cases.map(row => row.id).sort());
  for (const item of [...study.cases, ...study.transfer.cases]) {
    assert.match(item.repository, /^[\w.-]+\/[\w.-]+$/);
    assert.match(item.base, /^[a-f0-9]{40}$/);
    assert.match(item.reference, /^[a-f0-9]{40}$/);
    assert.ok(item.fullAssertions > item.publicAssertions);
  }
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      if (name.endsWith('Sha256')) assert.match(child, /^[a-f0-9]{64}$/);
      visit(child);
    }
  };
  visit(study);
});

test('published evidence omits model content, fixture source and personal paths', () => {
  assert.doesNotMatch(bytes, /\/Users\/|op:\/\/|\bsk-[A-Za-z0-9_-]{10,}\b/);
  const forbidden = new Set(['raw', 'prompt', 'completion', 'messages', 'authorization', 'apiKey', 'api_key', 'fullTests', 'publicTests', 'files', 'answer', 'feedback', 'stderr', 'directory']);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      assert.ok(!forbidden.has(name), `Unexpected private-content field: ${name}`);
      visit(child);
    }
  };
  visit(study);
});
