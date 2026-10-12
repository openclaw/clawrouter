import snapshotJson from "./generated/provider-snapshot.json" with { type: "json" };
import type { AccessControlUser, AccessPolicyEntry, Env, ProviderConnection, ProviderSnapshot, ProxyCredentialEntry, UpstreamGrant } from "./types";
import type { AdmissionPool, AdmissionRequest, AdmissionResult } from "./authority-admission.ts";
import type { GrantAttachmentSnapshot } from "./authority.ts";
import { routingProjection } from "./grant-projection.ts";
import { activeOperationCandidates, filterGrantCandidates, currentGrantRuntime, grantRoutingPolicy, grantWeight } from "./grant-eligibility.ts";
import { grantQuotaRatio } from "./grant-quota.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { normalizeEmail, safeEqual, sha256Hex } from "./utils.ts";

interface SelectionStore {
  getCredential(id: string): ProxyCredentialEntry | null;
  getPolicy(id: string): AccessPolicyEntry | null;
  getUser(email: string): AccessControlUser | null;
  resolveConnections(ids: string[]): { connections: ProviderConnection[] };
  resolveGrantPool(input: { providerId: string; policyId: string; tenantId: string; defaultKeys: string[] }): AdmissionPool;
  grantAttachment(key: string): GrantAttachmentSnapshot;
  selectGrant(input: { poolKey: string; strategy: string; stickyHash: string | null; switchAtUsedPercent: number; hysteresisPercent: number; candidates: Array<{ key: string; weight: number; remainingRatio: number | null }> }): { selectedKey: string };
}
function rows<T>(cursor: Iterable<T>): T[] { return Array.from(cursor); }

