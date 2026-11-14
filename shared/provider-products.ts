import type { GrantKind } from "./provider-snapshot.ts";
import type { ProviderProductSummary } from "../packages/provider-plugin-contract/src/product-metadata.ts";

export type { ProviderAuthenticationMethod, ProviderCommercialModel, ProviderProductSummary } from "../packages/provider-plugin-contract/src/product-metadata.ts";

/** References existing execution declarations; never supplies new credentials or endpoints. */
export type ProviderProductBinding =
  | { type: "provider-default" }
  | { type: "grant-transport"; grantKind: GrantKind };

export interface ProviderProductOffer {
  endpoint: string;
  capability: string;
  /** Exact router model IDs; null explicitly declares a model-free operation. */
  models: string[] | null;
}

/** A static declaration. Runtime qualification and caller admission are still required. */
export interface ProviderOfferDefinition {
  id: string;
  providerId: string;
  productId: string;
  endpoint: string;
  capability: string;
  model: { id: string; upstream: string } | null;
  qualification: "declared";
}

/** A declaration matched to a catalog offer, not a credential or dispatch authority. */
export interface ProviderOfferReference { id: string; productId: string }

/** Authored product metadata, not proof of entitlement, pricing, or onboarding support. */
export interface ProviderProduct extends ProviderProductSummary {
  binding: ProviderProductBinding;
  endpoints: string[];
  offers?: ProviderProductOffer[];
}
