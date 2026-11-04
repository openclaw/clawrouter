import type { PersonalUsageReport, UsageCostLane, UsageCostSummary, UsageMetrics } from '../../shared/usage-report';

export type PersonalUsageMetric = 'tokens' | 'apiCost' | 'calls';
export const personalMetricLabels: Record<PersonalUsageMetric, string> = { tokens: 'Tokens', apiCost: 'API cost', calls: 'Calls' };
/** Refuse rounded, negative, or overflowing ledger-derived aggregates. */
export function safeUsageSum(values: readonly number[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(sum + value)) return null;
    sum += value;
  }
  return sum;
}
export function tokenTotal(metrics: UsageMetrics) {
  const input = metrics.inputReportedCalls > 0 ? safeUsageSum([metrics.inputTokens]) : null;
  const output = metrics.outputReportedCalls > 0 ? safeUsageSum([metrics.outputTokens]) : null;
  const reported = [input, output].filter((value): value is number => value !== null);
  const invalid = (metrics.inputReportedCalls > 0 && input === null) || (metrics.outputReportedCalls > 0 && output === null);
  return {
    input, output,
    value: !reported.length || invalid ? null : safeUsageSum(reported),
    partial: metrics.calls > 0 && (metrics.inputReportedCalls < metrics.calls || metrics.outputReportedCalls < metrics.calls),
  };
}
/** Known subtotal only: no estimates, unknowns, partial prices, or cross-lane sums. */
export function knownLaneCost(costs: readonly UsageCostSummary[], lane: UsageCostLane) {
  const entries = costs.filter(cost => cost.lane === lane && cost.calls > 0);
  const known = entries.filter(cost => cost.costClass === 'calculated' || cost.costClass === 'fixed' || cost.costClass === 'no_charge');
  const knownCalls = safeUsageSum(known.map(cost => cost.calls));
  const totalCalls = safeUsageSum(entries.map(cost => cost.calls));
  // A no-charge record is a genuine zero, never a fallback for missing prices.
  const amount = known.length ? safeUsageSum(known.map(cost => cost.costClass === 'no_charge' ? 0 : cost.amountMicros)) : null;
  return { value: amount, knownCalls, totalCalls, partial: knownCalls === null || totalCalls === null || knownCalls !== totalCalls, present: entries.length > 0 };
}
export function personalMetricValue(metrics: UsageMetrics, costs: readonly UsageCostSummary[], metric: PersonalUsageMetric) {
  if (metric === 'tokens') return tokenTotal(metrics);
  if (metric === 'apiCost') return knownLaneCost(costs, 'api');
  return { value: safeUsageSum([metrics.calls]), partial: false };
}
export function personalTrendRows(report: PersonalUsageReport, metric: PersonalUsageMetric) {
  // Use the server's order, labels and clipped bounds verbatim; do not pad UTC days.
  return report.buckets.map(bucket => ({ start: bucket.start, end: bucket.end, label: bucket.label, ...personalMetricValue(bucket.metrics, bucket.costs, metric) }));
}
export function personalRankedGroups(report: PersonalUsageReport, metric: PersonalUsageMetric, limit = 6) {
  const rows = report.groups.map((group, index) => ({ group, index, ...personalMetricValue(group.metrics, group.costs, metric) }));
  rows.sort((left, right) => left.value === null ? right.value === null ? left.index - right.index : 1 : right.value === null ? -1 : right.value - left.value || left.index - right.index);
  return { rows: rows.slice(0, limit), missing: rows.filter(row => row.value === null).length, total: rows.length, truncated: report.groupsTruncated };
}
export function personalPeak(rows: readonly { value: number | null; label: string }[]) {
  return rows.reduce<{ value: number; label: string } | null>((peak, row) => row.value !== null && row.value > 0 && (!peak || row.value > peak.value) ? { value: row.value, label: row.label } : peak, null);
}

/** Glance-only formatting. Precise chart, detail and CSV values stay unchanged. */
export function personalGlanceMoney(micros: number | null): string {
  if (micros === null || safeUsageSum([micros]) === null) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: micros > 0 && micros < 10_000 ? 6 : 2 }).format(micros / 1_000_000);
}
export function personalSuccessCaption({ calls, successfulCalls }: Pick<UsageMetrics, 'calls' | 'successfulCalls'>): string {
  if (safeUsageSum([calls]) === null || safeUsageSum([successfulCalls]) === null || successfulCalls > calls) return 'Outcomes unavailable';
  if (calls === 0) return 'No calls';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(successfulCalls / calls * 100) + '% successful';
}
