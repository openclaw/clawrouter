import type { UsageGroupIdentity, CompleteUsageEvent } from "../shared/usage-report.ts";
import { completeUsageLimits, reportCellSlotMs, completeUsageBuckets, validateCompleteUsageQuery, usageJsonBytes, capacity, invalidSource, exact, boundedText, type UsageShardInput, type UsageShardResult, type UsageCandidateSize, type UsageGroupPage, type CompleteAggregateRow, type UsageReportQuery, type UsageReportMigrationEffect, type UsageReportMigrationOptions, type UsageAggregateRow, type UsageReportHistory, type UsageReportShard, type UsageEventPosition } from "./usage-report-protocol.ts";
import { usageMetricKeys } from "../shared/usage-report.ts";
import { ensureUsageVisibility, captureUsageVisibility, validateUsageVisibility, maintainUsageVisibility } from "./usage-report-visibility.ts";
import { UsageVisibilityError, type UsageVisibilityCut } from "./usage-report-protocol.ts";
import type { PersonalUsageEvent, UsageMetrics } from "../shared/usage-report.ts";
import type { UsageEvent } from "./types.ts";
import { normalizeEmail } from "./utils.ts";
import { reportRetentionMs } from "./usage-report-range.ts";
import { reportingCost, recordedAccountingAmount, usageCounter as counter } from "./usage-report-cost.ts";
import { utilityFormats, twinCte, twinOwnedColumns, reportCounters } from "./usage-report-twin.ts";
import { cellDim, cellsPaused, usableCells } from "./usage-report-cells.ts";
export { reportingCost } from "./usage-report-cost.ts";

export interface ReportSql { exec(query: string, ...bindings: Array<string | number | null>): Iterable<Record<string, unknown>>; readonly databaseSize?: number }
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
  // The owner index cannot time-bound an all-principal scan. Canonical legacy
  // indexes also sort equal-time IDs; these private paths have measured plans.
  sql.exec("CREATE INDEX IF NOT EXISTS usage_report_scope_range ON usage_report_events (tenant_id, policy_id, occurred_at_ms DESC, id DESC)");
  sql.exec("CREATE INDEX IF NOT EXISTS usage_events_report_scope ON usage_events (policy_id, occurred_at_ms DESC, id DESC)");
  sql.exec("CREATE INDEX IF NOT EXISTS usage_events_report_owner ON usage_events (policy_id, principal_key, occurred_at_ms DESC, id DESC)");
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
/** Reads trust the projection only once its coverage is verified, and a migration round re-projects every row it pins
 * (a new round starts from rowid 0). A projection neither verified nor in a current round is never read: writers skip
 * it and the alarm reclaims it, so history that predates it does not keep a second, unread copy of the ledger. */
export function usageReportProjectionLive(sql: ReportSql): boolean {
  return [...sql.exec("SELECT 1 FROM usage_report_coverage WHERE id = 1 AND (verified_generation = generation OR round_generation = generation)")].length > 0;
}
/** Scheduling check (no writes): an unread projection still holds rows. */
export function usageReportProjectionReclaimDue(sql: ReportSql): boolean {
  return !usageReportProjectionLive(sql) && [...sql.exec("SELECT 1 FROM usage_report_events LIMIT 1")].length > 0;
}
/** One bounded alarm step; caller owns the transaction. Deletes up to 2,000 rows of an unread projection.
 * Returns 'idle' (nothing to reclaim), 'more' (rows remain) or 'done' (this step removed the last rows). */
export function reclaimUsageReportProjection(sql: ReportSql): 'idle' | 'more' | 'done' {
  if (!usageReportProjectionReclaimDue(sql)) return 'idle';
  sql.exec("DELETE FROM usage_report_events WHERE rowid IN (SELECT rowid FROM usage_report_events ORDER BY rowid LIMIT 2000)");
  return [...sql.exec("SELECT 1 FROM usage_report_events LIMIT 1")].length ? 'more' : 'done';
}
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
    // Dry-run also accepts the pre-format schema without altering it. A saved
    // completion/coverage pair cannot certify obsolete projected metadata.
    const hasFormat = tables.has("usage_report_events") && [...sql.exec("PRAGMA table_info(usage_report_events)")].some(row => row.name === "report_format_version");
    const obsoleteFormat = tables.has("usage_report_events") && [...sql.exec(hasFormat
      ? "SELECT 1 FROM usage_report_events INDEXED BY usage_report_old_format WHERE report_format_version IS NULL OR report_format_version != 2 LIMIT 1"
      : "SELECT 1 FROM usage_report_events LIMIT 1")].length > 0;
    const previouslyComplete = saved?.complete === 1 && coverage !== undefined && coverage.verified_generation === coverage.generation && !obsoleteFormat;
    // Old writers may have acknowledged a prefix (or paired rows beyond the
    // pinned upper bound) in the old format. Reopen those, not obsolete rows
    // still ahead inside a current round: resetting those would never finish.
    const obsoleteOutsideRound = obsoleteFormat && saved !== undefined && [...sql.exec(
      "SELECT 1 FROM usage_report_events AS report" + (hasFormat ? " INDEXED BY usage_report_old_format" : "") + " JOIN usage_events AS ledger ON ledger.id = report.id WHERE " +
      (hasFormat ? "(report.report_format_version IS NULL OR report.report_format_version != 2) AND " : "") + "(ledger.rowid <= ? OR ledger.rowid > ?) LIMIT 1", Number(saved.last_rowid), Number(saved.upper_rowid))].length > 0;
    const freshRound = !previouslyComplete && (!coverage || coverage.round_generation !== coverage.generation || saved?.complete === 1 && obsoleteFormat || obsoleteOutsideRound);
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
const metricSql = usageMetricKeys.map(key => 'COALESCE(' + metricExpressions[key] + ', 0) AS "' + key + '"').join(", ");
const filterColumns = { model: "model", provider: "provider", key: "key_id", status: "status", costClass: "cost_class", lane: "lane" };
function filterTerms(query: UsageReportQuery) {
  const terms: string[] = [], bindings: Array<string | number | null> = [];
  for (const [key, column] of Object.entries(filterColumns)) {
    const value = query.filters[key as keyof typeof filterColumns];
    if (value !== undefined) { if (value === null) terms.push(column + " IS NULL"); else { terms.push(column + " = ?"); bindings.push(value); } }
  }
  return { terms, bindings };
}
export function reportWhere(query: UsageReportQuery) {
  const { from, to } = query.range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || to - from > reportRetentionMs) throw new Error("reporting SQL requires a bounded retained range of at most 30 days");
  const filters = filterTerms(query);
  return {
    where: ["tenant_id = ?", "policy_id = ?", ...(query.principal === undefined ? [] : ["principal_key = ?"]), "occurred_at_ms >= ?", "occurred_at_ms < ?", ...filters.terms].join(" AND "),
    bindings: [query.tenantId, query.policyId, ...(query.principal === undefined ? [] : [query.principal]), from, to, ...filters.bindings] as Array<string | number | null>,
  };
}

