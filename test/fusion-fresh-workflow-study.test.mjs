import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stratifiedFusionEvaluation } from '../scripts/fusion-stratified-evaluation.mjs';

const bytes = readFileSync(new URL('../docs/fusion-fresh-workflow-study.json', import.meta.url), 'utf8');
const study = JSON.parse(bytes);
const key = row => JSON.stringify([row.caseId, row.trial, row.strategy]);
const rows = study.evaluation.records;
const outcomes = new Map(study.workflowOutcomes.map(row => [key(row), row]));
const sum = (values, field) => values.reduce((total, row) => total + row[field], 0);

test('interrupted confirmation preserves the frozen roster and every available paired trial', () => {
  assert.equal(study.status, 'interrupted');
  assert.deepEqual([study.interruption.plannedRows, study.interruption.recordedRows, study.interruption.replayAuditedRows, study.interruption.unrunRows], [270, 240, 210, 30]);
  assert.equal(study.protocolSha256, 'bf5b639206a02e146545f5e648f614144ad0a1523b68e407b9effe48f3f75eff');
  assert.equal(study.qualifiedProductionGain, false);
  assert.equal(rows.length, 240); assert.equal(new Set(rows.map(key)).size, 240);
  assert.equal(new Set(rows.map(row => row.caseId)).size, 30);
  assert.equal(new Set(rows.map(row => row.domain)).size, 22);
  for (const id of new Set(rows.map(row => row.caseId))) {
    const task = rows.filter(row => row.caseId === id);
    assert.ok([6, 9].includes(task.length));
    const trials = [...new Set(task.map(row => row.trial))].sort();
    assert.deepEqual(trials, task.length === 6 ? [1, 2] : [1, 2, 3]);
    for (const trial of trials) {
      assert.deepEqual(task.filter(row => row.trial === trial).map(row => row.strategy).sort(), ['cascade', 'cheap', 'strong']);
    }
  }
  assert.equal(new Set(study.partition.assignments.map(row => row.caseId)).size, 30);
  assert.equal(study.partition.assignments.filter(row => row.stratum === 'admitted').length, 26);
  assert.equal(study.partition.assignments.filter(row => row.stratum === 'bypass').length, 4);
  const environments = new Map(study.environmentAssignments.map(row => [row.caseId, row.policy]));
  assert.equal(study.environmentAssignments.length, 30); assert.equal(environments.size, 30);
  assert.equal([...environments.values()].filter(value => value === 'original-lock-v1').length, 20);
  assert.equal(Object.keys(study.environmentStrata).length, 2);
  for (const [policy, expected] of Object.entries(study.environmentStrata)) {
    const selected = rows.filter(row => environments.get(row.caseId) === policy);
    assert.equal(new Set(selected.map(row => row.caseId)).size, expected.cases);
    for (const [strategy, totals] of Object.entries(expected.strategies)) {
      const group = selected.filter(row => row.strategy === strategy);
      assert.equal(group.length, totals.runs);
      assert.equal(sum(group, 'score'), totals.passed);
      assert.equal(sum(group, 'costMicros'), totals.costMicros);
    }
  }
});

test('every outcome retains its verification verdict, call ceiling and complete charged cost', () => {
  assert.equal(outcomes.size, 240); assert.equal(study.workflowOutcomes.length, 240);
  const admitted = new Set(study.partition.assignments.filter(row => row.stratum === 'admitted').map(row => row.caseId));
  for (const row of rows) {
    const outcome = outcomes.get(key(row)); assert.ok(outcome);
    assert.equal(row.score, Number(outcome.publicPassed && outcome.fullValid && outcome.fullPassed));
    const expectedRoles = row.strategy === 'cheap' ? ['cheap', 'cheap-repair']
      : row.strategy === 'cascade' && admitted.has(row.caseId) ? ['draft', 'fallback-fresh', 'fallback-repair']
        : ['control', 'control-repair'];
    assert.deepEqual(outcome.reservedRoles, expectedRoles);
    assert.ok(Number.isSafeInteger(row.callCount) && row.callCount >= 1 && row.callCount <= expectedRoles.length);
    assert.ok(Number.isSafeInteger(row.costMicros) && row.costMicros >= 0);
    assert.ok(Number.isSafeInteger(outcome.normalizedCostMicros) && outcome.normalizedCostMicros >= 0);
    assert.ok(Number.isFinite(row.latencyMs) && row.latencyMs > 0);
  }
  assert.equal(study.workflow.fallbackMode, 'fresh'); assert.equal(study.workflow.fallbackAttempts, 2);
  assert.equal(sum(rows, 'costMicros'), study.campaign.newCostMicros);
  assert.equal(study.campaign.priorSpentOrReservedMicros, 316662825);
  assert.equal(study.campaign.maximumStudyReservationMicros, 66509715);
  assert.equal(study.campaign.spentOrReservedMicros, study.campaign.priorSpentOrReservedMicros + study.campaign.newCostMicros);
  assert.ok(study.campaign.newCostMicros <= study.campaign.maximumStudyReservationMicros);
  assert.ok(study.campaign.spentOrReservedMicros <= study.campaign.limitMicros);
});

