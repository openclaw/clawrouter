import type { PersonalUsageEvents, PersonalUsageReport, PersonalUsageEvent, UsageCostSummary, UsageGroupBy, UsageMetrics, UsageReportGroup } from "../shared/usage-report.ts";
import { usageStub } from "./ledgers.ts";
import type { Env } from "./types.ts";
import { HttpError, normalizeEmail } from "./utils.ts";
import { parseUsageReportRange } from "./usage-report-range.ts";
import { emptyUsageMetrics, usageMetricKeys, type UsageAggregateRow, type UsageEventPosition, type UsageReportQuery, type UsageReportShard, type UsageReportMigrationOptions, type UsageReportMigrationEffect, type UsageReportHistory } from "./usage-report-store.ts";

const filterNames = ["model", "provider", "key", "status", "costClass", "lane"] as const;
const classes = new Set(["calculated", "fixed", "estimated", "upper_bound", "partial", "unknown", "no_charge"]);
const lanes = new Set(["api", "subscription", "unattributed"]);
function invalid(message: string): never { throw new HttpError(400, "invalid_usage_query", message); }
export function parseUsageReportQuery(params: URLSearchParams, now = Date.now()) {
  for (const key of params.keys()) if (!["from", "to", "days", "timezone", "groupBy", "cursor", "limit", ...filterNames].includes(key)) invalid("unsupported usage parameter: " + key);
  for (const key of params.keys()) if (params.getAll(key).length > 1) invalid("duplicate usage parameters are not allowed");
  const groupBy = params.get("groupBy") ?? "model";
  if (!["model", "provider", "key"].includes(groupBy)) invalid("groupBy must be model, provider, or key");
  const filters: UsageReportQuery["filters"] = {};
  for (const name of filterNames) { const value = params.get(name); if (value !== null) { if (!value || value.length > 512) invalid("invalid exact filter"); filters[name] = value; } }
  if (filters.costClass && !classes.has(filters.costClass) || filters.lane && !lanes.has(filters.lane)) invalid("invalid cost classification");
  const limit = Number(params.get("limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit must be 1..100");
  return { range: parseUsageReportRange(params, now), groupBy: groupBy as UsageGroupBy, filters, limit };
}
interface Policy { tenantId: string; policyId: string }
interface Cursor { v: 1; binding: string; position: UsageEventPosition & { shard: string }; now: number }
function decodeCursor(value: string): Cursor {
  if (value.length > 16384) invalid("invalid usage cursor");
  try {
    const cursor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)))) as Cursor;
    if (cursor.v !== 1 || typeof cursor.binding !== "string" || !Number.isSafeInteger(cursor.now) || !Number.isSafeInteger(cursor.position?.at) || typeof cursor.position?.id !== "string" || !cursor.position.id || cursor.position.id.length > 8192 || typeof cursor.position.shard !== "string" || cursor.position.shard.length > 1200) invalid("invalid usage cursor");
    return cursor;
  } catch { return invalid("invalid usage cursor"); }
}
function encodeCursor(cursor: Cursor): string { return btoa(Array.from(new TextEncoder().encode(JSON.stringify(cursor)), b => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function cursorBinding(principal: string, policies: Policy[], query: ReturnType<typeof parseUsageReportQuery>): Promise<string> {
  const scope = policies.map(p => [p.tenantId, p.policyId]).sort((a, b) => compareUsageIds(JSON.stringify(a), JSON.stringify(b)));
  const data = JSON.stringify([principal, scope, query.range.from, query.range.to, query.range.timezone, query.groupBy, query.filters]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}
/** Max eight concurrent shard calls; any rejected/non-2xx shard rejects the whole read. */
export async function mapUsageShards<T>(policies: Policy[], fetchShard: (policy: Policy) => Promise<T>): Promise<T[]> {
  const unique = [...new Map(policies.map(p => [JSON.stringify([p.tenantId, p.policyId]), p])).values()];
  const results = new Array<T>(unique.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(8, unique.length) }, async () => { while (index < unique.length) { const i = index++; results[i] = await fetchShard(unique[i]); } }));
  return results;
}
function safeSum(a: number, b: number): number {
  const value = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || !Number.isSafeInteger(value)) throw new HttpError(422, "usage_range_too_large", "usage totals exceed exact numeric bounds; choose a narrower range or filter");
  return value;
}
function addMetrics(target: UsageMetrics, source: UsageMetrics) { for (const key of usageMetricKeys) target[key] = safeSum(target[key], source[key]); }
function addCost(target: UsageCostSummary[], row: Pick<UsageAggregateRow, "lane" | "costClass" | "calls" | "amountMicros">) {
  let cost = target.find(c => c.lane === row.lane && c.costClass === row.costClass);
  if (!cost) { cost = { lane: row.lane, costClass: row.costClass, calls: 0, amountMicros: 0 }; target.push(cost); }
  cost.calls = safeSum(cost.calls, row.calls); cost.amountMicros = safeSum(cost.amountMicros, row.amountMicros);
}
// SQLite BINARY is UTF-8 ordering, not locale ordering (nor UTF-16 for astral characters).
export function compareUsageIds(a: string, b: string): number {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
export function mergeUsageReports(shards: UsageReportShard[], query: ReturnType<typeof parseUsageReportQuery>, now = Date.now()): PersonalUsageReport {
  const report: PersonalUsageReport = { range: query.range, groupBy: query.groupBy, metrics: emptyUsageMetrics(), costs: [], groups: [], buckets: query.range.buckets.map(b => ({ ...b, metrics: emptyUsageMetrics(), costs: [] })), groupsTruncated: shards.some(s => s.groupsTruncated), historyComplete: shards.every(s => s.historyComplete), projectionComplete: shards.every(s => s.projectionComplete !== false), historySource: shards.some(s => s.historySource === "retained_ledger") ? "retained_ledger" : "projection", generatedAt: now };
  const groups = new Map<string | null, UsageReportGroup>();
  for (const shard of shards) for (const row of shard.rows) {
    if (row.dimension === "total") { addMetrics(report.metrics, row); addCost(report.costs, row); }
    else if (row.dimension === "bucket") { const bucket = report.buckets[Number(row.value)]; if (bucket) { addMetrics(bucket.metrics, row); addCost(bucket.costs, row); } }
    else if (row.dimension === "group") {
      const value = row.value === null ? null : String(row.value);
      let group = groups.get(value);
      if (!group) { group = { value, metrics: emptyUsageMetrics(), costs: [] }; groups.set(value, group); }
      addMetrics(group.metrics, row); addCost(group.costs, row);
    }
  }
  report.groupsTruncated ||= groups.size > 100;
  report.groups = [...groups.values()].sort((a, b) => a.value === null ? b.value === null ? 0 : -1 : b.value === null ? 1 : compareUsageIds(a.value, b.value)).slice(0, 100);
  return report;
}
interface EventShard extends UsageReportHistory { shard?: string; events: PersonalUsageEvent[] }
export function mergeUsageEvents(shards: EventShard[], limit: number) {
  const ordered = shards.flatMap(s => s.events.map(event => ({ event, shard: s.shard ?? "" }))).sort((a, b) => b.event.occurredAt - a.event.occurredAt || compareUsageIds(b.event.id, a.event.id) || compareUsageIds(b.shard, a.shard));
  const selected = ordered.slice(0, limit), last = selected.at(-1);
  return { events: selected.map(row => row.event), lastShard: last?.shard, hasMore: ordered.length > limit, historyComplete: shards.every(s => s.historyComplete), projectionComplete: shards.every(s => s.projectionComplete !== false), historySource: shards.some(s => s.historySource === "retained_ledger") ? "retained_ledger" as const : "projection" as const };
}
/** Principal and policy scope are arguments supplied exclusively by verified session authority. */
export async function personalUsage(env: Env, policies: Policy[], principalId: string, params: URLSearchParams, events = false, now = Date.now()): Promise<PersonalUsageReport | PersonalUsageEvents> {
  const principal = normalizeEmail(principalId);
  if (!principal) throw new HttpError(401, "access_session_required", "a verified session principal is required");
  const cursor = params.has("cursor") ? decodeCursor(params.get("cursor")!) : null;
  if (cursor && !events) invalid("cursor is only supported for events");
  if (cursor && (cursor.now > now || now - cursor.now > 30 * 86_400_000)) invalid("usage cursor has expired");
  const query = parseUsageReportQuery(params, cursor?.now ?? now);
  const binding = await cursorBinding(principal, policies, query);
  if (cursor && cursor.binding !== binding) invalid("cursor does not match this owner and query");
  // Retention continues advancing during pagination. Keep query binding anchored, clip only SQL execution.
  const sqlRange = { ...query.range, from: Math.min(query.range.to, Math.max(query.range.from, now - 30 * 86_400_000)) };
  const shards = await mapUsageShards(policies, async policy => {
    const shard = JSON.stringify([policy.tenantId, policy.policyId]);
    const request: UsageReportQuery = { ...query, range: sqlRange, principal, ...policy };
    const response = await usageStub(env, policy.tenantId, policy.policyId).fetch("https://clawrouter.internal/" + (events ? "personal-events" : "personal-report"), { method: "POST", body: JSON.stringify({ query: request, limit: query.limit, before: cursor?.position, includeEqualId: cursor ? compareUsageIds(shard, cursor.position.shard) < 0 : false }) });
    if (!response.ok) throw new HttpError(503, "usage_report_unavailable", "personal usage is unavailable; retry later");
    const result = await response.json<UsageReportShard | EventShard>();
    return events ? { ...result, shard } : result;
  });
  if (!events) return mergeUsageReports(shards as UsageReportShard[], query, now);
  const merged = mergeUsageEvents(shards as EventShard[], query.limit), last = merged.events.at(-1);
  return { events: merged.events, historyComplete: merged.historyComplete, projectionComplete: merged.projectionComplete, historySource: merged.historySource, nextCursor: merged.hasMore && last ? encodeCursor({ v: 1, binding, now: cursor?.now ?? now, position: { at: last.occurredAt, id: last.id, shard: merged.lastShard! } }) : null };
}

/** Operator/private tooling only: deliberately not wired to any public route.
 * Defaults to a dry-run; call each batch explicitly, with separate apply authorization. */
export async function migrateUsageReportShard(env: Env, policy: Policy, options: UsageReportMigrationOptions = {}) {
  const response = await usageStub(env, policy.tenantId, policy.policyId).fetch("https://clawrouter.internal/reporting-migration", { method: "POST", body: JSON.stringify(options) });
  if (!response.ok) throw new HttpError(503, "usage_migration_unavailable", "reporting migration did not acknowledge a batch");
  return response.json<{ dryRun: boolean; examined: number; projected: number; lastRowid: number; upperRowid: number; complete: boolean; previouslyComplete: boolean; effects: UsageReportMigrationEffect[] }>();
}
