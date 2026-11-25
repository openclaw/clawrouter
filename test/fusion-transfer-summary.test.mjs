import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeTransfer } from '../scripts/fusion-repeatability-summary.mjs';

const ids = Array.from({ length: 30 }, (_, i) => `task-${i}`);
function fixture() {
  return ['cheap', 'strong', 'cascade'].flatMap(strategy => ids.map(caseId => ({
    caseId, strategy, costMicros: strategy === 'strong' ? 100 : 50,
    normalizedMicros: strategy === 'strong' ? 100 : 50,
    elapsedMs: 100, publicPassed: strategy !== 'cheap', fullValid: true,
    fullPassed: strategy !== 'cheap', passed: strategy !== 'cheap',
  })));
}

test('single-draw transfer counts thirty tasks and pairs outcomes across batches by ID', () => {
  const result = summarizeTransfer(fixture().reverse(), ids);
  assert.equal(result.uniqueTasks, 30);
  assert.equal(result.drawsPerTask, 1);
  assert.equal(result.pairedSamples, 30);
  assert.equal(result.outcomes, 90);
  assert.equal(result.aggregate.strong.passed, 30);
  assert.equal(result.aggregate.cascade.costMicros, 1500);
  assert.equal(result.aggregate.costRatio, 0.5);
  assert.equal(result.transferLead, true);
  assert.equal(result.qualifiedProductionGain, false);
});

test('partial batches, duplicate outcomes and repeated draws cannot replace the declared cohort', () => {
  assert.throws(() => summarizeTransfer(fixture().slice(30), ids), /complete_single_draw/);
  assert.throws(() => summarizeTransfer(fixture(), ids.slice(1)), /declared_task_count/);
  const duplicate = fixture(); duplicate[0] = duplicate[1];
  assert.throws(() => summarizeTransfer(duplicate, ids), /duplicate_outcome/);
  const unknown = fixture(); unknown[0].caseId = 'other-task';
  assert.throws(() => summarizeTransfer(unknown, ids), /unknown_task/);
  const repeated = fixture(); repeated[0].repeat = 1;
  assert.throws(() => summarizeTransfer(repeated, ids), /unknown_repeat/);
});

test('a strong loss vetoes a cheaper aggregate even when another task rescues quality', () => {
  const rows = fixture();
  const cascade = rows.find(row => row.caseId === ids[0] && row.strategy === 'cascade');
  cascade.publicPassed = cascade.fullPassed = cascade.passed = false;
  const strong = rows.find(row => row.caseId === ids[1] && row.strategy === 'strong');
  strong.publicPassed = strong.fullPassed = strong.passed = false;
  const result = summarizeTransfer(rows, ids);
  assert.equal(result.aggregate.strong.passed, result.aggregate.cascade.passed);
  assert.equal(result.aggregate.strongLosses, 1);
  assert.equal(result.aggregate.efficiencyGate, true);
  assert.equal(result.transferLead, false);
});

test('public acceptance still fails when full tests fail or are invalid', () => {
  for (const field of ['fullPassed', 'fullValid']) {
    const rows = fixture();
    const cascade = rows.find(row => row.strategy === 'cascade');
    cascade[field] = cascade.passed = false;
    const result = summarizeTransfer(rows, ids);
    assert.equal(result.aggregate.falseAccepts, 1);
    assert.equal(result.transferLead, false);
  }
  const inconsistent = fixture(); inconsistent[0].passed = true;
  assert.throws(() => summarizeTransfer(inconsistent, ids), /inconsistent_verdict/);
});

test('normalized cost, latency and cheap-control quality each veto apparent savings', () => {
  const missing = fixture(); delete missing[0].normalizedMicros;
  assert.throws(() => summarizeTransfer(missing, ids), /invalid_normalized_cost/);
  for (const change of [
    row => { if (row.strategy === 'cascade') row.normalizedMicros = 81; },
    row => { if (row.strategy === 'cascade') row.elapsedMs = 121; },
    row => { if (row.strategy === 'cheap') row.publicPassed = row.fullPassed = row.passed = true; },
  ]) {
    const rows = fixture(); rows.forEach(change);
    assert.equal(summarizeTransfer(rows, ids).transferLead, false);
  }
});
