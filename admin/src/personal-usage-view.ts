import type { PersonalUsageReport, UsageCostLane, UsageCostSummary, UsageMetrics } from '../../shared/usage-report';

/** Presentation-only coverage: complete discovered scope is not exhaustive history. */
export type PersonalUsageView = Omit<PersonalUsageReport, 'historyComplete'> & { historyComplete?: boolean; discoveredScopeAnswered?: boolean };

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
export function personalHistoryComplete(report: PersonalUsageView, start = report.range.from, end = report.range.to) {
  const { range } = report;
  return (report.discoveredScopeAnswered === true || report.historyComplete === true) && range.clampedStart === false && range.from >= range.retentionStart
    && start >= range.from && end <= range.to && end > start;
}
export function tokenTotal(metrics: UsageMetrics, complete = false) {
  const empty = complete && metrics.calls === 0 && metrics.inputReportedCalls === 0 && metrics.outputReportedCalls === 0
    && metrics.inputTokens === 0 && metrics.outputTokens === 0;
  const input = metrics.inputReportedCalls > 0 || empty ? safeUsageSum([metrics.inputTokens]) : null;
  const output = metrics.outputReportedCalls > 0 || empty ? safeUsageSum([metrics.outputTokens]) : null;
  const reported = [input, output].filter((value): value is number => value !== null);
  const invalid = (metrics.inputReportedCalls > 0 && input === null) || (metrics.outputReportedCalls > 0 && output === null);
  return {
    input, output,
    value: !reported.length || invalid ? null : safeUsageSum(reported),
    partial: metrics.calls > 0 && (metrics.inputReportedCalls < metrics.calls || metrics.outputReportedCalls < metrics.calls),
  };
}
/** Known subtotal only: no estimates, unknowns, partial prices, or cross-lane sums. */
export function knownLaneCost(costs: readonly UsageCostSummary[], lane: UsageCostLane, completeCalls?: number) {
  const entries = costs.filter(cost => cost.lane === lane && cost.calls > 0);
  const known = entries.filter(cost => cost.costClass === 'calculated' || cost.costClass === 'fixed' || cost.costClass === 'no_charge');
  const knownCalls = safeUsageSum(known.map(cost => cost.calls));
  const totalCalls = safeUsageSum(entries.map(cost => cost.calls));
  // An absent lane is known empty only when complete history accounts for every call's lane.
  const empty = !entries.length && completeCalls !== undefined && safeUsageSum([completeCalls]) !== null
    && safeUsageSum(costs.map(cost => cost.calls)) === completeCalls && costs.every(cost => cost.lane === 'api' || cost.lane === 'subscription');
  const amount = known.length ? safeUsageSum(known.map(cost => cost.costClass === 'no_charge' ? 0 : cost.amountMicros)) : empty ? 0 : null;
  return { value: amount, knownCalls, totalCalls, partial: knownCalls === null || totalCalls === null || knownCalls !== totalCalls, present: entries.length > 0 };
}
export function personalMetricValue(metrics: UsageMetrics, costs: readonly UsageCostSummary[], metric: PersonalUsageMetric, complete = false) {
  if (metric === 'tokens') return tokenTotal(metrics, complete);
  if (metric === 'apiCost') return knownLaneCost(costs, 'api', complete ? metrics.calls : undefined);
  return { value: safeUsageSum([metrics.calls]), partial: false };
}
export function personalTrendRows(report: PersonalUsageView, metric: PersonalUsageMetric) {
  // Use the server's order, labels and clipped bounds verbatim; do not pad UTC days.
  return report.buckets.map(bucket => ({ start: bucket.start, end: bucket.end, label: bucket.label, ...personalMetricValue(bucket.metrics, bucket.costs, metric, personalHistoryComplete(report, bucket.start, bucket.end)) }));
}
export function personalRankedGroups(report: PersonalUsageView, metric: PersonalUsageMetric, limit = 6) {
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
  const percent = successfulCalls / calls * 100;
  if (successfulCalls > 0 && percent < 0.1) return '<0.1% successful';
  if (successfulCalls < calls && percent > 99.9) return '>99.9% successful';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(percent) + '% successful';
}
