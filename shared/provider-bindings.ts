import type { ProviderProduct } from "./provider-products.ts";
import type { CompiledEndpoint, CompiledGrantTransport, CompiledProvider, GrantKind } from "./provider-snapshot.ts";

export interface ProviderBindingGrant { kind?: GrantKind }
export interface ProviderBindingRequirement {
  provider: CompiledProvider;
  endpoint: CompiledEndpoint;
  mode: "http" | "websocket";
  responsesLifecycle?: boolean;
  managedLifecycle?: boolean;
}

export function transportForGrant(provider: CompiledProvider, grant: ProviderBindingGrant | null): CompiledGrantTransport | null {
  if (!grant?.kind) return null;
  return provider.auth.grantTransports[grant.kind] ?? null;
}

function lifecycleEndpoints(requirement: ProviderBindingRequirement): string[] | null {
  if (!requirement.responsesLifecycle && !requirement.managedLifecycle) return [];
  const lifecycle = requirement.managedLifecycle ? requirement.endpoint.lifecycle : requirement.endpoint.responsesLifecycle;
  if (requirement.mode !== "http" || !lifecycle) return null;
  return [lifecycle.retrieve, lifecycle.cancel, "result" in lifecycle ? lifecycle.result : undefined,
    ...(requirement.managedLifecycle ? [requirement.endpoint.lifecycle?.files?.metadata, requirement.endpoint.lifecycle?.files?.download] : [])]
    .filter((id): id is string => typeof id === "string");
}

/** Static transport checks only; provider-specific qualification remains in the Worker. */
export function bindingSupportsOperation(requirement: ProviderBindingRequirement, grant: ProviderBindingGrant | null): boolean {
  if (requirement.endpoint.websocket === "openai.realtime" && requirement.mode !== "websocket") return false;
  const transport = transportForGrant(requirement.provider, grant);
  if (transport?.allowedEndpoints && !transport.allowedEndpoints.includes(requirement.endpoint.id)) return false;
  if (requirement.responsesLifecycle || requirement.managedLifecycle) {
    const dependencies = lifecycleEndpoints(requirement);
    if (!dependencies || !dependencies.every(id => requirement.provider.endpoints.some(endpoint => endpoint.id === id)
      && (!transport?.allowedEndpoints || transport.allowedEndpoints.includes(id)))) return false;
  }
  return requirement.mode === "http" || (["openai.responses", "openai.realtime"].includes(requirement.endpoint.websocket ?? "")
    && transport === null && (requirement.endpoint.websocket !== "openai.realtime" || !grant || grant.kind === "api_key"));
}

/** Match a declared product to a selected transport, without inferring commerce or authentication. */
export function productSupportsBinding(requirement: ProviderBindingRequirement, product: ProviderProduct, grant: ProviderBindingGrant | null): boolean {
  const transport = transportForGrant(requirement.provider, grant);
  if (product.binding.type === "provider-default") {
    if (transport !== null) return false;
  } else if (grant?.kind !== product.binding.grantKind || transport === null
    || !Object.hasOwn(requirement.provider.auth.grantTransports, product.binding.grantKind)) return false;
  const dependencies = lifecycleEndpoints(requirement);
  return dependencies !== null && [requirement.endpoint.id, ...dependencies].every(id => product.endpoints.includes(id))
    && bindingSupportsOperation(requirement, grant);
}
