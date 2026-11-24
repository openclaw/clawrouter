import assert from 'node:assert/strict';
import test from 'node:test';
import { auditedFusionCosts, screenFusionCosts } from '../scripts/fusion-cost-screen.mjs';

const rows = (invoice = 70, normalized = 70) => [
  { id: 'task', strategy: 'strong', costMicros: 100, normalizedMicros: 100 },
  { id: 'task', strategy: 'cascade', costMicros: invoice, normalizedMicros: normalized },
];

test('cache discounts cannot turn a normalized regression into cost eligibility', () => {
  const result = screenFusionCosts(rows(60, 105), 1);
  assert.equal(result.invoiceCostScreen, true);
  assert.equal(result.normalizedCostRatio, 1.05);
  assert.equal(result.costScreen, false);
  assert.equal(screenFusionCosts(rows(80, 80), 1).costScreen, true);
  assert.equal(screenFusionCosts(rows(81, 70), 1).costScreen, false);
});

test('all calls count regardless of disposition, including rejected drafts and retries', () => {
  const stage = records => ({ status: 'audited', records, newCostMicros: records.reduce((sum, row) => sum + row.costMicros, 0) });
  const costs = auditedFusionCosts([
    stage([{ costMicros: 10, normalizedMicros: 30, disposition: 'incomplete' }]),
    stage([{ costMicros: 20, normalizedMicros: 40, disposition: 'complete' },
      { costMicros: 30, normalizedMicros: 50, disposition: 'complete' }]),
  ]);
  assert.deepEqual(costs, { costMicros: 60, normalizedMicros: 120 });
});

test('missing usage, unaudited stages and mismatched totals fail closed', () => {
  assert.throws(() => screenFusionCosts(rows().map(({ normalizedMicros, ...row }) => row), 1), /invalid_fusion_cost/);
  assert.throws(() => auditedFusionCosts([]), /missing_fusion_stages/);
  assert.throws(() => auditedFusionCosts([{ status: 'pending' }]), /unaudited/);
  assert.throws(() => auditedFusionCosts([{ status: 'audited', records: [], newCostMicros: 0 }]), /missing_fusion_calls/);
  assert.throws(() => auditedFusionCosts([{ status: 'audited', records: [{ costMicros: 1, normalizedMicros: 2 }], newCostMicros: 0 }]), /mismatch/);
});

test('unpaired and duplicate arms cannot pass', () => {
  assert.throws(() => screenFusionCosts(rows().slice(1), 1), /incomplete/);
  assert.throws(() => screenFusionCosts([rows()[0], rows()[0]], 1), /duplicate/);
  assert.throws(() => screenFusionCosts([rows()[0], { ...rows()[1], id: 'other' }], 1), /incomplete/);
  assert.throws(() => screenFusionCosts([{ ...rows()[0], strategy: '__proto__' }, rows()[1]], 1), /invalid_fusion_strategy/);
});

test('zero denominator, invalid currency and overflow never produce a passing screen', () => {
  assert.equal(screenFusionCosts(rows(0, 0).map(row => ({ ...row, costMicros: 0, normalizedMicros: 0 })), 1).costScreen, false);
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => screenFusionCosts(rows(value), 1), /invalid_fusion_cost/);
  }
  assert.throws(() => screenFusionCosts([...rows(Number.MAX_SAFE_INTEGER), ...rows().map(row => ({ ...row, id: 'second' }))], 2), /invalid_fusion_cost/);
});
