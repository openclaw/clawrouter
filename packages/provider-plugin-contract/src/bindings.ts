import type { ProviderProduct, ProviderGrantKind } from "./products.ts";
import type { CompiledEndpoint } from "./endpoints.ts";
import type { CompiledGrantTransport } from "./auth.ts";
import type { CompiledProvider } from "./snapshot.ts";

export interface ProviderBindingGrant { kind?: ProviderGrantKind }
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

/** A static declaration mismatch, never a credential or account-health diagnosis. */
export type ProviderBindingIssue =
  | "operation_requires_websocket"
  | "transport_endpoint_unsupported"
  | "lifecycle_unavailable"
  | "lifecycle_endpoint_unsupported"
  | "websocket_unsupported"
  | "product_transport_mismatch"
  | "product_endpoint_unsupported";

/** First static mismatch in check order. Null means compatible, not admitted. */
export function bindingCompatibilityIssue(requirement: ProviderBindingRequirement, grant: ProviderBindingGrant | null): ProviderBindingIssue | null {
  if (requirement.endpoint.websocket === "openai.realtime" && requirement.mode !== "websocket") return "operation_requires_websocket";
  const transport = transportForGrant(requirement.provider, grant);
  if (transport?.allowedEndpoints && !transport.allowedEndpoints.includes(requirement.endpoint.id)) return "transport_endpoint_unsupported";
  if (requirement.responsesLifecycle || requirement.managedLifecycle) {
    const dependencies = lifecycleEndpoints(requirement);
    if (!dependencies) return "lifecycle_unavailable";
    if (!dependencies.every(id => requirement.provider.endpoints.some(endpoint => endpoint.id === id)
      && (!transport?.allowedEndpoints || transport.allowedEndpoints.includes(id)))) return "lifecycle_endpoint_unsupported";
  }
  return requirement.mode === "http" || (["openai.responses", "openai.realtime"].includes(requirement.endpoint.websocket ?? "")
    && transport === null && (requirement.endpoint.websocket !== "openai.realtime" || !grant || grant.kind === "api_key"))
    ? null : "websocket_unsupported";
}

/** Static transport checks only; provider-specific qualification remains in the Worker. */
export function bindingSupportsOperation(requirement: ProviderBindingRequirement, grant: ProviderBindingGrant | null): boolean {
  return bindingCompatibilityIssue(requirement, grant) === null;
}

/** Product restrictions precede operation checks, matching the boolean compatibility API. */
export function productBindingCompatibilityIssue(requirement: ProviderBindingRequirement, product: ProviderProduct, grant: ProviderBindingGrant | null): ProviderBindingIssue | null {
  const transport = transportForGrant(requirement.provider, grant);
  if (product.binding.type === "provider-default") {
    if (transport !== null) return "product_transport_mismatch";
  } else if (grant?.kind !== product.binding.grantKind || transport === null
    || !Object.hasOwn(requirement.provider.auth.grantTransports, product.binding.grantKind)) return "product_transport_mismatch";
  const dependencies = lifecycleEndpoints(requirement);
  if (dependencies === null) return "lifecycle_unavailable";
  if (![requirement.endpoint.id, ...dependencies].every(id => product.endpoints.includes(id))) return "product_endpoint_unsupported";
  return bindingCompatibilityIssue(requirement, grant);
}

/** Match a declared product to a selected transport, without inferring commerce or authentication. */
export function productSupportsBinding(requirement: ProviderBindingRequirement, product: ProviderProduct, grant: ProviderBindingGrant | null): boolean {
  return productBindingCompatibilityIssue(requirement, product, grant) === null;
}
