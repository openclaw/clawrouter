import { canonicalFreshIdentityRouting, admitIdentity, admitIdentityCount, identitySourceBudget, readIdentityKv } from "./identity-admission.ts";
import { grantSupports, type GrantRequirement } from "./provider-auth.ts";
import { HttpError } from "./utils.ts";
import { authorityCall, type AdmissionPool } from "./authority.ts";
import { grantQuotaRatio } from "./grant-quota.ts";
export * from "./grant-eligibility.ts";
import { DEFAULT_GRANT_ROUTING, grantRoutingPolicy, activeOperationCandidates, filterGrantCandidates, currentGrantRuntime, grantWeight, grantPriority, poolRetryAt, type SelectedGrant, type GrantCandidates, type GrantSelectionResult } from "./grant-eligibility.ts";
import type { AccessPolicyEntry, Env, GrantRoutingPolicy, GrantRuntimeState, UpstreamGrant } from "./types";

export function selectPolicyCandidates<T extends AccessPolicyEntry>(pools: Array<{ entry: T; candidates: GrantCandidates }>, requirement?: GrantRequirement): { entry: T; candidates: GrantCandidates } | undefined {
  admitIdentity(pools); admitIdentityCount(pools.length, 128);
  let total = 0; for (const pool of pools) { admitIdentityCount(pool.candidates.available.length, 256); total += pool.candidates.available.length; } admitIdentityCount(total, 1024);
  const compatible = pools.map(({ entry, candidates }) => ({
    entry,
    candidates: { ...candidates, available: candidates.available.filter(({ grant }) => !requirement || grantSupports(requirement, grant)) },
  }));
  // Policy order is decided by grant/transport availability, never affordability.
  return compatible.find(({ candidates }) => candidates.available.length > 0) ?? compatible[0];
}

export async function policyGrantCandidates<T extends AccessPolicyEntry>(entry: T, providerId: string, env: Env, tokenRef = providerId, requirement?: GrantRequirement, admittedPool?: AdmissionPool) {
  // Dispatch and ledgers have always used default for a policy without a tenant.
  const candidates = await resolveGrantCandidates(providerId, entry.policyId, entry.policy.tenantId ?? "default", tokenRef, env, new Set(), entry.policy.grantRouting, undefined, requirement, admittedPool);
  return { entry, candidates };
}

export async function selectProviderPolicy(entries: AccessPolicyEntry[], providerId: string, env: Env, requirement?: GrantRequirement): Promise<AccessPolicyEntry> {
  const tokenRef = requirement?.provider.auth.schemes.find((scheme) => scheme.type === "oauth")?.tokenRef ?? providerId;
  for (const entry of entries) {
    const pool = await policyGrantCandidates(entry, providerId, env, tokenRef, requirement);
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
  admittedPool?: AdmissionPool,
): Promise<GrantSelectionResult> {
  admitIdentity(routing, "record");
  routing = canonicalFreshIdentityRouting(grantRoutingPolicy(routing));
  const candidates = await resolveGrantCandidates(providerId, policyId, tenantId, defaultTokenRef, env, excludedKeys, routing, pinnedKey, requirement, admittedPool);
  const { available, hasConfiguredGrant } = candidates;
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
      candidates: active.map((entry) => ({ key: entry.key, weight: grantWeight(entry.grant), remainingRatio: grantQuotaRatio(entry.runtimeState, nowMs, routing.staleAfterSeconds * 1_000, requirement?.model) })),
    });
    selected = active.find((entry) => entry.key === choice.selectedKey) ?? null;
  }
  const retryAt = selected ? undefined : poolRetryAt(candidates, env, requirement);
  return { selected, hasConfiguredGrant, ...(retryAt ? { retryAt } : {}) };
}

