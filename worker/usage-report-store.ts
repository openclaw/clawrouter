import type { PersonalUsageEvent, UsageCostClass, UsageCostLane, UsageGroupBy, UsageMetrics, UsageReportRange } from "../shared/usage-report.ts";
import type { UsageEvent } from "./types.ts";
import { normalizeEmail } from "./utils.ts";
import { reportRetentionMs } from "./usage-report-range.ts";

export interface ReportSql { exec(query: string, ...bindings: Array<string | number | null>): Iterable<Record<string, unknown>> }
export interface UsageReportQuery { principal: string; tenantId: string; policyId: string; range: UsageReportRange; groupBy: UsageGroupBy; filters: Partial<Record<"model" | "provider" | "key" | "status" | "costClass" | "lane", string>> }
export const utilityFormats = new Set(["openai.models", "anthropic.models", "openai.responses_input_tokens", "anthropic.count_tokens", "openai.moderations"]);
const text = (v: unknown): string | null => typeof v === "string" ? v : null;
const counter = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const subsetCounter = (v: unknown, inclusive: number | null): number | null => {
  const value = counter(v);
  return value !== null && inclusive !== null && value <= inclusive ? value : null;
};

/** Evidence classification only: never recompute prices, charges, or reservation settlement. */
export function reportingCost(event: UsageEvent): { lane: UsageCostLane; costClass: UsageCostClass; amount: number | null } {
  const lane: UsageCostLane = event.grant_lane === "subscription" ? "subscription" : event.grant_lane === "api_key" || event.grant_lane === "environment" ? "api" : "unattributed";
  const basis = event.cost_basis;
  let costClass: UsageCostClass = basis === "none" ? "no_charge" : basis === "policy_fixed" ? "fixed"
    : basis === "request_character_estimate" || basis === "manifest_reservation" ? "estimated"
    : basis === "manifest_rate_upper_bound" || basis === "realtime_full_context_bound" ? "upper_bound"
    : basis === "manifest_pricing" || basis === "realtime_modality_usage" || basis === "realtime_input_transcription_usage" ? "calculated" : basis === "partial" || basis === "partial_usage" ? "partial" : "unknown";
  let amount = counter(event.actual_cost_micros);
  // Contradictory evidence is not a no-charge assertion; unknown recorded debits remain separately visible.
  if (amount === null || costClass === "no_charge" && amount !== 0) costClass = "unknown";
  if (costClass === "unknown" && typeof basis === "string" && basis.startsWith("unpriced_") && amount !== null && amount > 0) costClass = "partial";
  if (costClass === "unknown") {
    const estimate = counter(event.reporting_estimated_cost_micros);
    if (amount === 0 && estimate !== null && typeof event.reporting_estimate_reason === "string" && event.reporting_estimate_reason.length > 0) { costClass = "estimated"; amount = estimate; }
    else amount = null;
  }
  return { lane, costClass, amount };
}
export function projectUsageEvent(event: UsageEvent): PersonalUsageEvent {
  const cost = reportingCost(event);
  const inputTokens = counter(event.input_tokens), outputTokens = counter(event.output_tokens);
  let cachedInputTokens = subsetCounter(event.cached_input_tokens, inputTokens);
  let cacheWriteInputTokens = subsetCounter(event.cache_write_input_tokens, inputTokens);
  // Cache read/write allocations are disjoint subsets of inclusive input. If
  // they conflict, neither allocation is established. Raw ledger evidence stays intact.
  if (cachedInputTokens !== null && cacheWriteInputTokens !== null && cachedInputTokens > inputTokens! - cacheWriteInputTokens) { cachedInputTokens = null; cacheWriteInputTokens = null; }
  const reasoningOutputTokens = subsetCounter(event.reasoning_output_tokens, outputTokens);
  // This literal is the detail allowlist. Never spread raw UsageEvent here.
  return { id: event.id, occurredAt: event.occurred_at_ms, provider: event.provider, model: text(event.model), keyId: text(event.credential_id),
    capability: text(event.capability) ?? "unknown", callKind: utilityFormats.has(event.request_format ?? "") || event.request_format === "anthropic.messages" && event.capability === "llm.count_tokens" ? "utility" : "generation",
    status: event.status, statusCode: counter(event.status_code), durationMs: counter(event.duration_ms),
    inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, reasoningOutputTokens,
    lane: cost.lane, costClass: cost.costClass, reportingCostMicros: cost.amount, estimateReason: cost.costClass === "estimated" ? text(event.reporting_estimate_reason) : null, recordedChargeMicros: counter(event.actual_cost_micros) ?? 0,
    costBasis: text(event.cost_basis), pricingRef: text(event.pricing_ref), requestedTier: text(event.requested_service_tier), servedTier: text(event.served_service_tier),
    compoundRequestId: text(event.compound_request_id), compoundStage: text(event.compound_request_stage) };
}

