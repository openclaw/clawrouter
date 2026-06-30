import type { BudgetReserveRequest, BudgetSettleRequest, Env, QueueMessage, UsageEvent } from "./types";
import { emptyUsageSnapshot, mergeUsageSnapshots, usageShardName, type UsageSnapshot } from "./usage-sharding.ts";
import { errorResponse, json } from "./utils.ts";

const reservationLeaseMs = 15 * 60 * 1_000;
const chargeRetentionMs = 45 * 86_400_000;
const usageWindowDays = 30;
const usageRetentionMs = 30 * 86_400_000;
const legacyUsageReadUntilMs = Date.parse("2026-07-23T00:00:00.000Z");

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
      const spent = this.effectiveSpent(windowKey);
      return json({ policyId, windowKey, limitMicros: limit, spentMicros: spent, remainingMicros: Math.max(0, limit - spent) });
    }
    if (request.method === "POST" && url.pathname === "/reserve") return this.reserve(await request.json<BudgetReserveRequest>());
    if (request.method === "POST" && url.pathname === "/settle") return this.settle(await request.json<BudgetSettleRequest>());
    return errorResponse("route_not_found", "route not found", 404);
  }

  async alarm(): Promise<void> {
    this.maintain();
    await this.scheduleAlarm();
  }

  private reserve(request: BudgetReserveRequest): Response {
    const existing = first<{ window_key: string; policy_id: string; reserved_micros: number }>(this.sql.exec("SELECT window_key, policy_id, reserved_micros FROM budget_reservations WHERE reservation_id = ?", request.reservationId));
    if (existing) {
      const spent = this.effectiveSpent(existing.window_key);
      return json({ allowed: true, policyId: existing.policy_id, windowKey: existing.window_key, chargedMicros: existing.reserved_micros, spentMicros: spent, remainingMicros: Math.max(0, request.limitMicros - spent) });
    }
    const spent = this.effectiveSpent(request.windowKey);
    const remaining = Math.max(0, request.limitMicros - spent);
    if (request.costMicros > remaining) return json({ allowed: false, policyId: request.policyId, windowKey: request.windowKey, chargedMicros: 0, spentMicros: spent, remainingMicros: remaining });
    this.sql.exec("INSERT INTO budget_reservations (reservation_id, window_key, policy_id, reserved_micros, created_at_ms, settled) VALUES (?, ?, ?, ?, ?, 0)", request.reservationId, request.windowKey, request.policyId, request.costMicros, Date.now());
    void this.scheduleAlarm();
    const next = spent + request.costMicros;
    return json({ allowed: true, policyId: request.policyId, windowKey: request.windowKey, chargedMicros: request.costMicros, spentMicros: next, remainingMicros: Math.max(0, request.limitMicros - next) });
  }

  private settle(request: BudgetSettleRequest): Response {
    const reservation = first<{ window_key: string; policy_id: string; reserved_micros: number }>(this.sql.exec("SELECT window_key, policy_id, reserved_micros FROM budget_reservations WHERE reservation_id = ?", request.reservationId));
    if (!reservation) return json({ settled: false, chargedMicros: 0, spentMicros: 0 });
    const current = this.effectiveSpent(reservation.window_key);
    const next = Math.max(0, current - reservation.reserved_micros) + request.actualCostMicros;
    this.sql.exec("UPDATE budget_reservations SET reserved_micros = ?, settled = 1 WHERE reservation_id = ?", request.actualCostMicros, request.reservationId);
    return json({ settled: true, chargedMicros: request.actualCostMicros, spentMicros: next });
  }

  private effectiveSpent(windowKey: string): number {
    const window = first<{ spent_micros: number }>(this.sql.exec("SELECT spent_micros FROM budget_windows WHERE window_key = ?", windowKey))?.spent_micros ?? 0;
    const reservations = first<{ spent_micros: number }>(this.sql.exec("SELECT COALESCE(SUM(reserved_micros), 0) AS spent_micros FROM budget_reservations WHERE window_key = ?", windowKey))?.spent_micros ?? 0;
    return Math.max(0, window) + Math.max(0, reservations);
  }

  private maintain(): void {
    const now = Date.now();
    this.sql.exec("DELETE FROM budget_reservations WHERE settled = 0 AND created_at_ms < ?", now - reservationLeaseMs);
    this.sql.exec("DELETE FROM budget_reservations WHERE settled = 1 AND created_at_ms < ?", now - chargeRetentionMs);
  }

  private async scheduleAlarm(): Promise<void> {
    if (await this.state.storage.getAlarm()) return;
    const pending = first(this.sql.exec("SELECT reservation_id FROM budget_reservations WHERE settled = 0 LIMIT 1"));
    const any = pending ?? first(this.sql.exec("SELECT reservation_id FROM budget_reservations LIMIT 1"));
    if (any) await this.state.storage.setAlarm(Date.now() + (pending ? reservationLeaseMs : 86_400_000));
  }

  private ensureSchema(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS budget_windows (window_key TEXT PRIMARY KEY, policy_id TEXT NOT NULL, spent_micros INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS budget_reservations (reservation_id TEXT PRIMARY KEY, window_key TEXT NOT NULL, policy_id TEXT NOT NULL, reserved_micros INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, settled INTEGER NOT NULL)");
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
    if (request.method === "GET" && url.pathname === "/snapshot") return json(this.snapshot(url.searchParams.getAll("policy_id"), Math.min(100, Number(url.searchParams.get("limit")) || 100)));
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

  private snapshot(policyIds: string[], limit: number) {
    this.cleanup();
    const cutoff = Math.floor(Date.now() / 86_400_000) * 86_400_000 - (usageWindowDays - 1) * 86_400_000;
    const uniquePolicyIds = [...new Set(policyIds.filter(Boolean))];
    const where = uniquePolicyIds.length ? `policy_id IN (${uniquePolicyIds.map(() => "?").join(", ")}) AND occurred_at_ms >= ?` : "occurred_at_ms >= ?";
    const params = [...uniquePolicyIds, cutoff];
    const events = rows<{ event_json: string }>(this.sql.exec(`SELECT event_json FROM usage_events WHERE ${where} ORDER BY occurred_at_ms DESC LIMIT ?`, ...params, limit)).map((row) => JSON.parse(row.event_json));
    const summary = first<SummaryRow>(this.sql.exec(`SELECT COUNT(*) AS request_count, COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count, COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS error_count, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(SUM(actual_cost_micros), 0) AS actual_cost_micros FROM usage_events WHERE ${where}`, ...params) as unknown as Iterable<SummaryRow>) ?? emptySummary();
    const providers = rows<ProviderRow>(this.sql.exec(`SELECT provider, COUNT(*) AS request_count, COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count, COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS error_count, COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(SUM(actual_cost_micros), 0) AS actual_cost_micros FROM usage_events WHERE ${where} GROUP BY provider ORDER BY request_count DESC`, ...params) as unknown as Iterable<ProviderRow>);
    const daily = rows<DailyRow>(this.sql.exec(`SELECT CAST(occurred_at_ms / 86400000 AS INTEGER) * 86400000 AS day_start_ms, COUNT(*) AS request_count, COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count, COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS error_count, COALESCE(SUM(total_tokens), 0) AS total_tokens, COALESCE(SUM(actual_cost_micros), 0) AS actual_cost_micros FROM usage_events WHERE ${where} GROUP BY CAST(occurred_at_ms / 86400000 AS INTEGER) ORDER BY day_start_ms`, ...params) as unknown as Iterable<DailyRow>);
    return { ledger: "durable_object", summary: camelSummary(summary), providers: providers.map(camelProvider), daily: daily.map(camelDaily), events };
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
      let response: Response;
      if ("type" in message.body) response = await usageStub(env, message.body.tenant_id, message.body.policy_id).fetch("https://clawrouter.internal/ingest", { method: "POST", body: JSON.stringify(message.body) });
      else {
        const job = message.body;
        const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(`${job.tenant_id}:${job.policy_id}`));
        response = await stub.fetch("https://clawrouter.internal/settle", { method: "POST", body: JSON.stringify(job.request) });
      }
      if (!response.ok) throw new Error(`ledger queue write returned ${response.status}`);
      message.ack();
    } catch { message.retry(); }
  }
}

