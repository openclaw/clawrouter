import { authorityCall } from "./authority.ts";
import type { AccessPolicyEntry, Env, UpstreamGrant } from "./types";

const DEFAULT_GRANT_PRIORITY = 100;

export interface SelectedGrant {
  key: string;
  grant: UpstreamGrant;
}

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
    if (await selectGrant(providerId, entry.policyId, tenant, providerId, env)) return entry;
  }
  return entries[0];
}

export async function selectGrant(
  providerId: string,
  policyId: string,
  tenantId: string,
  defaultTokenRef: string,
  env: Env,
  excludedKeys: ReadonlySet<string> = new Set(),
): Promise<SelectedGrant | null> {
  const pool = await authorityCall<{ keys: string[] }>(env, "/grant-pools/resolve", { providerId, policyId, tenantId });
  const keys = [...new Set([
    `oauth/${policyId}/${defaultTokenRef}`,
    `oauth/tenants/${tenantId}/${defaultTokenRef}`,
    ...pool.keys,
  ])].filter((key) => !excludedKeys.has(key));
  const grants = keys.length ? await env.POLICY_KV.get<UpstreamGrant>(keys, "json") : new Map<string, UpstreamGrant | null>();
  return keys
    .map((key) => ({ key, grant: grants.get(key) ?? null }))
    .filter((entry): entry is SelectedGrant => !!entry.grant && entry.grant.enabled !== false && (!entry.grant.provider || entry.grant.provider === providerId) && grantUsable(entry.grant))
    .sort(compareGrants)[0] ?? null;
}

export async function syncGrantPoolIndex(env: Env, key: string, previous: UpstreamGrant | null, current: UpstreamGrant | null): Promise<void> {
  const scope = parseGrantScope(key);
  if (!scope) throw new Error("invalid upstream grant key");
  await authorityCall(env, "/grant-pools/sync", {
    ...scope,
    previousProvider: previous?.provider ?? null,
    provider: current?.provider ?? null,
    enabled: !!current && current.enabled !== false && grantUsable(current),
  });
}

export function grantPriority(grant: UpstreamGrant): number {
  return Number.isInteger(grant.priority) && grant.priority! >= 0 && grant.priority! <= 1_000_000 ? grant.priority! : DEFAULT_GRANT_PRIORITY;
}

function compareGrants(a: SelectedGrant, b: SelectedGrant): number {
  return grantPriority(a.grant) - grantPriority(b.grant) || a.key.localeCompare(b.key);
}

export function validGrantSegment(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes("/") && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseGrantScope(key: string): { scope: "policies" | "tenants"; scopeId: string; tokenRef: string } | null {
  const parts = key.split("/");
  if (parts[0] !== "oauth") return null;
  if (parts[1] === "tenants" && parts.length === 4 && validGrantSegment(parts[2]) && validGrantSegment(parts[3])) return { scope: "tenants", scopeId: parts[2], tokenRef: parts[3] };
  if (parts.length === 3 && validGrantSegment(parts[1]) && validGrantSegment(parts[2])) return { scope: "policies", scopeId: parts[1], tokenRef: parts[2] };
  return null;
}
