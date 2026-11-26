import type { ReportSql } from "./usage-report-store.ts";
import { reportCounters, twinCte, twinOwnedColumns } from "./usage-report-twin.ts";
import { observeUsageClock } from "./usage-report-visibility.ts";
import { reportCutTtlMs, reportRetentionMs } from "./usage-report-range.ts";
import { reportCellSlotMs } from "./usage-report-protocol.ts";

// Derived, optional quarter-hour aggregates of the retained-ledger SQL twin. Only the alarm
// writes cells; canonical writers (current or rollback) only clear `healthy` through triggers.
// Cells hold rows with rowid <= folded_rowid; reads add the unfolded tail and range edges raw.
const cellSlotMs = reportCellSlotMs;
const cellFoldBatch = 2_000;
const storageCeiling = 8 * 1024 ** 3;
const dims = ["principal_key", "key_id", "model", "provider", "status", "lane", "cost_class"] as const;
const nullable = new Set<string>(["principal_key", "key_id", "model"]);
const key = "tenant_id, policy_id, slot_ms, " + dims.join(", ");
// Nullable dimensions are stored as x'' (a BLOB never equals TEXT) so NULL keeps a unique key.
const storedDim = (d: string) => nullable.has(d) ? "COALESCE(" + d + ", x'')" : d;
export const cellDim = (d: string, alias = "") => nullable.has(d) ? "NULLIF(" + alias + d + ", x'')" : alias + d;
const table = "CREATE TABLE usage_report_cells (tenant_id TEXT NOT NULL, policy_id TEXT NOT NULL, slot_ms INTEGER NOT NULL, " +
  dims.map(d => d + " NOT NULL").join(", ") + ", " + reportCounters.map(([name]) => '"' + name + '" INTEGER NOT NULL').join(", ") + ", PRIMARY KEY (" + key + ")) WITHOUT ROWID";
const index = "CREATE INDEX usage_report_cells_owner ON usage_report_cells (tenant_id, policy_id, principal_key, slot_ms)";
const state = (column: string) => "(SELECT " + column + " FROM usage_report_cell_state WHERE id = 1)";
const unhealthy = " BEGIN UPDATE usage_report_cell_state SET healthy = 0 WHERE id = 1; END";
const triggers: Record<string, string> = {
  // T never decreases, so a reused rowid at or below any folded/targeted row is always caught.
  usage_report_cells_insert_v1: "AFTER INSERT ON usage_events WHEN NEW.rowid <= " + state("target_rowid") + unhealthy,
  usage_report_cells_update_v1: "AFTER UPDATE ON usage_events WHEN OLD.rowid <= " + state("target_rowid") + " OR NEW.rowid <= " + state("target_rowid") + unhealthy,
  // Retention deletes sit below every cut floor and are pruned by the alarm, not the writer.
  usage_report_cells_delete_v1: "AFTER DELETE ON usage_events WHEN OLD.rowid <= " + state("folded_rowid") +
    " AND NOT COALESCE(OLD.occurred_at_ms < (SELECT retention_marker FROM usage_report_visibility WHERE id = 1), 0)" + unhealthy,
};
const fold = "WITH " + twinCte("SELECT " + twinOwnedColumns() + " FROM usage_events WHERE rowid > ? AND rowid <= ? AND occurred_at_ms >= ?") +
  " INSERT INTO usage_report_cells (" + key + ", " + reportCounters.map(([name]) => '"' + name + '"').join(", ") + ") SELECT tenant_id, policy_id, occurred_at_ms - occurred_at_ms % " + cellSlotMs + ", " +
  dims.map(storedDim).join(", ") + ", " + reportCounters.map(([, expression]) => expression).join(", ") +
  " FROM source WHERE true ON CONFLICT (" + key + ") DO UPDATE SET " + reportCounters.map(([name]) => '"' + name + '" = "' + name + '" + excluded."' + name + '"').join(", ");
const definition = JSON.stringify([table, index, triggers, fold]);
const definitions = Object.entries(triggers).map(([name, body]) => ({ name, sql: "CREATE TRIGGER " + name + " " + body }));
const objects = [{ name: "usage_report_cells", sql: table }, { name: "usage_report_cells_owner", sql: index }, ...definitions];

