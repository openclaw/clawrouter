import snapshotJson from "./generated/provider-snapshot.json" with { type: "json" };
import { grantPriority, grantUsable, grantWeight } from "./grant-selection.ts";
import type { ProviderSnapshot, UpstreamGrant } from "./types";

const snapshot = snapshotJson as unknown as ProviderSnapshot;

// Public views are an allowlist. Owner metadata and refresh extraParams can
// contain private material and must never be spread into mutation/read receipts.
export function grantResponse(key: string, grant: UpstreamGrant) {
  const parts = key.split("/"), tenant = parts[1] === "tenants";
  const refresh = grant.refresh ?? snapshot.providers.find((provider) => provider.id === grant.provider)?.auth.refresh;
  return {
    key, scope: tenant ? "tenants" as const : "policies" as const,
    scopeId: tenant ? parts[2] : parts[1], tokenRef: tenant ? parts[3] : parts[2],
    version: grant.version ?? 1, credentialGeneration: grant.credentialGeneration,
    priority: grantPriority(grant), weight: grantWeight(grant), enabled: grant.enabled ?? true,
    kind: grant.kind ?? "oauth", provider: safeString(grant.provider), label: safeString(grant.label),
    tokenType: safeString(grant.tokenType) ?? "Bearer", expiresAt: safeString(grant.expiresAt),
    scopes: safeStrings(grant.scopes), accountId: safeString(grant.accountId),
    subscription: grant.subscription ? { plan: safeString(grant.subscription.plan), subject: safeString(grant.subscription.subject) } : null,
    maintenance: { keepWarm: grant.maintenance?.keepWarm === true },
    createdAt: safeString(grant.createdAt), updatedAt: safeString(grant.updatedAt), revokedAt: safeString(grant.revokedAt),
    hasCredential: grant.hasCredential ?? (!!grant.credential || Object.keys(grant.credentials ?? {}).length > 0),
    credentialFields: safeStrings(grant.credentialFields ?? Object.keys(grant.credentials ?? {}).sort()),
    hasAccessToken: grant.hasAccessToken ?? !!grant.accessToken, hasRefreshToken: grant.hasRefreshToken ?? !!grant.refreshToken,
    credentialStatus: grant.credentialStatus ?? (grantUsable(grant) ? "active" as const : undefined),
    refreshConfigured: !!refresh, refreshTokenUrl: safeString(refresh?.tokenUrl),
    clientIdConfig: safeString(refresh?.clientIdConfig), clientSecretConfig: safeString(refresh?.clientSecretConfig),
    usable: grant.enabled !== false && grantUsable(grant),
  };
}

function safeString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function safeStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
