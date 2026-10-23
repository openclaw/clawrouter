import { normalizeRequestCosts } from "../shared/request-pricing.ts";
import { boundedPercent } from "./grant-selection-strategies.ts";
import type { AccessPolicyEntry, GrantRoutingPolicy } from "./types";

export function normalizePolicyRecord(
  value: Record<string, unknown>,
  retainRequestContentDefault: boolean,
): AccessPolicyEntry["policy"] {
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
    retainRequestContent:
      typeof value.retainRequestContent === "boolean"
        ? value.retainRequestContent
        : retainRequestContentDefault,
    grantRouting: normalizeStoredGrantRouting(value.grantRouting),
  };
}

function normalizeStoredGrantRouting(value: unknown): GrantRoutingPolicy {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const strategy = typeof record.strategy === "string" && ["priority", "round_robin", "least_used", "most_remaining", "threshold", "weighted_random"].includes(record.strategy)
    ? record.strategy as GrantRoutingPolicy["strategy"]
    : "most_remaining";
  const stickiness = strategy !== "threshold" && typeof record.stickiness === "string" && ["none", "identity", "session"].includes(record.stickiness)
    ? record.stickiness as GrantRoutingPolicy["stickiness"]
    : "none";
  const staleAfterSeconds = Number.isSafeInteger(record.staleAfterSeconds) && (record.staleAfterSeconds as number) >= 30 && (record.staleAfterSeconds as number) <= 86_400
    ? record.staleAfterSeconds as number
    : 300;
  const switchAtUsedPercent = boundedPercent(record.switchAtUsedPercent, 90);
  const hysteresisPercent = boundedPercent(record.hysteresisPercent, 10);
  const eligibleGrants: Record<string, string[]> = {};
  if (record.eligibleGrants && typeof record.eligibleGrants === "object" && !Array.isArray(record.eligibleGrants)) {
    for (const [providerId, refs] of Object.entries(record.eligibleGrants as Record<string, unknown>)) {
      if (!validStoredGrantSegment(providerId) || !Array.isArray(refs)) continue;
      eligibleGrants[providerId] = [...new Set(refs.filter((ref): ref is string => typeof ref === "string" && validStoredGrantSegment(ref)))].slice(0, 32).sort();
    }
  }
  return {
    strategy,
    stickiness,
    failover: record.failover !== false,
    environmentFallback: record.environmentFallback === true,
    includedQuotaReservePercent: Number.isInteger(record.includedQuotaReservePercent) && (record.includedQuotaReservePercent as number) >= 0 && (record.includedQuotaReservePercent as number) <= 50 ? record.includedQuotaReservePercent as number : 0,
    staleState: record.staleState === "deny" ? "deny" : "allow",
    staleAfterSeconds,
    switchAtUsedPercent,
    hysteresisPercent,
    eligibleGrants,
  };
}

function validStoredGrantSegment(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes("/") && !/[\u0000-\u001f\u007f]/.test(value);
}

