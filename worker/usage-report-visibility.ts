import type { ReportSql } from './usage-report-store.ts';
import { reportCutTtlMs, reportRetentionMs } from './usage-report-range.ts';

// Private shard metadata; never a public token or shared result contract.
export interface UsageVisibilityCut { seq: number; epoch: string; createdAt: number; expiresAt: number; floor: number; source: 'projection' | 'retained_ledger'; normalizer: 2 }
export class UsageVisibilityError extends Error {
  kind: 'restart' | 'unavailable';
  reason: 'mutation' | 'source' | 'expired' | 'capacity' | 'migration';
  constructor(kind: UsageVisibilityError['kind'], reason: UsageVisibilityError['reason']) { super('usage visibility ' + reason); this.kind = kind; this.reason = reason; }
}
const maximum = 9007199254740991, rowCap = 100_000, byteCap = 16 * 1024 * 1024;
const idBytes = 'length(CAST(NEW.id AS BLOB))';
const fits = "typeof(seq) = 'integer' AND seq >= 0 AND seq < " + maximum +
  " AND typeof(arrival_rows) = 'integer' AND typeof(arrival_bytes) = 'integer' AND arrival_rows BETWEEN 0 AND " + (rowCap - 1) + ' AND arrival_bytes BETWEEN 0 AND ' + byteCap +
  ' AND ' + idBytes + ' <= ' + byteCap + ' - arrival_bytes' +
  ' AND NOT EXISTS (SELECT 1 FROM usage_report_arrivals WHERE id = NEW.id OR seq = usage_report_visibility.seq + 1)';
const bump = 'epoch = lower(hex(randomblob(16)))';
const triggers: Record<string, string> = {
  usage_visibility_insert_v1: 'AFTER INSERT ON usage_events BEGIN ' +
    'UPDATE usage_report_visibility SET usable = 0, ' + bump + ' WHERE id = 1 AND usable = 1 AND NOT COALESCE((' + fits + '), 0); ' +
    'INSERT INTO usage_report_arrivals (seq, id) SELECT seq + 1, NEW.id FROM usage_report_visibility WHERE id = 1 AND usable = 1 AND (' + fits + '); ' +
    'UPDATE usage_report_visibility SET seq = seq + 1, arrival_rows = arrival_rows + 1, arrival_bytes = arrival_bytes + ' + idBytes + ' WHERE id = 1 AND usable = 1 AND EXISTS (SELECT 1 FROM usage_report_arrivals WHERE id = NEW.id AND seq = usage_report_visibility.seq + 1); END',
  usage_visibility_update_v1: 'AFTER UPDATE ON usage_events BEGIN UPDATE usage_report_visibility SET ' + bump + ' WHERE id = 1; END',
  usage_visibility_delete_v1: 'AFTER DELETE ON usage_events BEGIN ' +
    'UPDATE usage_report_visibility SET ' + bump + ' WHERE id = 1 AND (retention_marker IS NULL OR OLD.occurred_at_ms >= retention_marker); ' +
    'UPDATE usage_report_visibility SET arrival_rows = MAX(0, arrival_rows - 1), arrival_bytes = MAX(0, arrival_bytes - length(CAST(OLD.id AS BLOB))) WHERE id = 1 AND EXISTS (SELECT 1 FROM usage_report_arrivals WHERE id = OLD.id); ' +
    'DELETE FROM usage_report_arrivals WHERE id = OLD.id; END',
};
const definitions = Object.entries(triggers).map(([name, body]) => ({ name, sql: 'CREATE TRIGGER ' + name + ' ' + body }));
function manifestMatches(sql: ReportSql): boolean {
  return definitions.every(def => [...sql.exec("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", def.name)][0]?.sql === def.sql);
}
interface VisibilityState { seq: number; epoch: string; observed_clock: number; retention_cutoff: number; checkpoint_seq: number; checkpoint_at: number; usable: number; version: number }
function state(sql: ReportSql): VisibilityState {
  return [...sql.exec('SELECT * FROM usage_report_visibility WHERE id = 1')][0] as unknown as VisibilityState;
}
/** Called in the ledger schema transaction. Missing/mismatched trigger continuity
 * invalidates all old cuts, then bounded maintenance drains before reopening. */
export function ensureUsageVisibility(sql: ReportSql): void {
  sql.exec('CREATE TABLE IF NOT EXISTS usage_report_visibility (id INTEGER PRIMARY KEY, seq INTEGER, epoch TEXT, observed_clock INTEGER, retention_cutoff INTEGER, retention_marker INTEGER, checkpoint_seq INTEGER, checkpoint_at INTEGER, arrival_rows INTEGER, arrival_bytes INTEGER, usable INTEGER, version INTEGER)');
  sql.exec('CREATE TABLE IF NOT EXISTS usage_report_arrivals (seq INTEGER PRIMARY KEY, id TEXT UNIQUE)');
  const existing = state(sql);
  if (!existing) sql.exec('INSERT INTO usage_report_visibility VALUES (1, 0, lower(hex(randomblob(16))), 0, 0, NULL, 0, 0, 0, 0, 1, 1)');
  if (!manifestMatches(sql)) {
    if (existing) sql.exec('UPDATE usage_report_visibility SET usable = 0, ' + bump + ' WHERE id = 1');
    for (const def of definitions) { sql.exec('DROP TRIGGER IF EXISTS ' + def.name); sql.exec(def.sql); }
  }
}
function observe(sql: ReportSql, now: number): VisibilityState {
  if (!Number.isSafeInteger(now) || now < 0 || now > maximum - reportCutTtlMs) throw new UsageVisibilityError('unavailable', 'source');
  sql.exec('UPDATE usage_report_visibility SET observed_clock = MAX(observed_clock, ?) WHERE id = 1', now);
  const value = state(sql);
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.observed_clock)) throw new UsageVisibilityError('unavailable', 'source');
  return value;
}
/** At most 1000 indexed metadata deletes; never a canonical scan or ingest loop.
 * The caller owns the synchronous transaction, including any following read. */
