export type ProviderCommercialModel = "metered" | "subscription" | "prepaid" | "unbilled" | "unknown";
export type ProviderAuthenticationMethod = "api-key" | "oauth2" | "aws-sigv4" | "binding" | "none" | "unknown";

/** Authored labels only; no claim of credentials, entitlement, pricing or setup support. */
export interface ProviderProductSummary {
  /** Scoped to the containing provider, not globally unique. */
  id: string;
  displayName: string;
  commercialModel: ProviderCommercialModel;
  authenticationMethod: ProviderAuthenticationMethod;
}