test('seven replayed batches and the failed eighth remain distinct', () => {
  assert.deepEqual(Object.keys(study.analysisSources).sort(), [
    'scripts/evaluate-fusion.mjs', 'scripts/fusion-cluster-intervals.mjs', 'scripts/fusion-stratified-evaluation.mjs',
  ]);
  for (const [path, expected] of Object.entries(study.analysisSources)) {
    const source = readFileSync(new URL('../' + path, import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), expected);
  }
  assert.deepEqual(study.batchProofs.map(row => row.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const batch of study.batchProofs) {
    assert.equal(batch.caseIds.length, 10); assert.equal(new Set(batch.caseIds).size, 10);
    assert.equal(batch.audited, batch.index < 7);
    const pins = batch.audited ? ['protocolSha256', 'resultSha256', 'auditSha256', 'amendmentSha256', 'replaySha256'] : ['protocolSha256', 'resultSha256'];
    if (!batch.audited) { assert.equal(batch.replayFailed, true); assert.equal(batch.replaySha256, undefined); }
    for (const name of pins) {
      assert.match(batch[name], /^[a-f0-9]{64}$/);
    }
    const selected = rows.filter(row => batch.caseIds.includes(row.caseId) && row.trial === batch.trial);
    assert.equal(selected.length, 30); assert.equal(sum(selected, 'callCount'), batch.requests);
  }
});

test('quality, cost and latency gates reproduce without conflating cheap sample wins with rescues', () => {
  const strong = stratifiedFusionEvaluation(study.evaluation, 'strong', study.partition);
  const cheap = stratifiedFusionEvaluation(study.evaluation, 'cheap', study.partition);
  const comparison = strong.overall.report.comparisons.find(row => row.strategy === 'cascade');
  assert.equal(strong.overall.sourceClustered.comparisons.find(row => row.strategy === 'cascade').clusters, 22);
  assert.ok(strong.overall.report.strategies.every(row => row.runs === 80 && row.cases === 30));
  assert.deepEqual(strong.strata.map(row => row.stratum), ['admitted', 'bypass']);
  assert.deepEqual(study.equivalence.bound, comparison.binaryTaskLoss);
  assert.equal(study.equivalence.maximumTaskLossRate, .05);
  assert.equal(study.equivalence.passed, comparison.binaryTaskLoss.upper95 <= .05);
  const normalizedInput = { ...study.evaluation, records: rows.map(row => ({ ...row, costMicros: outcomes.get(key(row)).normalizedCostMicros })) };
  const normalizedRatio = stratifiedFusionEvaluation(normalizedInput, 'strong', study.partition).overall.report.comparisons.find(row => row.strategy === 'cascade').meanCostRatio;
  assert.equal(study.developmentScreen.normalizedCostRatio, normalizedRatio);
  const falseAccepts = study.workflowOutcomes.filter(row => row.strategy === 'cascade' && row.publicPassed && !(row.fullValid && row.fullPassed)).length;
  assert.equal(study.verificationCounts.cascade.falseAccepts, falseAccepts);
  assert.deepEqual(study.developmentScreen.gates, {
    recordedCost: comparison.meanCostRatio <= .8,
    cacheNeutralCost: normalizedRatio <= .8,
    noObservedStrongLoss: comparison.binaryTaskLoss.casesWithLostBaselineSuccess === 0,
    latency: study.latencyQualified && comparison.meanLatencyRatio <= 1.2,
    noFalseAccepts: falseAccepts === 0,
  });
  assert.equal(study.developmentScreen.complete, false);
  assert.equal(study.developmentScreen.passed, false);
  assert.equal(falseAccepts, 1);
  assert.equal(comparison.binaryTaskLoss.casesWithLostBaselineSuccess, 1);
  assert.equal(study.workflowOutcomes.filter(row => row.replayAudited).length, 210);
  const paired = new Map(rows.map(row => [key(row), row]));
  let rescues = 0, sampleWins = 0;
  for (const outcome of study.workflowOutcomes.filter(row => row.strategy === 'cascade')) {
    const current = paired.get(key(outcome));
    const baseline = paired.get(key({ ...outcome, strategy: 'cheap' }));
    if (current.score === 1 && baseline.score === 0) {
      if (outcome.escalated) rescues++; else sampleWins++;
    }
  }
  assert.equal(study.cheapComparison.rescuedCheapFailures, rescues);
  assert.equal(study.cheapComparison.independentDraftWins, sampleWins);
  assert.deepEqual(study.cheapComparison.sourceClustered, cheap.overall.sourceClustered.comparisons.find(row => row.strategy === 'cascade'));
});

test('public study contains no raw prompts, model responses, fixtures or personal paths', () => {
  assert.doesNotMatch(bytes, /\/Users\/|op:\/\/|\bsk-[A-Za-z0-9_-]{10,}\b/);
  const forbidden = new Set(['raw', 'prompt', 'completion', 'messages', 'authorization', 'apiKey', 'api_key', 'fullTests', 'publicTests', 'files', 'answer']);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      assert.ok(!forbidden.has(name), 'Unexpected private-content field: ' + name);
      visit(child);
    }
  };
  visit(study);
});

test('the public failure remains reproducible under a fixed clock without changing original results', () => {
  assert.equal(study.interruption.caseId, 'undici-de01babccb69');
  assert.equal(study.interruption.originalPublicPassed, true);
  assert.equal(study.interruption.originalFullPassed, false);
  assert.equal(study.interruption.unchangedPublicProbePassed, false);
  assert.deepEqual(study.interruption.fixedClock, [
    { strategy: 'cascade', passed: false, tests: 60, failures: 1 },
    { strategy: 'strong', passed: true, tests: 60, failures: 0 },
  ]);
  const failed = study.workflowOutcomes.filter(row => row.caseId === study.interruption.caseId && row.trial === 3 && row.strategy === 'cascade');
  assert.equal(failed.length, 1); assert.equal(failed[0].publicPassed, true); assert.equal(failed[0].fullPassed, false);
  assert.equal(failed[0].replayAudited, false);
});