export async function finishAdmissionSelection(env: Env, storage: DurableObjectStorage, input: AdmissionRequest, result: AdmissionResult, store: SelectionStore): Promise<AdmissionResult> {
  const sql = storage.sql;
  const request = input.selection!;
  const provider = (snapshotJson as unknown as ProviderSnapshot).providers.find(item => item.id === request.providerId);
  const endpoint = provider?.endpoints.find(item => item.id === request.endpointId);
  if (!provider || !endpoint || !result.policy || result.connectionsUnavailable || result.pools[provider.id]?.unavailable) return result;
  const poolInput = { providerId: provider.id, policyId: result.policy.policyId, tenantId: result.policy.policy.tenantId ?? "default", defaultKeys: [`oauth/${result.policy.policyId}/${provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id}`, `oauth/tenants/${result.policy.policy.tenantId ?? "default"}/${provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id}`] };
  const keys = store.resolveGrantPool(poolInput).keys;
  // One bounded import attempt per key. Recheck both the row marker and the
  // attachment revision after KV yields; an owner publication always wins.
  const missing = keys.filter(key => !rows(sql.exec("SELECT 1 FROM upstream_grant_projections WHERE grant_key = ?", key)).length);
  const versions = new Map(missing.map(key => [key, store.grantAttachment(key).revision]));
  let backfillFailed = false;
  if (missing.length) {
    try {
      const grants = await env.POLICY_KV.get<UpstreamGrant>(missing, "json");
      storage.transactionSync(() => {
        for (const key of missing) {
          if (rows(sql.exec("SELECT 1 FROM upstream_grant_projections WHERE grant_key = ?", key)).length || store.grantAttachment(key).revision !== versions.get(key)) continue;
          const grant = grants.get(key);
          const version = store.grantAttachment(key);
          if (!grant && (version.attached || version.pending || version.generation > 0)) continue;
          const legacy = !!grant && (grant.credentialStore !== "durable_object" || grant.credentialGeneration !== version.generation || version.pending);
          sql.exec("INSERT INTO upstream_grant_projections (grant_key, projection_json, legacy) VALUES (?, ?, ?)", key, grant && !legacy ? JSON.stringify(routingProjection(grant)) : null, legacy ? 1 : 0);
        }
      });
    } catch { backfillFailed = true; } // Migration failures retain the old read path.
  }
  const identity = result.credential!.credential.principalId ?? result.credential!.credentialId;
  const [identityHash, fallbackSessionHash] = await Promise.all([sha256Hex(`identity:${identity}`), sha256Hex(`session:${identity}`)]);
  return storage.transactionSync(() => {
    // Imports/hashing yielded. Reread authorization and the entire pool before
    // filtering and updating counters in this same synchronous transaction.
    const credential = store.getCredential(input.credentialId);
    const policy = credential ? store.getPolicy(credential.credential.policyId) : null;
    const owner = credential?.credential.principalId ? store.getUser(normalizeEmail(credential.credential.principalId) ?? credential.credential.principalId) : null;
    const fresh: AdmissionResult = { ...result, credential, policy, owner };
    if (!credential || !policy || !credential.credential.enabled || !policy.policy.enabled || credential.credential.policyGeneration !== policy.policy.generation || owner?.record.enabled === false || !input.secretSha256 || !safeEqual(input.secretSha256, credential.credential.secretSha256)) return fresh;
    if (credential.credential.principalId !== result.credential!.credential.principalId || policy.policyId !== poolInput.policyId || (policy.policy.tenantId ?? "default") !== poolInput.tenantId) return { ...fresh, pools: {} };
    fresh.connections = store.resolveConnections((input.providers ?? []).map(item => item.id)).connections;
    if (policy.policy.providers.length && !policy.policy.providers.includes(provider.id) || fresh.connections.find(item => item.providerId === provider.id)?.enabled === false) return fresh;
    try { assertPolicyModel(policy.policy, { model: request.catalogModelId ? { id: request.catalogModelId } : null, endpoint, capability: request.capability }); } catch { return fresh; }
    const pool = store.resolveGrantPool(poolInput);
    fresh.pools = { ...fresh.pools, [provider.id]: pool };
    if (backfillFailed) return fresh;
    const candidates = [];
    for (const key of pool.keys) {
      const row = rows<{ projection_json: string | null; legacy: number }>(sql.exec("SELECT projection_json, legacy FROM upstream_grant_projections WHERE grant_key = ?", key))[0];
      if (!row || row.legacy) return fresh;
      const grant = row.projection_json ? JSON.parse(row.projection_json) as UpstreamGrant : null;
      candidates.push({ key, grant, runtimeState: grant ? currentGrantRuntime(grant, pool.states[key]) : null });
    }
    const routing = grantRoutingPolicy(policy.policy.grantRouting), now = Date.now();
    const requirement = { provider, endpoint, mode: request.mode, model: request.model };
    const { available, hasConfiguredGrant } = filterGrantCandidates(provider.id, candidates, new Set(request.excludedKeys ?? []), routing, undefined, requirement, now);
    const active = activeOperationCandidates(available, env, requirement);
    const stickyHash = routing.stickiness === "identity" ? identityHash : routing.stickiness === "session" ? request.sessionHash ?? fallbackSessionHash : null;
    const choice = active.length ? store.selectGrant({ poolKey: `${encodeURIComponent(provider.id)}/${encodeURIComponent(policy.policyId)}/${encodeURIComponent(poolInput.tenantId)}`, strategy: routing.strategy, stickyHash, switchAtUsedPercent: routing.switchAtUsedPercent, hysteresisPercent: routing.hysteresisPercent, candidates: active.map(item => ({ key: item.key, weight: grantWeight(item.grant), remainingRatio: grantQuotaRatio(item.runtimeState, now, routing.staleAfterSeconds * 1000, request.model) })) }) : null;
    const selected = active.find(item => item.key === choice?.selectedKey) ?? null;
    return { ...fresh, selection: { selected: selected ? { ...selected, authorityRevision: store.grantAttachment(selected.key).revision } : null, hasConfiguredGrant } };
  });
}