export async function usageSnapshot(env: Env, tenantId: string, policyId: string, limit = 100): Promise<UsageSnapshot> {
  return usageSnapshots(env, [{ tenantId, policyId }], limit);
}

export async function usageSnapshots(env: Env, policies: Array<{ policyId: string; tenantId: string }>, limit = 100): Promise<UsageSnapshot> {
  if (!policies.length) return emptyUsageSnapshot();
  const current = await Promise.all(policies.map((policy) => currentUsageSnapshot(env, policy.tenantId, policy.policyId, limit)));
  if (Date.now() >= legacyUsageReadUntilMs) return mergeUsageSnapshots(current, limit);
  const url = new URL("https://clawrouter.internal/snapshot");
  for (const policyId of [...new Set(policies.map((policy) => policy.policyId))]) url.searchParams.append("policy_id", policyId);
  url.searchParams.set("limit", String(limit));
  const legacyResponse = await legacyUsageStub(env).fetch(url);
  if (!legacyResponse.ok) return mergeUsageSnapshots(current, limit);
  const legacy = await legacyResponse.json<UsageSnapshot>();
  return mergeUsageSnapshots([legacy, ...current], limit);
}

async function currentUsageSnapshot(env: Env, tenantId: string, policyId: string, limit: number): Promise<UsageSnapshot> {
  const url = new URL("https://clawrouter.internal/snapshot");
  url.searchParams.set("policy_id", policyId);
  url.searchParams.set("limit", String(limit));
  const response = await usageStub(env, tenantId, policyId).fetch(url);
  if (!response.ok) throw new Error(`usage snapshot returned ${response.status}`);
  return response.json<UsageSnapshot>();
}

