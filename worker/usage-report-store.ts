import type { PersonalUsageEvent, UsageCostClass, UsageCostLane, UsageGroupBy, UsageMetrics, UsageReportRange } from "../shared/usage-report.ts";
import type { UsageEvent } from "./types.ts";
import { normalizeEmail } from "./utils.ts";
import { reportRetentionMs } from "./usage-report-range.ts";
import { reportingCost, knownBasisClasses } from "./usage-report-cost.ts";
export { reportingCost } from "./usage-report-cost.ts";

export interface ReportSql { exec(query: string, ...bindings: Array<string | number | null>): Iterable<Record<string, unknown>> }
export interface UsageReportQuery { principal: string; tenantId: string; policyId: string; range: UsageReportRange; groupBy: UsageGroupBy; filters: Partial<Record<"model" | "provider" | "key" | "status" | "costClass" | "lane", string>> }
export const utilityFormats = new Set(["openai.models", "anthropic.models", "openai.responses_input_tokens", "anthropic.count_tokens", "openai.moderations"]);
const text = (v: unknown): string | null => typeof v === "string" ? v : null;
const counter = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const subsetCounter = (v: unknown, inclusive: number | null): number | null => {
  const value = counter(v);
  return value !== null && inclusive !== null && value <= inclusive ? value : null;
};

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
  // preexisting ledger history uses bounded read-through until explicit operator apply.
  if (![...sql.exec("SELECT id FROM usage_report_migration WHERE id = 1")].length) sql.exec("INSERT INTO usage_report_migration SELECT 1, 0, COALESCE(MAX(rowid), 0), CASE WHEN COALESCE(MAX(rowid), 0) = 0 THEN 1 ELSE 0 END FROM usage_events");
}
export function insertUsageReportEvent(sql: ReportSql, event: UsageEvent): boolean {
  const detail = projectUsageEvent(event);
  const inserted = [...sql.exec("INSERT OR IGNORE INTO usage_report_events (id, occurred_at_ms, tenant_id, policy_id, principal_key, provider, model, key_id, status, call_kind, input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, reasoning_output_tokens, lane, cost_class, reporting_cost_micros, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    detail.id, detail.occurredAt, event.tenant_id, event.policy_id || event.key_id, typeof event.principal_id === "string" ? normalizeEmail(event.principal_id) : null, detail.provider, detail.model, detail.keyId, detail.status, detail.callKind,
    detail.inputTokens, detail.outputTokens, detail.cachedInputTokens, detail.cacheWriteInputTokens, detail.reasoningOutputTokens, detail.lane, detail.costClass, detail.reportingCostMicros, JSON.stringify(detail))];
  return inserted[0]?.id === event.id;
}
/** Projection progress is not retained-history coverage. No read mutates either watermark. */
export function usageReportProjectionComplete(sql: ReportSql): boolean { return [...sql.exec("SELECT complete FROM usage_report_migration WHERE id = 1")][0]?.complete === 1; }
export function usageReportHistoryComplete(sql: ReportSql): boolean { return reportHistory(sql).historyComplete; }
function reportHistory(sql: ReportSql) {
  const projectionComplete = usageReportProjectionComplete(sql);
  const historyComplete = projectionComplete || [...sql.exec("SELECT complete FROM usage_attribution_migration WHERE id = 1")][0]?.complete === 1;
  return { projectionComplete, historyComplete, historySource: projectionComplete ? "projection" as const : "retained_ledger" as const };
}
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
  if (!Number.isSafeInteger(query.range.from) || !Number.isSafeInteger(query.range.to) || query.range.from > query.range.to || query.range.to - query.range.from > reportRetentionMs) throw new Error("reporting SQL requires a bounded retained range of at most 30 days");
  const terms = ["tenant_id = ?", "policy_id = ?", "principal_key = ?", "occurred_at_ms >= ?", "occurred_at_ms < ?"];
  const bindings: Array<string | number | null> = [query.tenantId, query.policyId, query.principal, query.range.from, query.range.to];
  const columns = { model: "model", provider: "provider", key: "key_id", status: "status", costClass: "cost_class", lane: "lane" };
  for (const [key, column] of Object.entries(columns)) { const value = query.filters[key as keyof typeof columns]; if (value !== undefined) { terms.push(column + " = ?"); bindings.push(value); } }
  return { where: terms.join(" AND "), bindings };
}
export interface UsageAggregateRow extends UsageMetrics { dimension: string; value: string | number | null; lane: UsageCostLane; costClass: UsageCostClass; amountMicros: number }
export interface UsageReportHistory { historyComplete: boolean; projectionComplete?: boolean; historySource?: "projection" | "retained_ledger" }
export interface UsageReportShard extends UsageReportHistory { rows: UsageAggregateRow[]; groupsTruncated: boolean }