export function ensureUsageReportSchema(sql: ReportSql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS usage_report_events (id TEXT PRIMARY KEY, occurred_at_ms INTEGER NOT NULL, tenant_id TEXT NOT NULL, policy_id TEXT NOT NULL, principal_key TEXT, provider TEXT NOT NULL, model TEXT, key_id TEXT, status TEXT NOT NULL, call_kind TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER, reasoning_output_tokens INTEGER, lane TEXT NOT NULL, cost_class TEXT NOT NULL, reporting_cost_micros INTEGER, detail_json TEXT NOT NULL)");
  sql.exec("CREATE INDEX IF NOT EXISTS usage_report_owner_range ON usage_report_events (tenant_id, policy_id, principal_key, occurred_at_ms DESC, id DESC)");
  sql.exec("CREATE INDEX IF NOT EXISTS usage_report_retention ON usage_report_events (occurred_at_ms)");
  sql.exec("CREATE TABLE IF NOT EXISTS usage_report_migration (id INTEGER PRIMARY KEY CHECK (id = 1), last_rowid INTEGER NOT NULL, upper_rowid INTEGER NOT NULL, complete INTEGER NOT NULL)");
  // No historical projection here or in alarms/reads. Empty shards have no history to recover;
  // any preexisting ledger history stays pending until explicit operator apply.
  if (![...sql.exec("SELECT id FROM usage_report_migration WHERE id = 1")].length) sql.exec("INSERT INTO usage_report_migration SELECT 1, 0, COALESCE(MAX(rowid), 0), CASE WHEN COALESCE(MAX(rowid), 0) = 0 THEN 1 ELSE 0 END FROM usage_events");
}
export function insertUsageReportEvent(sql: ReportSql, event: UsageEvent): boolean {
  const detail = projectUsageEvent(event);
  const inserted = [...sql.exec("INSERT OR IGNORE INTO usage_report_events (id, occurred_at_ms, tenant_id, policy_id, principal_key, provider, model, key_id, status, call_kind, input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, reasoning_output_tokens, lane, cost_class, reporting_cost_micros, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    detail.id, detail.occurredAt, event.tenant_id, event.policy_id || event.key_id, typeof event.principal_id === "string" ? normalizeEmail(event.principal_id) : null, detail.provider, detail.model, detail.keyId, detail.status, detail.callKind,
    detail.inputTokens, detail.outputTokens, detail.cachedInputTokens, detail.cacheWriteInputTokens, detail.reasoningOutputTokens, detail.lane, detail.costClass, detail.reportingCostMicros, JSON.stringify(detail))];
  return inserted[0]?.id === event.id;
}
export function usageReportHistoryComplete(sql: ReportSql): boolean { return [...sql.exec("SELECT complete FROM usage_report_migration WHERE id = 1")][0]?.complete === 1; }
export interface UsageReportMigrationEffect { lane: UsageCostLane; costClass: UsageCostClass; calls: number; proposedReportingMicros: number | null; recordedChargeMicros: number }
export interface UsageReportMigrationOptions { apply?: boolean; batchSize?: number; now?: number; afterRowid?: number }
/** Internal/offline only. Default dry-run does not initialize or update any schema/state.
 * Apply writes reporting tables only, atomically advancing its fixed historical watermark. */
