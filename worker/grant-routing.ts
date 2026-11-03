import { boundedPercent, GRANT_SELECTION_STRATEGIES } from "./grant-selection-strategies.ts";
import type { GrantRoutingPolicy } from "./types";

export const DEFAULT_GRANT_ROUTING: GrantRoutingPolicy = {
  strategy: "most_remaining",
  stickiness: "none",
  failover: true,
  environmentFallback: false,
  includedQuotaReservePercent: 0,
  staleState: "allow",
  staleAfterSeconds: 300,
  switchAtUsedPercent: 90,
  hysteresisPercent: 10,
  eligibleGrants: {},
};

export function grantRoutingPolicy(input: unknown): GrantRoutingPolicy {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Partial<GrantRoutingPolicy> : {};
  const eligibleGrants: Record<string, string[]> = {};
  if (value.eligibleGrants && typeof value.eligibleGrants === "object" && !Array.isArray(value.eligibleGrants)) {
    for (const [providerId, refs] of Object.entries(value.eligibleGrants)) {
      if (!validGrantSegment(providerId) || !Array.isArray(refs)) continue;
      eligibleGrants[providerId] = [...new Set(refs.filter((ref): ref is string => typeof ref === "string" && validGrantSegment(ref)))].slice(0, 32).sort();
    }
  }
  const strategy = (GRANT_SELECTION_STRATEGIES as readonly unknown[]).includes(value.strategy) ? value.strategy! : DEFAULT_GRANT_ROUTING.strategy;
  return {
    strategy,
    stickiness: strategy === "threshold" ? "none" : ["none", "identity", "session"].includes(value.stickiness ?? "") ? value.stickiness! : DEFAULT_GRANT_ROUTING.stickiness,
    failover: value.failover !== false,
    environmentFallback: value.environmentFallback === true,
    includedQuotaReservePercent: Number.isInteger(value.includedQuotaReservePercent) && value.includedQuotaReservePercent! >= 0 && value.includedQuotaReservePercent! <= 50 ? value.includedQuotaReservePercent! : 0,
    staleState: value.staleState === "deny" ? "deny" : "allow",
    staleAfterSeconds: Number.isSafeInteger(value.staleAfterSeconds) && value.staleAfterSeconds! >= 30 && value.staleAfterSeconds! <= 86_400 ? value.staleAfterSeconds! : DEFAULT_GRANT_ROUTING.staleAfterSeconds,
    switchAtUsedPercent: boundedPercent(value.switchAtUsedPercent, DEFAULT_GRANT_ROUTING.switchAtUsedPercent),
    hysteresisPercent: boundedPercent(value.hysteresisPercent, DEFAULT_GRANT_ROUTING.hysteresisPercent),
    eligibleGrants,
  };
}

export function validGrantSegment(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes("/") && !/[\u0000-\u001f\u007f]/.test(value);
}