const scalarColumns = "model, provider, key_id, occurred_at_ms, status, call_kind, input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, reasoning_output_tokens, lane, cost_class, reporting_cost_micros";
const filterColumns = { model: "model", provider: "provider", key: "key_id", status: "status", costClass: "cost_class", lane: "lane" };
function reportFilters(query: UsageReportQuery) {
  const terms: string[] = [], bindings: Array<string | number | null> = [];
  for (const [key, column] of Object.entries(filterColumns)) { const value = query.filters[key as keyof typeof filterColumns]; if (value !== undefined) { terms.push(column + " = ?"); bindings.push(value); } }
  return { where: terms.length ? terms.join(" AND ") : "1", bindings };
}
const jsonText = (field: string) => "CASE WHEN json_type(event_json, '$." + field + "') = 'text' THEN json_extract(event_json, '$." + field + "') END";
const jsonCounter = (field: string) => {
  const value = "json_extract(event_json, '$." + field + "')";
  return "CASE WHEN json_type(event_json, '$." + field + "') IN ('integer', 'real') AND " + value + " BETWEEN 0 AND 9007199254740991 AND " + value + " = CAST(" + value + " AS INTEGER) THEN CAST(" + value + " AS INTEGER) END";
};
/** Scalar-only SQL twin of projectUsageEvent. The only JSON evaluated belongs to
 * this indexed canonical owner range. Never expand aliases or infer old ownership.
 * The ledger, not a UNION with sparse projection rows, is the sole source until
 * migration completes: each retained original occurs exactly once. */
function retainedSource(query: UsageReportQuery, keyset = "", keysetBindings: Array<string | number | null> = []) {
  const range = reportWhere({ ...query, filters: {} });
  const counters = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens", "actual_cost_micros", "reporting_known_cost_micros", "reporting_estimated_cost_micros"];
  const texts = ["model", "credential_id", "cost_basis", "grant_lane", "request_format", "capability", "reporting_estimate_reason"];
  const basisCase = "CASE cost_basis " + Object.entries(knownBasisClasses).map(([basis, cls]) => "WHEN '" + basis + "' THEN '" + cls + "'").join(" ") + " ELSE 'unknown' END";
  return { cte: "owned AS MATERIALIZED (SELECT id, occurred_at_ms, provider, status, " +
    counters.map(field => jsonCounter(field) + " AS " + field).concat(texts.map(field => jsonText(field) + " AS " + field)).join(", ") +
    " FROM usage_events INDEXED BY usage_events_policy_principal WHERE " + range.where + keyset + "), " +
    "validated AS (SELECT *, " + basisCase + " AS basis_class, " +
    "CASE WHEN cached_input_tokens <= input_tokens THEN cached_input_tokens END AS cache_read, " +
    "CASE WHEN cache_write_input_tokens <= input_tokens THEN cache_write_input_tokens END AS cache_write, " +
    "CASE WHEN reasoning_output_tokens <= output_tokens THEN reasoning_output_tokens END AS reasoning FROM owned), " +
    "classified AS (SELECT *, CASE WHEN actual_cost_micros IS NULL OR (basis_class = 'no_charge' AND actual_cost_micros != 0) THEN 'unknown' " +
    "WHEN basis_class != 'unknown' THEN basis_class " +
    "WHEN substr(cost_basis, 1, 9) = 'unpriced_' AND reporting_known_cost_micros > 0 AND reporting_known_cost_micros <= actual_cost_micros THEN 'partial' " +
    "WHEN actual_cost_micros = 0 AND reporting_estimated_cost_micros IS NOT NULL AND reporting_estimate_reason != '' THEN 'estimated' ELSE 'unknown' END AS cost_class FROM validated), " +
    "source AS (SELECT id, occurred_at_ms, provider, status, model, credential_id AS key_id, input_tokens, output_tokens, " +
    "CASE WHEN cache_read > input_tokens - cache_write THEN NULL ELSE cache_read END AS cached_input_tokens, " +
    "CASE WHEN cache_read > input_tokens - cache_write THEN NULL ELSE cache_write END AS cache_write_input_tokens, reasoning AS reasoning_output_tokens, " +
    "CASE WHEN request_format IN (" + [...utilityFormats].map(format => "'" + format + "'").join(", ") + ") OR (request_format = 'anthropic.messages' AND capability = 'llm.count_tokens') THEN 'utility' ELSE 'generation' END AS call_kind, " +
    "CASE grant_lane WHEN 'subscription' THEN 'subscription' WHEN 'api_key' THEN 'api' WHEN 'environment' THEN 'api' ELSE 'unattributed' END AS lane, cost_class, " +
    "CASE WHEN cost_class = 'unknown' THEN NULL WHEN basis_class = 'unknown' AND cost_class = 'partial' THEN reporting_known_cost_micros " +
    "WHEN basis_class = 'unknown' AND cost_class = 'estimated' THEN reporting_estimated_cost_micros ELSE actual_cost_micros END AS reporting_cost_micros FROM classified)",
    bindings: [...range.bindings, ...keysetBindings] };
}
/** One indexed scalar range materialization; all three dimensions share it.
 * Lexical group selection is deterministic across shards; totals/buckets always include omitted groups. */
