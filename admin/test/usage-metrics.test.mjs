import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyUsageMetrics, usageMetricKeys, usageTokenFields } from '../../shared/usage-report.ts';

test('report metrics preserve the exported field order and fresh zero values', () => {
  const expected = [
    'calls', 'generationCalls', 'utilityCalls', 'successfulCalls', 'errorCalls', 'deniedCalls',
    'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens',
    'inputReportedCalls', 'outputReportedCalls', 'cacheReadReportedCalls', 'cacheWriteReportedCalls', 'reasoningReportedCalls',
  ];
  assert.deepEqual(usageMetricKeys, expected);
  const first = emptyUsageMetrics(), second = emptyUsageMetrics();
  assert.deepEqual(Object.keys(first), expected);
  assert.deepEqual(Object.values(first), expected.map(() => 0));
  first.calls = 3;
  assert.equal(second.calls, 0);
  assert.equal(emptyUsageMetrics().calls, 0);
});

test('each reported token field retains its matching presence counter', () => {
  assert.deepEqual(usageTokenFields, [
    ['inputTokens', 'inputReportedCalls'], ['outputTokens', 'outputReportedCalls'],
    ['cachedInputTokens', 'cacheReadReportedCalls'], ['cacheWriteInputTokens', 'cacheWriteReportedCalls'],
    ['reasoningOutputTokens', 'reasoningReportedCalls'],
  ]);
});
