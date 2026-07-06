import { authorityCall } from "./authority.ts";
import { grantCoolingDown, grantQuotaRatio } from "./grant-quota.ts";
import type { AccessPolicyEntry, Env, GrantRuntimeState, UpstreamGrant } from "./types";

const DEFAULT_GRANT_PRIORITY = 100;

export interface SelectedGrant {
  key: string;
  grant: UpstreamGrant;
  runtimeState: GrantRuntimeState | null;
}

export interface GrantSelectionResult {
  selected: SelectedGrant | null;
  hasConfiguredGrant: boolean;
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
  return (await resolveGrantSelection(providerId, policyId, tenantId, defaultTokenRef, env, excludedKeys)).selected;
}

export async function resolveGrantSelection(
  providerId: string,
  policyId: string,
  tenantId: string,
  defaultTokenRef: string,
  env: Env,
  excludedKeys: ReadonlySet<string> = new Set(),
): Promise<GrantSelectionResult> {
  const defaultKeys = [
    `oauth/${policyId}/${defaultTokenRef}`,
    `oauth/tenants/${tenantId}/${defaultTokenRef}`,
  ];
  const pool = await authorityCall<{ keys: string[]; states?: Record<string, GrantRuntimeState> }>(env, "/grant-pools/resolve", { providerId, policyId, tenantId, defaultKeys });
  const keys = [...new Set([...defaultKeys, ...pool.keys])];
  const grants = keys.length ? await env.POLICY_KV.get<UpstreamGrant>(keys, "json") : new Map<string, UpstreamGrant | null>();
  const nowMs = Date.now();
  const candidates: Array<{ key: string; grant: UpstreamGrant | null; runtimeState: GrantRuntimeState | null }> = keys
    .map((key) => {
      const grant = grants.get(key) ?? null;
      return { key, grant, runtimeState: grant ? currentGrantRuntime(grant, pool.states?.[key]) : null };
    });
  const configured = candidates.filter((entry): entry is SelectedGrant => !!entry.grant && entry.grant.enabled !== false && (!entry.grant.provider || entry.grant.provider === providerId) && grantUsable(entry.grant));
  const selected = configured
    .filter((entry) => !excludedKeys.has(entry.key) && !grantCoolingDown(entry.runtimeState, nowMs))
    .sort((a, b) => compareGrants(a, b, nowMs))[0] ?? null;
  return { selected, hasConfiguredGrant: configured.length > 0 };
}

export async function recordGrantRuntime(env: Env, key: string, state: GrantRuntimeState): Promise<void> {
  await authorityCall(env, "/grant-pools/feedback", { key, state });
}

export async function grantRuntimeStates(env: Env, keys: string[]): Promise<Record<string, GrantRuntimeState>> {
  const states: Record<string, GrantRuntimeState> = {};
  for (let offset = 0; offset < keys.length; offset += 66) Object.assign(states, (await authorityCall<{ states: Record<string, GrantRuntimeState> }>(env, "/grant-pools/states", { keys: keys.slice(offset, offset + 66) })).states);
  return states;
}

export function currentGrantRuntime(grant: UpstreamGrant, state: GrantRuntimeState | null | undefined): GrantRuntimeState | null {
  if (!state) return null;
  return state.grantRevision === grantRevision(grant) ? state : null;
}

export function grantRevision(grant: UpstreamGrant): string | null { return grant.updatedAt ?? grant.createdAt ?? null; }

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

function compareGrants(a: SelectedGrant, b: SelectedGrant, nowMs: number): number {
  const priority = grantPriority(a.grant) - grantPriority(b.grant);
  if (priority) return priority;
  const aRatio = grantQuotaRatio(a.runtimeState, nowMs), bRatio = grantQuotaRatio(b.runtimeState, nowMs);
  return (bRatio ?? -1) - (aRatio ?? -1) || a.key.localeCompare(b.key);
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
