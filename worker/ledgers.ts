import type { BudgetReserveRequest, BudgetSettleRequest, Env, QueueMessage, UsageEvent } from "./types";
import { budgetLedgerAddress, providerBudgetLedgerAddress } from "./budget-scope.ts";
import { mergeUsageSnapshots, usageCutoffs, usageDayMs, usageShardName, type UsageSnapshot } from "./usage-sharding.ts";
import { errorResponse, json, normalizeEmail } from "./utils.ts";

export type UsageEventScope = { kind: "admin" } | { kind: "principal" | "credential"; id: string };

const reservationLeaseMs = 15 * 60 * 1_000;
const chargeRetentionMs = 45 * 86_400_000;
const usageWindowDays = 30;
const usageRetentionMs = usageWindowDays * usageDayMs;

export class BudgetLedgerObject implements DurableObject {
  private sql: SqlStorage;
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sql = state.storage.sql;
    this.ensureSchema();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.maintain();
    if (request.method === "GET" && url.pathname === "/status") {
      const policyId = url.searchParams.get("policy_id"), windowKey = url.searchParams.get("window_key"), limit = numberParam(url, "limit_micros");
      if (!policyId || !windowKey || limit == null) return errorResponse("invalid_budget_request", "policy_id, window_key, and limit_micros are required", 400);
      const spent = this.effectiveSpent(windowKey, url.searchParams.get("scope_key"));
      return json({ policyId, windowKey, limitMicros: limit, spentMicros: spent, remainingMicros: Math.max(0, limit - spent) });
    }
    if (request.method === "POST" && url.pathname === "/reserve") return this.reserve(await request.json<BudgetReserveRequest>());
    if (request.method === "POST" && url.pathname === "/dispatch") return this.dispatch(await request.json<{ reservationId: string }>());
    if (request.method === "POST" && url.pathname === "/settle") return this.settle(await request.json<BudgetSettleRequest>());
    return errorResponse("route_not_found", "route not found", 404);
  }

  async alarm(): Promise<void> {
    this.maintain();
    await this.scheduleAlarm();
  }

  private reserve(request: BudgetReserveRequest): Response {
    const existing = first<{ window_key: string; policy_id: string; reserved_micros: number; budget_scope_key: string | null }>(this.sql.exec("SELECT window_key, policy_id, reserved_micros, budget_scope_key FROM budget_reservations WHERE reservation_id = ?", request.reservationId));
    if (existing) {
      const spent = this.effectiveSpent(existing.window_key, existing.budget_scope_key);
      return json({ allowed: true, policyId: existing.policy_id, windowKey: existing.window_key, chargedMicros: existing.reserved_micros, spentMicros: spent, remainingMicros: Math.max(0, request.limitMicros - spent) });
    }
    const spent = this.effectiveSpent(request.windowKey, request.scopeKey);
    const remaining = Math.max(0, request.limitMicros - spent);
    if (request.costMicros > remaining) return json({ allowed: false, policyId: request.policyId, windowKey: request.windowKey, chargedMicros: 0, spentMicros: spent, remainingMicros: remaining });
    this.sql.exec("INSERT INTO budget_reservations (reservation_id, window_key, policy_id, reserved_micros, created_at_ms, settled, dispatch_started, budget_scope_key) VALUES (?, ?, ?, ?, ?, 0, 0, ?)", request.reservationId, request.windowKey, request.policyId, request.costMicros, Date.now(), request.scopeKey ?? null);
    void this.scheduleAlarm();
    const next = spent + request.costMicros;
    return json({ allowed: true, policyId: request.policyId, windowKey: request.windowKey, chargedMicros: request.costMicros, spentMicros: next, remainingMicros: Math.max(0, request.limitMicros - next) });
  }

  private dispatch(request: { reservationId: string }): Response {
    const reservation = first<{ created_at_ms: number; settled: number }>(this.sql.exec("SELECT created_at_ms, settled FROM budget_reservations WHERE reservation_id = ?", request.reservationId));
    if (!reservation || reservation.settled !== 0 || reservation.created_at_ms + reservationLeaseMs <= Date.now()) return errorResponse("budget_reservation_expired", "budget reservation is no longer available for dispatch", 409);
    // Egress is allowed only after both ledger owners record this transition.
    // A crash after this point cannot prove that upstream work was free.
    this.sql.exec("UPDATE budget_reservations SET dispatch_started = 1 WHERE reservation_id = ?", request.reservationId);
    return json({ dispatched: true });
  }

  private settle(request: BudgetSettleRequest): Response {
    const reservation = first<{ window_key: string; reserved_micros: number; settled: number; dispatch_started: number; budget_scope_key: string | null }>(this.sql.exec("SELECT window_key, reserved_micros, settled, dispatch_started, budget_scope_key FROM budget_reservations WHERE reservation_id = ?", request.reservationId));
    if (!reservation) return errorResponse("budget_reservation_missing", "budget settlement has no retained reservation receipt", 404);
    if (!Number.isSafeInteger(request.actualCostMicros) || request.actualCostMicros < 0) return errorResponse("invalid_budget_settlement", "actual cost must be a non-negative safe integer", 400);
    if ((reservation.settled === 1 && reservation.reserved_micros !== request.actualCostMicros) || (!reservation.dispatch_started && request.actualCostMicros !== 0)) return errorResponse("budget_settlement_conflict", "budget settlement conflicts with its retained receipt", 409);
    const current = this.effectiveSpent(reservation.window_key, reservation.budget_scope_key);
    const next = Math.max(0, current - reservation.reserved_micros) + request.actualCostMicros;
    this.sql.exec("UPDATE budget_reservations SET reserved_micros = ?, settled = 1 WHERE reservation_id = ?", request.actualCostMicros, request.reservationId);
    return json({ settled: true, chargedMicros: request.actualCostMicros, spentMicros: next });
  }

  private effectiveSpent(windowKey: string, scopeKey: string | null = null): number {
    const window = first<{ spent_micros: number }>(this.sql.exec("SELECT spent_micros FROM budget_windows WHERE window_key = ?", windowKey))?.spent_micros ?? 0;
    // Untyped receipts remain shared legacy debt; their original scope is unknown.
    // Older callers omit scope and must still count every charge in the window.
    const reservations = first<{ spent_micros: number }>(this.sql.exec("SELECT COALESCE(SUM(reserved_micros), 0) AS spent_micros FROM budget_reservations WHERE window_key = ? AND (? IS NULL OR budget_scope_key IS NULL OR budget_scope_key = ?)", windowKey, scopeKey, scopeKey))?.spent_micros ?? 0;
    return Math.max(0, window) + Math.max(0, reservations);
  }

  private maintain(): void {
    const now = Date.now();
    // Expiry ends admission, not charge ownership. Undispatched work is known
    // zero; dispatched work keeps its bound in state 2 until one authoritative
    // settlement moves it to final state 1. Both receipts have bounded retention.
    this.sql.exec("UPDATE budget_reservations SET reserved_micros = 0, settled = 1 WHERE settled = 0 AND dispatch_started = 0 AND created_at_ms <= ?", now - reservationLeaseMs);
    this.sql.exec("UPDATE budget_reservations SET settled = 2 WHERE settled = 0 AND dispatch_started = 1 AND created_at_ms <= ?", now - reservationLeaseMs);
    this.sql.exec("DELETE FROM budget_reservations WHERE settled != 0 AND created_at_ms < ?", now - chargeRetentionMs);
  }

  private async scheduleAlarm(): Promise<void> {
    if (await this.state.storage.getAlarm()) return;
    const pending = first(this.sql.exec("SELECT reservation_id FROM budget_reservations WHERE settled = 0 LIMIT 1"));
    const any = pending ?? first(this.sql.exec("SELECT reservation_id FROM budget_reservations LIMIT 1"));
    if (any) await this.state.storage.setAlarm(Date.now() + (pending ? reservationLeaseMs : 86_400_000));
  }

  private ensureSchema(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS budget_windows (window_key TEXT PRIMARY KEY, policy_id TEXT NOT NULL, spent_micros INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS budget_reservations (reservation_id TEXT PRIMARY KEY, window_key TEXT NOT NULL, policy_id TEXT NOT NULL, reserved_micros INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, settled INTEGER NOT NULL, dispatch_started INTEGER NOT NULL DEFAULT 1, budget_scope_key TEXT)");
    let columns = new Set(rows<{ name: string }>(this.sql.exec("PRAGMA table_info(budget_reservations)")).map((row) => row.name));
    if (!columns.has("created_at_ms")) {
      for (const reservation of rows<{ window_key: string; policy_id: string; reserved_micros: number }>(this.sql.exec("SELECT window_key, policy_id, reserved_micros FROM budget_reservations"))) {
        const spent = first<{ spent_micros: number }>(this.sql.exec("SELECT spent_micros FROM budget_windows WHERE window_key = ?", reservation.window_key))?.spent_micros ?? 0;
        this.sql.exec("INSERT INTO budget_windows (window_key, policy_id, spent_micros) VALUES (?, ?, ?) ON CONFLICT(window_key) DO UPDATE SET spent_micros = excluded.spent_micros", reservation.window_key, reservation.policy_id, Math.max(0, spent - reservation.reserved_micros));
      }
      this.sql.exec("ALTER TABLE budget_reservations ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0");
      this.sql.exec("UPDATE budget_reservations SET created_at_ms = ? WHERE created_at_ms = 0", Date.now());
      columns = new Set(rows<{ name: string }>(this.sql.exec("PRAGMA table_info(budget_reservations)")).map((row) => row.name));
    }
    if (!columns.has("settled")) this.sql.exec("ALTER TABLE budget_reservations ADD COLUMN settled INTEGER NOT NULL DEFAULT 0");
    // Existing and older-version reservations lack dispatch evidence. Preserve
    // their bound rather than refunding potentially completed provider work.
    if (!columns.has("dispatch_started")) this.sql.exec("ALTER TABLE budget_reservations ADD COLUMN dispatch_started INTEGER NOT NULL DEFAULT 1");
    if (!columns.has("budget_scope_key")) this.sql.exec("ALTER TABLE budget_reservations ADD COLUMN budget_scope_key TEXT");
    this.sql.exec("CREATE INDEX IF NOT EXISTS budget_reservations_created_at ON budget_reservations (created_at_ms)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS budget_reservations_pending ON budget_reservations (settled, created_at_ms)");
  }
}

