import type { UsageCostClass, UsageCostLane, UsageGroupBy, UsageMetrics, UsageReportRange, CompleteUsageQuery, CompleteUsageEvent, UsageGroupIdentity } from "../shared/usage-report.ts";
import { reportRetentionMs, usageDateTools, nextUsageDate } from "./usage-report-range.ts";

// Private shard metadata; never a public token or shared result contract.
export interface UsageVisibilityCut { seq: number; epoch: string; createdAt: number; expiresAt: number; floor: number; source: 'projection' | 'retained_ledger'; normalizer: 2 }
export class UsageVisibilityError extends Error {
  kind: 'restart' | 'unavailable';
  reason: 'mutation' | 'source' | 'expired' | 'capacity' | 'migration';
  constructor(kind: UsageVisibilityError['kind'], reason: UsageVisibilityError['reason']) { super('usage visibility ' + reason); this.kind = kind; this.reason = reason; }
}
export interface UsageReportQuery { principal: string | undefined; tenantId: string; policyId: string; range: UsageReportRange; groupBy: UsageGroupBy; filters: Partial<Record<"model" | "provider" | "key" | "status" | "costClass" | "lane", string | null>> }
export interface UsageReportMigrationEffect { lane: UsageCostLane; costClass: UsageCostClass; calls: number; proposedReportingMicros: number | null; recordedChargeMicros: number }
export interface UsageReportMigrationOptions { apply?: boolean; batchSize?: number; now?: number; afterRowid?: number }
export interface UsageAggregateRow extends UsageMetrics { recordedChargeMicros: number; chargeReportedCalls: number; dimension: string; value: string | number | null; lane: UsageCostLane; costClass: UsageCostClass; amountMicros: number }
export interface UsageReportHistory { historyComplete: boolean; projectionComplete?: boolean; historySource?: "projection" | "retained_ledger" }
export interface UsageReportShard extends UsageReportHistory { rows: UsageAggregateRow[]; groupsTruncated: boolean }
export interface UsageEventPosition { at: number; id: string }

// Complete-query private transport. Only the service constructs these requests;
// no public HTTP caller can choose a shard, source, clock, fence or work budget.
export const completeUsageLimits = Object.freeze({ shards: 64, fanout: 8, calls: 256, groups: 32768,
  groupBytes: 16 * 1024 * 1024, candidateRows: 250000, totalRows: 1000000,
  inputBytes: 64 * 1024 * 1024, visits: 8000000, classifiedBytes: 512 * 1024 * 1024,
  pageBytes: 1024 * 1024, groupPage: 256, eventPage: 100 });
export interface UsageShardInput {
  action: 'capture' | 'preflight' | 'groups' | 'events' | 'validate'; tenantId: string; policyId: string;
  query: CompleteUsageQuery; cut?: UsageVisibilityCut;
  after?: UsageGroupIdentity; before?: UsageEventPosition; includeEqualId?: boolean; limit?: number;
  allowance?: { rows: number; bytes: number };
}
export interface UsageCandidateSize { rows: number; bytes: number }
export interface CompleteAggregateRow extends UsageAggregateRow { owner: string | null }
export interface UsageGroupPage { rows: CompleteAggregateRow[]; next: UsageGroupIdentity | null; work: UsageCandidateSize }
export type UsageShardResult = { kind: 'complete'; value: { cut: UsageVisibilityCut; work: UsageCandidateSize } | UsageCandidateSize | UsageGroupPage | { events: CompleteUsageEvent[]; hasMore: boolean; work: UsageCandidateSize } | { valid: true } }
  | { kind: 'restart' | 'unavailable'; reason: UsageVisibilityError['reason'] };
export const capacity = (): never => { throw new UsageVisibilityError('unavailable', 'capacity'); };
export function invalidSource(): never { throw new UsageVisibilityError('unavailable', 'source'); }
export function usageJsonBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length; }
export function exact(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < 0) capacity(); }
export function boundedText(value: unknown, max = 512): asserts value is string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > max) invalidSource();
}
export function validateCompleteUsageQuery(input: unknown): asserts input is CompleteUsageQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidSource();
  const q = input as CompleteUsageQuery;
  if (Object.keys(q).some(k => !['from','to','timezone','grain','groupBy','rankBy','rankOffset','filters'].includes(k))) invalidSource();
  exact(q.from); exact(q.to);
  if (q.from >= q.to || q.to - q.from > reportRetentionMs || !['day','minute'].includes(q.grain)
    || q.grain === 'minute' && q.to - q.from > 86400000 || !['model','provider','key','user'].includes(q.groupBy)
    || !['calls','tokens','recordedAmount'].includes(q.rankBy)) invalidSource();
  if (q.rankOffset !== undefined) { exact(q.rankOffset); if (q.rankOffset > completeUsageLimits.groups) capacity(); }
  boundedText(q.timezone,100); usageDateTools(q.timezone);
  if (!q.filters || typeof q.filters !== 'object' || Array.isArray(q.filters)) invalidSource();
  for (const key of Object.keys(q.filters)) {
    if (!['user','key','model','provider','status','lane','costClass'].includes(key)) invalidSource();
    if (key !== 'key') boundedText(q.filters[key as keyof typeof q.filters]);
  }
  const k = q.filters.key;
  if (k !== undefined) {
    if (!k || typeof k !== 'object' || Array.isArray(k) || Object.keys(k).some(x => !['kind','id'].includes(x))) invalidSource();
    if (k.kind === 'credential') boundedText(k.id); else if (k.kind !== 'session' || Object.hasOwn(k,'id')) invalidSource();
  }
  if (q.filters.lane && !['api','subscription','unattributed'].includes(q.filters.lane)
    || q.filters.costClass && !['calculated','fixed','estimated','upper_bound','partial','unknown','no_charge'].includes(q.filters.costClass)) invalidSource();
}
export function completeUsageBuckets(q: CompleteUsageQuery): UsageReportRange['buckets'] {
  const buckets: UsageReportRange['buckets'] = [], tools = usageDateTools(q.timezone);
  let start = q.from;
  while (start < q.to) {
    const end = Math.min(q.to, q.grain === 'minute' ? (Math.floor(start / 60000) + 1) * 60000 : tools.midnight(nextUsageDate(tools.label(start))));
    if (end <= start || buckets.length >= (q.grain === 'minute' ? 1441 : 32)) capacity();
    buckets.push({ start, end, label: q.grain === 'minute' ? new Date(start).toISOString() : tools.label(start) }); start = end;
  }
  return buckets;
}
