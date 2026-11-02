import type { PersonalUsageEvent, PersonalUsageEvents, PersonalUsageReport, UsageCostSummary, UsageGroupBy, UsageMetrics } from '../../../shared/usage-report';
// Synthetic metadata only. No prompts, completions or provider credentials.
export const fixtureNow = Date.parse('2026-11-02T12:00:00.000Z');
export const fixtureMetrics: UsageMetrics = { calls: 42, generationCalls: 38, utilityCalls: 4, successfulCalls: 39, errorCalls: 2, deniedCalls: 1, inputTokens: 124800, outputTokens: 23400, cachedInputTokens: 48000, cacheWriteInputTokens: 12000, reasoningOutputTokens: 6400, inputReportedCalls: 40, outputReportedCalls: 38, cacheReadReportedCalls: 28, cacheWriteReportedCalls: 12, reasoningReportedCalls: 16 };
export const fixtureCosts: UsageCostSummary[] = [
  { lane: 'api', costClass: 'calculated', calls: 17, amountMicros: 1_240_000 }, { lane: 'api', costClass: 'fixed', calls: 3, amountMicros: 150_000 }, { lane: 'api', costClass: 'estimated', calls: 5, amountMicros: 420_000 }, { lane: 'api', costClass: 'upper_bound', calls: 2, amountMicros: 90_000 }, { lane: 'api', costClass: 'partial', calls: 1, amountMicros: 30_000 },
  { lane: 'subscription', costClass: 'calculated', calls: 9, amountMicros: 2_350_000 }, { lane: 'subscription', costClass: 'no_charge', calls: 2, amountMicros: 0 }, { lane: 'unattributed', costClass: 'unknown', calls: 3, amountMicros: 0 },
];
function partitionMetrics(weights: number[]): UsageMetrics[] {
  const total = weights.reduce((sum, value) => sum + value, 0);
  let previous = 0;
  return weights.map(weight => {
    const cumulative = previous + weight;
    const metrics = Object.fromEntries(Object.entries(fixtureMetrics).map(([key, value]) => [key, Math.floor(value * cumulative / total) - Math.floor(value * previous / total)])) as unknown as UsageMetrics;
    metrics.generationCalls = metrics.calls - metrics.utilityCalls;
    metrics.successfulCalls = metrics.calls - metrics.errorCalls - metrics.deniedCalls;
    previous = cumulative;
    return metrics;
  });
}
export function fixtureReport(params = new URLSearchParams()): PersonalUsageReport {
  const groupBy = (params.get('groupBy') ?? 'model') as UsageGroupBy;
  const from = Date.parse(params.get('from') ?? '2026-10-26T12:00:00.000Z'), to = Date.parse(params.get('to') ?? '2026-11-02T12:00:00.000Z');
  const values = groupBy === 'model' ? ['openai/gpt-5-mini', 'anthropic/claude-sonnet', 'tavily/search'] : groupBy === 'provider' ? ['openai', 'anthropic', 'tavily'] : ['studio-key', null];
  const groupMetrics = partitionMetrics(values.length === 3 ? [28, 11, 3] : [28, 14]);
  const boundaries = [];
  for (let start = from; start < to && boundaries.length < 32;) {
    const end = Math.min(to, (Math.floor(start / 86400000) + 1) * 86400000);
    boundaries.push({ start, end, label: new Date(start).toISOString().slice(0, 10) }); start = end;
  }
  const dayMetrics = partitionMetrics(boundaries.map((_, index) => index % 3 + 1));
  const bucketCosts: UsageCostSummary[][] = boundaries.map(() => []);
  const capacity = dayMetrics.map(metrics => metrics.calls);
  let bucketIndex = 0;
  for (const cost of fixtureCosts) {
    let assigned = 0;
    while (assigned < cost.calls) {
      while (capacity[bucketIndex] === 0) bucketIndex++;
      const calls = Math.min(capacity[bucketIndex], cost.calls - assigned);
      const amountMicros = Math.floor(cost.amountMicros * (assigned + calls) / cost.calls) - Math.floor(cost.amountMicros * assigned / cost.calls);
      bucketCosts[bucketIndex].push({ ...cost, calls, amountMicros });
      assigned += calls; capacity[bucketIndex] -= calls;
    }
  }
  const buckets = boundaries.map((boundary, index) => ({ ...boundary, metrics: dayMetrics[index], costs: bucketCosts[index] }));
  return { range: { from, to, timezone: params.get('timezone') ?? 'UTC', retentionStart: fixtureNow - 30 * 86400000, clampedStart: false, buckets: boundaries }, groupBy, metrics: fixtureMetrics, costs: fixtureCosts, groups: values.map((value, index) => ({ value, metrics: groupMetrics[index], costs: index === 0 ? fixtureCosts.slice(0, 5) : values.length === 2 ? fixtureCosts.slice(5) : index === 1 ? fixtureCosts.slice(5, 7) : fixtureCosts.slice(7) })), buckets, groupsTruncated: false, historyComplete: true, generatedAt: fixtureNow };
}
export function fixtureEvents(params = new URLSearchParams()): PersonalUsageEvents {
  const second = params.has('cursor');
  const events: PersonalUsageEvent[] = Array.from({ length: second ? 2 : 3 }, (_, index) => ({ id: (second ? 'page-two-' : 'call-') + index, occurredAt: fixtureNow - (index + 1) * 60000, provider: index === 1 ? 'anthropic' : 'openai', model: index === 1 ? 'anthropic/claude-sonnet' : 'openai/gpt-5-mini', keyId: index === 1 ? null : 'studio-key', capability: 'llm.responses', callKind: 'generation', status: 'ok', statusCode: 200, durationMs: 1200, inputTokens: 2400, outputTokens: 600, cachedInputTokens: 1200, cacheWriteInputTokens: null, reasoningOutputTokens: 200, lane: index === 1 ? 'subscription' : 'api', costClass: index === 2 ? 'unknown' : index === 0 ? 'estimated' : 'calculated', reportingCostMicros: index === 2 ? null : 18000, recordedChargeMicros: 0, estimateReason: index === 0 ? 'max_declared_rate' : null, costBasis: 'token_pricing', pricingRef: 'fixture-2026-11', requestedTier: 'default', servedTier: 'default', compoundRequestId: index < 2 ? 'fusion-fixture' : null, compoundStage: index === 0 ? 'synthesizer' : index === 1 ? 'adviser' : null }));
  return { events, nextCursor: second ? null : 'opaque-page-two', historyComplete: true };
}
export const fixtureResponses: Record<string, unknown> = {
  '/v1/providers': { providers: [] }, '/v1/routes': { openaiCompatible: [], manifestProxy: [] },
  '/v1/session': { authenticated: true, auth: 'cloudflare_access', role: 'user', email: 'member@example.com', tenantId: 'personal-fixture', entitlements: { providers: [], policies: [] } },
  '/v1/session/credentials': { credentials: [] },
  '/v1/session/usage': { policies: [], usage: { ledger: 'ready', summary: { requestCount: 999999, successCount: 999999, errorCount: 0, inputTokens: 999999, outputTokens: 999999, totalTokens: 1999998, actualCostMicros: 999999000000 }, providers: [], daily: [], events: [] } },
};
