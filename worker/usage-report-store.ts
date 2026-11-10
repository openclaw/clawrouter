import { ensureUsageVisibility, captureUsageVisibility, validateUsageVisibility, UsageVisibilityError, type UsageVisibilityCut } from "./usage-report-visibility.ts";
import type { PersonalUsageEvent, UsageCostClass, UsageCostLane, UsageGroupBy, UsageMetrics, UsageReportRange } from "../shared/usage-report.ts";
import type { UsageEvent } from "./types.ts";
import { normalizeEmail } from "./utils.ts";
import { reportRetentionMs } from "./usage-report-range.ts";
import { reportingCost, knownBasisClasses, recordedAccountingAmount, usageCounter as counter } from "./usage-report-cost.ts";
export { reportingCost } from "./usage-report-cost.ts";

export interface ReportSql { exec(query: string, ...bindings: Array<string | number | null>): Iterable<Record<string, unknown>> }
export interface UsageReportQuery { principal: string; tenantId: string; policyId: string; range: UsageReportRange; groupBy: UsageGroupBy; filters: Partial<Record<"model" | "provider" | "key" | "status" | "costClass" | "lane", string>> }
export const utilityFormats = new Set(["openai.models", "anthropic.models", "openai.responses_input_tokens", "anthropic.count_tokens", "openai.moderations"]);
const text = (v: unknown): string | null => typeof v === "string" ? v : null;
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
    lane: cost.lane, costClass: cost.costClass, reportingCostMicros: cost.amount, estimateReason: cost.costClass === "estimated" ? text(event.reporting_estimate_reason) : null, recordedChargeMicros: recordedAccountingAmount(event),
    costBasis: text(event.cost_basis), pricingRef: text(event.pricing_ref), requestedTier: text(event.requested_service_tier), servedTier: text(event.served_service_tier),
    compoundRequestId: text(event.compound_request_id), compoundStage: text(event.compound_request_stage) };
}

export function ensureUsageReportSchema(sql: ReportSql): void {
  ensureUsageVisibility(sql);
  sql.exec(
    "CREATE TABLE IF NOT EXISTS usage_report_events (id TEXT PRIMARY KEY, occurred_at_ms INTEGER NOT NULL, tenant_id TEXT NOT NULL, policy_id TEXT NOT NULL, principal_key TEXT, provider TEXT NOT NULL, model TEXT, key_id TEXT, status TEXT NOT NULL, call_kind TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER, reasoning_output_tokens INTEGER, lane TEXT NOT NULL, cost_class TEXT NOT NULL, reporting_cost_micros INTEGER, detail_json TEXT NOT NULL)");
  const columns = new Set([...sql.exec("PRAGMA table_info(usage_report_events)")].map(row => row.name));
  if (!columns.has("recorded_charge_micros")) sql.exec("ALTER TABLE usage_report_events ADD COLUMN recorded_charge_micros INTEGER");
  if (!columns.has("report_format_version")) sql.exec("ALTER TABLE usage_report_events ADD COLUMN report_format_version INTEGER DEFAULT 0");
  sql.exec("CREATE INDEX IF NOT EXISTS usage_report_old_format ON usage_report_events (report_format_version) WHERE report_format_version IS NULL OR report_format_version != 2");
  sql.exec("CREATE INDEX IF NOT EXISTS usage_report_owner_range ON usage_report_events (tenant_id, policy_id, principal_key, occurred_at_ms DESC, id DESC)");
  sql.exec("CREATE INDEX IF NOT EXISTS usage_report_retention ON usage_report_events (occurred_at_ms)");
  sql.exec("CREATE TABLE IF NOT EXISTS usage_report_migration (id INTEGER PRIMARY KEY CHECK (id = 1), last_rowid INTEGER NOT NULL, upper_rowid INTEGER NOT NULL, complete INTEGER NOT NULL)");
  // No historical projection here or in alarms/reads. Empty shards have no history to recover;
  // preexisting ledger history uses bounded read-through until explicit operator apply.
  if (![...sql.exec("SELECT id FROM usage_report_migration WHERE id = 1")].length) sql.exec("INSERT INTO usage_report_migration SELECT 1, 0, COALESCE(MAX(rowid), 0), CASE WHEN COALESCE(MAX(rowid), 0) = 0 THEN 1 ELSE 0 END FROM usage_events");
  // Persistent across old-writer rollback. A saved complete marker predating these
  // triggers proves nothing: only a truly empty canonical AND projection starts trusted.
  // Never derive coverage from MAX(rowid)/counts: retention permits rowid reuse.
  sql.exec("CREATE TABLE IF NOT EXISTS usage_report_coverage (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991), verified_generation INTEGER NOT NULL, round_generation INTEGER NOT NULL)");
  sql.exec("INSERT OR IGNORE INTO usage_report_coverage SELECT 1, 0, CASE WHEN NOT EXISTS (SELECT 1 FROM usage_events LIMIT 1) AND NOT EXISTS (SELECT 1 FROM usage_report_events LIMIT 1) THEN 0 ELSE -1 END, -1");
  sql.exec("CREATE TRIGGER IF NOT EXISTS usage_report_canonical_insert AFTER INSERT ON usage_events BEGIN UPDATE usage_report_coverage SET generation = generation + 1 WHERE id = 1; END");
  sql.exec("CREATE TRIGGER IF NOT EXISTS usage_report_canonical_delete AFTER DELETE ON usage_events BEGIN DELETE FROM usage_report_events WHERE id = OLD.id; UPDATE usage_report_coverage SET generation = generation + 1 WHERE id = 1; END");
  sql.exec("CREATE TRIGGER IF NOT EXISTS usage_report_canonical_update AFTER UPDATE ON usage_events BEGIN DELETE FROM usage_report_events WHERE id = OLD.id; UPDATE usage_report_coverage SET generation = generation + 1 WHERE id = 1; END");
}
/** Must run INSIDE the caller's synchronous transaction, around paired canonical /
 * projection writes only. Advance acknowledgements only if already current; a
 * new successful ingest/retention pass must never erase an older writer's gap.
 * No persistent bypass flag: crashes roll back both writes and acknowledgements. */
