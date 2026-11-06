import { productSupportsBinding, transportForGrant, type ProviderBindingRequirement } from "../shared/provider-bindings.ts";
import { modelSupportsEndpoint } from "../shared/route-catalog.ts";
import type { ProviderOfferDefinition, ProviderProduct } from "../shared/provider-products.ts";
import type { CompiledEndpoint, CompiledGrantTransport, CompiledModel, CompiledProvider, UpstreamGrant } from "./types.ts";
import { modelForEndpoint } from "./model-pricing.ts";
import { grantSupports } from "./provider-auth.ts";

export interface CompatibleProviderOffer {
  status: "compatible";
  definition: ProviderOfferDefinition;
  product: ProviderProduct;
  endpoint: CompiledEndpoint;
  model: CompiledModel | null;
  transport: CompiledGrantTransport | null;
}

/** Pure compatibility projection. The caller still owns credentials, policy, quota and budget admission. */
export function resolveProviderOffer(provider: CompiledProvider, offerId: string, grant: UpstreamGrant | null,
  operation: Pick<ProviderBindingRequirement, "mode" | "responsesLifecycle" | "managedLifecycle">): CompatibleProviderOffer | null {
  if (grant && (grant.provider !== provider.id || grant.enabled === false)) return null;
  const definition = provider.offer_definitions?.find(offer => offer.id === offerId);
  if (!definition || definition.providerId !== provider.id || definition.qualification !== "declared") return null;
  const product = provider.products?.find(product => product.id === definition.productId);
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === definition.endpoint);
  if (!product || !endpoint || !provider.capabilities.some(capability => capability.id === definition.capability
    && capability.endpoint === endpoint.id)) return null;
  // Reject a mixed/stale definition instead of deriving an undeclared selection.
  if (!product.offers?.some(offer => offer.endpoint === endpoint.id && offer.capability === definition.capability
    && (definition.model === null ? offer.models === null : offer.models?.includes(definition.model.id)))) return null;
  let model: CompiledModel | null = null;
  const reference = definition.model;
  if (reference !== null) {
    const selected = provider.models.find(model => model.id === reference.id && model.upstream === reference.upstream);
    if (!selected || !selected.capabilities.includes(definition.capability) || !modelSupportsEndpoint(provider, selected, endpoint)) return null;
    model = modelForEndpoint(selected, endpoint.id);
  }
  const requirement = { ...operation, provider, endpoint, model: model?.id };
  if (!productSupportsBinding(requirement, product, grant) || !grantSupports(requirement, grant)) return null;
  return { status: "compatible", definition, product, endpoint, model, transport: transportForGrant(provider, grant) };
}
