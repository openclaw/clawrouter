import type { CompiledModel } from "./types";

// One upstream model can have different tariffs on different wire contracts.
// Resolve once at selection; never mutate the shared discovery snapshot.
export function modelForEndpoint(model: CompiledModel, endpointId?: string): CompiledModel {
  const card = endpointId ? model.endpointPricing?.[endpointId] : undefined;
  return card ? { ...model, pricing_ref: card.pricing_ref, pricing: card.pricing } : model;
}
