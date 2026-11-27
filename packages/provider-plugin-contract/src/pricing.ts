// Published provider tariffs. No policy overrides, settlement logic, or runtime state.
export interface TokenRates { inputMicrosPerMillion: number; outputMicrosPerMillion: number; cachedInputMicrosPerMillion: number | null; cacheWriteInputMicrosPerMillion: number | null; cacheWrite5mInputMicrosPerMillion: number | null; cacheWrite1hInputMicrosPerMillion: number | null }
export interface LongContextPricing extends TokenRates { thresholdInputTokens: number }
export interface ServiceTierPricing extends TokenRates { id: string; aliases: string[]; maxInputTokens: number | null; longContext: LongContextPricing | null }
// Native Messages modifiers are independent of OpenAI service-tier tariffs.
// Null means no qualified premium; it never prevents standard/default admission.
export interface AnthropicPriceModifiers { sources: string[]; checkedAt: string; fastMultiplier: 2 | null; usMultiplier: 1.1 | null; serviceTiers: ["standard"] }
export interface TokenPricing extends TokenRates { unit?: never; effectiveAt: string; source: string; maxInputTokens: number; maxRequestInputTokens: number | null; defaultMaxOutputTokens: number; inputTokenOverhead: number; longContext: LongContextPricing | null; serviceTiers?: ServiceTierPricing[]; anthropicModifiers?: AnthropicPriceModifiers; unpricedCosts?: Array<"request_fee">; settlementBasis?: "published_upper_bound" }
export interface CharacterPricing { unit: "character"; effectiveAt: string; source: string; inputMicrosPerMillionCharacters: number; maxInputCharacters: number }
// Image generation uses modality-specific usage, not an ordinary chat token card.
export interface ImageTokenPricing {
  unit: "image_token"; effectiveAt: string; source: string;
  textInputMicrosPerMillion: number; imageInputMicrosPerMillion: number; imageOutputMicrosPerMillion: number;
  generation: { source: string; checkedAt: string; maxPromptCharacters: number; maxImages: number;
    dimensionMultiple: number; minPixels: number; maxPixels: number; maxEdge: number; maxAspectRatio: number;
    outputTokenBound: { basePixels: number; divisor: number; qualityFactors: Record<string, number> } };
}
export type ModelPricing = TokenPricing | CharacterPricing | ImageTokenPricing;

/** Published operation prices; policy-fixed tariffs remain a separate basis. */
export interface SuccessfulRequestPricing {
  unit: "request";
  version: string;
  effectiveAt: string;
  source: string;
  successfulResponseMicros: number;
  parameterRates?: { parameter: string; rates: Record<string, number> };
}

export interface OutcomeRequestPricing {
  unit: "request";
  version: string;
  effectiveAt: string;
  source: "https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee";
  outcome: "xai.responses_violation";
  maximumAdditionalMicros: 50000;
  receipt: "xai.usage.cost_in_usd_ticks";
}
export interface ImageRequestPricing {
  unit: "image"; protocol: "xai.images"; version: string; effectiveAt: string;
  source: "https://docs.x.ai/developers/pricing";
  receipt: "xai.usage.cost_in_usd_ticks";
  alias: { selectedModel: "grok-imagine-image-quality"; servingModel: "grok-imagine-image-2.0"; quality: "low";
    effectiveAt: "2026-11-02"; source: "https://docs.x.ai/developers/migration/imagine-image-quality-nov-2" };
  rates: {
    "grok-imagine-image": { inputMicrosPerImage: number; outputMicrosPerImage: Record<"1k" | "2k", number> };
    "grok-imagine-image-2.0": { inputMicrosPerImage: number; outputMicrosPerImage: Record<"low" | "medium", Record<"1k" | "2k", number>> };
  };
}
/** Published native-result tariff; admission freezes this before dispatch. */
export interface DeepSeekSearchRequestPricing {
  unit: "request";
  protocol: "deepseek.search";
  version: string;
  effectiveAt: "2026-11-01T00:00:00+08:00";
  source: "https://api-docs.deepseek.com/guides/search/";
  successfulNonemptyRequestMicros: 750;
  emptyRequestMicros: 0;
}
export type RequestPricing = SuccessfulRequestPricing | OutcomeRequestPricing | ImageRequestPricing | DeepSeekSearchRequestPricing;
