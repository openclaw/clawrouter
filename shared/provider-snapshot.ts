import type { CompiledEndpoint } from "../packages/provider-plugin-contract/src/endpoints.ts";
import type { AuthScheme, AuthorizationConfig, RefreshConfig, CompiledGrantTransport } from "../packages/provider-plugin-contract/src/auth.ts";
import type { CompiledQuotaConfig } from "../packages/provider-plugin-contract/src/quota.ts";
import type { ProviderModelDefinition } from "./provider-model.ts";
import type { ProviderOfferDefinition, ProviderProduct } from "./provider-products.ts";

// Compiled v1 declarations shared by build tools and runtime consumers.
// Credential state and adapter implementations remain outside this contract.
export type { AuthScheme, AuthorizationConfig, RefreshConfig, GrantTransportAuth, CompiledGrantTransport } from "../packages/provider-plugin-contract/src/auth.ts";
export type { ProviderGrantKind as GrantKind } from "../packages/provider-plugin-contract/src/products.ts";
export type { ManagedProtocol, ManagedFileLinks, OutputTokenLimit, ToolPricing, CompiledEndpoint } from "../packages/provider-plugin-contract/src/endpoints.ts";
export type { GrantQuotaKind, CompiledQuotaWindow, CompiledQuotaProbeWindow, CompiledQuotaProbe, CompiledQuotaConfig } from "../packages/provider-plugin-contract/src/quota.ts";

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

export type CompiledModel = ProviderModelDefinition;
