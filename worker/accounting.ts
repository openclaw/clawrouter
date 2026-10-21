import { dailyBudgetMessage, weeklyBudgetMessage, withLimitHint } from "./policy-limits.ts";
import type { AuthorizedIdentity, BudgetChargeRequest, BudgetReserveRequest, BudgetSettleRequest, Env, ProviderConnection, UsageEvent } from "./types";
import { budgetLedgerAddress, dailyBudgetLedgerAddress, weeklyBudgetLedgerAddress, budgetPrincipal, providerBudgetLedgerAddress } from "./budget-scope.ts";
import { logCorrelationError } from "./correlation.ts";
import { chargeLedger, ingestUsage, settleLedger } from "./ledgers.ts";
import { HttpError, randomId } from "./utils.ts";
import type { PricingGap } from "./pricing.ts";

export interface BudgetReservation {
  reservations: LedgerBudgetReservation[];
  charges?: Array<{ objectName: string; request: Omit<BudgetChargeRequest, "amountMicros"> }>;
  reservedMicros: number;
}

interface LedgerBudgetReservation {
  reservationId: string;
  objectName: string;
}

export interface BudgetReservationIntent {
  kind: "policy" | "daily" | "weekly" | "provider";
  limitHint?: string | null;
  objectName: string;
  request: BudgetReserveRequest;
}
export interface BudgetReservationPlan {
  reservedMicros: number;
  legs: BudgetReservationIntent[];
}

export interface EstimatedCost {
  reserveMicros: number;
  basis: string;
  inputTokens: number | null;
  outputTokens: number | null;
  pricingGap?: PricingGap;
}

// Shared with read-only availability. Passing this guard never replaces the
// atomic reservation; the return value only says whether a ledger is required.
export function validateBudgetReservation(capability: string, cost: EstimatedCost, policyLimit: number | null | undefined, connection?: ProviderConnection, dailyLimit?: number | null, limitHint?: string | null, weeklyLimit?: number | null): boolean {
  if (dailyLimit === 0) throw new HttpError(402, "daily_budget_exhausted", withLimitHint(dailyBudgetMessage(0), { limitHint }));
  if (weeklyLimit === 0) throw new HttpError(402, "weekly_budget_exhausted", withLimitHint(weeklyBudgetMessage(0), { limitHint }));
  if (capability === "llm.count_tokens") return false;
  const providerLimit = connection?.monthlyBudgetMicros;
  // Unmetered callers retain upstream tier selection; only an enforced budget
  // needs a provable reservation price before dispatch.
  if (policyLimit == null && providerLimit == null && dailyLimit == null && weeklyLimit == null) return false;
  if (policyLimit === 0) throw new HttpError(402, "budget_exhausted", withLimitHint("proxy key budget is exhausted", { limitHint }));
  if (providerLimit === 0) throw new HttpError(402, "provider_budget_exhausted", `provider ${connection?.providerId ?? "unknown"} monthly budget is exhausted`);
  if (cost.basis === "unpriced_service_tier") throw new HttpError(400, "pricing_required", "requested service tier has no versioned manifest price; select a declared tier or configure a fixed policy request price");
  if (cost.pricingGap === "opaque_input_bound") throw new HttpError(400, "pricing_required", "opaque Responses input requires a valid manifest input bound or a fixed policy request price");
  if (cost.pricingGap === "retained_tool_unknown") throw new HttpError(400, "pricing_required", "retained response tools have no qualified bounded price; start a token-priced request without previous_response_id or configure a fixed policy request price");
  if (cost.pricingGap) throw new HttpError(400, "pricing_required", `${cost.pricingGap === "model_request_fee" ? "model request fees" : cost.pricingGap === "hosted_tool_fee" ? "hosted tool fees" : "hosted tool usage"} have no complete bounded price; choose a token-priced request or configure a fixed policy request price`);
  if (cost.basis === "flat_fallback") throw new HttpError(400, "pricing_required", "budgeted requests require versioned manifest pricing or a fixed policy request price");
  return true;
}

// Construct before I/O so a durable caller can record the exact IDs, scopes and
// month before an acknowledgment is lost. Physical shard aliases remain two legs.
export function planBudgetReservation(auth: AuthorizedIdentity, capability: string, cost: EstimatedCost, connection?: ProviderConnection, at = Date.now(), soft = false): BudgetReservationPlan {
  if (soft ? capability === "llm.count_tokens" : !validateBudgetReservation(capability, cost, auth.policy.monthlyBudgetMicros, connection, auth.policy.dailyBudgetMicros, auth.policy.limitHint, auth.policy.weeklyBudgetMicros)) return { reservedMicros: 0, legs: [] };
  const policyLimit = auth.policy.monthlyBudgetMicros;
  const providerLimit = connection?.monthlyBudgetMicros;
  const legs: BudgetReservationIntent[] = [];
  const add = (kind: BudgetReservationIntent["kind"], address: ReturnType<typeof budgetLedgerAddress>, limitMicros: number) => legs.push({
    kind, objectName: address.objectName, limitHint: kind === "provider" ? null : auth.policy.limitHint ?? null,
    request: { policyId: address.policyId, windowKey: address.windowKey, scopeKey: address.scopeKey, limitMicros,
      costMicros: cost.reserveMicros, reservationId: randomId("budget"), capability },
  });
  if (policyLimit != null) {
    add("policy", budgetLedgerAddress(auth.policyId, auth.policy, budgetPrincipal(auth), at), policyLimit);
  }
  if (auth.policy.dailyBudgetMicros != null) add("daily", dailyBudgetLedgerAddress(auth.policyId, auth.policy, budgetPrincipal(auth), at), auth.policy.dailyBudgetMicros);
  if (auth.policy.weeklyBudgetMicros != null) add("weekly", weeklyBudgetLedgerAddress(auth.policyId, auth.policy, budgetPrincipal(auth), at), auth.policy.weeklyBudgetMicros);
  if (providerLimit != null && connection) add("provider", providerBudgetLedgerAddress(connection.providerId, at), providerLimit);
  return { reservedMicros: cost.reserveMicros, legs };
}