export async function budgetStatus(env: Env, policyId: string, policy: { tenantId?: string | null; monthlyBudgetMicros?: number | null }) {
  const limit = policy.monthlyBudgetMicros;
  if (limit == null) return { configured: false, ledger: "unmetered", windowKey: null, limitMicros: null, spentMicros: null, remainingMicros: null };
  const tenant = policy.tenantId ?? "default", qualifiedId = `${tenant}/${policyId}`, windowKey = `${qualifiedId}/${new Date().toISOString().slice(0, 7)}`;
  if (limit === 0) return { configured: true, ledger: "blocked", windowKey, limitMicros: 0, spentMicros: 0, remainingMicros: 0 };
  try {
    const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(`${tenant}:${policyId}`));
    const url = new URL("https://clawrouter.internal/status");
    url.searchParams.set("policy_id", qualifiedId); url.searchParams.set("window_key", windowKey); url.searchParams.set("limit_micros", String(limit));
    const response = await stub.fetch(url);
    if (!response.ok) throw new Error(`budget status returned ${response.status}`);
    const status = await response.json<{ spentMicros: number; remainingMicros: number }>();
    return { configured: true, ledger: "durable_object", windowKey, limitMicros: limit, spentMicros: status.spentMicros, remainingMicros: status.remainingMicros };
  } catch {
    return { configured: true, ledger: "unavailable", windowKey, limitMicros: limit, spentMicros: null, remainingMicros: null };
  }
}

export function usageStub(env: Env, tenantId: string, policyId: string): DurableObjectStub { return env.USAGE_LEDGER.get(env.USAGE_LEDGER.idFromName(usageShardName(tenantId, policyId))); }
function legacyUsageStub(env: Env): DurableObjectStub { return env.USAGE_LEDGER.get(env.USAGE_LEDGER.idFromName("global")); }

function numberParam(url: URL, name: string): number | null { const value = Number(url.searchParams.get(name)); return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function rows<T>(cursor: Iterable<T>): T[] { return [...cursor]; }
function first<T>(cursor: Iterable<T>): T | undefined { return rows(cursor)[0]; }

interface SummaryRow { request_count: number; success_count: number; error_count: number; input_tokens: number; output_tokens: number; total_tokens: number; actual_cost_micros: number }
interface ProviderRow { provider: string; request_count: number; success_count: number; error_count: number; total_tokens: number; actual_cost_micros: number }
interface DailyRow { day_start_ms: number; request_count: number; success_count: number; error_count: number; total_tokens: number; actual_cost_micros: number }
function emptySummary(): SummaryRow { return { request_count: 0, success_count: 0, error_count: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, actual_cost_micros: 0 }; }
function camelSummary(row: SummaryRow) { return { requestCount: row.request_count, successCount: row.success_count, errorCount: row.error_count, inputTokens: row.input_tokens, outputTokens: row.output_tokens, totalTokens: row.total_tokens, actualCostMicros: row.actual_cost_micros }; }
function camelProvider(row: ProviderRow) { return { provider: row.provider, requestCount: row.request_count, successCount: row.success_count, errorCount: row.error_count, totalTokens: row.total_tokens, actualCostMicros: row.actual_cost_micros }; }
function camelDaily(row: DailyRow) { return { dayStartMs: row.day_start_ms, requestCount: row.request_count, successCount: row.success_count, errorCount: row.error_count, totalTokens: row.total_tokens, actualCostMicros: row.actual_cost_micros }; }