export function migrateUsageReport(sql: ReportSql, transaction: (fn: () => void) => void, options: UsageReportMigrationOptions = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) || options.apply !== undefined && typeof options.apply !== "boolean") throw new Error("apply must be an explicit boolean");
  if (options.now !== undefined && (!Number.isSafeInteger(options.now) || options.now < 0)) throw new Error("invalid migration time");
  if (options.apply && options.afterRowid !== undefined) throw new Error("apply resumes its persisted watermark");
  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000) throw new Error("batchSize must be 1..2000");
  const exists = [...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_report_migration'")].length > 0;
  const saved = exists ? [...sql.exec("SELECT last_rowid, upper_rowid, complete FROM usage_report_migration WHERE id = 1")][0] : undefined;
  const upper = Number(saved?.upper_rowid ?? [...sql.exec("SELECT COALESCE(MAX(rowid), 0) AS upper_rowid FROM usage_events")][0].upper_rowid);
  const last = Number(options.apply ? saved?.last_rowid ?? 0 : options.afterRowid ?? saved?.last_rowid ?? 0);
  if (!Number.isSafeInteger(last) || last < 0 || last > upper) throw new Error("invalid migration watermark");
  const batch = [...sql.exec("SELECT rowid, occurred_at_ms, event_json FROM usage_events WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?", last, upper, batchSize)];
  const next = Number(batch.at(-1)?.rowid ?? upper), complete = batch.length < batchSize || next === upper;
  const projected = batch.filter(row => Number(row.occurred_at_ms) >= (options.now ?? Date.now()) - reportRetentionMs).map(row => { const event = JSON.parse(String(row.event_json)) as UsageEvent; projectUsageEvent(event); return event; });
  const effects = new Map<string, UsageReportMigrationEffect>();
  for (const event of projected) {
    const detail = projectUsageEvent(event), key = detail.lane + ":" + detail.costClass;
    const effect = effects.get(key) ?? { lane: detail.lane, costClass: detail.costClass, calls: 0, proposedReportingMicros: detail.reportingCostMicros === null ? null : 0, recordedChargeMicros: 0 };
    effect.calls++; effect.recordedChargeMicros += detail.recordedChargeMicros;
    if (effect.proposedReportingMicros !== null) effect.proposedReportingMicros += detail.reportingCostMicros ?? 0;
    if (!Number.isSafeInteger(effect.recordedChargeMicros) || effect.proposedReportingMicros !== null && !Number.isSafeInteger(effect.proposedReportingMicros)) throw new Error("migration effect exceeds exact numeric bounds");
    effects.set(key, effect);
  }
  if (options.apply) transaction(() => {
    ensureUsageReportSchema(sql);
    for (const event of projected) {
      if (!insertUsageReportEvent(sql, event) && ![...sql.exec("SELECT id FROM usage_report_events WHERE id = ?", event.id)].length) throw new Error("reporting migration did not confirm projection");
    }
    sql.exec("UPDATE usage_report_migration SET last_rowid = ?, complete = ? WHERE id = 1", next, complete ? 1 : 0);
  });
  return { dryRun: !options.apply, examined: batch.length, projected: projected.length, lastRowid: next, upperRowid: upper, complete, previouslyComplete: saved?.complete === 1, effects: [...effects.values()].sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : a.costClass < b.costClass ? -1 : a.costClass > b.costClass ? 1 : 0) };
}

const metricExpressions: Record<keyof UsageMetrics, string> = {
  calls: "COUNT(*)", generationCalls: "SUM(call_kind = 'generation')", utilityCalls: "SUM(call_kind = 'utility')",
  successfulCalls: "SUM(status = 'success')", errorCalls: "SUM(status NOT IN ('success', 'denied'))", deniedCalls: "SUM(status = 'denied')",
  inputTokens: "SUM(input_tokens)", outputTokens: "SUM(output_tokens)", cachedInputTokens: "SUM(cached_input_tokens)", cacheWriteInputTokens: "SUM(cache_write_input_tokens)", reasoningOutputTokens: "SUM(reasoning_output_tokens)",
  inputReportedCalls: "COUNT(input_tokens)", outputReportedCalls: "COUNT(output_tokens)", cacheReadReportedCalls: "COUNT(cached_input_tokens)", cacheWriteReportedCalls: "COUNT(cache_write_input_tokens)", reasoningReportedCalls: "COUNT(reasoning_output_tokens)",
};
export const usageMetricKeys = Object.keys(metricExpressions) as Array<keyof UsageMetrics>;
export function emptyUsageMetrics(): UsageMetrics { return Object.fromEntries(usageMetricKeys.map(key => [key, 0])) as unknown as UsageMetrics; }
const metricSql = Object.entries(metricExpressions).map(([key, expr]) => 'COALESCE(' + expr + ', 0) AS "' + key + '"').join(", ");
export function reportWhere(query: UsageReportQuery) {
  const terms = ["tenant_id = ?", "policy_id = ?", "principal_key = ?", "occurred_at_ms >= ?", "occurred_at_ms < ?"];
  const bindings: Array<string | number | null> = [query.tenantId, query.policyId, query.principal, query.range.from, query.range.to];
  const columns = { model: "model", provider: "provider", key: "key_id", status: "status", costClass: "cost_class", lane: "lane" };
  for (const [key, column] of Object.entries(columns)) { const value = query.filters[key as keyof typeof columns]; if (value !== undefined) { terms.push(column + " = ?"); bindings.push(value); } }
  return { where: terms.join(" AND "), bindings };
}
export interface UsageAggregateRow extends UsageMetrics { dimension: string; value: string | number | null; lane: UsageCostLane; costClass: UsageCostClass; amountMicros: number }
export interface UsageReportShard { rows: UsageAggregateRow[]; groupsTruncated: boolean; historyComplete: boolean }
/** One indexed range materialization; all three dimensions share it. No event JSON read.
 * Lexical group selection is deterministic across shards; totals/buckets always include omitted groups. */
