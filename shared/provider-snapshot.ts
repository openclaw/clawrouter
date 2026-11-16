import type { AuthScheme, AuthorizationConfig, RefreshConfig, CompiledGrantTransport } from "../packages/provider-plugin-contract/src/auth.ts";
import type { ProviderGrantKind as GrantKind } from "../packages/provider-plugin-contract/src/products.ts";
import type { GrantAccount, GrantExtraUsage } from "./provider-observations.ts";
import type { ProviderModelDefinition, ModelPricing } from "./provider-model.ts";
import type { ProviderOfferDefinition, ProviderProduct } from "./provider-products.ts";

// Compiled v1 declarations shared by build tools and runtime consumers.
// Credential state and adapter implementations remain outside this contract.
export type { AuthScheme, AuthorizationConfig, RefreshConfig, GrantTransportAuth, CompiledGrantTransport } from "../packages/provider-plugin-contract/src/auth.ts";
export type { ProviderGrantKind as GrantKind } from "../packages/provider-plugin-contract/src/products.ts";
export type ManagedProtocol = "replicate.predictions" | "fal.queue" | "kie.jobs" | "vydra.jobs" | "dashscope.video" | "pixverse.video" | "runway.tasks" | "together.video" | "google.omni_video" | "openrouter.video" | "minimax.video";
export type ManagedFileLinks = { mode?: "metadata"; metadata: string; download: string }
  | { mode: "download_only"; metadata?: never; download: string };

export interface ProviderSnapshot {
  version: string;
  providers: CompiledProvider[];
  capability_index: Record<string, Array<{ provider: string; endpoint: string; methods: string[] }>>;
  model_index: Record<string, Omit<CompiledModel, "id"> & { provider: string }>;
}

export interface CompiledProvider {
  products?: ProviderProduct[];
  offer_definitions?: ProviderOfferDefinition[];
  id: string; display_name: string; status: string; class: string; service_platform: string; service_kind: string;
  config_keys: string[]; optional_config_keys: string[]; auth: { schemes: AuthScheme[]; authorization: AuthorizationConfig | null; refresh: RefreshConfig | null; grantTransports: Record<string, CompiledGrantTransport> };
  auth_schemes: string[]; base_urls: Record<string, string>; routing: { nativePrefixes: string[]; modelPrefixes: string[]; baseUrlParam: string | null; serviceParam: string | null };
  native_prefixes: string[]; adapter: { request: string | null; response: string | null; stream: string | null; error: string | null; passthroughHeaders: string[]; injectHeaders: Record<string, string>; injectQuery: Record<string, string>; requestTransforms: { renameFields: Array<{ from: string; to: string; paths: string[]; upstreams: string[]; upstreamConfig: string | null }> } };
  capabilities: Array<{ id: string; endpoint: string; methods: string[] }>;
  endpoints: CompiledEndpoint[]; models: CompiledModel[]; billing: { meter: string | null; dimensions: string[]; counters: Array<{ name: string; source: string; unit?: string | null }> }; meter: string | null;
  quota: CompiledQuotaConfig;
}

export type GrantQuotaKind = "requests" | "tokens" | "input_tokens" | "output_tokens" | "credits" | "subscription" | "generic";
export interface CompiledQuotaWindow {
  id: string;
  kind: GrantQuotaKind;
  unit: string | null;
  window: string | null;
  limitHeaders: string[];
  remainingHeaders: string[];
  usedHeaders: string[];
  resetHeaders: string[];
  fixedLimit: number | null;
  metricScale: number;
}
export interface CompiledQuotaProbeWindow {
  models?: string[] | null;
  collection?: { pointer: string; filter: { pointer: string; equals: string }; modelPointer?: string } | null;
  id: string;
  kind: GrantQuotaKind;
  unit: string | null;
  window: string | null;
  limitPointer: string | null;
  remainingPointer: string | null;
  usedPointer: string | null;
  resetPointer: string | null;
  fixedLimit: number | null;
  metricScale: number;
}
export interface CompiledQuotaProbe {
  grantKinds: GrantKind[];
  requiresRefreshToken: boolean;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  windows: CompiledQuotaProbeWindow[];
  facts?: { account?: Partial<Record<keyof GrantAccount, string>>; extraUsage?: Partial<Record<keyof GrantExtraUsage, string>> };
}
export interface CompiledQuotaConfig { responseHeaders: CompiledQuotaWindow[]; probes: CompiledQuotaProbe[] }

export type CompiledModel = ProviderModelDefinition;
export interface OutputTokenLimit { field: "max_tokens" | "max_completion_tokens" | "max_output_tokens"; minimum: number; maximum: number }
export interface ToolPricing { version: string; effectiveAt: string; source: string; webSearchMicrosPerCall: number; previewMicrosPerCallByModel: Record<string, number> }
export interface CompiledEndpoint { inputProfile?: "clawrouter.pixverse-image-input.v1"; id: string; method: string; methods: string[]; path: string; upstreamPath?: string; native_proxy: boolean; auth: string | null; headers: Record<string, string>; request_headers: string[]; response_headers: string[]; query: Record<string, string>; path_params: string[]; path_param_styles: Record<string, string>; request_format: string; response_format: string; streaming: string | null; responsesLifecycle?: { retrieve: string; cancel: string }; lifecycle?: { protocol: ManagedProtocol; retrieve: string; result?: string; cancel?: string; files?: ManagedFileLinks }; outputTokenLimit?: OutputTokenLimit; toolPricing?: ToolPricing; requestPricing?: import("./request-pricing.ts").RequestPricing; modelPassthrough?: { pricing_ref: string | null; pricing: ModelPricing | null }; websocket?: "openai.responses" | "openai.realtime"; timeout_ms: number | null }
