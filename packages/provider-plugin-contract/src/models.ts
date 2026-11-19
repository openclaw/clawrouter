import type { ModelAvailability } from "./model-availability.ts";
import type { NativeModelCapabilities } from "./native-capabilities.ts";
import type { ModelRequestParameters, ProviderReasoningEffort } from "./model-request-parameters.ts";
import type { ModelPricing } from "./pricing.ts";

/** Compiled provider model facts, independent of their client API projection. */
export interface ProviderModelDefinition { id: string; upstream: string; displayName?: string; codexModel?: string; availability?: ModelAvailability; capabilities: string[]; supportedReasoningEfforts?: ProviderReasoningEffort[]; requestParameters?: Record<string, ModelRequestParameters>; nativeCapabilities?: NativeModelCapabilities; endpointPricing?: Record<string, { pricing_ref: string; pricing: ModelPricing }>; pricing_ref: string | null; pricing: ModelPricing | null }
