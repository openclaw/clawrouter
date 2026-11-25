// Compatibility exports; portable compiled declarations belong to the plugin contract.
export type { AuthScheme, AuthorizationConfig, RefreshConfig, GrantTransportAuth, CompiledGrantTransport } from "../packages/provider-plugin-contract/src/auth.ts";
export type { ProviderGrantKind as GrantKind } from "../packages/provider-plugin-contract/src/products.ts";
export type { ManagedProtocol, ManagedFileLinks, OutputTokenLimit, ToolPricing, CompiledEndpoint } from "../packages/provider-plugin-contract/src/endpoints.ts";
export type { GrantQuotaKind, CompiledQuotaWindow, CompiledQuotaProbeWindow, CompiledQuotaProbe, CompiledQuotaConfig } from "../packages/provider-plugin-contract/src/quota.ts";
export type { ProviderSnapshot, CompiledProvider, CompiledModel } from "../packages/provider-plugin-contract/src/snapshot.ts";
