import type { UsageEventScope } from "./ledgers.ts";
import { normalizeEmail } from "./utils.ts";

interface RollupSql { exec(query: string, ...bindings: Array<string | number | null>): Iterable<Record<string, unknown>> }
export interface UsageRollupProgress { last_rowid: number; upper_rowid: number; complete: number }
export const usageRollupBatchSize = 2_000;
export const usageRollupAlarmMs = 500;
const keys = ["policy_id", "day_start_ms", "provider", "principal_key", "credential_key", "principal_nontext"];
const counters = ["request_count", "success_count", "error_count", "total_tokens", "actual_cost_micros", "unpriced_request_count", "input_tokens", "output_tokens"];
export const rollupSummaryColumns = counters.map(name => `COALESCE(SUM(${name}), 0) AS ${name}`).join(", ");
export const rollupTotalColumns = counters.slice(0, 6).map(name => `COALESCE(SUM(${name}), 0) AS ${name}`).join(", ");

// JSON quoting distinguishes missing principals/credentials from empty strings.
// Unvisited pre-attribution rows need raw aliases: SQLite cannot implement the
// authority's Unicode email normalization. Rollback writers retain #337's columns.
const attributionPending = (prefix: string) => `EXISTS (SELECT 1 FROM usage_attribution_migration WHERE id = 1 AND complete = 0 AND ${prefix}rowid > last_rowid AND ${prefix}rowid <= upper_rowid)`;
function keyValues(prefix = "") {
  const c = (name: string) => prefix + name;
  const pending = attributionPending(prefix);
  const principal = `COALESCE(${c("principal_key")}, ${c("principal_id")}, CASE WHEN ${pending} AND json_type(${c("event_json")}, '$.principal_id') = 'text' THEN json_extract(${c("event_json")}, '$.principal_id') END)`;
  const credential = `COALESCE(${c("credential_id")}, CASE WHEN ${pending} AND json_type(${c("event_json")}, '$.credential_id') = 'text' THEN json_extract(${c("event_json")}, '$.credential_id') END)`;
  return [c("policy_id"), `CAST(${c("occurred_at_ms")} / 86400000 AS INTEGER) * 86400000`, c("provider"), `json_quote(${principal})`, `json_quote(${credential})`,
    `CASE WHEN ${pending} THEN CASE WHEN json_type(${c("event_json")}, '$.principal_id') NOT IN ('text', 'null') THEN 1 ELSE 0 END ELSE ${c("principal_nontext")} END`];
}
function counterValues(prefix = "") {
  const c = (name: string) => prefix + name;
  return ["1", `CASE WHEN ${c("status")} = 'success' THEN 1 ELSE 0 END`, `CASE WHEN ${c("status")} != 'success' THEN 1 ELSE 0 END`, `COALESCE(${c("total_tokens")}, 0)`, `COALESCE(${c("actual_cost_micros")}, 0)`,
    `CASE WHEN (CASE WHEN ${attributionPending(prefix)} THEN json_extract(${c("event_json")}, '$.cost_basis') ELSE ${c("cost_basis")} END) = 'unpriced_usage' THEN 1 ELSE 0 END`, `COALESCE(${c("input_tokens")}, 0)`, `COALESCE(${c("output_tokens")}, 0)`];
}
const addConflict = ` ON CONFLICT (${keys.join(", ")}) DO UPDATE SET ` + counters.map(name => `${name} = ${name} + excluded.${name}`).join(", ");
const counted = (row: string) => `EXISTS (SELECT 1 FROM usage_rollup_migration WHERE id = 1 AND (complete = 1 OR ${row}.rowid <= last_rowid OR ${row}.rowid > upper_rowid))`;
const insert = (row: string) => `INSERT INTO usage_rollups (${[...keys, ...counters].join(", ")}) SELECT ${[...keyValues(row + "."), ...counterValues(row + ".")].join(", ")} WHERE ${counted(row)}${addConflict};`;
function remove(row: string) {
  const where = keyValues(row + ".").map((value, i) => `${keys[i]} = ${value}`).join(" AND ");
  return `UPDATE usage_rollups SET ${counterValues(row + ".").map((value, i) => `${counters[i]} = ${counters[i]} - (${value})`).join(", ")} WHERE ${where} AND ${counted(row)}; DELETE FROM usage_rollups WHERE ${where} AND request_count = 0;`;
}

