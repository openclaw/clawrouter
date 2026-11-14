import assert from 'node:assert/strict';
import test from 'node:test';
import { knownLaneCost, personalGlanceMoney, personalSuccessCaption, personalMetricValue, personalPeak, personalRankedGroups, personalTrendRows, safeUsageSum, tokenTotal } from '../src/personal-usage-view.ts';
import { usageMoney } from '../src/personal-usage.ts';

const metrics = (overrides = {}) => ({ calls: 4, generationCalls: 3, utilityCalls: 1, successfulCalls: 3, errorCalls: 1, deniedCalls: 0, inputTokens: 100, outputTokens: 30, cachedInputTokens: 80, cacheWriteInputTokens: 10, reasoningOutputTokens: 20, inputReportedCalls: 4, outputReportedCalls: 4, cacheReadReportedCalls: 4, cacheWriteReportedCalls: 2, reasoningReportedCalls: 3, ...overrides });
const cost = (lane, costClass, amountMicros, calls = 1) => ({ lane, costClass, amountMicros, calls });
const group = (value, calls, costs = []) => ({ value, metrics: metrics({ calls }), costs });
const report = (overrides = {}) => ({ range: { from: 1000, to: 3000, timezone: 'Pacific/Auckland' }, metrics: metrics(), costs: [], groupBy: 'model', groups: [], buckets: [], groupsTruncated: false, ...overrides });

test('inclusive input + output never double counts cache or reasoning', () => {
  assert.deepEqual(tokenTotal(metrics()), { value: 130, input: 100, output: 30, partial: false });
  assert.equal(tokenTotal(metrics({ cachedInputTokens: 9999, reasoningOutputTokens: 9999 })).value, 130);
  assert.deepEqual(personalMetricValue(metrics(), [], 'calls'), { value: 4, partial: false });
});
test('missing fields are not zero; partial token coverage is explicit', () => {
  assert.deepEqual(tokenTotal(metrics({ inputReportedCalls: 0 })), { input: null, output: 30, value: 30, partial: true });
  assert.deepEqual(tokenTotal(metrics({ outputReportedCalls: 0 })), { input: 100, output: null, value: 100, partial: true });
  assert.deepEqual(tokenTotal(metrics({ inputReportedCalls: 0, outputReportedCalls: 0 })), { input: null, output: null, value: null, partial: true });
  assert.equal(tokenTotal(metrics({ outputReportedCalls: 2 })).partial, true);
  assert.equal(tokenTotal(metrics({ inputTokens: 0, outputTokens: 0 })).value, 0, 'reported zeros are genuine');
});
test('complete idle buckets are zero, but incomplete, clipped and unreported buckets stay unknown', () => {
  const empty = Object.fromEntries(Object.keys(metrics()).map(key => [key, 0]));
  const bucket = { start: 1000, end: 2000, label: 'idle', metrics: empty, costs: [] };
  const complete = report({ historyComplete: true, range: { from: 1000, to: 2000, retentionStart: 500, clampedStart: false }, metrics: empty, buckets: [bucket] });
  assert.deepEqual(personalTrendRows(complete, 'tokens').map(row => row.value), [0]);
  assert.deepEqual(personalTrendRows(complete, 'apiCost').map(row => row.value), [0]);
  for (const value of [
    { ...complete, historyComplete: false },
    { ...complete, historyComplete: undefined },
    { ...complete, range: { ...complete.range, clampedStart: true } },
    { ...complete, range: { ...complete.range, retentionStart: 1500 } },
    { ...complete, buckets: [{ ...bucket, start: 500 }] },
    { ...complete, buckets: [{ ...bucket, end: 2500 }] },
    { ...complete, buckets: [{ ...bucket, metrics: { ...empty, calls: 1 } }] },
  ]) {
    assert.equal(personalTrendRows(value, 'tokens')[0].value, null);
    assert.equal(personalTrendRows(value, 'apiCost')[0].value, null);
  }
  for (const field of ['inputTokens', 'outputTokens', 'inputReportedCalls', 'outputReportedCalls']) {
    const missing = { ...complete, buckets: [{ ...bucket, metrics: { ...empty, [field]: undefined } }] };
    assert.equal(personalTrendRows(missing, 'tokens')[0].value, null, field);
  }
});