export function withUsageReportPair(sql: ReportSql, write: () => void): void {
  const generation = Number([...sql.exec("SELECT generation FROM usage_report_coverage WHERE id = 1")][0].generation);
  write();
  sql.exec("UPDATE usage_report_coverage SET verified_generation = CASE WHEN verified_generation = ? THEN generation ELSE verified_generation END, round_generation = CASE WHEN round_generation = ? THEN generation ELSE round_generation END WHERE id = 1", generation, generation);
}
export function insertUsageReportEvent(sql: ReportSql, event: UsageEvent): boolean {
  const detail = projectUsageEvent(event);
  const inserted = [...sql.exec("INSERT OR IGNORE INTO usage_report_events (id, occurred_at_ms, tenant_id, policy_id, principal_key, provider, model, key_id, status, call_kind, input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, reasoning_output_tokens, lane, cost_class, reporting_cost_micros, detail_json, recorded_charge_micros, report_format_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2) RETURNING id",
    detail.id, detail.occurredAt, event.tenant_id, event.policy_id || event.key_id, typeof event.principal_id === "string" ? normalizeEmail(event.principal_id) : null, detail.provider, detail.model, detail.keyId, detail.status, detail.callKind,
    detail.inputTokens, detail.outputTokens, detail.cachedInputTokens, detail.cacheWriteInputTokens, detail.reasoningOutputTokens, detail.lane, detail.costClass, detail.reportingCostMicros, JSON.stringify(detail), detail.recordedChargeMicros)];
  return inserted[0]?.id === event.id;
}
/** Projection progress is not retained-history coverage. No read mutates either watermark. */
export function usageReportProjectionComplete(sql: ReportSql): boolean { return [...sql.exec("SELECT migration.complete FROM usage_report_migration AS migration JOIN usage_report_coverage AS coverage ON coverage.id = migration.id WHERE migration.id = 1 AND coverage.verified_generation = coverage.generation")][0]?.complete === 1; }
export function usageReportHistoryComplete(sql: ReportSql): boolean { return reportHistory(sql).historyComplete; }
function reportHistory(sql: ReportSql, cut?: UsageVisibilityCut) {
  const qualified = usageReportProjectionComplete(sql) && ![...sql.exec("SELECT 1 FROM usage_report_events INDEXED BY usage_report_old_format WHERE report_format_version IS NULL OR report_format_version != 2 LIMIT 1")].length;
  if (cut?.source === "projection" && !qualified) throw new UsageVisibilityError("restart", "source");
  const projectionComplete = cut ? cut.source === "projection" : qualified;
  const historyComplete = projectionComplete || [...sql.exec("SELECT complete FROM usage_attribution_migration WHERE id = 1")][0]?.complete === 1;
  return { projectionComplete, historyComplete, historySource: projectionComplete ? "projection" as const : "retained_ledger" as const };
}
/** Caller keeps capture/query/validation inside the shard's synchronous transaction. */
export function openUsageReportCut(sql: ReportSql, from: number, now = Date.now()): UsageVisibilityCut {
  return captureUsageVisibility(sql, reportHistory(sql).historySource, from, now);
}
function visibilityWhere(cut: UsageVisibilityCut | undefined, table: string) {
  return cut ? " AND NOT EXISTS (SELECT 1 FROM usage_report_arrivals AS arrival WHERE arrival.id = " + table + ".id AND arrival.seq > " + cut.seq + ")" : "";
}
export interface UsageReportMigrationEffect { lane: UsageCostLane; costClass: UsageCostClass; calls: number; proposedReportingMicros: number | null; recordedChargeMicros: number }
export interface UsageReportMigrationOptions { apply?: boolean; batchSize?: number; now?: number; afterRowid?: number }
/** Internal/offline only. Default dry-run does not initialize or update any schema/state.
 * A round pins both an upper rowid and a coverage generation. Unpaired changes
 * restart at zero with a fresh bound (including reused rowids below the cursor).
 * Paired current-writer inserts do not widen or restart an interrupted round.
 * Apply reads/writes in one transaction; it never mutates canonical history. */