/** Caller owns the transaction: trigger installation and the initial upper bound are atomic. */
export function ensureUsageRollups(sql: RollupSql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS usage_rollups (policy_id TEXT NOT NULL, day_start_ms INTEGER NOT NULL, provider TEXT NOT NULL, principal_key TEXT NOT NULL, credential_key TEXT NOT NULL, principal_nontext INTEGER NOT NULL, ${counters.map(name => `${name} INTEGER NOT NULL`).join(", ")}, PRIMARY KEY (${keys.join(", ")})) WITHOUT ROWID`);
  sql.exec("CREATE TABLE IF NOT EXISTS usage_rollup_migration (id INTEGER PRIMARY KEY CHECK (id = 1), last_rowid INTEGER NOT NULL, upper_rowid INTEGER NOT NULL, complete INTEGER NOT NULL)");
  if (![...sql.exec("SELECT id FROM usage_rollup_migration WHERE id = 1")].length) sql.exec("INSERT INTO usage_rollup_migration SELECT 1, 0, COALESCE(MAX(rowid), 0), CASE WHEN MAX(rowid) IS NULL THEN 1 ELSE 0 END FROM usage_events");
  sql.exec(`CREATE TRIGGER IF NOT EXISTS usage_rollup_insert AFTER INSERT ON usage_events BEGIN ${insert("NEW")} END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS usage_rollup_delete AFTER DELETE ON usage_events BEGIN ${remove("OLD")} END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS usage_rollup_update AFTER UPDATE ON usage_events BEGIN ${remove("OLD")} ${insert("NEW")} END`);
}
export function usageRollupProgress(sql: RollupSql): UsageRollupProgress {
  return [...sql.exec("SELECT last_rowid, upper_rowid, complete FROM usage_rollup_migration WHERE id = 1")][0] as unknown as UsageRollupProgress;
}

/** At most one bounded batch. Cursor and additions must commit together. */
export function backfillUsageRollups(sql: RollupSql, transaction: (fn: () => void) => void): void {
  transaction(() => {
    const progress = usageRollupProgress(sql);
    if (progress.complete) return;
    const page = [...sql.exec("SELECT MAX(rowid) AS last, COUNT(*) AS count FROM (SELECT rowid FROM usage_events WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?)", progress.last_rowid, progress.upper_rowid, usageRollupBatchSize)][0];
    const last = Number(page.last ?? progress.upper_rowid);
    const covered = Number(page.count) < usageRollupBatchSize || last === progress.upper_rowid;
    // Keep the fallback until owner-event indexes are ready too. Otherwise a
    // "complete" personal snapshot would still scan JSON to discover aliases.
    const complete = covered && [...sql.exec("SELECT complete FROM usage_attribution_migration WHERE id = 1")][0].complete === 1;
    if (page.count) sql.exec(`INSERT INTO usage_rollups (${[...keys, ...counters].join(", ")}) SELECT ${[...keyValues("event."), ...counterValues("event.").map(value => `SUM(${value})`)].join(", ")} FROM usage_events AS event WHERE event.rowid > ? AND event.rowid <= ? GROUP BY ${keys.map((_, i) => i + 1).join(", ")}${addConflict}`, progress.last_rowid, last);
    sql.exec("UPDATE usage_rollup_migration SET last_rowid = ?, complete = ? WHERE id = 1", last, complete ? 1 : 0);
  });
}

export function rollupOwnerCondition(sql: RollupSql, scope: UsageEventScope) {
  if (scope.kind === "admin") return null;
  if (scope.kind === "credential") return { where: "principal_key = 'null' AND principal_nontext = 0 AND credential_key = ?", params: [JSON.stringify(scope.id)] };
  const principal = normalizeEmail(scope.id);
  if (!principal) return { where: "0", params: [] };
  // Normally one normalized key; rollback-era aliases are bounded by rollup keys,
  // never by the number/size of retained events.
  const aliases = [...sql.exec("SELECT DISTINCT principal_key FROM usage_rollups")].map(row => String(row.principal_key)).filter(key => {
    const value = JSON.parse(key);
    return typeof value === "string" && normalizeEmail(value) === principal;
  });
  return aliases.length ? { where: "principal_key IN (SELECT value FROM json_each(?))", params: [JSON.stringify(aliases)] } : { where: "0", params: [] };
}