export async function resolveGrantCandidates(
  providerId: string, policyId: string, tenantId: string, defaultTokenRef: string, env: Env,
  excludedKeys: ReadonlySet<string> = new Set(), routing: GrantRoutingPolicy = DEFAULT_GRANT_ROUTING,
  pinnedKey?: string | null, requirement?: GrantRequirement,
  admittedPool?: AdmissionPool,
  privateCopilot = false,
): Promise<GrantCandidates> {
  admitIdentity(routing, "record");
  routing = canonicalFreshIdentityRouting(grantRoutingPolicy(routing));
  const source = identitySourceBudget();
  if (privateCopilot) admitIdentityCount((routing.eligibleGrants[providerId] ?? []).length * 2 + 2, 256);
  const defaultKeys = [
    `oauth/${policyId}/${defaultTokenRef}`,
    `oauth/tenants/${tenantId}/${defaultTokenRef}`,
    // Private Copilot tokens intentionally remain reauth_required for generic
    // materialization, so the active generic pool cannot enumerate them. The
    // CURRENT policy's explicit references may nominate original scoped owners;
    // only the private owner can qualify their device/account authority.
    ...(privateCopilot ? (routing.eligibleGrants[providerId] ?? []).flatMap(ref => [
      `oauth/${policyId}/${ref}`, `oauth/tenants/${tenantId}/${ref}`,
    ]) : []),
  ];
  const pool = admittedPool ?? await authorityCall<{ keys: string[]; states?: Record<string, GrantRuntimeState> }>(env, "/grant-pools/resolve", { providerId, policyId, tenantId, defaultKeys }, "policy-bindings", undefined, undefined, undefined, undefined, undefined, source);
  if (admittedPool?.unavailable) throw new Error("admission pool resolution failed");
  if (privateCopilot && (providerId !== "github-copilot" || pool.keys.length > 128)) throw new HttpError(503, "copilot_owner_unavailable", "Original Copilot owner unavailable");
  admitIdentity(pool); admitIdentityCount(defaultKeys.length + pool.keys.length, 256);
  const keys = [...new Set([...defaultKeys, ...pool.keys])];
  if (privateCopilot && keys.length > 128) throw new HttpError(503, "copilot_owner_unavailable", "Original Copilot owner unavailable");
  const grants = new Map<string, UpstreamGrant | null>();
  for (const key of keys) grants.set(key, await readIdentityKv<UpstreamGrant>(() => env.POLICY_KV.get(key, "stream"), source));
  const nowMs = Date.now();
  const candidates: Array<{ key: string; grant: UpstreamGrant | null; runtimeState: GrantRuntimeState | null }> = keys
    .map((key) => {
      const grant = grants.get(key) ?? null;
      return { key, grant, runtimeState: grant ? currentGrantRuntime(grant, pool.states?.[key]) : null };
    });
  return filterGrantCandidates(providerId, candidates, excludedKeys, routing, pinnedKey, requirement, nowMs, privateCopilot);
}

// Route/provider are known before input; model permission is deliberately NOT
// decided here. Choose once within the original policy/tenant, then pin this
// owner through model qualification. Never retry a different owner after read.
export async function selectCopilotPublicGrant(policyId: string, policy: import("./types.ts").AccessPolicy, env: Env,
  tokenRef: string, stickyHash: string | null = null): Promise<SelectedGrant> {
  admitIdentity(policy.grantRouting ?? DEFAULT_GRANT_ROUTING, "record");
  const routing = canonicalFreshIdentityRouting(grantRoutingPolicy(policy.grantRouting)), tenant = policy.tenantId ?? "default";
  const candidates = await resolveGrantCandidates("github-copilot", policyId, tenant, tokenRef, env, new Set(), routing, undefined, undefined, undefined, true);
  const scoped = candidates.available.filter(entry => entry.key.startsWith(`oauth/${policyId}/`) || entry.key.startsWith(`oauth/tenants/${tenant}/`));
  const priority = scoped.length ? Math.min(...scoped.map(entry => grantPriority(entry.grant))) : null;
  const available = scoped.filter(entry => grantPriority(entry.grant) === priority);
  if (!available.length) throw new HttpError(503, "copilot_owner_unavailable", "Original Copilot owner unavailable");
  const choice = await authorityCall<{ selectedKey: string }>(env, "/grant-pools/select", {
    poolKey: `${encodeURIComponent("github-copilot")}/${encodeURIComponent(policyId)}/${encodeURIComponent(tenant)}`,
    strategy: routing.strategy, stickyHash, switchAtUsedPercent: routing.switchAtUsedPercent, hysteresisPercent: routing.hysteresisPercent,
    candidates: available.map(entry => ({ key: entry.key, weight: grantWeight(entry.grant), remainingRatio: grantQuotaRatio(entry.runtimeState, Date.now(), routing.staleAfterSeconds * 1_000) })),
  });
  const selected = available.find(entry => entry.key === choice.selectedKey);
  if (!selected) throw new HttpError(503, "copilot_owner_unavailable", "Original Copilot owner unavailable");
  return selected;
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
