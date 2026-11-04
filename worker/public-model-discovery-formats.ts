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