export function queryUsageReport(sql: ReportSql, query: UsageReportQuery): UsageReportShard {
  const range = reportWhere(query), column = { model: "model", provider: "provider", key: "key_id" }[query.groupBy];
  const bucket = "CASE " + query.range.buckets.map((b, i) => "WHEN occurred_at_ms >= " + b.start + " AND occurred_at_ms < " + b.end + " THEN " + i).join(" ") + " ELSE -1 END";
  const result = [...sql.exec(
    "WITH filtered AS MATERIALIZED (" +
    "SELECT model, provider, key_id, occurred_at_ms, status, call_kind, input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, reasoning_output_tokens, lane, cost_class, reporting_cost_micros " +
    "FROM usage_report_events INDEXED BY usage_report_owner_range WHERE " + range.where +
    "), selected AS (SELECT DISTINCT " + column + " AS value FROM filtered ORDER BY value COLLATE BINARY LIMIT 101), " +
    "dimensions AS (SELECT 'total' AS dimension UNION ALL SELECT 'bucket' UNION ALL SELECT 'group'), " +
    "expanded AS (SELECT filtered.*, dimension, CASE dimension WHEN 'group' THEN " + column + " WHEN 'bucket' THEN " + (query.range.buckets.length ? bucket : "-1") + " ELSE NULL END AS dimension_value " +
    "FROM filtered CROSS JOIN dimensions WHERE dimension != 'group' OR (" + column + " IS NULL AND EXISTS (SELECT 1 FROM selected WHERE value IS NULL)) OR " + column + " IN (SELECT value FROM selected)) " +
    "SELECT dimension, dimension_value AS value, lane, cost_class AS costClass, " + metricSql + ", COALESCE(SUM(reporting_cost_micros), 0) AS amountMicros " +
    "FROM expanded GROUP BY dimension, dimension_value, lane, cost_class ORDER BY dimension, dimension_value COLLATE BINARY, lane, cost_class",
    ...range.bindings)] as unknown as UsageAggregateRow[];
  const groups = new Set(result.filter(row => row.dimension === "group").map(row => row.value));
  return { rows: result, groupsTruncated: groups.size > 100, historyComplete: usageReportHistoryComplete(sql) };
}
export interface UsageEventPosition { at: number; id: string }
export function queryUsageEvents(sql: ReportSql, query: UsageReportQuery, limit: number, before?: UsageEventPosition, includeEqualId = false): { events: PersonalUsageEvent[]; historyComplete: boolean } {
  const range = reportWhere(query);
  const keyset = before ? " AND (occurred_at_ms < ? OR (occurred_at_ms = ? AND id " + (includeEqualId ? "<=" : "<") + " ? COLLATE BINARY))" : "";
  const bindings = before ? [...range.bindings, before.at, before.at, before.id] : range.bindings;
  const events = [...sql.exec("SELECT detail_json FROM usage_report_events INDEXED BY usage_report_owner_range WHERE " + range.where + keyset + " ORDER BY occurred_at_ms DESC, id COLLATE BINARY DESC LIMIT ?", ...bindings, limit + 1)].map(row => JSON.parse(String(row.detail_json)) as PersonalUsageEvent);
  return { events, historyComplete: usageReportHistoryComplete(sql) };
}
