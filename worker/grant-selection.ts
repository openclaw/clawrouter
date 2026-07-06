import type { AccessPolicyEntry, Env, UpstreamGrant } from "./types";

export function grantUsable(grant: UpstreamGrant): boolean {
  const scalarCredentials = [grant.credential, grant.accessToken, grant.refreshToken];
  if (scalarCredentials.some((value) => value != null && (typeof value !== "string" || value.trim().length === 0)) || !validCredentialBundle(grant.credentials)) return false;
  const bundled = grant.credentials ? Object.values(grant.credentials) : [];
  return [grant.credential, grant.accessToken, ...bundled].some((value) => typeof value === "string" && value.trim().length > 0);
}

export function validCredentialBundle(value: UpstreamGrant["credentials"]): boolean {
  return value == null || (!Array.isArray(value) && typeof value === "object" && Object.entries(value).every(([name, secret]) => /^[A-Za-z0-9_.-]{1,128}$/.test(name) && typeof secret === "string" && secret.trim().length > 0));
}

export async function selectProviderPolicy(entries: AccessPolicyEntry[], providerId: string, tenantId: string, env: Env): Promise<AccessPolicyEntry> {
  for (const entry of entries) {
    const tenant = entry.policy.tenantId ?? tenantId;
    for (const key of [`oauth/${entry.policyId}/${providerId}`, `oauth/tenants/${tenant}/${providerId}`]) {
      const grant = await env.POLICY_KV.get<UpstreamGrant>(key, "json");
      if (grant && grant.enabled !== false && grantUsable(grant)) return entry;
    }
  }
  return entries[0];
}