// The aggregate never fetches detail_json. Bound the width of the typed row
// it actually visits, including the scope/fence columns. Reserve 8 bytes per
// value for record overhead plus 8 for each numeric value (including NULL).
const aggregateText = ['model','provider','key_id','status','call_kind','lane','cost_class'];
const projectedText = ['id','tenant_id','policy_id','principal_key',...aggregateText];
const projectedNumbers = ['occurred_at_ms','input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens','reporting_cost_micros','recorded_charge_micros'];
const byteLengths = (names: string[]) => names.map(name=>'COALESCE(length(CAST('+name+' AS BLOB)),0)').join(' + ');
const projectedAggregateBytes = 8 * (projectedText.length + 2 * projectedNumbers.length) + ' + ' + byteLengths(projectedText);
const scalarColumns = [...aggregateText,...projectedNumbers].join(', ');
/** The same exact filters against cells, whose nullable dimensions are stored as x''. */
function cellFilters(query: UsageReportQuery) {
  const terms: string[] = [], bindings: Array<string | number | null> = [];
  for (const [key, column] of Object.entries(filterColumns)) {
    const value = query.filters[key as keyof typeof filterColumns];
    if (value === null) terms.push(cellDim(column, 'c.') + ' IS NULL'); else if (value !== undefined) { terms.push('c.' + column + ' = ?'); bindings.push(value); }
  }
  return { where: terms.length ? terms.join(" AND ") : "1", bindings };
}
function reportFilters(query: UsageReportQuery) {
  const { terms, bindings } = filterTerms(query);
  return { where: terms.length ? terms.join(" AND ") : "1", bindings };
}
/** Scalar-only SQL twin of projectUsageEvent (usage-report-twin.ts). The only JSON evaluated belongs to
 * this indexed canonical owner range. Never expand aliases or infer old ownership.
 * The ledger, not a UNION with sparse projection rows, is the sole source until
 * migration completes: each retained original occurs exactly once. */