export async function reserveBudget(env: Env, auth: AuthorizedIdentity, capability: string, cost: EstimatedCost, connection?: ProviderConnection): Promise<BudgetReservation> {
  const plan = planBudgetReservation(auth, capability, cost, connection);
  const reservation: BudgetReservation = { reservations: [], reservedMicros: plan.reservedMicros };
  for (const leg of plan.legs) {
    try {
      reservation.reservations.push(await reserveLedgerIntent(env, leg));
    } catch (error) {
      if (reservation.reservations.length) {
        try { await settleBudget(env, reservation, 0); }
        catch { throw new HttpError(503, "accounting_unavailable", "Budget reservation rollback could not finish; retry after accounting recovers."); }
      }
      throw error;
    }
  }
  return reservation;
}

export async function reserveLedgerIntent(env: Env, intent: BudgetReservationIntent, signal?: AbortSignal): Promise<LedgerBudgetReservation> {
  const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(intent.objectName));
  const response = await stub.fetch("https://clawrouter.internal/reserve", { method: "POST", body: JSON.stringify(intent.request), signal });
  if (!response.ok) throw new Error(`budget reserve returned ${response.status}`);
  const result = await response.json<{ allowed: boolean; chargedMicros: number }>();
  if (typeof result?.allowed !== "boolean") throw new Error("budget reserve was not acknowledged");
  if (!result.allowed) throw new HttpError(402, intent.kind === "weekly" ? "weekly_budget_exhausted" : intent.kind === "daily" ? "daily_budget_exhausted" : intent.kind === "policy" ? "budget_exhausted" : "provider_budget_exhausted",
    withLimitHint(intent.kind === "weekly" ? weeklyBudgetMessage(intent.request.limitMicros) : intent.kind === "daily" ? dailyBudgetMessage(intent.request.limitMicros) : intent.kind === "policy" ? "proxy key budget is exhausted" : `provider ${intent.request.policyId.slice("provider/".length)} monthly budget is exhausted`, intent));
  return { reservationId: intent.request.reservationId, objectName: intent.objectName };
}

export async function finalizeAccounting(env: Env, reservation: BudgetReservation, actualCostMicros: number, event: UsageEvent): Promise<boolean> {
  const results = await Promise.allSettled([
    reservation.charges ? chargeBudget(env, reservation, actualCostMicros) : settleBudget(env, reservation, actualCostMicros),
    publishUsage(env, event),
  ]);
  for (const result of results) {
    if (result.status === "rejected") logCorrelationError("accounting finalization failed", event.request_id);
  }
  // HTTP has already delivered its response; persistent sessions must stop
  // accepting work if either durable settlement recovery or usage delivery fails.
  return results.every((result) => result.status === "fulfilled");
}

export async function markBudgetDispatched(env: Env, reservation: BudgetReservation, signal?: AbortSignal): Promise<void> {
  const results = await Promise.allSettled(reservation.reservations.map(async (item) => {
    const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(item.objectName));
    const response = await stub.fetch("https://clawrouter.internal/dispatch", { method: "POST", body: JSON.stringify({ reservationId: item.reservationId }), signal });
    if (!response.ok || (await response.json<{ dispatched: boolean }>()).dispatched !== true) throw new Error("budget dispatch was not acknowledged");
  }));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw new HttpError(503, "accounting_unavailable", "Budget dispatch could not be recorded; no upstream request was sent.");
}

async function publishUsage(env: Env, event: UsageEvent): Promise<void> {
  try { await env.USAGE_QUEUE.send(event); }
  catch {
    // A rejected send can still have been accepted. Reuse the event ID so
    // direct recovery and later queue delivery converge on one stored row.
    await ingestUsage(env, event);
  }
}

export async function settleBudget(env: Env, reservation: BudgetReservation, actualCostMicros: number): Promise<void> {
  const results = await Promise.allSettled(reservation.reservations.map((reservation) => settleReservation(env, reservation, actualCostMicros)));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function settleReservation(env: Env, reservation: LedgerBudgetReservation, actualCostMicros: number): Promise<void> {
  const body: BudgetSettleRequest = { reservationId: reservation.reservationId, actualCostMicros };
  try {
    await settleLedger(env, reservation.objectName, body);
    return;
  } catch {
    // The durable queue is the recovery boundary for thrown and non-2xx ledger failures.
  }
  await env.USAGE_QUEUE.send({ kind: "budget_settlement", ledger: { objectName: reservation.objectName }, request: body });
}

export function emptyReservation(): BudgetReservation { return { reservations: [], reservedMicros: 0 }; }

async function chargeBudget(env: Env, reservation: BudgetReservation, amountMicros: number): Promise<void> {
  const results = await Promise.allSettled((reservation.charges ?? []).map(async item => {
    const request = { ...item.request, amountMicros };
    try { await chargeLedger(env, item.objectName, request); }
    catch { await env.USAGE_QUEUE.send({ kind: "budget_charge", ledger: { objectName: item.objectName }, request }); }
  }));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}
