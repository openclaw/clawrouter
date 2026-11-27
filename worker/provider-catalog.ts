import { capabilityForPath, createRouteCatalog, unifiedPathForRequestFormat } from "../shared/route-catalog.ts";
import { modelForEndpoint } from "./model-pricing.ts";
import snapshotJson from "./generated/provider-snapshot.json" with { type: "json" };
import type { CompiledEndpoint, CompiledModel, CompiledProvider, ProviderSnapshot } from "./types.ts";

export const snapshot = snapshotJson as unknown as ProviderSnapshot;

export function providerById(id: string): CompiledProvider | undefined {
  return snapshot.providers.find((provider) => provider.id === id);
}

export function providerForModel(model: string): CompiledProvider | undefined {
  const exact = snapshot.model_index[model as keyof typeof snapshot.model_index];
  return exact ? providerById(exact.provider) : snapshot.providers.find((provider) => provider.routing.modelPrefixes.some((prefix) => model.startsWith(prefix) && model.length > prefix.length));
}

export function modelRoute(model: string, capability?: string): { provider: CompiledProvider; model: CompiledModel } | null {
  const provider = providerForModel(model);
  if (!provider) return null;
  const endpointId = provider.capabilities.find((item) => item.id === capability)?.endpoint;
  const entry = providerModel(provider, model, provider.endpoints.find((endpoint) => endpoint.id === endpointId));
  return entry ? { provider, model: entry } : null;
}

export function providerModel(provider: CompiledProvider, value: string, endpoint?: CompiledEndpoint, native = false): CompiledModel | null {
  const prefix = provider.routing.modelPrefixes.find((candidate) => value.startsWith(candidate));
  const upstream = prefix && !native ? value.slice(prefix.length) : value;
  const known = provider.models.find((model) => model.id === value) ?? provider.models.find((model) => model.upstream === value || model.upstream === upstream);
  if (known) return modelForEndpoint(known, endpoint?.id);
  if (native && value) {
    // A registered native identity may differ from its physical upstream alias.
    // Match only literal cards with an exact declared router prefix plus identity,
    // never configured deployment templates, suffixes or stripped unknown IDs.
    const declared = provider.models.filter((model) => !model.id.includes("${") && !model.upstream.includes("${")
      && provider.routing.modelPrefixes.some((prefix) => model.id === prefix + value));
    if (declared.length > 1) return null;
    if (declared.length === 1) return modelForEndpoint(declared[0], endpoint?.id);
  }
  if (!value || !endpoint?.modelPassthrough) return null;
  if (!upstream) return null;
  // Native opaque ids belong to the upstream namespace, even when they match
  // a routing prefix. They cannot inherit another model's metadata or price.
  return {
    id: value,
    upstream,
    capabilities: provider.capabilities.filter((capability) => capability.endpoint === endpoint.id).map((capability) => capability.id),
    pricing_ref: endpoint.modelPassthrough.pricing_ref,
    pricing: endpoint.modelPassthrough.pricing,
  };
}

export function endpointForPath(provider: CompiledProvider, path: string): CompiledEndpoint | undefined {
  const capability = capabilityForPath(path);
  const endpointId = provider.capabilities.find((item) => item.id === capability)?.endpoint;
  return endpointId ? provider.endpoints.find((endpoint) => endpoint.id === endpointId) : undefined;
}

export function unifiedPathForEndpoint(provider: CompiledProvider, endpoint: CompiledEndpoint): string | null {
  const format = endpoint.request_format;
  const path = unifiedPathForRequestFormat(format);
  const responseFormat = format === "openai.audio_speech" ? "audio.binary" : format === "openai.images_edits" ? "openai.images_generations" : format;
  return path && endpoint.response_format === responseFormat && endpointForPath(provider, path)?.id === endpoint.id ? path : null;
}

export function routeCatalog() { return createRouteCatalog(snapshot.providers); }