export function migrateUsageReport(sql: ReportSql, transaction: (fn: () => void) => void, options: UsageReportMigrationOptions = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) || options.apply !== undefined && typeof options.apply !== "boolean") throw new Error("apply must be an explicit boolean");
  if (options.now !== undefined && (!Number.isSafeInteger(options.now) || options.now < 0)) throw new Error("invalid migration time");
  if (options.apply && options.afterRowid !== undefined) throw new Error("apply resumes its persisted watermark");
  const batchSize = options.batchSize ?? 500, cutoff = (options.now ?? Date.now()) - reportRetentionMs;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000) throw new Error("batchSize must be 1..2000");
  const run = () => {
    if (options.apply) ensureUsageReportSchema(sql);
    const tables = new Set([...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('usage_report_migration', 'usage_report_coverage', 'usage_report_events')")].map(row => row.name));
    const saved = tables.has("usage_report_migration") ? [...sql.exec("SELECT last_rowid, upper_rowid, complete FROM usage_report_migration WHERE id = 1")][0] : undefined;
    const coverage = tables.has("usage_report_coverage") ? [...sql.exec("SELECT generation, verified_generation, round_generation FROM usage_report_coverage WHERE id = 1")][0] : undefined;
    const previouslyComplete = saved?.complete === 1 && coverage !== undefined && coverage.verified_generation === coverage.generation;
    const freshRound = !previouslyComplete && (!coverage || coverage.round_generation !== coverage.generation);
    const upper = Number(freshRound || !saved ? [...sql.exec("SELECT COALESCE(MAX(rowid), 0) AS upper_rowid FROM usage_events")][0].upper_rowid : saved.upper_rowid);
    const last = Number(options.afterRowid ?? (freshRound ? 0 : saved?.last_rowid ?? 0));
    if (!Number.isSafeInteger(last) || last < 0 || last > upper || !Number.isSafeInteger(upper)) throw new Error("invalid migration watermark");
    const batch = previouslyComplete && options.afterRowid === undefined ? [] : [...sql.exec("SELECT rowid, id, occurred_at_ms, event_json FROM usage_events WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?", last, upper, batchSize)];
    const next = Number(batch.at(-1)?.rowid ?? upper), scanned = batch.length < batchSize || next === upper;
    const projected = batch.filter(row => Number(row.occurred_at_ms) >= cutoff).map(row => { const event = JSON.parse(String(row.event_json)) as UsageEvent; projectUsageEvent(event); return event; });
    // Explicit migration only: prune pre-trigger orphan/expired metadata, at most
    // one batch of deletes. Never perform this anti-join on a reporting read.
    const obsolete = !previouslyComplete && scanned && tables.has("usage_report_events") ? [...sql.exec("SELECT report.id FROM usage_report_events AS report LEFT JOIN usage_events AS ledger ON ledger.id = report.id WHERE ledger.id IS NULL OR report.occurred_at_ms < ? ORDER BY report.id LIMIT ?", cutoff, batchSize)] : [];
    const complete = scanned && obsolete.length < batchSize;
    const effects = new Map<string, UsageReportMigrationEffect>();
    for (const event of projected) {
      const detail = projectUsageEvent(event), key = detail.lane + ":" + detail.costClass;
      const effect = effects.get(key) ?? { lane: detail.lane, costClass: detail.costClass, calls: 0, proposedReportingMicros: detail.reportingCostMicros === null ? null : 0, recordedChargeMicros: 0 };
      effect.calls++; effect.recordedChargeMicros += detail.recordedChargeMicros ?? 0;
      if (effect.proposedReportingMicros !== null) effect.proposedReportingMicros += detail.reportingCostMicros ?? 0;
      if (!Number.isSafeInteger(effect.recordedChargeMicros) || effect.proposedReportingMicros !== null && !Number.isSafeInteger(effect.proposedReportingMicros)) throw new Error("migration effect exceeds exact numeric bounds");
      effects.set(key, effect);
    }
    if (options.apply) {
      // Refresh, not INSERT OR IGNORE over unverified pre-trigger metadata. Also
      // remove projections for expired canonical rows without parsing their JSON.
      for (const row of obsolete) sql.exec("DELETE FROM usage_report_events WHERE id = ?", String(row.id));
      for (const row of batch) sql.exec("DELETE FROM usage_report_events WHERE id = ?", String(row.id));
      for (const event of projected) if (!insertUsageReportEvent(sql, event)) throw new Error("reporting migration did not confirm projection");
      sql.exec("UPDATE usage_report_migration SET last_rowid = ?, upper_rowid = ?, complete = ? WHERE id = 1", next, upper, complete ? 1 : 0);
      sql.exec("UPDATE usage_report_coverage SET round_generation = generation, verified_generation = CASE WHEN ? = 1 THEN generation ELSE verified_generation END WHERE id = 1", complete ? 1 : 0);
    }
    return { dryRun: !options.apply, examined: batch.length, projected: projected.length, lastRowid: next, upperRowid: upper, complete, previouslyComplete, effects: [...effects.values()].sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : a.costClass < b.costClass ? -1 : a.costClass > b.costClass ? 1 : 0) };
  };
  if (!options.apply) return run();
  let result: ReturnType<typeof run> | undefined;
  transaction(() => { result = run(); });
  return result!;
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
const filterColumns = { model: "model", provider: "provider", key: "key_id", status: "status", costClass: "cost_class", lane: "lane" };
function filterTerms(query: UsageReportQuery) {
  const terms: string[] = [], bindings: Array<string | number | null> = [];
  for (const [key, column] of Object.entries(filterColumns)) {
    const value = query.filters[key as keyof typeof filterColumns];
    if (value !== undefined) { terms.push(column + " = ?"); bindings.push(value); }
  }
  return { terms, bindings };
}
export function reportWhere(query: UsageReportQuery) {
  const { from, to } = query.range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || to - from > reportRetentionMs) throw new Error("reporting SQL requires a bounded retained range of at most 30 days");
  const filters = filterTerms(query);
  return {
    where: ["tenant_id = ?", "policy_id = ?", "principal_key = ?", "occurred_at_ms >= ?", "occurred_at_ms < ?", ...filters.terms].join(" AND "),
    bindings: [query.tenantId, query.policyId, query.principal, from, to, ...filters.bindings] as Array<string | number | null>,
  };
}
export interface UsageAggregateRow extends UsageMetrics { recordedChargeMicros: number; chargeReportedCalls: number; dimension: string; value: string | number | null; lane: UsageCostLane; costClass: UsageCostClass; amountMicros: number }
export interface UsageReportHistory { historyComplete: boolean; projectionComplete?: boolean; historySource?: "projection" | "retained_ledger" }
export interface UsageReportShard extends UsageReportHistory { rows: UsageAggregateRow[]; groupsTruncated: boolean }

