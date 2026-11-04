import { readInputPublicationPolicy } from "../shared/input-publication.ts";
import { readUpstreamRetentionPolicy } from "../shared/upstream-retention.ts";
import { normalizeRequestCosts } from "../shared/request-pricing.ts";
import { grantRoutingPolicy } from "./grant-routing.ts";
import type { AccessPolicyEntry } from "./types";

export function normalizePolicyRecord(
  value: Record<string, unknown>,
  retainRequestContentDefault: boolean,
): AccessPolicyEntry["policy"] {
  const inputPublication = readInputPublicationPolicy(value.inputPublication);
  const upstreamRetention = readUpstreamRetentionPolicy(value.upstreamRetention);
  return {
    enabled: value.enabled !== false,
    generation: typeof value.generation === "string" ? value.generation : "legacy",
    providers: Array.isArray(value.providers) ? value.providers.filter((item): item is string => typeof item === "string") : [],
    models: Array.isArray(value.models) ? [...new Set(value.models.filter((item): item is string => typeof item === "string"))].slice(0, 1024) : value.models == null ? null : [],
    poolStatus: value.poolStatus === "visible" ? "visible" : "hidden",
    tenantId: typeof value.tenantId === "string" ? value.tenantId : null,
    tokenRole: typeof value.tokenRole === "string" ? value.tokenRole : null,
    monthlyBudgetMicros: typeof value.monthlyBudgetMicros === "number" ? value.monthlyBudgetMicros : null,
    dailyBudgetMicros: typeof value.dailyBudgetMicros === "number" ? value.dailyBudgetMicros : null,
    weeklyBudgetMicros: typeof value.weeklyBudgetMicros === "number" ? value.weeklyBudgetMicros : null,
    serviceTiers: value.serviceTiers as AccessPolicyEntry["policy"]["serviceTiers"] ?? null,
    limitHint: typeof value.limitHint === "string" ? value.limitHint : null,
    requestCostMicros: typeof value.requestCostMicros === "number" ? value.requestCostMicros : null,
    requestCostsMicros: normalizeRequestCosts(value.requestCostsMicros),
    budgetScope: value.budgetScope === "principal" ? "principal" : "policy",
    ...(value.budgetMode === "soft" || value.budgetMode === "reserve" ? { budgetMode: value.budgetMode } : {}),
    ...(upstreamRetention ? { upstreamRetention } : {}),
    ...(inputPublication ? { inputPublication } : {}),
    retainRequestContent:
      typeof value.retainRequestContent === "boolean"
        ? value.retainRequestContent
        : retainRequestContentDefault,
    grantRouting: grantRoutingPolicy(value.grantRouting),
  };
}
