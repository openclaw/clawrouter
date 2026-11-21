import type { UpstreamGrant } from "./types.ts";

export function qualifiedApiKeyOwner(grant: UpstreamGrant | null, provider: string): grant is UpstreamGrant {
  return !!grant && grant.provider === provider && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && typeof grant.credentialLineage === "string" && !!grant.credentialLineage
    && (!grant.expiresAt || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now());
}
export function grantOwnerIdentity(grant: UpstreamGrant): string {
  return JSON.stringify([grant.provider, grant.kind, grant.credentialGeneration, grant.credentialLineage, grant.accountId ?? null]);
}