function retainedSource(query: UsageReportQuery, keyset = "", keysetBindings: Array<string | number | null> = [], cut?: UsageVisibilityCut) {
  const range = reportWhere({ ...query, filters: {} });
  return { cte: twinCte("SELECT " + twinOwnedColumns() + " FROM usage_events INDEXED BY " + (query.principal === undefined ? "usage_events_policy" : "usage_events_policy_principal") + " WHERE " + range.where + visibilityWhere(cut, "usage_events") + keyset),
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

function shardQuery(x: UsageShardInput): UsageReportQuery {
  const { user, key, ...filters } = x.query.filters;
  return { tenantId: x.tenantId, policyId: x.policyId, principal: user, groupBy: 'model',
    filters: { ...filters, ...(key ? { key: key.kind === 'session' ? null : key.id } : {}) },
    range: { from: x.query.from, to: x.query.to, timezone: x.query.timezone, retentionStart: x.query.from, clampedStart: false, buckets: [] } };
}
function sourceNames(q: UsageReportQuery, cut: UsageVisibilityCut) {
  const projection = cut.source === 'projection';
  return { table: projection ? 'usage_report_events' : 'usage_events', detail: projection ? 'detail_json' : 'event_json',
    index: projection ? q.principal === undefined ? 'usage_report_scope_range' : 'usage_report_owner_range'
      : q.principal === undefined ? 'usage_events_report_scope' : 'usage_events_report_owner' };
}
/** Lengths, not JSON extraction or unbounded COUNT. Conservative candidate work
 * includes later arrivals and rows subsequently rejected by equality filters. */
function candidateSize(sql: ReportSql, q: UsageReportQuery, cut: UsageVisibilityCut): UsageCandidateSize {
  const n = sourceNames(q,cut), r = reportWhere({ ...q, filters: {} });
  const row = [...sql.exec('SELECT COUNT(*) AS rows, COALESCE(SUM(bytes),0) AS bytes FROM (SELECT length(CAST(' + n.detail + ' AS BLOB)) AS bytes FROM ' + n.table + ' INDEXED BY ' + n.index + ' WHERE ' + r.where + ' LIMIT 250001)', ...r.bindings)][0];
  exact(row.rows); exact(row.bytes);
  if (row.rows > completeUsageLimits.candidateRows || row.bytes > completeUsageLimits.inputBytes) capacity();
  return { rows: row.rows, bytes: row.bytes };
}
function sourceCte(q: UsageReportQuery, cut: UsageVisibilityCut, keyset = '', positions: Array<string | number> = []) {
  const n = sourceNames(q,cut), r = reportWhere(q);
  if (cut.source === 'projection') return { cte: 'filtered AS NOT MATERIALIZED (SELECT id, principal_key, ' + scalarColumns + ' FROM ' + n.table + ' INDEXED BY ' + n.index + ' WHERE ' + r.where + visibilityWhere(cut,n.table) + keyset + ')', bindings: [...r.bindings,...positions] };
  // Reuse the v2 scalar normalizer; only the access path differs from the legacy reader.
  const retained = retainedSource(q,keyset,positions,cut), filters = reportFilters(q);
  return { cte: retained.cte.replace('INDEXED BY ' + (q.principal === undefined ? 'usage_events_policy' : 'usage_events_policy_principal'), 'INDEXED BY ' + n.index) + ', filtered AS MATERIALIZED (SELECT * FROM source WHERE ' + filters.where + ')', bindings: [...retained.bindings,...filters.bindings] };
}
const identityOrder = '(owner IS NOT NULL), owner COLLATE BINARY, (value IS NOT NULL), value COLLATE BINARY';
function sameIdentity(a: UsageGroupIdentity, b: UsageGroupIdentity): boolean { return a.owner === b.owner && a.value === b.value; }
const cap = completeUsageLimits.candidateRows + 1;
/** Rows/bytes a scan visits, capped at the limit + 1, including rows later rejected by filters or the cut. */
function gross(sql: ReportSql, selects: string[], bindings: Array<string | number | null>, limit = cap) {
  if (!selects.length) return { rows: 0, bytes: 0 };
  const row = [...sql.exec('SELECT COUNT(*) AS rows, COALESCE(SUM(bytes), 0) AS bytes FROM (' + selects.join(' UNION ALL ') + ' LIMIT ' + limit + ')', ...bindings)][0];
  exact(row.rows); exact(row.bytes); return { rows: Number(row.rows), bytes: Number(row.bytes) };
}
/** Per local bucket: whole quarter-hour slots come from cells, the remainder (range edges,
 * any unaligned midnight) is read raw. Half-open throughout; no offset alignment assumed. */
function cellLayout(x: UsageShardInput, q: UsageReportQuery) {
  const buckets = completeUsageBuckets({ ...x.query, from: q.range.from, to: q.range.to }), blocks: number[][] = [], edges: number[][] = [];
  buckets.forEach((b, i) => {
    const lo = Math.ceil(b.start / reportCellSlotMs) * reportCellSlotMs, hi = Math.floor(b.end / reportCellSlotMs) * reportCellSlotMs;
    if (lo < hi) { blocks.push([lo, hi, i]); if (b.start < lo) edges.push([b.start, lo]); if (hi < b.end) edges.push([hi, b.end]); } else edges.push([b.start, b.end]);
  });
  return { buckets, blocks, edges };
}
function cellParts(q: UsageReportQuery, layout: ReturnType<typeof cellLayout>, folded: number) {
  const owner = q.principal !== undefined, base = 'tenant_id = ? AND policy_id = ?' + (owner ? ' AND principal_key = ?' : '');
  const scope: Array<string | number | null> = [q.tenantId, q.policyId, ...(owner ? [q.principal!] : [])];
  return { scope, blocks: 'blocks(lo, hi, bucket) AS (VALUES ' + layout.blocks.map(b => '(' + b.map(Number).join(', ') + ')').join(', ') + ')',
    // Unfolded tail by rowid (the fold lag), and edges by time; both are visited in full.
    raw: [{ from: 'usage_events NOT INDEXED WHERE rowid > ?', where: ' AND ' + base + ' AND EXISTS (SELECT 1 FROM blocks WHERE occurred_at_ms >= lo AND occurred_at_ms < hi)', bindings: [folded], scoped: true },
      ...layout.edges.map(([a, b]) => ({ from: 'usage_events INDEXED BY ' + (owner ? 'usage_events_report_owner' : 'usage_events_report_scope') + ' WHERE ' + base + ' AND occurred_at_ms >= ? AND occurred_at_ms < ?', where: '', bindings: [...scope, a, b], scoped: false }))],
    cells: 'blocks AS b JOIN usage_report_cells AS c' + (owner ? ' INDEXED BY usage_report_cells_owner' : '') + ' ON c.tenant_id = ? AND c.policy_id = ?' + (owner ? ' AND c.principal_key = ?' : '') + ' AND c.slot_ms >= b.lo AND c.slot_ms < b.hi' };
}
const fits = (w: UsageCandidateSize) => w.rows <= completeUsageLimits.candidateRows && w.bytes <= completeUsageLimits.inputBytes && (w.cellRows ?? 0) <= completeUsageLimits.cellRows;
/** Gross physical work of one negotiated report plan, measured in the caller's transaction. */
function measurePlan(sql: ReportSql, x: UsageShardInput, q: UsageReportQuery, cut: UsageVisibilityCut, plan: 'cells' | 'raw', rawLimit = cap): UsageCandidateSize {
  if (plan === 'raw') {
    const n = sourceNames(q, cut), r = reportWhere({ ...q, filters: {} });
    const bytes = cut.source === 'projection' ? projectedAggregateBytes : 'length(CAST(event_json AS BLOB))';
    return { ...gross(sql, ['SELECT ' + bytes + ' AS bytes FROM ' + n.table + ' INDEXED BY ' + n.index + ' WHERE ' + r.where], r.bindings, rawLimit), plan };
  }
  const cells = x.query.grain === 'day' ? usableCells(sql) : null;
  if (!cells) throw new UsageVisibilityError('unavailable', 'migration');
  const layout = cellLayout(x, q), parts = cellParts(q, layout, cells.folded), cellRows = countCells(sql, layout, parts), tail = tailCharge(q, layout, parts);
  const raw = gross(sql, parts.raw.map(p => 'SELECT '+(p.scoped ? tail.bytes : 'length(CAST(event_json AS BLOB))')+' AS bytes FROM '+p.from),
    parts.raw.flatMap(p => p.scoped ? [...tail.bindings,...p.bindings] : p.bindings));
  return { ...raw, cellRows, plan };
}
function countCells(sql: ReportSql, layout: ReturnType<typeof cellLayout>, parts: ReturnType<typeof cellParts>): number {
  const n = layout.blocks.length ? Number([...sql.exec('WITH ' + parts.blocks + ' SELECT COUNT(*) AS n FROM (SELECT 1 FROM ' + parts.cells + ' LIMIT ' + (completeUsageLimits.cellRows + 1) + ')', ...parts.scope)][0].n) : 0;
  exact(n); return n;
}
/** Bytes charged per unfolded-tail row. The rowid tail visits all owners, but SQLite evaluates the scope/time
 * predicates *before* passing owned rows to the JSON normalizer. Charge every visit and the scalar predicate inputs
 * even for a rejected row. The enclosing time span conservatively includes any gaps between whole slots. */
function tailCharge(q: UsageReportQuery, layout: ReturnType<typeof cellLayout>, parts: ReturnType<typeof cellParts>) {
  const tailScope = 'tenant_id = ? AND policy_id = ?' + (q.principal === undefined ? '' : ' AND principal_key = ?') + ' AND occurred_at_ms >= ? AND occurred_at_ms < ?';
  return { bytes: '32 + '+byteLengths(['tenant_id','policy_id','principal_key'])+' + CASE WHEN '+tailScope+' THEN length(CAST(event_json AS BLOB)) ELSE 0 END',
    bindings: [...parts.scope, layout.blocks[0]?.[0] ?? q.range.to, layout.blocks.at(-1)?.[1] ?? q.range.to] };
}
/** A retained cut's raw plan, measured in index order only while it stays within `rows` rows and `bytes` bytes: what
 * measurePlan(raw) measures, or null once it passes either bound. `charge` receives what it visited either way. */
function rawWithin(sql: ReportSql, q: UsageReportQuery, cut: UsageVisibilityCut, rows: number, bytes: number, charge: (w: UsageCandidateSize) => UsageCandidateSize): UsageCandidateSize | null {
  const n = sourceNames(q, cut), r = reportWhere({ ...q, filters: {} }), seen = { rows: 0, bytes: 0 };
  let within = true;
  for (const row of sql.exec('SELECT length(CAST(event_json AS BLOB)) AS bytes FROM ' + n.table + ' INDEXED BY ' + n.index + ' WHERE ' + r.where, ...r.bindings)) {
    exact(row.bytes); seen.rows++; seen.bytes += Number(row.bytes);
    if (seen.rows > rows || seen.bytes > bytes) { within = false; break; }
  }
  charge(seen); return within ? { ...seen, plan: 'raw' } : null;
}
/** The cells plan measured against a fitting raw plan without rescanning: its edges, then the unfolded tail in rowid
 * chunks growing from the raw plan's row count. Returns `raw` as soon as that raw part reads more rows and at least as
 * many bytes; otherwise what measurePlan(cells) measures, having visited no more. `charge` receives every scan. */
function cellsUnlessRawCheaper(sql: ReportSql, x: UsageShardInput, q: UsageReportQuery, folded: number, raw: UsageCandidateSize, charge: (w: UsageCandidateSize) => UsageCandidateSize): UsageCandidateSize {
  const layout = cellLayout(x, q), parts = cellParts(q, layout, folded), tail = tailCharge(q, layout, parts), edges = parts.raw.filter(p => !p.scoped);
  const seen = { ...charge(gross(sql, edges.map(p => 'SELECT length(CAST(event_json AS BLOB)) AS bytes FROM ' + p.from), edges.flatMap(p => p.bindings))) };
  const cheaper = () => seen.rows > raw.rows && seen.bytes >= raw.bytes;
  for (let after = folded, chunk = raw.rows + 1; !cheaper() && seen.rows < cap; chunk *= 2) {
    const want = Math.min(chunk, cap - seen.rows), page = [...sql.exec('SELECT COUNT(*) AS rows, COALESCE(SUM(b), 0) AS bytes, MAX(r) AS last FROM (SELECT rowid AS r, ' + tail.bytes + ' AS b FROM usage_events NOT INDEXED WHERE rowid > ? ORDER BY rowid LIMIT ?)', ...tail.bindings, after, want)][0];
    exact(page.rows); exact(page.bytes); charge({ rows: page.rows, bytes: page.bytes });
    seen.rows += page.rows; seen.bytes += page.bytes;
    if (page.rows < want) break;
    after = Number(page.last);
  }
  if (cheaper()) return raw;
  const cellRows = countCells(sql, layout, parts);
  charge({ rows: 0, bytes: 0, cellRows });
  return { rows: seen.rows, bytes: seen.bytes, cellRows, plan: 'cells' };
}
/** Capture/preflight choice: cells when usable and within limits; otherwise today's raw path. A large raw part (the
 * unfolded tail while cells catch up) is visited whatever the owner or range, so the raw plan runs instead when it
 * reads fewer raw rows and no more bytes (and so also visits less).
 * The result carries every row and cell its measurements visited, so the service charges rejected probes too. */
function measureReport(sql: ReportSql, x: UsageShardInput, q: UsageReportQuery, cut: UsageVisibilityCut): UsageCandidateSize {
  const probe = { rows: 0, bytes: 0 }, charge = (w: UsageCandidateSize) => { probe.rows += w.rows + (w.cellRows ?? 0); probe.bytes += w.bytes; return w; };
  const done = (w: UsageCandidateSize): UsageCandidateSize => ({ ...w, probe });
  const layout = cellLayout(x, q), eligible = x.query.grain === 'day' && layout.blocks.length > 0, cells = eligible ? usableCells(sql) : null;
  if (cut.source === 'projection') {
    // Select the aggregation plan independently of the pinned detail source.
    // Do not probe an unrelated unfolded tail for a small personal range.
    // An indexed prefix gives a lower bound for the alternative: if even
    // that prefix costs more than the complete cells plan, stop probing. It
    // never supplies totals or authorizes execution of a truncated raw plan.
    const limit = cells && cells.tailUpperBound < 8192 ? 8192 : cap;
    let raw = charge(measurePlan(sql, x, q, cut, 'raw', limit));
    const prefix = limit < cap && raw.rows === limit;
    if (!cells || (!prefix && fits(raw) && raw.rows <= 512 && raw.bytes <= 1024 * 1024)) return done(raw);
    // Rowid gaps can make the span much larger than the actual tail. Prove
    // the tail really visits at least as many rows before dismissing cells.
    if (!prefix && fits(raw) && cells.tailUpperBound >= raw.rows) {
      const tail = charge(gross(sql, ['SELECT 8 AS bytes FROM usage_events NOT INDEXED WHERE rowid > ?'], [cells.folded], raw.rows));
      if (tail.rows === raw.rows) return done(raw);
    }
    const folded = charge(measurePlan(sql, x, q, cut, 'cells'));
    const cheaper = () => folded.rows + (folded.cellRows ?? 0) <= raw.rows && folded.bytes <= raw.bytes;
    if (fits(folded) && cheaper()) return done(folded);
    if (prefix) raw = charge(measurePlan(sql, x, q, cut, 'raw'));
    return done(fits(folded) && (!fits(raw) || cheaper()) ? folded : raw);
  }
  const lag = completeUsageLimits.candidateRows / 10, share = completeUsageLimits.classifiedBytes / completeUsageLimits.shards;
  // While a tail wider than the fold lag catches up, the scoped raw range is measured first, while it stays within that
  // lag and one shard's share of the classified-byte budget: rowid gaps can make the span wide while the real tail is
  // small, and a discarded probe must not exhaust the budget. A raw plan within both is set against the cells plan
  // without rescanning, which stops once raw provably reads fewer rows and no more bytes; otherwise the steps below decide.
  let raw = cells && cells.tailUpperBound > lag ? rawWithin(sql, q, cut, lag, share, charge) : null;
  const viaCells = !cells ? null : raw ? cellsUnlessRawCheaper(sql, x, q, cells.folded, raw, charge) : charge(measurePlan(sql, x, q, cut, 'cells'));
  if (viaCells?.plan === 'raw') return done(viaCells);
  const cellsFit = viaCells && fits(viaCells) ? viaCells : null;
  // A steady-state tail (the fold lag) is small: no raw probe.
  if (cellsFit && cellsFit.rows <= completeUsageLimits.totalRows / completeUsageLimits.shards && cellsFit.bytes <= completeUsageLimits.inputBytes / completeUsageLimits.shards) return done(cellsFit);
  // Raw wins only on strictly fewer rows and no more bytes. Reaching
  // the cells row count proves it cannot win; never execute that prefix.
  raw ??= charge(measurePlan(sql, x, q, cut, 'raw', cellsFit ? cellsFit.rows : cap));
  if (fits(raw) && (!cellsFit || raw.rows < cellsFit.rows && raw.bytes <= cellsFit.bytes)) return done(raw);
  if (cellsFit) return done(cellsFit);
  if (viaCells && (viaCells.cellRows ?? 0) > completeUsageLimits.cellRows) return done(viaCells);
  // Retryable only while folding can still shrink the work: cells not yet built or rows left to
  // fold, and the partial-slot edges that always stay raw fit on their own. A storage pause or
  // oversized edges are limits the caller must narrow around.
  if (eligible && !cellsPaused(sql) && (!cells || cells.folding)) {
    const edges = cellParts(q, layout, 0).raw.slice(1), edgeWork = charge(gross(sql, edges.map(p => 'SELECT length(CAST(event_json AS BLOB)) AS bytes FROM ' + p.from), edges.flatMap(p => p.bindings)));
    if (fits(edgeWork)) throw new UsageVisibilityError('unavailable', 'migration');
  }
  return done(viaCells ?? raw);
}
function groupPage(sql: ReportSql, x: UsageShardInput, q: UsageReportQuery, work: UsageCandidateSize): UsageGroupPage {
  const group = x.query.groupBy, folded = work.plan === 'cells' ? usableCells(sql)?.folded : undefined;
  if (work.plan === 'cells' && folded === undefined) throw new UsageVisibilityError('unavailable', 'migration');
  const owner = group === 'key' ? 'principal_key' : 'NULL', value = { model:'model',provider:'provider',key:'key_id',user:'principal_key' }[group];
  const after = x.after, keyset = after ? " WHERE ((owner IS NOT NULL), COALESCE(owner,'') COLLATE BINARY, (value IS NOT NULL), COALESCE(value,'') COLLATE BINARY) > (?, ?, ?, ?)" : '';
  const positions = after ? [Number(after.owner !== null),after.owner ?? '',Number(after.value !== null),after.value ?? ''] : [];
  const buckets = completeUsageBuckets(x.query);
  const bucket = x.query.grain === 'minute' ? 'CAST(occurred_at_ms / 60000 AS INTEGER) - ' + Math.floor(q.range.from / 60000)
    : 'CASE ' + buckets.map((b,i) => 'WHEN occurred_at_ms >= ' + b.start + ' AND occurred_at_ms < ' + b.end + ' THEN ' + i).join(' ') + ' ELSE -1 END';
  const counters = (alias: string) => reportCounters.map(([name]) => alias + '"' + name + '"').join(', ');
  const fromRows = (table: string) => 'SELECT principal_key, key_id, model, provider, lane, cost_class, ' + bucket + ' AS bucket, ' + reportCounters.map(([name, expression]) => expression + ' AS "' + name + '"').join(', ') + ' FROM ' + table;
  let weighted: string, bindings: Array<string | number | null>;
  if (folded !== undefined) {
    // Every term is a nonnegative sum of rows visible at the cut: folded cells, unfolded tail, edges.
    const parts = cellParts(q, cellLayout(x, q), folded), filters = reportFilters(q), cellFilter = cellFilters(q);
    weighted = parts.blocks + ', ' + twinCte(parts.raw.map(p => 'SELECT ' + twinOwnedColumns() + ' FROM ' + p.from + p.where + visibilityWhere(x.cut, 'usage_events')).join(' UNION ALL ')) +
      ', weighted AS (' + fromRows('source WHERE ' + filters.where) + ' UNION ALL SELECT ' + ['principal_key', 'key_id', 'model', 'provider', 'lane', 'cost_class'].map(d => cellDim(d, 'c.')).join(', ') + ', b.bucket, ' + counters('c.') + ' FROM ' + parts.cells + ' WHERE ' + cellFilter.where + ')';
    bindings = [...parts.raw.flatMap(p => p.scoped ? [...p.bindings, ...parts.scope] : p.bindings), ...filters.bindings, ...parts.scope, ...cellFilter.bindings];
  } else {
    const source = sourceCte(q, x.cut!);
    weighted = source.cte + ', weighted AS (' + fromRows('filtered') + ')'; bindings = source.bindings;
  }
  const totals = reportCounters.map(([name]) => 'TOTAL("' + name + '") AS "' + name + '"').join(', ');
  const cursor = sql.exec('WITH ' + weighted + ', compact AS MATERIALIZED (SELECT ' + owner + ' AS owner, ' + value + ' AS value, lane, cost_class, bucket, ' + totals + ' FROM weighted GROUP BY 1, 2, 3, 4, 5), '
    + 'selected AS MATERIALIZED (SELECT DISTINCT owner,value FROM compact' + keyset + ' ORDER BY ' + identityOrder + ' LIMIT 257), '
    + "expanded AS (SELECT 'group' AS dimension, c.owner AS owner, c.value AS value, c.lane AS lane, c.cost_class AS cost_class, " + counters('c.') + ' FROM compact c JOIN selected s ON c.owner IS s.owner AND c.value IS s.value'
    + (after ? '' : " UNION ALL SELECT 'total', NULL, NULL, lane, cost_class, " + counters('') + " FROM compact UNION ALL SELECT 'bucket', NULL, bucket, lane, cost_class, " + counters('') + ' FROM compact') + ') '
    + 'SELECT dimension, owner, value, lane, cost_class AS costClass, ' + totals + ' FROM expanded GROUP BY dimension, owner, value, lane, cost_class ORDER BY dimension, ' + identityOrder + ', lane, cost_class', ...bindings, ...positions) as unknown as Iterable<CompleteAggregateRow>;
  // TOTAL of nonnegative integers is exact while the result is <= MAX_SAFE_INTEGER; exact() rejects the rest.
  const rows: CompleteAggregateRow[] = []; let bytes = 128;
  for (const row of cursor) {
    for (const key of [...usageMetricKeys,'amountMicros','recordedChargeMicros','chargeReportedCalls'] as const) exact(row[key]);
    bytes += usageJsonBytes(row) + 1; if (bytes > completeUsageLimits.pageBytes) capacity(); rows.push(row);
  }
  const identities: UsageGroupIdentity[] = [];
  for (const row of rows) if (row.dimension === 'group') {
    const identity = { owner: row.owner, value: row.value as string | null };
    if (!identities.length || !sameIdentity(identities.at(-1)!,identity)) identities.push(identity);
  }
  const more = identities.length > completeUsageLimits.groupPage, last = more ? identities[255] : null;
  return { rows: more ? rows.filter(r => r.dimension !== 'group' || !sameIdentity({owner:r.owner,value:r.value as string | null},identities[256])) : rows, next:last, work };
}
const detailKeys = ['id','occurredAt','provider','model','keyId','capability','callKind','status','statusCode','durationMs','inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','lane','costClass','reportingCostMicros','estimateReason','recordedChargeMicros','costBasis','pricingRef','requestedTier','servedTier','compoundRequestId','compoundStage'] as const;
// Walk the owner/time index in order. Count candidates *before* visibility
// and exact filters, and check lengths before asking SQLite to classify JSON.
// A full matching lookahead or exhaustion proves the answer; a budget limit
// never masquerades as end-of-history.
function seekEventPage(sql: ReportSql, x: UsageShardInput, q: UsageReportQuery, allowance: UsageCandidateSize) {
  const cut=x.cut!, n=sourceNames(q,cut), filters=reportFilters(q), filtered=filters.where!=='1';
  const needed=x.limit!+1, page: Record<string, unknown>[]=[];
  const work: UsageCandidateSize={plan:'events',rows:0,bytes:0};
  let before=x.before, inclusive=x.includeEqualId;
  while(page.length<needed){
    // Use just one upper bound so SQLite seeks the entire tuple even when
    // many events share a timestamp. Both cut bounds still apply.
    const anchored=before && before.at<q.range.to ? before : undefined;
    const seek=anchored?'(occurred_at_ms,id) '+(inclusive?'<=':'<')+' (?,?)':'occurred_at_ms < ?';
    const projected=cut.source==='projection';
    const scope=(projected?'tenant_id = ? AND ':'')+'policy_id = ?'+(q.principal===undefined?'':' AND principal_key = ?');
    const bounds=[...(projected?[q.tenantId]:[]),q.policyId,...(q.principal===undefined?[]:[q.principal]),q.range.from,...(anchored?[anchored.at,anchored.id]:[q.range.to])];
    const count=Math.min(filtered?512:needed-page.length, allowance.rows-work.rows+1);
    const batch=[...sql.exec('SELECT id,occurred_at_ms,principal_key,provider,status,length(CAST('+n.detail+' AS BLOB)) AS bytes, (tenant_id = ?'+visibilityWhere(cut,n.table)+') AS visible FROM '+n.table+' INDEXED BY '+n.index+' WHERE '+scope+' AND occurred_at_ms >= ? AND '+seek+' ORDER BY occurred_at_ms DESC,id DESC LIMIT ?', q.tenantId,...bounds,count)];
    work.rows+=batch.length;
    for(const row of batch){exact(row.bytes);work.bytes+=row.bytes;}
    if(work.rows>allowance.rows||work.bytes>allowance.bytes)capacity();
    let visible=batch.filter(r=>r.visible===1);
    if(filtered && visible.length){
      const byId=' FROM '+n.table+' WHERE id IN (SELECT value FROM json_each(?))';
      const match=cut.source==='projection'?'SELECT id'+byId+' AND '+filters.where
        :'WITH '+twinCte('SELECT '+twinOwnedColumns()+byId)+' SELECT id FROM source WHERE '+filters.where;
      const ids=new Set([...sql.exec(match,JSON.stringify(visible.map(r=>r.id)),...filters.bindings)].map(r=>r.id));
      visible=visible.filter(r=>ids.has(r.id));
    }
    page.push(...visible.slice(0,needed-page.length));
    if(batch.length<count)break;
    const last=batch.at(-1)!;before={at:Number(last.occurred_at_ms),id:String(last.id)};inclusive=false;
  }
  return {page,work};
}
function materializeEvents(sql: ReportSql,x: UsageShardInput,q: UsageReportQuery,work: UsageCandidateSize,page: Record<string, unknown>[]) {
  const n=sourceNames(q,x.cut!);
  let bytes = 0;
  for (const row of page) { exact(row.bytes); bytes += row.bytes; if (bytes > completeUsageLimits.pageBytes) capacity(); }
  const events = page.slice(0,x.limit).map(row => {
    const raw = JSON.parse(String([...sql.exec('SELECT ' + n.detail + ' AS detail FROM ' + n.table + ' WHERE id = ?',String(row.id))][0].detail));
    const detail = x.cut!.source === 'projection' ? raw as PersonalUsageEvent : projectUsageEvent(raw as UsageEvent);
    if (detail.id !== row.id || detail.occurredAt !== row.occurred_at_ms || detail.provider !== row.provider || detail.status !== row.status) invalidSource();
    const numeric = ['statusCode','durationMs','inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','reportingCostMicros','recordedChargeMicros'] as const;
    for (const key of numeric) if (detail[key] !== null) exact(detail[key]);
    for (const key of detailKeys) if (key !== 'occurredAt' && !(numeric as readonly string[]).includes(key)) {
      const value = detail[key]; if (value !== null && value !== undefined && typeof value !== 'string') invalidSource();
    }
    if (!['generation','utility'].includes(detail.callKind) || !['api','subscription','unattributed'].includes(detail.lane)
      || !['calculated','fixed','estimated','upper_bound','partial','unknown','no_charge'].includes(detail.costClass)
      || (detail.costClass === 'unknown') !== (detail.reportingCostMicros === null)) invalidSource();
    return { ...Object.fromEntries(detailKeys.map(key => [key,detail[key] ?? null])), user: row.principal_key } as CompleteUsageEvent;
  });
  return { events, hasMore: page.length > x.limit!, work };
}
/** Called exactly once INSIDE storage.transactionSync by the ledger dispatcher.
 * Expected refusals are values, so bounded maintenance/disabled-drain progress
 * commits even when this read cannot yet capture. Genuine SQL failures roll back. */
export function dispatchCompleteUsageShard(sql: ReportSql, input: unknown, now = Date.now()): UsageShardResult {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || usageJsonBytes(input) > completeUsageLimits.pageBytes) invalidSource();
    const x = input as UsageShardInput;
    if (Object.keys(x).some(k => !['action','tenantId','policyId','query','cut','after','before','includeEqualId','limit','allowance'].includes(k)) || !['capture','preflight','groups','events','validate'].includes(x.action)) invalidSource();
    boundedText(x.tenantId,2048); boundedText(x.policyId,2048); validateCompleteUsageQuery(x.query);
    maintainUsageVisibility(sql,now);
    // Report capture/preflight opt into plan negotiation; anything else keeps the legacy measure.
    const negotiate = x.allowance !== undefined && 'plan' in x.allowance && x.allowance.plan === 'report';
    if (negotiate && !['capture','preflight'].includes(x.action)) invalidSource();
    if (x.action === 'capture') {
      const cut = openUsageReportCut(sql,x.query.from,now);
      const at = {...x,query:{...x.query,from:Math.min(x.query.to,cut.floor)}}, q = shardQuery(at);
      return { kind:'complete',value:{cut,work:negotiate ? measureReport(sql,at,q,cut) : candidateSize(sql,q,cut)} };
    }
    if (!x.cut) invalidSource();
    validateUsageVisibility(sql,x.cut,x.query.from,now); reportHistory(sql,x.cut);
    if (x.action === 'validate') return { kind:'complete',value:{valid:true} };
    if (x.after) { for (const key of ['owner','value'] as const) if (x.after[key] !== null) boundedText(x.after[key],8192); }
    if (x.before) { exact(x.before.at); boundedText(x.before.id,8192); }
    if (x.includeEqualId !== undefined && typeof x.includeEqualId !== 'boolean') invalidSource();
    if ((x.action === 'events' || x.action === 'preflight' && x.limit !== undefined) && (!Number.isInteger(x.limit) || x.limit! < 1 || x.limit! > 100)) invalidSource();
    const q = shardQuery(x);
    const eventMax={rows:completeUsageLimits.candidateRows,bytes:completeUsageLimits.inputBytes};
    if(x.action==='preflight' && x.limit!==undefined){
      const max=x.allowance??eventMax;exact(max.rows);exact(max.bytes);
      return {kind:'complete',value:seekEventPage(sql,x,q,{rows:Math.min(max.rows,eventMax.rows),bytes:Math.min(max.bytes,eventMax.bytes)}).work};
    }
    if (x.action === 'preflight') return {kind:'complete',value:negotiate ? measureReport(sql,x,q,x.cut) : candidateSize(sql,q,x.cut)};
    const allowance = x.allowance as UsageCandidateSize | undefined;
    if (!allowance) invalidSource(); exact(allowance.rows); exact(allowance.bytes);
    if (allowance.plan !== undefined && !(allowance.plan==='events' && x.action==='events') && !(x.action==='groups' && ['cells','raw'].includes(allowance.plan))) invalidSource();
    if (allowance.cellRows !== undefined) exact(allowance.cellRows);
    if (!fits(allowance)) capacity();
    const selected = x.action === 'events' ? seekEventPage(sql,x,q,allowance) : undefined;
    const work = allowance.plan === 'events' ? selected!.work : allowance.plan === 'raw' || allowance.plan === 'cells' ? measurePlan(sql,x,q,x.cut,allowance.plan) : candidateSize(sql,q,x.cut);
    if (work.rows > allowance.rows || work.bytes > allowance.bytes || (work.cellRows ?? 0) > (allowance.cellRows ?? 0) || !fits(work)) capacity();
    const result = selected ? materializeEvents(sql,x,q,work,selected.page) : groupPage(sql,x,q,work);
    // Same transaction; requalification also covers empty pages and empty shards.
    validateUsageVisibility(sql,x.cut,x.query.from,now); reportHistory(sql,x.cut);
    if (usageJsonBytes(result) > completeUsageLimits.pageBytes - 128) capacity();
    return {kind:'complete',value:result};
  } catch (error) {
    if (error instanceof UsageVisibilityError) return {kind:error.kind,reason:error.reason};
    throw error;
  }
}