export function maintainUsageVisibility(sql: ReportSql, now = Date.now()): void {
  const s = observe(sql, now);
  if (s.usable === 1 && s.observed_clock < s.checkpoint_at + reportCutTtlMs) return;
  const batch = [...sql.exec('SELECT seq, length(CAST(id AS BLOB)) AS bytes FROM usage_report_arrivals' + (s.usable === 1 ? ' WHERE seq <= ?' : '') + ' ORDER BY seq LIMIT 1000', ...(s.usable === 1 ? [s.checkpoint_seq] : []))];
  for (const row of batch) sql.exec('DELETE FROM usage_report_arrivals WHERE seq = ?', Number(row.seq));
  sql.exec('UPDATE usage_report_visibility SET arrival_rows = MAX(0, arrival_rows - ?), arrival_bytes = MAX(0, arrival_bytes - ?) WHERE id = 1', batch.length, batch.reduce((sum, row) => sum + Number(row.bytes), 0));
  if (s.usable !== 1) {
    if (![...sql.exec('SELECT 1 FROM usage_report_arrivals LIMIT 1')].length) sql.exec('UPDATE usage_report_visibility SET seq = 0, ' + bump + ', checkpoint_seq = 0, checkpoint_at = observed_clock, arrival_rows = 0, arrival_bytes = 0, usable = 1, version = 1 WHERE id = 1');
  } else if (![...sql.exec('SELECT 1 FROM usage_report_arrivals WHERE seq <= ? LIMIT 1', s.checkpoint_seq)].length) {
    sql.exec('UPDATE usage_report_visibility SET checkpoint_seq = seq, checkpoint_at = observed_clock WHERE id = 1');
  }
}
export function captureUsageVisibility(sql: ReportSql, source: UsageVisibilityCut['source'], from: number, now = Date.now()): UsageVisibilityCut {
  if (!manifestMatches(sql)) throw new UsageVisibilityError('unavailable', 'source');
  if ([...sql.exec('SELECT complete FROM usage_attribution_migration WHERE id = 1')][0]?.complete !== 1) throw new UsageVisibilityError('unavailable', 'migration');
  const s = observe(sql, now);
  if (s.usable !== 1) throw new UsageVisibilityError('unavailable', 'capacity');
  if (!Number.isSafeInteger(s.seq) || s.seq < 0) throw new UsageVisibilityError('unavailable', 'source');
  return { seq: s.seq, epoch: s.epoch, createdAt: s.observed_clock, expiresAt: s.observed_clock + reportCutTtlMs,
    floor: Math.max(from, s.retention_cutoff, s.observed_clock - reportRetentionMs + reportCutTtlMs), source, normalizer: 2 };
}
export function validateUsageVisibility(sql: ReportSql, cut: UsageVisibilityCut, floor: number, now = Date.now()): void {
  if (!cut || !Number.isSafeInteger(cut.seq) || cut.seq < 0 || !Number.isSafeInteger(cut.expiresAt) || !Number.isSafeInteger(cut.floor) || !['projection', 'retained_ledger'].includes(cut.source) || !manifestMatches(sql) || cut.normalizer !== 2) throw new UsageVisibilityError('restart', 'source');
  const s = observe(sql, now);
  if ([...sql.exec('SELECT complete FROM usage_attribution_migration WHERE id = 1')][0]?.complete !== 1) throw new UsageVisibilityError('unavailable', 'migration');
  if (s.usable !== 1) throw new UsageVisibilityError('unavailable', 'capacity');
  if (s.epoch !== cut.epoch) throw new UsageVisibilityError('restart', 'mutation');
  if (s.observed_clock >= cut.expiresAt) throw new UsageVisibilityError('restart', 'expired');
  if (floor < cut.floor || s.retention_cutoff > floor || now - reportRetentionMs > floor) throw new UsageVisibilityError('restart', 'mutation');
}
/** Marker exists only around the new writer's retention DELETE in its transaction. */
export function withUsageRetention(sql: ReportSql, cutoff: number, remove: () => void): void {
  sql.exec('UPDATE usage_report_visibility SET retention_marker = ?, retention_cutoff = MAX(retention_cutoff, ?) WHERE id = 1', cutoff, cutoff);
  try { remove(); } finally { sql.exec('UPDATE usage_report_visibility SET retention_marker = NULL WHERE id = 1'); }
}
