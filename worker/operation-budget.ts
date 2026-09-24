import { validateBudgetReservation } from "./accounting";
import { modelReservationBounds, type PricingEndpoint } from "./pricing";
import { estimateCost } from "./proxy-accounting";
import type { AuthorizedIdentity, CompiledModel, ProviderConnection } from "./types";
import { HttpError } from "./utils";

export interface BudgetObservation { policyRemaining: number | null; providerRemaining: number | null }
export interface OperationAffordability {
  status: "exact-covered" | "exact-blocked" | "request-dependent";
  reasonCode?: string;
}

export function operationAffordability(auth: AuthorizedIdentity, connection: ProviderConnection, model: CompiledModel | null, capability: string, endpoint: PricingEndpoint, observation?: BudgetObservation): OperationAffordability {
  // Only the basis is used for variable prices; an empty body's default output
  // allowance is not a claim that every real request fits the observed balance.
  const cost = estimateCost(model, {}, auth.policy.requestCostMicros, capability, endpoint);
  try {
    if (!validateBudgetReservation(capability, cost, auth.policy.monthlyBudgetMicros, connection)) return { status: "exact-covered" };
  } catch (error) {
    if (error instanceof HttpError) return { status: "exact-blocked", reasonCode: error.code };
    throw error;
  }
  if (auth.policy.budgetScope === "principal" && !auth.principalId && !auth.credentialId)
    return { status: "exact-blocked", reasonCode: "principal_required" };
  const bounds = model?.pricing ? modelReservationBounds(model.pricing) : null;
  const exact = cost.basis === "policy_fixed" ? cost.reserveMicros : bounds?.zero ? 0 : null;
  const minimum = exact ?? bounds?.minimumMicros ?? 0;
  if (exact === 0) return { status: "exact-covered" };
  if (!observation) return { status: "request-dependent" };
  for (const [limit, remaining, reasonCode] of [
    [auth.policy.monthlyBudgetMicros, observation.policyRemaining, "budget_exhausted"],
    [connection.monthlyBudgetMicros, observation.providerRemaining, "provider_budget_exhausted"],
  ] as const) {
    if (limit != null && remaining != null && remaining < minimum) return { status: "exact-blocked", reasonCode };
  }
  const known = (auth.policy.monthlyBudgetMicros == null || observation.policyRemaining != null)
    && (connection.monthlyBudgetMicros == null || observation.providerRemaining != null);
  return { status: exact != null && known ? "exact-covered" : "request-dependent", ...(!known ? { reasonCode: "budget_status_unavailable" } : {}) };
}
