import { actualModelCost } from "./pricing.ts";
import type { ModelPricing } from "./types.ts";
import type { UsageTokens } from "./token-usage.ts";

/** Optional reporting estimate, never an input to actual cost or budget settlement.
 * Uses the frozen admission card, not today's price. Missing input/output is not estimated.
 * No assumption that absent cache-write counters are zero. Unknown writes use the
 * most expensive disjoint allocation. Missing served tier uses the most expensive
 * DECLARED tier, not a guarantee about an unknown provider invoice. */
export function reportingEstimate(pricing: ModelPricing | null | undefined, tokens: UsageTokens | null, format: string): { micros: number; reason: string } | null {
  if (!pricing || pricing.unit != null || !["openai.responses", "openai.responses_compact", "openai.chat_completions"].includes(format) || !tokens
    || tokens.billable === false || tokens.input == null || tokens.output == null
    || !Number.isSafeInteger(tokens.input) || !Number.isSafeInteger(tokens.output) || tokens.input < 0 || tokens.output < 0) return null;
  // An explicitly unknown tier is not bounded by the known cards.
  const tier = tokens.serviceTier;
  const missingTier = tier == null || tier === "auto";
  if (!missingTier && pricing.serviceTiers?.length && !pricing.serviceTiers.some(t => t.id === tier || t.aliases.includes(tier))) return null;
  const tiers = missingTier ? pricing.serviceTiers?.map(t => t.id) ?? [undefined] : [tier];
  const missingWrites = tokens.cacheWrite == null;
  if (!missingTier && !missingWrites) return null;
  // With unknown cache reads, full input rate is an estimate without a discount,
  // not a recorded zero-read counter. Impossible explicit allocations invalidate it.
  const cached = tokens.cached ?? 0;
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > tokens.input) return null;
  if (tokens.cacheWrite != null && (!Number.isSafeInteger(tokens.cacheWrite) || tokens.cacheWrite < 0 || tokens.cacheWrite > tokens.input - cached)) return null;
  for (const writes of [tokens.cacheWrite5m, tokens.cacheWrite1h]) if (writes != null && (!Number.isSafeInteger(writes) || writes < 0 || writes > tokens.input - cached)) return null;
  let maximum: number | null = null;
  for (const serviceTier of tiers) {
    // Both endpoints cover the extrema of the linear uncached/write allocation.
    // We do NOT normalize missing cache writes into a recorded zero counter.
    for (const cacheWrite of missingWrites ? [0, tokens.input - cached] : [tokens.cacheWrite!]) {
      const value = actualModelCost(pricing, { ...tokens, serviceTier, cacheWrite }, format);
      if (value != null) maximum = Math.max(maximum ?? 0, value);
    }
  }
  return maximum == null ? null : { micros: maximum, reason: [missingTier ? "served_tier_unreported_max_declared_rate" : "", missingWrites ? "cache_write_unreported_max_rate_allocation" : ""].filter(Boolean).join(";") };
}
