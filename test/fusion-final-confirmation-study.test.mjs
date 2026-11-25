import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stratifiedFusionEvaluation } from '../scripts/fusion-stratified-evaluation.mjs';

const bytes = readFileSync(new URL('../docs/fusion-final-confirmation-study.json', import.meta.url), 'utf8');
const study = JSON.parse(bytes);
const key = row => JSON.stringify([row.caseId, row.trial, row.strategy]);

test('frozen confirmation retains every task, paired trial, outcome and model charge', () => {
  assert.equal(study.status, 'audited');
  assert.equal(study.protocolSha256, '580b20b10145cff0f4cddc8c5fa6ee62d3e6f0cc6f11f994f51e63e4b0accf3e');
  assert.equal(study.qualifiedProductionGain, false);
  const rows = study.evaluation.records;
  assert.equal(rows.length, 270);
  assert.equal(new Set(rows.map(key)).size, 270);
  assert.equal(new Set(rows.map(row => row.caseId)).size, 30);
  assert.equal(new Set(rows.map(row => row.domain)).size, 20);
  for (const id of new Set(rows.map(row => row.caseId))) {
    const task = rows.filter(row => row.caseId === id);
    assert.equal(task.length, 9);
    assert.deepEqual([...new Set(task.map(row => row.trial))].sort(), [1, 2, 3]);
    assert.deepEqual([...new Set(task.map(row => row.strategy))].sort(), ['cascade', 'cheap', 'strong']);
  }
  const outcomes = new Map(study.workflowOutcomes.map(row => [key(row), row]));
  assert.equal(outcomes.size, 270);
  for (const row of rows) {
    const outcome = outcomes.get(key(row));
    assert.ok(outcome);
    assert.equal(row.score, Number(outcome.publicPassed && outcome.fullValid && outcome.fullPassed));
    assert.ok(row.callCount >= 1 && row.callCount <= 2);
    assert.ok(Number.isSafeInteger(outcome.normalizedCostMicros) && outcome.normalizedCostMicros >= 0);
  }
  assert.equal(rows.reduce((sum, row) => sum + row.costMicros, 0), study.studyCostMicros);
  assert.equal(study.priorCampaignSpentOrReservedMicros + study.studyCostMicros, study.campaignSpentOrReservedMicros);
  assert.ok(study.studyCostMicros <= study.maximumStudyReservationMicros);
  assert.ok(study.campaignSpentOrReservedMicros <= study.campaignLimitMicros);
  assert.equal(study.cohort.roster, study.cohort.qualified + study.cohort.excluded + study.cohort.unattempted);
  assert.equal(study.workflowOutcomes.filter(row => !row.artifactPresent).length, 13);
  const incomplete = study.workflowOutcomes.filter(row => row.artifactPresent && !row.fullValid);
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].gradeExitCode, 137);
  assert.equal(incomplete[0].publicPassed, false);
});

test('all nine batch proofs and both predeclared admission strata remain represented', () => {
  assert.equal(study.batchProofs.length, 9);
  assert.deepEqual(study.batchProofs.map(row => row.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const batch of study.batchProofs) {
    assert.equal(batch.caseIds.length, 10);
    for (const name of ['protocolSha256', 'resultSha256', 'auditSha256']) assert.match(batch[name], /^[a-f0-9]{64}$/);
    for (const caseId of batch.caseIds) {
      assert.equal(study.evaluation.records.filter(row => row.caseId === caseId && row.trial === batch.trial).length, 3);
    }
  }
  assert.equal(study.partition.assignments.filter(row => row.stratum === 'admitted').length, 20);
  assert.equal(study.partition.assignments.filter(row => row.stratum === 'bypass').length, 10);
  for (const baseline of ['strong', 'cheap']) {
    const analysis = stratifiedFusionEvaluation(study.evaluation, baseline, study.partition);
    assert.equal(analysis.overall.report.baseline, baseline);
    assert.ok(analysis.overall.report.strategies.every(row => row.cases === 30 && row.runs === 90));
    assert.deepEqual(analysis.strata.map(row => row.stratum), ['admitted', 'bypass']);
    assert.ok(analysis.overall.sourceClustered.comparisons.every(row => row.clusters === 20));
  }
});

test('public evidence omits raw model content, test fixtures and personal paths', () => {
  assert.doesNotMatch(bytes, /\/Users\/|op:\/\/|\bsk-[A-Za-z0-9_-]{10,}\b/);
  const forbidden = new Set(['raw', 'prompt', 'completion', 'messages', 'authorization', 'apiKey', 'api_key', 'fullTests', 'publicTests', 'files']);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      assert.ok(!forbidden.has(name), 'Unexpected private-content field: ' + name);
      visit(child);
    }
  };
  visit(study);
});