export function queryUsageReport(sql: ReportSql, query: UsageReportQuery): UsageReportShard {
  const history = reportHistory(sql), range = reportWhere(query), column = { model: "model", provider: "provider", key: "key_id" }[query.groupBy];
  const bucket = "CASE " + query.range.buckets.map((b, i) => "WHEN occurred_at_ms >= " + b.start + " AND occurred_at_ms < " + b.end + " THEN " + i).join(" ") + " ELSE -1 END";
  const filters = reportFilters(query), retained = history.projectionComplete ? null : retainedSource(query);
  const result = [...sql.exec(
    "WITH " + (retained ? retained.cte + ", " : "") + "filtered AS MATERIALIZED (" +
    "SELECT " + scalarColumns + " FROM " + (retained ? "source WHERE " + filters.where : "usage_report_events INDEXED BY usage_report_owner_range WHERE " + range.where) +
    "), selected AS (SELECT DISTINCT " + column + " AS value FROM filtered ORDER BY value COLLATE BINARY LIMIT 101), " +
    "dimensions AS (SELECT 'total' AS dimension UNION ALL SELECT 'bucket' UNION ALL SELECT 'group'), " +
    "expanded AS (SELECT filtered.*, dimension, CASE dimension WHEN 'group' THEN " + column + " WHEN 'bucket' THEN " + (query.range.buckets.length ? bucket : "-1") + " ELSE NULL END AS dimension_value " +
    "FROM filtered CROSS JOIN dimensions WHERE dimension != 'group' OR (" + column + " IS NULL AND EXISTS (SELECT 1 FROM selected WHERE value IS NULL)) OR " + column + " IN (SELECT value FROM selected)) " +
    "SELECT dimension, dimension_value AS value, lane, cost_class AS costClass, " + metricSql + ", COALESCE(SUM(reporting_cost_micros), 0) AS amountMicros " +
    "FROM expanded GROUP BY dimension, dimension_value, lane, cost_class ORDER BY dimension, dimension_value COLLATE BINARY, lane, cost_class",
    ...(retained ? [...retained.bindings, ...filters.bindings] : range.bindings))] as unknown as UsageAggregateRow[];
  const groups = new Set(result.filter(row => row.dimension === "group").map(row => row.value));
  return { rows: result, groupsTruncated: groups.size > 100, ...history };
}
export interface UsageEventPosition { at: number; id: string }
export function queryUsageEvents(sql: ReportSql, query: UsageReportQuery, limit: number, before?: UsageEventPosition, includeEqualId = false): { events: PersonalUsageEvent[] } & UsageReportHistory {
  const history = reportHistory(sql), range = reportWhere(query);
  const keyset = before ? " AND (occurred_at_ms < ? OR (occurred_at_ms = ? AND id " + (includeEqualId ? "<=" : "<") + " ? COLLATE BINARY))" : "";
  const positions = before ? [before.at, before.at, before.id] : [];
  if (history.projectionComplete) {
    const events = [...sql.exec("SELECT detail_json FROM usage_report_events INDEXED BY usage_report_owner_range WHERE " + range.where + keyset + " ORDER BY occurred_at_ms DESC, id COLLATE BINARY DESC LIMIT ?", ...range.bindings, ...positions, limit + 1)].map(row => JSON.parse(String(row.detail_json)) as PersonalUsageEvent);
    return { events, ...history };
  }
  if (Object.values(query.filters).every(value => value === undefined)) {
    // The common unfiltered page does not classify the rest of the retained
    // range. Read only the indexed keyset page and project its metadata in JS.
    const events = [...sql.exec("SELECT event_json FROM usage_events INDEXED BY usage_events_policy_principal WHERE " + range.where + keyset + " ORDER BY occurred_at_ms DESC, id COLLATE BINARY DESC LIMIT ?", ...range.bindings, ...positions, limit + 1)]
      .map(row => projectUsageEvent(JSON.parse(String(row.event_json)) as UsageEvent));
    return { events, ...history };
  }
  const retained = retainedSource(query, keyset, positions), filters = reportFilters(query);
  // Only the bounded selected page fetches raw JSON. Classification/filtering and
  // stable keysets precede LIMIT; only scalar owner metadata is materialized.
  const events = [...sql.exec("WITH " + retained.cte + ", page AS MATERIALIZED (SELECT id, occurred_at_ms FROM source WHERE " + filters.where +
    " ORDER BY occurred_at_ms DESC, id COLLATE BINARY DESC LIMIT ?) SELECT ledger.event_json FROM page JOIN usage_events AS ledger ON ledger.id = page.id ORDER BY page.occurred_at_ms DESC, page.id COLLATE BINARY DESC",
    ...retained.bindings, ...filters.bindings, limit + 1)].map(row => projectUsageEvent(JSON.parse(String(row.event_json)) as UsageEvent));
  return { events, ...history };
}
