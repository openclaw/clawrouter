import { HttpError } from "./utils.ts";
import { assertOperationConfiguration, grantSupports, type GrantRequirement } from "./provider-auth.ts";
import { authorityCall } from "./authority.ts";
import { grantCoolingDown, grantQuotaRatio, grantRuntimeFresh } from "./grant-quota.ts";
import type { AccessPolicyEntry, Env, GrantRoutingPolicy, GrantRuntimeState, UpstreamGrant } from "./types";

const DEFAULT_GRANT_PRIORITY = 100;
const DEFAULT_GRANT_WEIGHT = 1;
export const DEFAULT_GRANT_ROUTING: GrantRoutingPolicy = {
  strategy: "most_remaining",
  stickiness: "none",
  failover: true,
  staleState: "allow",
  staleAfterSeconds: 300,
  switchAtUsedPercent: 90,
  hysteresisPercent: 10,
  eligibleGrants: {},
};

export function grantRoutingPolicy(value: GrantRoutingPolicy | null | undefined): GrantRoutingPolicy {
  if (!value) return { ...DEFAULT_GRANT_ROUTING, eligibleGrants: {} };
  const eligibleGrants: Record<string, string[]> = {};
  if (value.eligibleGrants && typeof value.eligibleGrants === "object" && !Array.isArray(value.eligibleGrants)) {
    for (const [providerId, refs] of Object.entries(value.eligibleGrants)) {
      if (!validGrantSegment(providerId) || !Array.isArray(refs)) continue;
      eligibleGrants[providerId] = [...new Set(refs.filter((ref): ref is string => typeof ref === "string" && validGrantSegment(ref)))].slice(0, 32).sort();
    }
  }
  const strategy = ["priority", "round_robin", "least_used", "most_remaining", "threshold", "weighted_random"].includes(value.strategy) ? value.strategy : DEFAULT_GRANT_ROUTING.strategy;
  return {
    strategy,
    stickiness: strategy === "threshold" ? "none" : ["none", "identity", "session"].includes(value.stickiness) ? value.stickiness : DEFAULT_GRANT_ROUTING.stickiness,
    failover: value.failover !== false,
    staleState: value.staleState === "deny" ? "deny" : "allow",
    staleAfterSeconds: Number.isSafeInteger(value.staleAfterSeconds) && value.staleAfterSeconds >= 30 && value.staleAfterSeconds <= 86_400 ? value.staleAfterSeconds : DEFAULT_GRANT_ROUTING.staleAfterSeconds,
    switchAtUsedPercent: finitePercent(value.switchAtUsedPercent, DEFAULT_GRANT_ROUTING.switchAtUsedPercent),
    hysteresisPercent: finitePercent(value.hysteresisPercent, DEFAULT_GRANT_ROUTING.hysteresisPercent),
    eligibleGrants,
  };
}

export interface SelectedGrant {
  key: string;
  grant: UpstreamGrant;
  runtimeState: GrantRuntimeState | null;
}

export interface GrantSelectionResult {
  selected: SelectedGrant | null;
  hasConfiguredGrant: boolean;
}
export interface PinnedGrant { key: string | null; revision: string | null }

export function grantUsable(grant: UpstreamGrant): boolean {
  if (grant.credentialStore === "durable_object") {
    return grant.credentialStatus !== "reauth_required" && !!(grant.hasCredential || grant.hasAccessToken);
  }
  const scalarCredentials = [grant.credential, grant.accessToken, grant.refreshToken];
  if (scalarCredentials.some((value) => value != null && (typeof value !== "string" || value.trim().length === 0)) || !validCredentialBundle(grant.credentials)) return false;
  const bundled = grant.credentials ? Object.values(grant.credentials) : [];
  return [grant.credential, grant.accessToken, ...bundled].some((value) => typeof value === "string" && value.trim().length > 0);
}

export function validCredentialBundle(value: UpstreamGrant["credentials"]): boolean {
  return value == null || (!Array.isArray(value) && typeof value === "object" && Object.entries(value).every(([name, secret]) => /^[A-Za-z0-9_.-]{1,128}$/.test(name) && typeof secret === "string" && secret.trim().length > 0));
}

export interface GrantCandidates { available: SelectedGrant[]; hasConfiguredGrant: boolean }

export function selectPolicyCandidates<T extends AccessPolicyEntry>(pools: Array<{ entry: T; candidates: GrantCandidates }>, requirement?: GrantRequirement): { entry: T; candidates: GrantCandidates } | undefined {
  const compatible = pools.map(({ entry, candidates }) => ({
    entry,
    candidates: { ...candidates, available: candidates.available.filter(({ grant }) => !requirement || grantSupports(requirement, grant)) },
  }));
  // Policy order is decided by grant/transport availability, never affordability.
  return compatible.find(({ candidates }) => candidates.available.length > 0) ?? compatible[0];
}

export async function policyGrantCandidates<T extends AccessPolicyEntry>(entry: T, providerId: string, env: Env, tokenRef = providerId) {
  // Dispatch and ledgers have always used default for a policy without a tenant.
  const candidates = await resolveGrantCandidates(providerId, entry.policyId, entry.policy.tenantId ?? "default", tokenRef, env, new Set(), entry.policy.grantRouting);
  return { entry, candidates };
}