export class UsageLedgerObject implements DurableObject {
  private sql: SqlStorage;
  private state: DurableObjectState;
  constructor(state: DurableObjectState) { this.state = state; this.sql = state.storage.sql; this.ensureSchema(); }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/ingest") {
      this.ingest(await request.json<UsageEvent>());
      if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 86_400_000);
      return new Response("accepted");
    }
    if (request.method === "GET" && url.pathname === "/snapshot") {
      const kind = url.searchParams.get("events"), id = url.searchParams.get("event_owner");
      if (kind !== "admin" && !(kind === "principal" && id !== null) && !(kind === "credential" && id)) return errorResponse("invalid_usage_scope", "an explicit usage event scope is required", 400);
      return json(this.snapshot(url.searchParams.getAll("policy_id"), kind === "admin" ? { kind } : { kind, id: id! }, Math.min(100, Number(url.searchParams.get("limit")) || 100)));
    }
    return errorResponse("route_not_found", "route not found", 404);
  }

  async alarm(): Promise<void> {
    this.cleanup();
    if (first(this.sql.exec("SELECT id FROM usage_events LIMIT 1"))) await this.state.storage.setAlarm(Date.now() + 86_400_000);
  }

  private ingest(event: UsageEvent): void {
    event.occurred_at_ms ||= Date.now();
    event.policy_id ||= event.key_id;
    this.sql.exec(
      "INSERT OR IGNORE INTO usage_events (id, occurred_at_ms, tenant_id, policy_id, provider, status, status_code, input_tokens, output_tokens, total_tokens, actual_cost_micros, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      event.id, event.occurred_at_ms, event.tenant_id, event.policy_id, event.provider, event.status, event.status_code,
      event.input_tokens, event.output_tokens, event.total_tokens, event.actual_cost_micros, JSON.stringify(event),
    );
    this.cleanup();
  }

  private snapshot(policyIds: string[], scope: UsageEventScope, limit: number) {
    this.cleanup();
    const cutoffs = usageCutoffs(Date.now(), usageWindowDays);
    const uniquePolicyIds = [...new Set(policyIds.filter(Boolean))];
    const where = uniquePolicyIds.length ? `policy_id IN (${uniquePolicyIds.map(() => "?").join(", ")}) AND occurred_at_ms >= ?` : "occurred_at_ms >= ?";
    const params = [...uniquePolicyIds, cutoffs.rolling];
    const dailyParams = [...uniquePolicyIds, cutoffs.daily];
    const eventFilter = this.eventFilter(where, params, scope);
    const events = rows<{ event_json: string }>(this.sql.exec(`SELECT event_json FROM usage_events WHERE ${eventFilter.where} ORDER BY occurred_at_ms DESC LIMIT ?`, ...eventFilter.params, limit)).map((row) => JSON.parse(row.event_json));
    // Count final unavailable outcomes, not historical unpriced-tier admission denials.
    const unpricedCount = "COALESCE(SUM(CASE WHEN json_extract(event_json, '$.cost_basis') = 'unpriced_usage' THEN 1 ELSE 0 END), 0) AS unpriced_request_count";
    const summary = first<SummaryRow>(this.sql.exec(`SELECT COUNT(*) AS request_count, COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count, COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS error_count, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(SUM(actual_cost_micros), 0) AS actual_cost_micros, ${unpricedCount} FROM usage_events WHERE ${where}`, ...params) as unknown as Iterable<SummaryRow>) ?? emptySummary();
    const providers = rows<ProviderRow>(this.sql.exec(`SELECT provider, COUNT(*) AS request_count, COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count, COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS error_count, COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(SUM(actual_cost_micros), 0) AS actual_cost_micros, ${unpricedCount} FROM usage_events WHERE ${where} GROUP BY provider ORDER BY request_count DESC`, ...params) as unknown as Iterable<ProviderRow>);
    const daily = rows<DailyRow>(this.sql.exec(`SELECT CAST(occurred_at_ms / 86400000 AS INTEGER) * 86400000 AS day_start_ms, COUNT(*) AS request_count, COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count, COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS error_count, COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(SUM(actual_cost_micros), 0) AS actual_cost_micros, ${unpricedCount} FROM usage_events WHERE ${where} GROUP BY CAST(occurred_at_ms / 86400000 AS INTEGER) ORDER BY day_start_ms`, ...dailyParams) as unknown as Iterable<DailyRow>);
    return { ledger: "durable_object", summary: camelSummary(summary), providers: providers.map(camelProvider), daily: daily.map(camelDaily), events };
  }

  private eventFilter(where: string, params: Array<string | number>, scope: UsageEventScope) {
    if (scope.kind === "admin") return { where, params };
    if (scope.kind === "credential") return { where: `${where} AND json_extract(event_json, '$.principal_id') IS NULL AND json_extract(event_json, '$.credential_id') = ?`, params: [...params, scope.id] };
    const principal = normalizeEmail(scope.id);
    if (!principal) return { where: "0", params: [] };
    // SQLite lower/trim do not implement JS Unicode identity normalization.
    // Match retained raw IDs with the authority's normalizer, then filter in SQL
    // before LIMIT. Never derive historical ownership from today's credentials.
    const candidates = rows<{ principal_id: string }>(this.sql.exec(`SELECT DISTINCT json_extract(event_json, '$.principal_id') AS principal_id FROM usage_events WHERE ${where} AND json_type(event_json, '$.principal_id') = 'text'`, ...params));
    const aliases = candidates.map((row) => row.principal_id).filter((id) => normalizeEmail(id) === principal);
    return { where: `${where} AND json_type(event_json, '$.principal_id') = 'text' AND json_extract(event_json, '$.principal_id') IN (SELECT value FROM json_each(?))`, params: [...params, JSON.stringify(aliases)] };
  }

  private cleanup(): void { this.sql.exec("DELETE FROM usage_events WHERE occurred_at_ms < ?", Date.now() - usageRetentionMs); }
  private ensureSchema(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, occurred_at_ms INTEGER NOT NULL, tenant_id TEXT NOT NULL, policy_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, status_code INTEGER, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, actual_cost_micros INTEGER NOT NULL, event_json TEXT NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS usage_events_occurred_at ON usage_events (occurred_at_ms DESC)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS usage_events_policy ON usage_events (policy_id, occurred_at_ms DESC)");
  }
}

