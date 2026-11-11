import type { ModelAvailability } from "./model-availability";
import type { NativeModelCapabilities } from "./native-capabilities";
import type { ModelRequestParameters, ProviderReasoningEffort } from "./model-request-parameters";

// Shared model and price facts. No client response, credentials, or admission state.
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

/** Compiled provider model facts, independent of their client API projection. */
export interface ProviderModelDefinition { id: string; upstream: string; codexModel?: string; availability?: ModelAvailability; capabilities: string[]; supportedReasoningEfforts?: ProviderReasoningEffort[]; requestParameters?: Record<string, ModelRequestParameters>; nativeCapabilities?: NativeModelCapabilities; endpointPricing?: Record<string, { pricing_ref: string; pricing: ModelPricing }>; pricing_ref: string | null; pricing: ModelPricing | null }
