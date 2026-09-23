import type { AuthorizedIdentity, BudgetReserveRequest, BudgetSettleRequest, Env, ProviderConnection, UsageEvent } from "./types";
import { budgetLedgerAddress, budgetPrincipal, providerBudgetLedgerAddress } from "./budget-scope.ts";
import { logCorrelationError } from "./correlation.ts";
import { ingestUsage, settleLedger } from "./ledgers.ts";
import { HttpError, randomId } from "./utils.ts";
import type { PricingGap } from "./pricing.ts";

export interface BudgetReservation {
  reservations: LedgerBudgetReservation[];
  reservedMicros: number;
}

interface LedgerBudgetReservation {
  reservationId: string;
  objectName: string;
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
export function validateBudgetReservation(capability: string, cost: EstimatedCost, policyLimit: number | null | undefined, connection?: ProviderConnection): boolean {
  if (capability === "llm.count_tokens") return false;
  const providerLimit = connection?.monthlyBudgetMicros;
  // Unmetered callers retain upstream tier selection; only an enforced budget
  // needs a provable reservation price before dispatch.
  if (policyLimit == null && providerLimit == null) return false;
  if (policyLimit === 0) throw new HttpError(402, "budget_exhausted", "proxy key budget is exhausted");
  if (providerLimit === 0) throw new HttpError(402, "provider_budget_exhausted", `provider ${connection?.providerId ?? "unknown"} monthly budget is exhausted`);
  if (cost.basis === "unpriced_service_tier") throw new HttpError(400, "pricing_required", "requested service tier has no versioned manifest price; select a declared tier or configure a fixed policy request price");
  if (cost.pricingGap) throw new HttpError(400, "pricing_required", `${cost.pricingGap === "model_request_fee" ? "model request fees" : cost.pricingGap === "hosted_tool_fee" ? "hosted tool fees" : "hosted tool usage"} have no complete bounded price; choose a token-priced request or configure a fixed policy request price`);
  if (cost.basis === "flat_fallback") throw new HttpError(400, "pricing_required", "budgeted requests require versioned manifest pricing or a fixed policy request price");
  return true;
}

export async function reserveBudget(env: Env, auth: AuthorizedIdentity, capability: string, cost: EstimatedCost, connection?: ProviderConnection): Promise<BudgetReservation> {
  if (!validateBudgetReservation(capability, cost, auth.policy.monthlyBudgetMicros, connection)) return emptyReservation();
  const policyLimit = auth.policy.monthlyBudgetMicros;
  const providerLimit = connection?.monthlyBudgetMicros;
  const reservation: BudgetReservation = { reservations: [], reservedMicros: cost.reserveMicros };
  if (policyLimit != null) {
    const principal = budgetPrincipal(auth);
    const address = budgetLedgerAddress(auth.policyId, auth.policy, principal);
    reservation.reservations.push(await reserveLedger(env, address, policyLimit, cost, capability, "budget_exhausted", "proxy key budget is exhausted"));
  }
  if (providerLimit != null && connection) {
    const address = providerBudgetLedgerAddress(connection.providerId);
    try {
      reservation.reservations.push(await reserveLedger(env, address, providerLimit, cost, capability, "provider_budget_exhausted", `provider ${connection.providerId} monthly budget is exhausted`));
    } catch (error) {
      try { await settleBudget(env, reservation, 0); }
      catch { throw new HttpError(503, "accounting_unavailable", "Budget reservation rollback could not finish; retry after accounting recovers."); }
      throw error;
    }
  }
  return reservation;
}

async function reserveLedger(
  env: Env,
  address: ReturnType<typeof budgetLedgerAddress>,
  limitMicros: number,
  cost: EstimatedCost,
  capability: string,
  exhaustedCode: string,
  exhaustedMessage: string,
): Promise<LedgerBudgetReservation> {
  const reservationId = randomId("budget");
  const request: BudgetReserveRequest = {
    policyId: address.policyId,
    windowKey: address.windowKey,
    scopeKey: address.scopeKey,
    limitMicros,
    costMicros: cost.reserveMicros,
    reservationId,
    capability,
  };
  const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(address.objectName));
  const response = await stub.fetch("https://clawrouter.internal/reserve", { method: "POST", body: JSON.stringify(request) });
  if (!response.ok) throw new Error(`budget reserve returned ${response.status}`);
  const result = await response.json<{ allowed: boolean; chargedMicros: number }>();
  if (!result.allowed) throw new HttpError(402, exhaustedCode, exhaustedMessage);
  return { reservationId, objectName: address.objectName };
}

export async function finalizeAccounting(env: Env, reservation: BudgetReservation, actualCostMicros: number, event: UsageEvent): Promise<boolean> {
  const results = await Promise.allSettled([
    settleBudget(env, reservation, actualCostMicros),
    publishUsage(env, event),
  ]);
  for (const result of results) {
    if (result.status === "rejected") logCorrelationError("accounting finalization failed", event.request_id);
  }
  // HTTP has already delivered its response; persistent sessions must stop
  // accepting work if either durable settlement recovery or usage delivery fails.
  return results.every((result) => result.status === "fulfilled");
}

export async function markBudgetDispatched(env: Env, reservation: BudgetReservation): Promise<void> {
  const results = await Promise.allSettled(reservation.reservations.map(async (item) => {
    const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(item.objectName));
    const response = await stub.fetch("https://clawrouter.internal/dispatch", { method: "POST", body: JSON.stringify({ reservationId: item.reservationId }) });
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