const scalarColumns = "model, provider, key_id, occurred_at_ms, status, call_kind, input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, reasoning_output_tokens, lane, cost_class, reporting_cost_micros, recorded_charge_micros";
function reportFilters(query: UsageReportQuery) {
  const { terms, bindings } = filterTerms(query);
  return { where: terms.length ? terms.join(" AND ") : "1", bindings };
}
const jsonText = (field: string) => "CASE WHEN json_valid(event_json) THEN CASE WHEN json_type(event_json, '$." + field + "') = 'text' THEN json_extract(event_json, '$." + field + "') END END";
const jsonCounter = (field: string) => {
  const value = "json_extract(event_json, '$." + field + "')";
  return "CASE WHEN json_valid(event_json) THEN CASE WHEN json_type(event_json, '$." + field + "') IN ('integer', 'real') AND " + value + " BETWEEN 0 AND 9007199254740991 AND " + value + " = CAST(" + value + " AS INTEGER) THEN CAST(" + value + " AS INTEGER) END END";
};
/** Scalar-only SQL twin of projectUsageEvent. The only JSON evaluated belongs to
 * this indexed canonical owner range. Never expand aliases or infer old ownership.
 * The ledger, not a UNION with sparse projection rows, is the sole source until
 * migration completes: each retained original occurs exactly once. */
