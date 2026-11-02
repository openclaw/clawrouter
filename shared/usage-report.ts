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
  recordedChargeMicros: number;
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
}
// Query: from/to = ISO dates in timezone or RFC3339 instants; timezone = IANA (default UTC).
// Defaults: rolling 7 days, day buckets. Max 30 days; <= 32 exact clipped day buckets.
// groupBy = model|provider|key; provider/model/key/status/costClass/lane are optional exact filters.
// /v1/session/usage/report: at most 100 groups, no events.
// /v1/session/usage/events: limit 1..100 (default 25), opaque cursor, same filters/range.
