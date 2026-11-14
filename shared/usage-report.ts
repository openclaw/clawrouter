/** Personal reporting only. Never use these values to settle budget ledgers. */
export type UsageCostClass = "calculated" | "fixed" | "estimated" | "upper_bound" | "partial" | "unknown" | "no_charge";
export type UsageCostLane = "api" | "subscription" | "unattributed";
export type UsageGroupBy = "model" | "provider" | "key";
export interface UsageMetrics {
  calls: number;
  generationCalls: number;
  utilityCalls: number;
  successfulCalls: number;
  errorCalls: number;
  deniedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningOutputTokens: number;
  inputReportedCalls: number;
  outputReportedCalls: number;
  cacheReadReportedCalls: number;
  cacheWriteReportedCalls: number;
  reasoningReportedCalls: number;
}
export interface UsageCostSummary {
  lane: UsageCostLane;
  costClass: UsageCostClass;
  calls: number;
  amountMicros: number; // Per-class only. Unknown is never a zero-price claim.
}
export interface UsageReportGroup {
  value: string | null;
  metrics: UsageMetrics;
  costs: UsageCostSummary[];
}
export interface UsageReportBucket {
  start: number;
  end: number;
  label: string;
  metrics: UsageMetrics;
  costs: UsageCostSummary[];
}
export interface UsageReportRange {
  from: number;
  to: number;
  timezone: string;
  retentionStart: number;
  clampedStart: boolean;
  buckets: Array<{ start: number; end: number; label: string }>;
}
export interface PersonalUsageReport {
  range: UsageReportRange;
  groupBy: UsageGroupBy;
  metrics: UsageMetrics;
  costs: UsageCostSummary[];
  groups: UsageReportGroup[];
  buckets: UsageReportBucket[];
  groupsTruncated: boolean;
  historyComplete: boolean;
  /** Retained-ledger read-through preserves history until explicit projection migration. */
  historySource?: "projection" | "retained_ledger";
  projectionComplete?: boolean;
  generatedAt: number;
}
/** Explicit allowlist: no content, identities, correlation, or upstream credential handles. */
export interface PersonalUsageEvent {
  id: string;
  occurredAt: number;
  provider: string;
  model: string | null;
  keyId: string | null;
  capability: string;
  callKind: "generation" | "utility";
  status: string;
  statusCode: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  reasoningOutputTokens: number | null;
  lane: UsageCostLane;
  costClass: UsageCostClass;
  reportingCostMicros: number | null;
  estimateReason?: string | null;
  recordedChargeMicros: number | null;
  costBasis: string | null;
  pricingRef: string | null;
  requestedTier: string | null;
  servedTier: string | null;
  compoundRequestId: string | null;
  compoundStage: string | null;
}
export interface PersonalUsageEvents {
  events: PersonalUsageEvent[];
  nextCursor: string | null;
  historyComplete: boolean;
  historySource?: "projection" | "retained_ledger";
  projectionComplete?: boolean;
}
// Query: days=7|30 resolves on the Worker clock; never combine with custom from/to.
// Custom from/to = ISO dates in timezone or RFC3339 instants; timezone = IANA (default UTC).
// Event pages use the report's exact returned from/to, not a fresh rolling preset.
// Defaults: rolling 7 days, day buckets. Max 30 days; <= 32 exact clipped day buckets.
// groupBy = model|provider|key; provider/model/key/status/costClass/lane are optional exact filters.
// /v1/session/usage/report: at most 100 groups, no events.
// /v1/session/usage/events: limit 1..100 (default 25), opaque cursor, same filters/range.

/** Complete reporting: no private addresses, fences or digests. Existing endpoints
 * retain their compatibility contract until the separately gated adapters switch. */
export interface CompleteUsageQuery {
  from: number; to: number; timezone: string; grain: 'day' | 'minute';
  groupBy: UsageGroupBy | 'user'; rankBy: 'calls' | 'tokens' | 'recordedAmount'; rankOffset?: number;
  filters: { user?: string; key?: { kind: 'session' } | { kind: 'credential'; id: string };
    model?: string; provider?: string; status?: string; lane?: string; costClass?: string };
}
export interface UsageAdditives {
  metrics: UsageMetrics; recordedChargeMicros: number; chargeReportedCalls: number; costs: UsageCostSummary[];
}
export interface UsageGroupIdentity { owner: string | null; value: string | null }
export interface CompleteUsageGroup extends UsageAdditives { identity: UsageGroupIdentity }
export interface UsageCoverage {
  authority: 'current_access' | 'admin_retained';
  scope: 'admin_current_plus_tracked_retired' | 'personal_current_access';
  discoveredScopeEnumeration: 'complete'; allDiscoveredSourcesAnswered: true; retainedAttributionComplete: true;
  historicalLocations: 'not_exhaustively_assessed'; formerLocationLateWrites: 'not_bounded';
  captureAudit: { startedAt: number; verifiedSince: number; captureGapObserved: boolean };
  effectiveFrom: number; clippedFrom: number | null; capturedBetween: { from: number; to: number };
}
export interface CompleteUsageReport extends UsageAdditives {
  query: CompleteUsageQuery; cut: string | null; coverage: UsageCoverage;
  buckets: Array<{ start: number; end: number; label: string } & UsageAdditives>;
  groups: CompleteUsageGroup[]; remainder: UsageAdditives;
  rank: { exact: true; distinctGroups: number; offset: number; hasMore: boolean };
}
export interface CompleteUsageEvent extends PersonalUsageEvent { user: string | null }
export interface CompleteUsageEvents { events: CompleteUsageEvent[]; nextCursor: string | null; coverage: UsageCoverage }
export type CompleteUsageOutcome<T> = { kind: 'complete'; value: T } | { kind: 'no_access' }
  | { kind: 'outside_retained_range'; effectiveFrom: number; requestedTo: number }
  | { kind: 'restart'; reason: 'authority' | 'mutation' | 'source' | 'expired' | 'evicted' }
  | { kind: 'unavailable'; reason: 'capacity' | 'source' | 'migration' | 'cancelled' };