export async function queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if ("type" in message.body) await ingestUsage(env, message.body);
      else {
        const job = message.body;
        const objectName = "ledger" in job ? job.ledger.objectName : `${job.tenant_id}:${job.policy_id}${job.principal_id ? `:${job.principal_id}` : ""}`;
        await settleLedger(env, objectName, job.request);
      }
      message.ack();
    } catch { message.retry(); }
  }
}

export async function settleLedger(env: Env, objectName: string, request: BudgetSettleRequest): Promise<void> {
  const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(objectName));
  const response = await stub.fetch("https://clawrouter.internal/settle", { method: "POST", body: JSON.stringify(request) });
  if (!response.ok || (await response.json<{ settled: boolean }>()).settled !== true) throw new Error("budget ledger did not acknowledge settlement");
}

export async function ingestUsage(env: Env, event: UsageEvent): Promise<void> {
  const response = await usageStub(env, event.tenant_id, event.policy_id).fetch("https://clawrouter.internal/ingest", { method: "POST", body: JSON.stringify(event) });
  if (!response.ok) throw new Error(`usage ledger write returned ${response.status}`);
}

export async function usageSnapshot(env: Env, tenantId: string, policyId: string, scope: UsageEventScope, limit = 100): Promise<UsageSnapshot> {
  return usageSnapshots(env, [{ tenantId, policyId }], scope, limit);
}