interface CellState { folded_rowid: number; target_rowid: number; target_at: number; healthy: number; definition: string }
function read(sql: ReportSql): CellState | undefined { return [...sql.exec("SELECT * FROM usage_report_cell_state WHERE id = 1")][0] as unknown as CellState | undefined; }
function current(sql: ReportSql, value = read(sql)): value is CellState {
  return value?.healthy === 1 && value.definition === definition && objects.every(o => [...sql.exec("SELECT sql FROM sqlite_master WHERE name = ?", o.name)][0]?.sql === o.sql);
}
/** Caller owns the transaction. Missing, stale, or unhealthy cells are dropped and refolded from rowid 0. */
export function ensureUsageReportCells(sql: ReportSql): void {
  sql.exec("CREATE TABLE IF NOT EXISTS usage_report_cell_state (id INTEGER PRIMARY KEY CHECK (id = 1), folded_rowid INTEGER NOT NULL, target_rowid INTEGER NOT NULL, target_at INTEGER NOT NULL, healthy INTEGER NOT NULL, definition TEXT NOT NULL)");
  if (current(sql)) return;
  for (const d of definitions) sql.exec("DROP TRIGGER IF EXISTS " + d.name);
  sql.exec("DROP TABLE IF EXISTS usage_report_cells");
  sql.exec(table); sql.exec(index);
  sql.exec("INSERT OR REPLACE INTO usage_report_cell_state VALUES (1, 0, 0, 0, 1, ?)", definition);
  for (const d of definitions) sql.exec(d.sql);
}
/** Cells usable for a read in this transaction (folded rowid bound; `folding`: a target is still being folded), or null. */
export function usableCells(sql: ReportSql): { folded: number; folding: boolean } | null {
  const value = read(sql);
  return current(sql, value) && value.folded_rowid > 0 ? { folded: value.folded_rowid, folding: value.folded_rowid < value.target_rowid } : null;
}
/**
 * One bounded alarm step; caller owns the transaction. Folds rows <= T only once T is a full cut
 * TTL old on the persisted shard clock: every cut still valid was created after T was chosen, so
 * every folded row predates it. Returns when the next step is due (null: nothing pending).
 */
export function maintainUsageReportCells(sql: ReportSql, now: number): number | null {
  ensureUsageReportCells(sql);
  const clock = observeUsageClock(sql, now), cutoff = clock - reportRetentionMs;
  if (cellsPaused(sql)) {
    const databaseSize = sql.databaseSize;
    // Derived state yields to canonical writes; refold starts from 0 once storage allows.
    if ([...sql.exec("SELECT 1 FROM usage_report_cells LIMIT 1")].length || read(sql)!.folded_rowid) {
      sql.exec("DELETE FROM usage_report_cells"); sql.exec("UPDATE usage_report_cell_state SET folded_rowid = 0, target_rowid = 0, target_at = 0 WHERE id = 1");
    }
    console.log(JSON.stringify({ event: "usage_report_cells_paused", databaseSize }));
    return null;
  }
  const s = read(sql)!;
  if (s.folded_rowid >= s.target_rowid) {
    const max = Number([...sql.exec("SELECT COALESCE(MAX(rowid), 0) AS max FROM usage_events")][0].max);
    if (max <= s.target_rowid) return null;
    // Whole slots older than retention are never read (every cut floor is at or above it).
    sql.exec("DELETE FROM usage_report_cells WHERE slot_ms <= ?", cutoff - cellSlotMs);
    sql.exec("UPDATE usage_report_cell_state SET target_rowid = MAX(target_rowid, ?), target_at = ? WHERE id = 1", max, clock);
    return clock + reportCutTtlMs;
  }
  if (clock < s.target_at + reportCutTtlMs) return s.target_at + reportCutTtlMs;
  const page = [...sql.exec("SELECT MAX(rowid) AS last, COUNT(*) AS n FROM (SELECT rowid FROM usage_events WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?)", s.folded_rowid, s.target_rowid, cellFoldBatch)][0];
  const upto = Number(page.n) < cellFoldBatch ? s.target_rowid : Number(page.last);
  sql.exec(fold, s.folded_rowid, upto, cutoff);
  sql.exec("UPDATE usage_report_cell_state SET folded_rowid = ? WHERE id = 1", upto);
  return now; // Next batch, or choose the next target.
}
export const cellsPaused = (sql: ReportSql) => (sql.databaseSize ?? 0) >= storageCeiling;
/** Next fold step time for alarm scheduling from the ingest path (no writes). */
export function usageReportCellsDue(sql: ReportSql, latestRowid: number): number | null {
  const s = read(sql);
  // A paused shard cannot fold; leave it on the ordinary maintenance cadence.
  if (!s || cellsPaused(sql)) return null;
  if (s.folded_rowid < s.target_rowid) return s.target_at + reportCutTtlMs;
  return latestRowid > s.target_rowid ? 0 : null;
}