export async function selectProviderPolicy(entries: AccessPolicyEntry[], providerId: string, env: Env, requirement?: GrantRequirement): Promise<AccessPolicyEntry> {
  const tokenRef = requirement?.provider.auth.schemes.find((scheme) => scheme.type === "oauth")?.tokenRef ?? providerId;
  for (const entry of entries) {
    const pool = await policyGrantCandidates(entry, providerId, env, tokenRef);
    if (selectPolicyCandidates([pool], requirement)!.candidates.available.length) return entry;
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
  routing: GrantRoutingPolicy = DEFAULT_GRANT_ROUTING,
  stickyHash: string | null = null,
): Promise<SelectedGrant | null> {
  return (await resolveGrantSelection(providerId, policyId, tenantId, defaultTokenRef, env, excludedKeys, routing, stickyHash)).selected;
}

export function activeOperationCandidates(available: SelectedGrant[], env: Env, requirement?: GrantRequirement): SelectedGrant[] {
  // Qualification follows policy choice. Preserve the original pool-presence
  // fact so an unusable configured pool cannot fall back to environment auth.
  const configured = requirement ? available.filter(({ grant }) => {
    try { assertOperationConfiguration(requirement, grant, env); return true; }
    catch (error) { if (error instanceof HttpError) return false; throw error; }
  }) : available;
  const priority = configured.length ? Math.min(...configured.map(({ grant }) => grantPriority(grant))) : null;
  return configured.filter(({ grant }) => grantPriority(grant) === priority);
}

export async function resolveGrantSelection(
  providerId: string,
  policyId: string,
  tenantId: string,
  defaultTokenRef: string,
  env: Env,
  excludedKeys: ReadonlySet<string> = new Set(),
  routing: GrantRoutingPolicy = DEFAULT_GRANT_ROUTING,
  stickyHash: string | null = null,
  recordSelection = true,
  pinnedKey?: string | null,
  requirement?: GrantRequirement,
): Promise<GrantSelectionResult> {
  routing = grantRoutingPolicy(routing);
  const { available, hasConfiguredGrant } = await resolveGrantCandidates(providerId, policyId, tenantId, defaultTokenRef, env, excludedKeys, routing, pinnedKey, requirement);
  const nowMs = Date.now();
  const active = activeOperationCandidates(available, env, requirement);
  let selected: SelectedGrant | null = null;
  if (active.length && !recordSelection) selected = active[0];
  else if (active.length) {
    const choice = await authorityCall<{ selectedKey: string }>(env, "/grant-pools/select", {
      poolKey: `${encodeURIComponent(providerId)}/${encodeURIComponent(policyId)}/${encodeURIComponent(tenantId)}`,
      strategy: routing.strategy,
      stickyHash,
      switchAtUsedPercent: routing.switchAtUsedPercent,
      hysteresisPercent: routing.hysteresisPercent,
      candidates: active.map((entry) => ({ key: entry.key, weight: grantWeight(entry.grant), remainingRatio: grantQuotaRatio(entry.runtimeState, nowMs, routing.staleAfterSeconds * 1_000) })),
    });
    selected = active.find((entry) => entry.key === choice.selectedKey) ?? null;
  }
  return { selected, hasConfiguredGrant };
}

export async function resolveGrantCandidates(
  providerId: string, policyId: string, tenantId: string, defaultTokenRef: string, env: Env,
  excludedKeys: ReadonlySet<string> = new Set(), routing: GrantRoutingPolicy = DEFAULT_GRANT_ROUTING,
  pinnedKey?: string | null, requirement?: GrantRequirement,
): Promise<GrantCandidates> {
  routing = grantRoutingPolicy(routing);
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
  const eligibilityRestricted = Object.prototype.hasOwnProperty.call(routing.eligibleGrants, providerId);
  const eligibleRefs = routing.eligibleGrants[providerId] ?? [];
  const available = configured.filter((entry) => {
    if (requirement && !grantSupports(requirement, entry.grant)) return false;
    if (pinnedKey !== undefined && entry.key !== pinnedKey) return false;
    if (excludedKeys.has(entry.key) || grantCoolingDown(entry.runtimeState, nowMs)) return false;
    const scope = parseGrantScope(entry.key);
    if (eligibilityRestricted && (!scope || !eligibleRefs.includes(scope.tokenRef))) return false;
    return routing.staleState !== "deny" || grantRuntimeFresh(entry.runtimeState, routing.staleAfterSeconds * 1_000, nowMs);
  });
  // Transport filtering must not reopen environment auth for a configured pool.
  return { available, hasConfiguredGrant: configured.length > 0 || eligibilityRestricted || routing.staleState === "deny" || typeof pinnedKey === "string" };
}

function finitePercent(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback;
}

export async function recordGrantRuntime(env: Env, key: string, state: GrantRuntimeState): Promise<void> {
  await authorityCall(env, "/grant-pools/feedback", { key, state });
}

export async function grantRuntimeStates(env: Env, keys: string[]): Promise<Record<string, GrantRuntimeState>> {
  const states: Record<string, GrantRuntimeState> = {};
  for (let offset = 0; offset < keys.length; offset += 66) Object.assign(states, (await authorityCall<{ states: Record<string, GrantRuntimeState> }>(env, "/grant-pools/states", { keys: keys.slice(offset, offset + 66) })).states);
  return states;
}

export async function grantSelectionStats(env: Env, keys: string[]): Promise<Record<string, { selectedCount: number; lastSelectedAt: string | null }>> {
  const stats: Record<string, { selectedCount: number; lastSelectedAt: string | null }> = {};
  for (let offset = 0; offset < keys.length; offset += 66) Object.assign(stats, (await authorityCall<{ stats: Record<string, { selectedCount: number; lastSelectedAt: string | null }> }>(env, "/grant-pools/stats", { keys: keys.slice(offset, offset + 66) })).stats);
  return stats;
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

export function grantWeight(grant: UpstreamGrant): number {
  return typeof grant.weight === "number" && Number.isFinite(grant.weight) && grant.weight > 0 && grant.weight <= 1_000_000 ? grant.weight : DEFAULT_GRANT_WEIGHT;
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