export async function usageSnapshots(env: Env, policies: Array<{ policyId: string; tenantId: string }>, scope: UsageEventScope, limit = 100): Promise<UsageSnapshot> {
  const shards = new Map(policies.map(policy => [usageShardName(policy.tenantId, policy.policyId), policy]));
  const snapshots = await Promise.all([...shards.values()].map(policy => currentUsageSnapshot(env, policy.tenantId, policy.policyId, scope, limit)));
  return mergeUsageSnapshots(snapshots, limit);
}

async function currentUsageSnapshot(env: Env, tenantId: string, policyId: string, scope: UsageEventScope, limit: number): Promise<UsageSnapshot> {
  const url = new URL("https://clawrouter.internal/snapshot");
  url.searchParams.set("policy_id", policyId);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("events", scope.kind);
  if (scope.kind !== "admin") url.searchParams.set("event_owner", scope.id);
  const response = await usageStub(env, tenantId, policyId).fetch(url);
  if (!response.ok) throw new Error(`usage snapshot returned ${response.status}`);
  return response.json<UsageSnapshot>();
}

export async function budgetStatus(env: Env, policyId: string, policy: { tenantId?: string | null; monthlyBudgetMicros?: number | null; budgetScope?: "policy" | "principal" }, principal?: string | null) {
  const limit = policy.monthlyBudgetMicros;
  if (limit == null) return { configured: false, ledger: "unmetered", windowKey: null, limitMicros: null, spentMicros: null, remainingMicros: null };
  if (policy.budgetScope === "principal" && !principal) return { configured: true, ledger: "per_principal", windowKey: null, limitMicros: limit, spentMicros: null, remainingMicros: null };
  const address = budgetLedgerAddress(policyId, policy, principal);
  if (limit === 0) return { configured: true, ledger: "blocked", windowKey: address.windowKey, limitMicros: 0, spentMicros: 0, remainingMicros: 0 };
  try {
    const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(address.objectName));
    const url = new URL("https://clawrouter.internal/status");
    url.searchParams.set("policy_id", address.policyId); url.searchParams.set("window_key", address.windowKey); url.searchParams.set("limit_micros", String(limit));
    url.searchParams.set("scope_key", address.scopeKey);
    const response = await stub.fetch(url);
    if (!response.ok) throw new Error(`budget status returned ${response.status}`);
    const status = await response.json<{ spentMicros: number; remainingMicros: number }>();
    return { configured: true, ledger: "durable_object", windowKey: address.windowKey, limitMicros: limit, spentMicros: status.spentMicros, remainingMicros: status.remainingMicros };
  } catch {
    return { configured: true, ledger: "unavailable", windowKey: address.windowKey, limitMicros: limit, spentMicros: null, remainingMicros: null };
  }
}

