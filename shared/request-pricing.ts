/** Capability tariffs override the legacy policy-wide tariff, including zero. */
export interface RequestPricingPolicy {
  requestCostMicros?: number | null;
  requestCostsMicros?: Record<string, number> | null;
}
export function policyRequestCost(policy: RequestPricingPolicy, capability: string): number | null {
  const costs = policy.requestCostsMicros;
  return costs && Object.hasOwn(costs, capability) ? costs[capability]! : policy.requestCostMicros ?? null;
}
export function normalizeRequestCosts(value: unknown): Record<string, number> | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64) throw new Error("requestCostsMicros must be a capability-to-price object with at most 64 entries");
  const entries = Object.entries(value);
  for (const [capability, price] of entries) {
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(capability) || capability.length > 128 || typeof price !== "number" || !Number.isSafeInteger(price) || price < 0)
      throw new Error("requestCostsMicros entries require a capability and a non-negative safe integer price");
  }
  return Object.fromEntries(entries);
}
