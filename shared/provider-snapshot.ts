import type { ClientCatalogModel, ModelPricing, GrantAccount, GrantExtraUsage } from "./contracts";

// Compiled v1 declarations shared by build tools and runtime consumers.
// Credential state and adapter implementations remain outside this contract.
export type GrantKind = "api_key" | "oauth" | "subscription";
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
  collection?: { pointer: string; filter: { pointer: string; equals: string }; modelPointer: string } | null;
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

export type GrantTransportAuth =
  | { type: "bearer"; header: string; format: string }
  | { type: "api_key"; header: string }
  | { type: "query_api_key"; param: string };
export interface CompiledGrantTransport {
  baseUrl: string | null;
  auth: GrantTransportAuth | null;
  endpointPaths: Record<string, string>;
  allowedEndpoints?: string[];
  headers: Record<string, string>;
  appendHeaders: Record<string, string>;
  requestTransforms: { prependSystem: Array<{ type: "text"; text: string }> };
  maintenance: {
    quotaPoll: { normalIntervalSeconds: number; urgentIntervalSeconds: number; exhaustedIntervalSeconds: number; urgentRemainingPercent: number } | null;
    keepWarm: { defaultEnabled: boolean; intervalSeconds: number; endpoint: string; body: Record<string, unknown> } | null;
  };
}

export type AuthScheme =
  | { type: "bearer"; header: string; format: string; secretKind: string; required: boolean }
  | { type: "api_key"; header: string; secretKind: string }
  | { type: "query_api_key"; param: string; secretKind: string }
  | { type: "oauth"; provider: string | null; scopes: string[]; tokenRef: string | null }
  | { type: "sig_v4"; service: string; regionParam: string | null }
  | { type: "cloudflare_binding" };

export interface AuthorizationConfig { authorizeUrl: string; tokenUrl: string; clientId: string | null; clientIdConfig: string | null; clientSecretConfig: string | null; scopes: string[]; grantKind: string; extraAuthorizeParams: Record<string, string>; extraTokenParams: Record<string, string>; accountIdJsonPointer: string | null; subscriptionPlanJsonPointer: string | null }
export interface RefreshConfig { tokenUrl: string; clientId: string | null; clientIdConfig: string | null; clientSecretConfig: string | null; requestFormat: "form" | "json"; extraParams: Record<string, string> }
export type CompiledModel = ClientCatalogModel;
export interface OutputTokenLimit { field: "max_tokens" | "max_completion_tokens" | "max_output_tokens"; minimum: number; maximum: number }
export interface ToolPricing { version: string; effectiveAt: string; source: string; webSearchMicrosPerCall: number; previewMicrosPerCallByModel: Record<string, number> }
export interface CompiledEndpoint { inputProfile?: "clawrouter.pixverse-image-input.v1"; id: string; method: string; methods: string[]; path: string; upstreamPath?: string; native_proxy: boolean; auth: string | null; headers: Record<string, string>; request_headers: string[]; response_headers: string[]; query: Record<string, string>; path_params: string[]; path_param_styles: Record<string, string>; request_format: string; response_format: string; streaming: string | null; responsesLifecycle?: { retrieve: string; cancel: string }; lifecycle?: { protocol: ManagedProtocol; retrieve: string; result?: string; cancel?: string; files?: ManagedFileLinks }; outputTokenLimit?: OutputTokenLimit; toolPricing?: ToolPricing; requestPricing?: import("./request-pricing.ts").RequestPricing; modelPassthrough?: { pricing_ref: string | null; pricing: ModelPricing | null }; websocket?: "openai.responses" | "openai.realtime"; timeout_ms: number | null }
