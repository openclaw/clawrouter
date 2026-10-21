import { validateBudgetReservation } from "./accounting";
import { modelReservationBounds, type PricingEndpoint } from "./pricing";
import { estimateCost } from "./proxy-accounting";
import type { AuthorizedIdentity, CompiledModel, ProviderConnection, ProxyRequestBody } from "./types";
import { REALTIME } from "./realtime-protocol";
import { HttpError } from "./utils";

export interface BudgetObservation { policyRemaining: number | null; dailyRemaining?: number | null; weeklyRemaining?: number | null; providerRemaining: number | null }
export interface OperationAffordability {
  status: "exact-covered" | "exact-blocked" | "request-dependent";
  reasonCode?: string;
}

export function operationAffordability(auth: AuthorizedIdentity, connection: ProviderConnection, model: CompiledModel | null, capability: string, endpoint: PricingEndpoint, observation?: BudgetObservation, body: ProxyRequestBody = {}): OperationAffordability {
  // Only the basis is used for variable prices; a representative body's default output
  // allowance is not a claim that every real request fits the observed balance.
  const realtime = endpoint.request_format === "openai.realtime";
  if (realtime && (auth.policy.budgetMode === "soft" || [auth.policy.monthlyBudgetMicros, auth.policy.dailyBudgetMicros, auth.policy.weeklyBudgetMicros, connection.monthlyBudgetMicros].every(v => v == null))) return { status: "exact-blocked", reasonCode: "realtime_hard_budget_required" };
  const cost = realtime ? { reserveMicros: Math.max(REALTIME.reservation, auth.policy.requestCostMicros ?? 0), basis: "realtime_full_context_bound", inputTokens: REALTIME.context, outputTokens: REALTIME.output } : estimateCost(model, body, auth.policy.requestCostMicros, capability, endpoint);
  try {
    if (auth.policy.budgetMode === "soft") {
      if (capability === "llm.count_tokens") return { status: "exact-covered" };
    } else if (!validateBudgetReservation(capability, cost, auth.policy.monthlyBudgetMicros, connection, auth.policy.dailyBudgetMicros, auth.policy.limitHint, auth.policy.weeklyBudgetMicros)) return { status: "exact-covered" };
  } catch (error) {
    if (error instanceof HttpError) return { status: "exact-blocked", reasonCode: error.code };
    throw error;
  }
  if (auth.policy.budgetScope === "principal" && !auth.principalId && !auth.credentialId)
    return { status: "exact-blocked", reasonCode: "principal_required" };
  const bounds = model?.pricing ? modelReservationBounds(model.pricing) : null;
  const exact = realtime ? cost.reserveMicros : cost.basis === "policy_fixed" ? cost.reserveMicros : bounds?.zero ? 0 : null;
  const minimum = exact ?? bounds?.minimumMicros ?? 0;
  if (exact === 0 && auth.policy.budgetMode !== "soft") return { status: "exact-covered" };
  if (!observation) return { status: "request-dependent" };
  for (const [limit, remaining, reasonCode] of [
    [auth.policy.monthlyBudgetMicros, observation.policyRemaining, "budget_exhausted"],
    [auth.policy.dailyBudgetMicros, observation.dailyRemaining, "daily_budget_exhausted"],
    [auth.policy.weeklyBudgetMicros, observation.weeklyRemaining, "weekly_budget_exhausted"],
    [connection.monthlyBudgetMicros, observation.providerRemaining, "provider_budget_exhausted"],
  ] as const) {
    if (limit != null && remaining != null && (auth.policy.budgetMode === "soft" ? remaining <= 0 : remaining < minimum)) return { status: "exact-blocked", reasonCode };
  }
  const known = (auth.policy.monthlyBudgetMicros == null || observation.policyRemaining != null)
    && (auth.policy.dailyBudgetMicros == null || observation.dailyRemaining != null)
    && (auth.policy.weeklyBudgetMicros == null || observation.weeklyRemaining != null)
    && (connection.monthlyBudgetMicros == null || observation.providerRemaining != null);
  return { status: exact != null && known ? "exact-covered" : "request-dependent", ...(!known ? { reasonCode: "budget_status_unavailable" } : {}) };
}
