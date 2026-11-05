import type { GrantKind } from "./provider-snapshot.ts";

export type ProviderCommercialModel = "metered" | "subscription" | "prepaid" | "unbilled" | "unknown";
export type ProviderAuthenticationMethod = "api-key" | "oauth2" | "aws-sigv4" | "binding" | "none" | "unknown";

/** References existing execution declarations; never supplies new credentials or endpoints. */
export type ProviderProductBinding =
  | { type: "provider-default" }
  | { type: "grant-transport"; grantKind: GrantKind };

/** Authored product metadata, not proof of entitlement, pricing, or onboarding support. */
export interface ProviderProduct {
  id: string;
  displayName: string;
  commercialModel: ProviderCommercialModel;
  authenticationMethod: ProviderAuthenticationMethod;
  binding: ProviderProductBinding;
  endpoints: string[];
}
