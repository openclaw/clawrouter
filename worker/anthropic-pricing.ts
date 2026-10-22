import type { ModelPricing, TokenRates } from "./types";

// Native Messages semantics cannot be expressed by OpenAI service-tier cards.
// Source-qualified on 2026-10-22; see docs/anthropic-price-modifiers.md.
const fastModels = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);
const geoModels = new Set([...fastModels, "claude-sonnet-5", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-4-6"]);
const noPriorityModels = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"]);
const knownModels = new Set([...geoModels, "claude-haiku-4-5"]);

export interface AnthropicModifiers { speed?: string | null; inferenceGeo?: string | null; serviceTier?: string | null }

// Preserve explicit invalid evidence as null, not as an omitted/default value.
export function anthropicModifiers(value: Record<string, unknown>): AnthropicModifiers {
  return Object.fromEntries([["speed", "speed"], ["inference_geo", "inferenceGeo"], ["service_tier", "serviceTier"]]
    .filter(([wire]) => Object.hasOwn(value, wire))
    .map(([wire, key]) => [key, typeof value[wire] === "string" && value[wire].length <= 64 ? value[wire] : null]));
}

export function anthropicPricing(pricing: ModelPricing | null | undefined, model: string | undefined, requested: AnthropicModifiers, served?: AnthropicModifiers): ModelPricing | null {
  if (!pricing || pricing.unit != null || !model || !knownModels.has(model)) return null;
  const reserve = served === undefined;
  const speed = served?.speed !== undefined ? served.speed : requested.speed === undefined ? "standard" : requested.speed;
  const geo = served?.inferenceGeo !== undefined ? served.inferenceGeo : requested.inferenceGeo !== undefined ? requested.inferenceGeo
    : geoModels.has(model) ? reserve ? "us" : null : "global";
  const tier = reserve ? requested.serviceTier === undefined ? "auto" : requested.serviceTier
    : served.serviceTier !== undefined ? served.serviceTier : requested.serviceTier === "standard_only" || noPriorityModels.has(model) ? "standard" : null;
  if (speed !== "standard" && !(speed === "fast" && fastModels.has(model))) return null;
  if (geo !== "global" && geo !== "us") return null;
  // Older models reject even explicit global geo; omission uses base pricing.
  if (!geoModels.has(model) && (requested.inferenceGeo !== undefined || served?.inferenceGeo !== undefined)) return null;
  // auto may consume negotiated Priority capacity. There is no public tariff
  // or finite upper bound to reserve; never silently change it to standard_only.
  if (reserve ? tier !== "standard_only" && !(tier === "auto" && noPriorityModels.has(model)) : tier !== "standard") return null;
  const multiplier = (speed === "fast" ? 2 : 1) * (geo === "us" ? 1.1 : 1);
  const scale = (rates: TokenRates): TokenRates => Object.fromEntries(Object.entries(rates).map(([key, value]) =>
    [key, key.endsWith("MicrosPerMillion") && typeof value === "number" ? Math.round(value * multiplier) : value])) as unknown as TokenRates;
  // Scale each category before rounding the total, and compose with context
  // tiers rather than multiplying an already-rounded settlement.
  return { ...pricing, ...scale(pricing), longContext: pricing.longContext ? { ...pricing.longContext, ...scale(pricing.longContext) } : pricing.longContext };
}
