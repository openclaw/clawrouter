import type { PersonalUsageReport, PersonalUsageEvent, UsageCostClass, UsageCostLane, UsageCostSummary, UsageGroupBy } from '../../shared/usage-report';

export const costClasses: UsageCostClass[] = ['calculated', 'fixed', 'estimated', 'upper_bound', 'partial', 'unknown', 'no_charge'];
export const costLanes: UsageCostLane[] = ['api', 'subscription', 'unattributed'];
export const costClassLabel: Record<UsageCostClass, string> = { calculated: 'Calculated', fixed: 'Fixed tariff', estimated: 'Estimate', upper_bound: 'Upper bound', partial: 'Partial', unknown: 'Unknown price', no_charge: 'No charge' };
export const laneLabel: Record<UsageCostLane, string> = { api: 'API', subscription: 'Subscription', unattributed: 'Unattributed' };
export type UsageFilters = Record<'model' | 'provider' | 'key' | 'status' | 'costClass' | 'lane', string>;
export interface PersonalUsageQuery { rollingDays?: 7 | 30; from: string; to: string; timezone: string; groupBy: UsageGroupBy; filters: UsageFilters }
export interface UsageKeyName { credentialId: string; name?: string | null }
export function usageKeyLabel(keyId: string | null, keys: readonly UsageKeyName[] = []): string {
  if (keyId === null) return 'Dashboard session';
  const name = keys.find(key => key.credentialId === keyId)?.name?.trim();
  return name ? name + ' · ' + keyId : keyId;
}
/** Page-local anchors do not assume ledger event IDs are globally unique or URI-safe. */
export function usageEventAnchor(page: number, index: number): string { return 'usage-event-' + page + '-' + index; }
export function usageGroupLabel(groupBy: UsageGroupBy, value: string | null): string {
  return value ?? (groupBy === 'key' ? 'Dashboard session' : 'Unattributed');
}
export const emptyFilters: UsageFilters = { model: '', provider: '', key: '', status: '', costClass: '', lane: '' };
export function rollingUsageQuery(days: 7 | 30 = 7): PersonalUsageQuery {
  // Presets are resolved by the Worker clock, never the browser clock. Fields
  // remain blank until the server supplies the authoritative display range.
  return { rollingDays: days, from: '', to: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', groupBy: 'model', filters: { ...emptyFilters } };
}
/** Keep the explicit preset marker; each uncached read resolves it on the server. */
export function refreshUsageQuery(query: PersonalUsageQuery): PersonalUsageQuery {
  return query;
}
export function resolvedUsageQuery(query: PersonalUsageQuery, report: PersonalUsageReport): PersonalUsageQuery {
  return { ...query, from: new Date(report.range.from).toISOString(), to: new Date(report.range.to).toISOString(), timezone: report.range.timezone, groupBy: report.groupBy };
}
export function usageQueryString(query: PersonalUsageQuery): string {
  const params = new URLSearchParams({ timezone: query.timezone, groupBy: query.groupBy });
  if (query.rollingDays) params.set('days', String(query.rollingDays));
  else { params.set('from', query.from); params.set('to', query.to); }
  for (const [key, value] of Object.entries(query.filters)) if (value) params.set(key, value);
  return params.toString();
}
export function usageMoney(micros: number | null): string {
  if (micros === null) return 'Unknown';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(micros / 1_000_000);
}
export function costCell(costs: UsageCostSummary[], lane: UsageCostLane, classes: UsageCostClass[]): string {
  const values = costs.filter(cost => cost.lane === lane && classes.includes(cost.costClass));
  if (!values.length) return '—';
  const calls = values.reduce((sum, value) => sum + value.calls, 0);
  if (classes.includes('unknown')) return calls + ' calls · price unknown';
  if (classes.includes('no_charge')) return calls + ' calls · no charge';
  return usageMoney(values.reduce((sum, value) => sum + value.amountMicros, 0)) + ' · ' + calls + ' calls';
}
/** Small per-auth-lifetime cache. Never share instances across accepted sessions. */
export class UsageQueryCache<T> {
  private entries = new Map<string, { at: number; value: T }>();
  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry || now - entry.at >= 15_000) { this.entries.delete(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, now = Date.now()) {
    this.entries.delete(key); this.entries.set(key, { value, at: now });
    while (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
  }
  clear() { this.entries.clear(); }
}
/** Quote every cell; neutralize spreadsheet formulas, including leading whitespace/control. */
export function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function csvRows(rows: unknown[][]): string { return rows.map(row => row.map(csvCell).join(',')).join('\r\n'); }
/** Exactly one row per group: metrics are additive across rows, never repeated per price class. */
export function reportCsv(report: PersonalUsageReport): string {
  const costColumns = costLanes.flatMap(lane => costClasses.map(costClass => ({ lane, costClass })));
  const header = ['from', 'to_exclusive', 'timezone', 'group_by', 'group', 'model_calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'input_reported_calls', 'output_reported_calls', 'cache_read_reported_calls', 'cache_write_reported_calls', 'reasoning_reported_calls', 'history_complete', 'groups_truncated',
    ...costColumns.flatMap(({ lane, costClass }) => [lane + '_' + costClass + '_calls', lane + '_' + costClass + '_reporting_amount_usd'])];
  const rows = report.groups.map(group => {
    const m = group.metrics;
    const costs = costColumns.flatMap(({ lane, costClass }) => {
      const entries = group.costs.filter(cost => cost.lane === lane && cost.costClass === costClass);
      return [entries.reduce((sum, cost) => sum + cost.calls, 0),
        // Absence is not a zero-price claim; unknown prices never get numeric amounts.
        !entries.length || costClass === 'unknown' ? null : entries.reduce((sum, cost) => sum + cost.amountMicros, 0) / 1_000_000];
    });
    return [new Date(report.range.from).toISOString(), new Date(report.range.to).toISOString(), report.range.timezone, report.groupBy, usageGroupLabel(report.groupBy, group.value), m.calls, m.inputTokens, m.outputTokens, m.cachedInputTokens, m.cacheWriteInputTokens, m.reasoningOutputTokens, m.inputReportedCalls, m.outputReportedCalls, m.cacheReadReportedCalls, m.cacheWriteReportedCalls, m.reasoningReportedCalls, report.historyComplete, report.groupsTruncated, ...costs];
  });
  return csvRows([header, ...rows]);
}
export function eventsCsv(events: PersonalUsageEvent[]): string {
  const keys: Array<keyof PersonalUsageEvent> = ['id', 'occurredAt', 'provider', 'model', 'keyId', 'callKind', 'status', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens', 'lane', 'costClass', 'reportingCostMicros', 'recordedChargeMicros', 'costBasis', 'estimateReason', 'pricingRef', 'compoundRequestId', 'compoundStage'];
  return csvRows([keys, ...events.map(event => keys.map(key => key === 'reportingCostMicros' && event.costClass === 'unknown' ? null : event[key]))]);
}
export function downloadUsageCsv(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
