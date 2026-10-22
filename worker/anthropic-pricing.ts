import type { ModelPricing, TokenRates } from "./types";

// Native Messages semantics cannot be expressed by OpenAI service-tier cards.
// Source-qualified on 2026-10-22; see docs/anthropic-price-modifiers.md.
const fastModels = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);
const geoModels = new Set([...fastModels, "claude-sonnet-5", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-4-6"]);
const knownModels = new Set([...geoModels, "claude-haiku-4-5"]);

export interface AnthropicModifiers { speed?: string | null; inferenceGeo?: string | null; serviceTier?: string | null }

// Documented null is unreported; malformed evidence must not become a default.
export function anthropicModifiers(value: Record<string, unknown>): AnthropicModifiers {
  return Object.fromEntries([["speed", "speed"], ["inference_geo", "inferenceGeo"], ["service_tier", "serviceTier"]]
    .filter(([wire]) => Object.hasOwn(value, wire))
    .map(([wire, key]) => [key, value[wire] === null ? null : typeof value[wire] === "string" && value[wire].length <= 64 ? value[wire] : "invalid"]));
}

export function anthropicPricing(pricing: ModelPricing | null | undefined, model: string | undefined, requested: AnthropicModifiers, served?: AnthropicModifiers): ModelPricing | null {
  if (!pricing || pricing.unit != null || !model) return null;
  // New cards qualify support in the manifest. Keep the previously reviewed
  // legacy cards unchanged; do not infer capabilities from version prefixes.
  const modifiers = pricing.anthropicModifiers;
  if (!modifiers && !knownModels.has(model)) return null;
  const fastMultiplier = modifiers ? modifiers.fastMultiplier : fastModels.has(model) ? 2 : null;
  const usMultiplier = modifiers ? modifiers.usMultiplier : geoModels.has(model) ? 1.1 : null;
  const reserve = served === undefined;
  // Request null means omitted. Usage fields are documented nullable, and models
  // without inference_geo report "not_available": unreported, not premium evidence.
  const requestedSpeed = requested.speed ?? undefined, requestedGeo = requested.inferenceGeo ?? undefined;
  const servedSpeed = served?.speed ?? undefined, servedTier = served?.serviceTier ?? undefined;
  const servedGeo = served?.inferenceGeo == null || served.inferenceGeo === "not_available" ? undefined : served.inferenceGeo;
  const speed = servedSpeed ?? requestedSpeed ?? "standard";
  // Unreported geography settles at the reserved 1.1x bound, never at global.
  const geo = servedGeo ?? requestedGeo ?? (usMultiplier != null ? "us" : "global");
  const requestedTier = requested.serviceTier ?? "auto";
  const tier = reserve ? requestedTier
    : servedTier ?? (["standard_only", "auto"].includes(requestedTier) ? "standard" : null);
  if (speed !== "standard" && !(speed === "fast" && fastMultiplier != null)) return null;
  if (geo !== "global" && geo !== "us") return null;
  // Older models reject even explicit global geo; omission uses base pricing.
  if (usMultiplier == null && (requestedGeo !== undefined || servedGeo !== undefined && servedGeo !== "global")) return null;
  // Preserve native auto/default admission at standard rates without rewriting
  // the request. Positive Priority/Batch evidence still has no public tariff.
  if (reserve ? tier !== "standard_only" && tier !== "auto" : tier !== "standard") return null;
  const multiplier = (speed === "fast" ? fastMultiplier! : 1) * (geo === "us" ? usMultiplier! : 1);
  const scale = (rates: TokenRates): TokenRates => Object.fromEntries(Object.entries(rates).map(([key, value]) =>
    [key, key.endsWith("MicrosPerMillion") && typeof value === "number" ? Math.round(value * multiplier) : value])) as unknown as TokenRates;
  // Scale each category before rounding the total, and compose with context
  // tiers rather than multiplying an already-rounded settlement.
  return { ...pricing, ...scale(pricing), longContext: pricing.longContext ? { ...pricing.longContext, ...scale(pricing.longContext) } : pricing.longContext };
}
