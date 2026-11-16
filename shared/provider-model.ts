import type { ModelAvailability } from "./model-availability";
import type { NativeModelCapabilities } from "./native-capabilities";
import type { ModelRequestParameters, ProviderReasoningEffort } from "./model-request-parameters";
import type { ModelPricing } from "../packages/provider-plugin-contract/src/pricing.ts";

export type { TokenRates, LongContextPricing, ServiceTierPricing, AnthropicPriceModifiers, TokenPricing, CharacterPricing, ImageTokenPricing, ModelPricing } from "../packages/provider-plugin-contract/src/pricing.ts";
/** Compiled provider model facts, independent of their client API projection. */
export interface ProviderModelDefinition { id: string; upstream: string; displayName?: string; codexModel?: string; availability?: ModelAvailability; capabilities: string[]; supportedReasoningEfforts?: ProviderReasoningEffort[]; requestParameters?: Record<string, ModelRequestParameters>; nativeCapabilities?: NativeModelCapabilities; endpointPricing?: Record<string, { pricing_ref: string; pricing: ModelPricing }>; pricing_ref: string | null; pricing: ModelPricing | null }
