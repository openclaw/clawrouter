import type { CompiledEndpoint } from "./types.ts";

const providers = {
  "cerebras.public_catalog": "cerebras",
  "nvidia.public_catalog": "nvidia",
  "chutes.models": "chutes",
  "venice.models": "venice",
} as const;

export function publicCatalogProvider(format: string): typeof providers[keyof typeof providers] | null {
  return Object.hasOwn(providers, format) ? providers[format as keyof typeof providers] : null;
}

// Aggregated public facts are router metadata, not a vendor-native API.
export function manifestOnlyPublicCatalog(format: string): boolean {
  return format === "cerebras.public_catalog" || format === "nvidia.public_catalog";
}

export const REQUESTY_MODELS_FORMAT = "requesty.models_managed";

export const keyedCatalogProviders = {
  "baseten.models": "baseten",
  "arcee.models": "arcee",
  "novita.models": "novita",
} as const;

export function isKeyedModelDiscovery(format: string): format is keyof typeof keyedCatalogProviders {
  return Object.hasOwn(keyedCatalogProviders, format);
}

// These formats are metadata, not inference or a permission to delete models.
export function isModelDiscovery(endpoint: Pick<CompiledEndpoint, "request_format">): boolean {
  return endpoint.request_format === REQUESTY_MODELS_FORMAT || endpoint.request_format === "featherless.catalog" || publicCatalogProvider(endpoint.request_format) !== null || isKeyedModelDiscovery(endpoint.request_format) || ["radius.config", "openai.models", "anthropic.models", "ollama.models", "synthetic.models"].includes(endpoint.request_format);
}