test('known API subtotal excludes other quality and billing lanes', () => {
  const costs = [cost('api', 'calculated', 20), cost('api', 'fixed', 3), cost('api', 'no_charge', 0), ...['unknown', 'estimated', 'upper_bound', 'partial'].map(quality => cost('api', quality, 900)), cost('subscription', 'calculated', 10000), cost('unattributed', 'fixed', 20000)];
  assert.deepEqual(knownLaneCost(costs, 'api'), { value: 23, knownCalls: 3, totalCalls: 7, partial: true, present: true });
  assert.equal(knownLaneCost(costs, 'subscription').value, 10000);
  assert.equal(personalMetricValue(metrics(), costs, 'apiCost').value, 23);
  assert.equal(usageMoney(1), '$0.000001', 'small nonzero amounts do not look free');
});
test('unknown/missing/estimate-only prices remain null, genuine no-charge stays zero', () => {
  for (const costs of [[], [cost('api', 'unknown', 0)], [cost('api', 'estimated', 500)], [cost('subscription', 'fixed', 100)]]) assert.equal(knownLaneCost(costs, 'api').value, null);
  assert.deepEqual(knownLaneCost([cost('api', 'no_charge', 0, 3)], 'api'), { value: 0, knownCalls: 3, totalCalls: 3, partial: false, present: true });
  assert.equal(knownLaneCost([], 'subscription').present, false);
  assert.equal(knownLaneCost([cost('subscription', 'estimated', 2)], 'subscription').present, true);
});
test('unsafe, noninteger, negative and overflowing derived sums are unavailable', () => {
  for (const values of [[Number.MAX_SAFE_INTEGER, 1], [NaN], [Infinity], [0.25], [-1], [Number.MAX_SAFE_INTEGER + 1]]) assert.equal(safeUsageSum(values), null);
  assert.equal(safeUsageSum([0, 1, 3]), 4);
  assert.equal(tokenTotal(metrics({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 })).value, null);
  assert.equal(tokenTotal(metrics({ inputTokens: NaN })).value, null);
  assert.equal(knownLaneCost([cost('api', 'fixed', Number.MAX_SAFE_INTEGER), cost('api', 'calculated', 1)], 'api').value, null);
  assert.equal(knownLaneCost([cost('api', 'fixed', 1, Number.MAX_SAFE_INTEGER), cost('api', 'calculated', 1)], 'api').knownCalls, null);
  assert.equal(personalMetricValue(metrics({ calls: Infinity }), [], 'calls').value, null);
});
test('trend preserves exact server clipped bounds, labels and gaps, not padded UTC days', () => {
  const buckets = [
    { start: 1000, end: 1400, label: '2026-11-01', metrics: metrics(), costs: [cost('api', 'fixed', 10)] },
    { start: 1400, end: 2500, label: '2026-11-02', metrics: metrics({ inputReportedCalls: 0, outputReportedCalls: 0 }), costs: [cost('api', 'unknown', 0)] },
    { start: 2500, end: 3000, label: '2026-11-03', metrics: metrics({ calls: 1 }), costs: [cost('api', 'no_charge', 0)] },
  ];
  const value = report({ buckets });
  assert.deepEqual(personalTrendRows(value, 'apiCost').map(row => [row.start, row.end, row.label, row.value]), [[1000, 1400, '2026-11-01', 10], [1400, 2500, '2026-11-02', null], [2500, 3000, '2026-11-03', 0]]);
  assert.equal(personalTrendRows(value, 'tokens')[1].value, null);
  assert.deepEqual(personalPeak(personalTrendRows(value, 'calls')), { value: 4, label: '2026-11-01' });
  assert.deepEqual(personalTrendRows(report(), 'tokens'), []);
  assert.equal(personalPeak([{ label: 'empty', value: null }, { label: 'zero', value: 0 }]), null);
});
test('ranked bars sort only returned groups, stable ties, null last, bounded and explicit truncation', () => {
  const groups = [group('missing', 50), group('free', 2, [cost('api', 'no_charge', 0)]), group('high', 4, [cost('api', 'fixed', 100)]), group('tie', 1, [cost('api', 'calculated', 100)]), group(null, 1, [cost('api', 'estimated', 999)])];
  const value = report({ groups, groupsTruncated: true });
  const ranked = personalRankedGroups(value, 'apiCost');
  assert.deepEqual(ranked.rows.map(row => [row.group.value, row.value]), [['high', 100], ['tie', 100], ['free', 0], ['missing', null], [null, null]]);
  assert.equal(ranked.missing, 2); assert.equal(ranked.total, 5); assert.equal(ranked.truncated, true);
  assert.equal(personalRankedGroups(value, 'apiCost', 2).rows.length, 2);
  assert.equal(personalRankedGroups(value, 'calls').rows[0].group.value, 'missing');
  assert.deepEqual(value.groups.map(group => group.value), ['missing', 'free', 'high', 'tie', null], 'sorting does not mutate response order');
  assert.deepEqual(personalRankedGroups(report(), 'tokens'), { rows: [], missing: 0, total: 0, truncated: false });
});


test('glance cost rounds cents but preserves positive sub-cent values and rejects unavailable amounts', () => {
  assert.equal(personalGlanceMoney(14_323_800), '$14.32');
  assert.equal(personalGlanceMoney(6_428_500), '$6.43');
  assert.equal(personalGlanceMoney(10_000), '$0.01');
  assert.equal(personalGlanceMoney(9_999), '$0.009999');
  assert.equal(personalGlanceMoney(1), '$0.000001');
  assert.equal(personalGlanceMoney(0), '$0.00');
  for (const amount of [null, NaN, Infinity, -1, 0.5]) assert.equal(personalGlanceMoney(amount), 'Unavailable');
});
test('success caption is selected-period success/calls, never an invalid or invented percentage', () => {
  assert.equal(personalSuccessCaption({ calls: 400, successfulCalls: 390 }), '97.5% successful');
  assert.equal(personalSuccessCaption({ calls: 10_000, successfulCalls: 9_999 }), '>99.9% successful');
  assert.equal(personalSuccessCaption({ calls: 10_000, successfulCalls: 1 }), '<0.1% successful');
  assert.equal(personalSuccessCaption({ calls: 1_000, successfulCalls: 999 }), '99.9% successful');
  assert.equal(personalSuccessCaption({ calls: 1_000, successfulCalls: 1 }), '0.1% successful');
  assert.equal(personalSuccessCaption({ calls: 7, successfulCalls: 7 }), '100% successful');
  assert.equal(personalSuccessCaption({ calls: 7, successfulCalls: 0 }), '0% successful');
  assert.equal(personalSuccessCaption({ calls: 0, successfulCalls: 0 }), 'No calls');
  for (const [calls, successfulCalls] of [[7, 39], [0, 39], [-1, 0], [Infinity, 0], [7, NaN], [7, -1], [7, 0.5], [Number.MAX_SAFE_INTEGER + 1, 0]]) {
    assert.equal(personalSuccessCaption({ calls, successfulCalls }), 'Outcomes unavailable');
  }
});
