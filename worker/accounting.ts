import type { AuthorizedIdentity, BudgetReserveRequest, BudgetSettleRequest, Env, ProviderConnection, UsageEvent } from "./types";
import { budgetLedgerAddress, budgetPrincipal, providerBudgetLedgerAddress } from "./budget-scope.ts";
import { logCorrelationError } from "./correlation.ts";
import { HttpError, randomId } from "./utils.ts";

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
}

export async function reserveBudget(env: Env, auth: AuthorizedIdentity, capability: string, cost: EstimatedCost, connection?: ProviderConnection): Promise<BudgetReservation> {
  if (capability === "llm.count_tokens") return emptyReservation();
  const policyLimit = auth.policy.monthlyBudgetMicros;
  const providerLimit = connection?.monthlyBudgetMicros;
  if (policyLimit == null && providerLimit == null) return emptyReservation();
  if (policyLimit === 0) throw new HttpError(402, "budget_exhausted", "proxy key budget is exhausted");
  if (providerLimit === 0) throw new HttpError(402, "provider_budget_exhausted", `provider ${connection?.providerId ?? "unknown"} monthly budget is exhausted`);
  if (cost.basis === "flat_fallback") throw new HttpError(400, "pricing_required", "budgeted requests require versioned manifest pricing or a fixed policy request price");
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
      await settleBudget(env, reservation, 0).catch(() => undefined);
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

export async function finalizeAccounting(env: Env, reservation: BudgetReservation, actualCostMicros: number, event: UsageEvent): Promise<void> {
  const results = await Promise.allSettled([
    settleBudget(env, reservation, actualCostMicros),
    env.USAGE_QUEUE.send(event),
  ]);
  for (const result of results) {
    if (result.status === "rejected") logCorrelationError("accounting finalization failed", event.request_id);
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
    const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(reservation.objectName));
    const response = await stub.fetch("https://clawrouter.internal/settle", { method: "POST", body: JSON.stringify(body) });
    if (response.ok) return;
  } catch {
    // The durable queue is the recovery boundary for thrown and non-2xx ledger failures.
  }
  await env.USAGE_QUEUE.send({ kind: "budget_settlement", ledger: { objectName: reservation.objectName }, request: body });
}

export function emptyReservation(): BudgetReservation { return { reservations: [], reservedMicros: 0 }; }