export async function providerBudgetStatus(env: Env, providerId: string, limitMicros: number) {
  const address = providerBudgetLedgerAddress(providerId);
  try {
    const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(address.objectName));
    const url = new URL("https://clawrouter.internal/status");
    url.searchParams.set("policy_id", address.policyId);
    url.searchParams.set("window_key", address.windowKey);
    url.searchParams.set("scope_key", address.scopeKey);
    url.searchParams.set("limit_micros", String(limitMicros));
    const response = await stub.fetch(url);
    if (!response.ok) throw new Error(`provider budget status returned ${response.status}`);
    return response.json<{ spentMicros: number; remainingMicros: number }>();
  } catch {
    return { spentMicros: null, remainingMicros: null };
  }
}

export function usageStub(env: Env, tenantId: string, policyId: string): DurableObjectStub { return env.USAGE_LEDGER.get(env.USAGE_LEDGER.idFromName(usageShardName(tenantId, policyId))); }

function numberParam(url: URL, name: string): number | null { const value = Number(url.searchParams.get(name)); return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function rows<T>(cursor: Iterable<T>): T[] { return [...cursor]; }
function first<T>(cursor: Iterable<T>): T | undefined { return rows(cursor)[0]; }

interface SummaryRow { request_count: number; success_count: number; error_count: number; input_tokens: number; output_tokens: number; total_tokens: number; actual_cost_micros: number; unpriced_request_count: number }
interface ProviderRow { provider: string; request_count: number; success_count: number; error_count: number; total_tokens: number; actual_cost_micros: number; unpriced_request_count: number }
interface DailyRow { day_start_ms: number; request_count: number; success_count: number; error_count: number; total_tokens: number; actual_cost_micros: number; unpriced_request_count: number }
function emptySummary(): SummaryRow { return { request_count: 0, success_count: 0, error_count: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, actual_cost_micros: 0, unpriced_request_count: 0 }; }
function camelSummary(row: SummaryRow) { return { requestCount: row.request_count, successCount: row.success_count, errorCount: row.error_count, inputTokens: row.input_tokens, outputTokens: row.output_tokens, totalTokens: row.total_tokens, actualCostMicros: row.actual_cost_micros, unpricedRequestCount: row.unpriced_request_count }; }
function camelProvider(row: ProviderRow) { return { provider: row.provider, requestCount: row.request_count, successCount: row.success_count, errorCount: row.error_count, totalTokens: row.total_tokens, actualCostMicros: row.actual_cost_micros, unpricedRequestCount: row.unpriced_request_count }; }
function camelDaily(row: DailyRow) { return { dayStartMs: row.day_start_ms, requestCount: row.request_count, successCount: row.success_count, errorCount: row.error_count, totalTokens: row.total_tokens, actualCostMicros: row.actual_cost_micros, unpricedRequestCount: row.unpriced_request_count }; }