function retainedSource(query: UsageReportQuery, keyset = "", keysetBindings: Array<string | number | null> = [], cut?: UsageVisibilityCut) {
  const range = reportWhere({ ...query, filters: {} });
  const counters = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens", "actual_cost_micros", "reporting_known_cost_micros", "reporting_estimated_cost_micros"];
  const texts = ["model", "credential_id", "cost_basis", "grant_lane", "request_format", "capability", "reporting_estimate_reason"];
  const basisCase = "CASE cost_basis " + Object.entries(knownBasisClasses).map(([basis, cls]) => "WHEN '" + basis + "' THEN '" + cls + "'").join(" ") + " ELSE 'unknown' END";
  return { cte: "owned AS MATERIALIZED (SELECT id, occurred_at_ms, provider, status, " +
    counters.map(field => jsonCounter(field) + " AS " + field).concat(texts.map(field => jsonText(field) + " AS " + field)).join(", ") +
    " FROM usage_events INDEXED BY usage_events_policy_principal WHERE " + range.where + visibilityWhere(cut, "usage_events") + keyset + "), " +
    "validated AS (SELECT *, " + basisCase + " AS basis_class, " +
    "CASE WHEN cached_input_tokens <= input_tokens THEN cached_input_tokens END AS cache_read, " +
    "CASE WHEN cache_write_input_tokens <= input_tokens THEN cache_write_input_tokens END AS cache_write, " +
    "CASE WHEN reasoning_output_tokens <= output_tokens THEN reasoning_output_tokens END AS reasoning FROM owned), " +
    "classified AS (SELECT *, CASE WHEN actual_cost_micros IS NULL OR (basis_class = 'no_charge' AND actual_cost_micros != 0) THEN 'unknown' " +
    "WHEN basis_class != 'unknown' THEN basis_class " +
    "WHEN substr(cost_basis, 1, 9) = 'unpriced_' AND reporting_known_cost_micros > 0 AND reporting_known_cost_micros <= actual_cost_micros THEN 'partial' " +
    "WHEN actual_cost_micros = 0 AND reporting_estimated_cost_micros IS NOT NULL AND reporting_estimate_reason != '' THEN 'estimated' ELSE 'unknown' END AS cost_class FROM validated), " +
    "source AS (SELECT actual_cost_micros AS recorded_charge_micros, id, occurred_at_ms, provider, status, model, credential_id AS key_id, input_tokens, output_tokens, " +
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
export function queryUsageReport(sql: ReportSql, query: UsageReportQuery, cut?: UsageVisibilityCut): UsageReportShard {
  if (cut) validateUsageVisibility(sql, cut, query.range.from);
  const history = reportHistory(sql, cut), range = reportWhere(query), column = { model: "model", provider: "provider", key: "key_id" }[query.groupBy];
  const bucket = "CASE " + query.range.buckets.map((b, i) => "WHEN occurred_at_ms >= " + b.start + " AND occurred_at_ms < " + b.end + " THEN " + i).join(" ") + " ELSE -1 END";
  const filters = reportFilters(query), retained = history.projectionComplete ? null : retainedSource(query, "", [], cut);
  const result = [...sql.exec(
    "WITH " + (retained ? retained.cte + ", " : "") + "filtered AS MATERIALIZED (" +
    "SELECT " + scalarColumns + " FROM " + (retained ? "source WHERE " + filters.where : "usage_report_events INDEXED BY usage_report_owner_range WHERE " + range.where + visibilityWhere(cut, "usage_report_events")) +
    "), selected AS (SELECT DISTINCT " + column + " AS value FROM filtered ORDER BY value COLLATE BINARY LIMIT 101), " +
    "dimensions AS (SELECT 'total' AS dimension UNION ALL SELECT 'bucket' UNION ALL SELECT 'group'), " +
    "expanded AS (SELECT filtered.*, dimension, CASE dimension WHEN 'group' THEN " + column + " WHEN 'bucket' THEN " + (query.range.buckets.length ? bucket : "-1") + " ELSE NULL END AS dimension_value " +
    "FROM filtered CROSS JOIN dimensions WHERE dimension != 'group' OR (" + column + " IS NULL AND EXISTS (SELECT 1 FROM selected WHERE value IS NULL)) OR " + column + " IN (SELECT value FROM selected)) " +
    "SELECT dimension, dimension_value AS value, lane, cost_class AS costClass, " + metricSql + ", COALESCE(SUM(reporting_cost_micros), 0) AS amountMicros, TOTAL(recorded_charge_micros) AS recordedChargeMicros, COUNT(recorded_charge_micros) AS chargeReportedCalls " +
    "FROM expanded GROUP BY dimension, dimension_value, lane, cost_class ORDER BY dimension, dimension_value COLLATE BINARY, lane, cost_class",
    ...(retained ? [...retained.bindings, ...filters.bindings] : range.bindings))] as unknown as UsageAggregateRow[];
  // Nonnegative integer inputs: TOTAL stays exact through MAX_SAFE_INTEGER and
  // avoids SQLite integer overflow; anything beyond that bound is unavailable.
  if (result.some(row => [...usageMetricKeys, "recordedChargeMicros", "chargeReportedCalls", "amountMicros"].some(key => !Number.isSafeInteger(row[key as keyof UsageAggregateRow]) || Number(row[key as keyof UsageAggregateRow]) < 0))) throw new UsageVisibilityError("unavailable", "capacity");
  const groups = new Set(result.filter(row => row.dimension === "group").map(row => row.value));
  return { rows: result, groupsTruncated: groups.size > 100, ...history };
}
export interface UsageEventPosition { at: number; id: string }
export function queryUsageEvents(sql: ReportSql, query: UsageReportQuery, limit: number, before?: UsageEventPosition, includeEqualId = false, cut?: UsageVisibilityCut): { events: PersonalUsageEvent[] } & UsageReportHistory {
  if (cut) validateUsageVisibility(sql, cut, query.range.from);
  const history = reportHistory(sql, cut), range = reportWhere(query);
  const keyset = before ? " AND (occurred_at_ms < ? OR (occurred_at_ms = ? AND id " + (includeEqualId ? "<=" : "<") + " ? COLLATE BINARY))" : "";
  const positions = before ? [before.at, before.at, before.id] : [];
  if (history.projectionComplete) {
    const events = [...sql.exec("SELECT detail_json FROM usage_report_events INDEXED BY usage_report_owner_range WHERE " + range.where + visibilityWhere(cut, "usage_report_events") + keyset + " ORDER BY occurred_at_ms DESC, id COLLATE BINARY DESC LIMIT ?", ...range.bindings, ...positions, limit + 1)].map(row => JSON.parse(String(row.detail_json)) as PersonalUsageEvent);
    return { events, ...history };
  }
  if (Object.values(query.filters).every(value => value === undefined)) {
    // The common unfiltered page does not classify the rest of the retained
    // range. Read only the indexed keyset page and project its metadata in JS.
    const events = [...sql.exec("SELECT event_json FROM usage_events INDEXED BY usage_events_policy_principal WHERE " + range.where + visibilityWhere(cut, "usage_events") + keyset + " ORDER BY occurred_at_ms DESC, id COLLATE BINARY DESC LIMIT ?", ...range.bindings, ...positions, limit + 1)]
      .map(row => projectUsageEvent(JSON.parse(String(row.event_json)) as UsageEvent));
    return { events, ...history };
  }
  const retained = retainedSource(query, keyset, positions, cut), filters = reportFilters(query);
  // Only the bounded selected page fetches raw JSON. Classification/filtering and
  // stable keysets precede LIMIT; only scalar owner metadata is materialized.
  const events = [...sql.exec("WITH " + retained.cte + ", page AS MATERIALIZED (SELECT id, occurred_at_ms FROM source WHERE " + filters.where +
    " ORDER BY occurred_at_ms DESC, id COLLATE BINARY DESC LIMIT ?) SELECT ledger.event_json FROM page JOIN usage_events AS ledger ON ledger.id = page.id ORDER BY page.occurred_at_ms DESC, page.id COLLATE BINARY DESC",
    ...retained.bindings, ...filters.bindings, limit + 1)].map(row => projectUsageEvent(JSON.parse(String(row.event_json)) as UsageEvent));
  return { events, ...history };
}
