import type { AuthorizedIdentity, BudgetReserveRequest, BudgetSettleRequest, Env, QueueMessage, UsageEvent } from "./types";
import { budgetLedgerAddress, budgetPrincipal } from "./budget-scope.ts";
import { logCorrelationError } from "./correlation.ts";
import { HttpError, randomId } from "./utils.ts";

export interface BudgetReservation {
  reservationId: string | null;
  reservedMicros: number;
}

export interface EstimatedCost {
  reserveMicros: number;
  basis: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export async function reserveBudget(env: Env, auth: AuthorizedIdentity, capability: string, cost: EstimatedCost): Promise<BudgetReservation> {
  const limit = auth.policy.monthlyBudgetMicros;
  if (limit == null) return { reservationId: null, reservedMicros: 0 };
  if (limit === 0) throw new HttpError(402, "budget_exhausted", "proxy key budget is exhausted");
  if (cost.basis === "flat_fallback") throw new HttpError(400, "pricing_required", "budgeted requests require versioned manifest pricing or a fixed policy request price");
  const reservationId = randomId("budget");
  const address = budgetLedgerAddress(auth.policyId, auth.policy, budgetPrincipal(auth));
  const request: BudgetReserveRequest = {
    policyId: address.policyId,
    windowKey: address.windowKey,
    limitMicros: limit,
    costMicros: cost.reserveMicros,
    reservationId,
    capability,
  };
  const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(address.objectName));
  const response = await stub.fetch("https://clawrouter.internal/reserve", { method: "POST", body: JSON.stringify(request) });
  if (!response.ok) throw new Error(`budget reserve returned ${response.status}`);
  const result = await response.json<{ allowed: boolean; chargedMicros: number }>();
  if (!result.allowed) throw new HttpError(402, "budget_exhausted", "proxy key budget is exhausted");
  return { reservationId, reservedMicros: result.chargedMicros };
}

export async function finalizeAccounting(env: Env, auth: AuthorizedIdentity, reservation: BudgetReservation, actualCostMicros: number, event: UsageEvent): Promise<void> {
  const results = await Promise.allSettled([
    settleBudget(env, auth, reservation, actualCostMicros),
    enqueueUsage(env, event),
  ]);
  for (const result of results) {
    if (result.status === "rejected") logCorrelationError("accounting finalization failed", event.request_id);
  }
}

export async function settleBudget(env: Env, auth: AuthorizedIdentity, reservation: BudgetReservation, actualCostMicros: number): Promise<void> {
  if (!reservation.reservationId) return;
  const principal = budgetPrincipal(auth);
  const address = budgetLedgerAddress(auth.policyId, auth.policy, principal);
  const body: BudgetSettleRequest = { reservationId: reservation.reservationId, actualCostMicros };
  const job: QueueMessage = { kind: "budget_settlement", tenant_id: address.tenant, policy_id: auth.policyId, principal_id: principal, request: body };
  try {
    const stub = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(address.objectName));
    const response = await stub.fetch("https://clawrouter.internal/settle", { method: "POST", body: JSON.stringify(body) });
    if (response.ok) return;
  } catch {
    // The durable queue is the recovery boundary for thrown and non-2xx ledger failures.
  }
  await env.USAGE_QUEUE.send(job);
}

export async function enqueueUsage(env: Env, event: UsageEvent): Promise<void> {
  await env.USAGE_QUEUE.send(event satisfies QueueMessage);
}
