import { admitAdmission, admitIdentity, admitIdentityBytes, admitIdentityCount, identityJson, isIdentityFailure, parseIdentity, readIdentityKv, type IdentitySourceBudget } from "./identity-admission.ts";
import { videoControlVersion, videoControlBytes, videoJsonBytes } from "./minimax-video-operation.ts";
import { inspectSearchJson, searchControlVersion, searchControlBytes, searchJsonBytes, searchUnavailable } from "./minimax-search-operation.ts";
import { credentialExpired } from "./credential-lifecycle.ts";
import snapshotJson from "./generated/provider-snapshot.json" with { type: "json" };
import type { AccessControlUser, AccessPolicyEntry, CompiledEndpoint, CompiledProvider, Env, GrantRuntimeState, ProviderConnection, ProviderSnapshot, ProxyCredentialEntry, UpstreamGrant } from "./types";
import type { AdmissionPool, AdmissionPoolCandidate, AdmissionPoolSnapshot, AdmissionRequest, AdmissionResult, AdmissionSelection } from "./authority-admission.ts";
import type { GrantSelectionResult } from "./grant-eligibility.ts";
import type { GrantChoiceInput } from "./grant-selection-strategies.ts";
import type { GrantAttachmentSnapshot } from "./authority.ts";
import { routingProjection } from "./grant-projection.ts";
import { activeOperationCandidates, filterGrantCandidates, currentGrantRuntime, grantRoutingPolicy, grantWeight, poolRetryAt } from "./grant-eligibility.ts";
import { grantQuotaRatio } from "./grant-quota.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { normalizeEmail, safeEqual, sha256Hex } from "./utils.ts";
import { musicCoverControlVersion, musicCoverUnavailable } from "./minimax-music-cover-control.ts";
import { miniMaxMusicCoverProjection } from "./native-media-credential.ts";

interface SelectionStore {
  identity?: IdentitySourceBudget;
  afterAdmission?(action: () => void): void;
  planGrant?(input: GrantChoiceInput & { poolKey: string }): { result: { selectedKey: string; selectedCount: number; lastSelectedAt: string }; state?: { cursorKey: string | null; counts: Record<string, { count: number; lastMs: number }> }; commit(): void };
  consumeProjectionBytes?(bytes: number, text?: string): void;
  getCredential(id: string): ProxyCredentialEntry | null;
  getPolicy(id: string): AccessPolicyEntry | null;
  getUser(email: string): AccessControlUser | null;
  resolveConnections(ids: string[]): { connections: ProviderConnection[] };
  resolveGrantPool(input: { providerId: string; policyId: string; tenantId: string; defaultKeys: string[] }): AdmissionPool;
  grantAttachment(key: string): GrantAttachmentSnapshot;
  selectGrant(input: GrantChoiceInput & { poolKey: string }): { selectedKey: string };
  selectionState(poolKey: string): { cursorKey: string | null; counts: Record<string, { count: number; lastMs: number }> };
}
function rows<T>(cursor: Iterable<T>): T[] { return Array.from(cursor); }

export async function finishAdmissionSelection(env: Env, storage: DurableObjectStorage, input: AdmissionRequest, result: AdmissionResult, store: SelectionStore): Promise<AdmissionResult> {
  if (input.cover === musicCoverControlVersion) return finishCoverSelection(env, storage, input, result, store);
  const sql = storage.sql;
  const request = input.selection!;
  const provider = (snapshotJson as unknown as ProviderSnapshot).providers.find(item => item.id === request.providerId);
  const endpoint = provider?.endpoints.find(item => item.id === request.endpointId);
  if (!provider || !endpoint || !result.policy || result.connectionsUnavailable || result.pools[provider.id]?.unavailable) return result;
  const poolInput = { providerId: provider.id, policyId: result.policy.policyId, tenantId: result.policy.policy.tenantId ?? "default", defaultKeys: [`oauth/${result.policy.policyId}/${provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id}`, `oauth/tenants/${result.policy.policy.tenantId ?? "default"}/${provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id}`] };
  const keys = store.resolveGrantPool(poolInput).keys;
  // One bounded import attempt per key. Recheck both the row marker and the
  // attachment revision after KV yields; an owner publication always wins.
  if ((input.search === searchControlVersion || input.video === videoControlVersion) && keys.length > 32) searchUnavailable();
  if (store.identity) { admitIdentityCount(keys.length, 256); admitIdentity(keys); }
  const missing = keys.filter(key => !rows(sql.exec("SELECT 1 FROM upstream_grant_projections WHERE grant_key = ?", key)).length);
  if ((input.search === searchControlVersion || input.video === videoControlVersion) && missing.length) searchUnavailable();
  const versions = new Map(missing.map(key => [key, store.grantAttachment(key).revision]));
  let backfillFailed = false;
  const staged = new Map<string, { text: string | null; legacy: number; revision: number }>();
  if (missing.length) {
    try {
      const grants = store.identity ? new Map<string, UpstreamGrant | null>() : await env.POLICY_KV.get<UpstreamGrant>(missing, "json");
      if (store.identity) for (const key of missing) grants.set(key, await readIdentityKv<UpstreamGrant>(() => env.POLICY_KV.get(key, "stream"), store.identity!));
      storage.transactionSync(() => {
        for (const key of missing) {
          if (rows(sql.exec("SELECT 1 FROM upstream_grant_projections WHERE grant_key = ?", key)).length || store.grantAttachment(key).revision !== versions.get(key)) continue;
          const grant = grants.get(key);
          const version = store.grantAttachment(key);
          if (!grant && (version.attached || version.pending || version.generation > 0)) continue;
          const legacy = !!grant && (grant.credentialStore !== "durable_object" || grant.credentialGeneration !== version.generation || version.pending);
          const text = grant && !legacy ? (store.identity ? (admitIdentity(grant, "record"), identityJson(routingProjection(grant), "record")) : JSON.stringify(routingProjection(grant))) : null;
          if (store.identity) staged.set(key, { text, legacy: legacy ? 1 : 0, revision: version.revision });
          else sql.exec("INSERT INTO upstream_grant_projections (grant_key, projection_json, legacy) VALUES (?, ?, ?)", key, text, legacy ? 1 : 0);
        }
      });
    } catch (error) { if (isIdentityFailure(error)) throw error; backfillFailed = true; } // Migration failures retain the old read path.
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
    if (!credential || !policy || !credential.credential.enabled || credentialExpired(credential.credential) || !policy.policy.enabled || credential.credential.policyGeneration !== policy.policy.generation || owner?.record.enabled === false || !input.secretSha256 || !safeEqual(input.secretSha256, credential.credential.secretSha256)) return fresh;
    if (credential.credential.principalId !== result.credential!.credential.principalId || policy.policyId !== poolInput.policyId || (policy.policy.tenantId ?? "default") !== poolInput.tenantId) return { ...fresh, pools: {} };
    fresh.connections = store.resolveConnections((input.providers ?? []).map(item => item.id)).connections;
    if (policy.policy.providers.length && !policy.policy.providers.includes(provider.id) || fresh.connections.find(item => item.providerId === provider.id)?.enabled === false) return fresh;
    try { assertPolicyModel(policy.policy, { model: request.catalogModelId ? { id: request.catalogModelId } : null, endpoint, capability: request.capability }); } catch { return fresh; }
    const pool = store.resolveGrantPool(poolInput);
    fresh.pools = { ...fresh.pools, [provider.id]: pool };
    if (backfillFailed) return fresh;
    const video = input.video === videoControlVersion;
    const search = input.search === searchControlVersion || video;
    const controlBytes = video ? videoControlBytes : searchControlBytes;
    if (search) {
      if (pool.keys.length > 32) searchUnavailable();
      let bytes = 0;
      // Count before retrieving projection_json, on the post-hash reread too.
      for (const key of pool.keys) {
        const bound = rows<{ bytes: number; legacy: number }>(sql.exec("SELECT length(CAST(projection_json AS BLOB)) AS bytes, legacy FROM upstream_grant_projections WHERE grant_key = ?", key))[0];
        const attachment = store.grantAttachment(key);
        if (!bound || bound.legacy || !Number.isSafeInteger(bound.bytes) || bound.bytes < 1
          || (bytes += bound.bytes) > controlBytes || attachment.pending) searchUnavailable();
      }
      store.consumeProjectionBytes?.(bytes);
    }
    if (store.identity) {
      // Admit ALL known projection sizes before retrieving the first value.
      for (const key of pool.keys) {
        const row = rows<{ bytes: number | null }>(sql.exec("SELECT length(CAST(projection_json AS BLOB)) AS bytes FROM upstream_grant_projections WHERE grant_key = ?", key))[0];
        if (row?.bytes != null) admitIdentityBytes(store.identity, row.bytes);
      }
    }
    const candidates: AdmissionPoolCandidate[] = [];
    for (const key of pool.keys) {
      let row = rows<{ projection_json: string | null; legacy: number }>(sql.exec("SELECT projection_json, legacy FROM upstream_grant_projections WHERE grant_key = ?", key))[0];
      const pending = staged.get(key); let usedStaged = false;
      if (!row && pending && store.grantAttachment(key).revision === pending.revision) {
        // The already-admitted private projection is not another original SQL read.
        usedStaged = true; row = { projection_json: pending.text, legacy: pending.legacy };
        store.afterAdmission!(() => sql.exec("INSERT OR IGNORE INTO upstream_grant_projections (grant_key, projection_json, legacy) VALUES (?, ?, ?)", key, pending.text, pending.legacy));
      }
      if (!row || row.legacy) return fresh;
      if (search && row.projection_json) {
        if (video) store.consumeProjectionBytes?.(0, row.projection_json);
        else inspectSearchJson(row.projection_json);
      }
      candidates.push({ key, grant: row.projection_json ? (store.identity && !usedStaged ? parseIdentity(row.projection_json, store.identity) : JSON.parse(row.projection_json)) as UpstreamGrant : null });
    }
    const poolKey = `${encodeURIComponent(provider.id)}/${encodeURIComponent(policy.policyId)}/${encodeURIComponent(poolInput.tenantId)}`;
    const revision = (key: string) => store.grantAttachment(key).revision;
    let planned: ReturnType<NonNullable<SelectionStore["planGrant"]>> | undefined;
    const snapshot = (): AdmissionPoolSnapshot => {
      const state = planned?.state ?? store.selectionState(poolKey);
      return { poolKey, candidates, revisions: Object.fromEntries(candidates.map(({ key }) => [key, revision(key)])), cursorKey: state.cursorKey, counts: state.counts, identityHash, fallbackSessionHash };
    };
    if (input.snapshot === "only") {
      const reply = { ...fresh, snapshots: { [provider.id]: snapshot() } };
      if (store.identity) admitAdmission(reply); return reply;
    }
    const selection = selectAdmissionCandidate(env, { provider, endpoint, request, policy, poolKey, candidates, states: pool.states, identityHash, fallbackSessionHash }, choice => {
      if (!store.identity) return store.selectGrant(choice);
      planned = store.planGrant!(choice); return planned.result;
    }, revision);
    if (search) (video ? videoJsonBytes : searchJsonBytes)({ ...fresh, selection });
    const reply = { ...fresh, selection, ...(input.snapshot === "select" ? { snapshots: { [provider.id]: snapshot() } } : {}) };
    if (store.identity) admitAdmission(reply);
    if (planned) store.afterAdmission!(planned.commit); // Final serialization precedes all selected writes.
    return reply;
  });
}

// Private canonical selection does not depend on, or add to, generated cards.
// Its profile is not eligible through the generic provider grant predicate.
async function finishCoverSelection(env: Env, storage: DurableObjectStorage, input: AdmissionRequest, result: AdmissionResult, store: SelectionStore): Promise<AdmissionResult> {
  if (!result.credential || !result.policy || result.ownerUnavailable || result.connectionsUnavailable || result.pools.minimax?.unavailable) musicCoverUnavailable();
  const identity = result.credential.credential.principalId ?? result.credential.credentialId;
  const identityHash = await sha256Hex(`identity:${identity}`);
  return storage.transactionSync(() => {
    const credential = store.getCredential(input.credentialId), policy = credential ? store.getPolicy(credential.credential.policyId) : null;
    const principal = credential?.credential.principalId;
    const owner = principal ? store.getUser(principal) : null;
    if (!credential || !policy || !credential.credential.enabled || credentialExpired(credential.credential)
      || !policy.policy.enabled || credential.credential.policyGeneration !== policy.policy.generation
      || principal && owner?.record.enabled !== true || !input.secretSha256 || !safeEqual(input.secretSha256, credential.credential.secretSha256)
      || credential.credential.principalId !== result.credential!.credential.principalId || policy.policyId !== result.policy!.policyId
      || policy.policy.providers.length && !policy.policy.providers.includes("minimax")
      || policy.policy.models != null && !policy.policy.models.includes("minimax/music-cover")) musicCoverUnavailable(403);
    const connections = store.resolveConnections(["minimax"]).connections;
    if (connections.length !== 1 || connections[0].providerId !== "minimax" || !connections[0].enabled) musicCoverUnavailable();
    const pool = store.resolveGrantPool({ providerId: "minimax", policyId: policy.policyId, tenantId: policy.policy.tenantId ?? "default", defaultKeys: [] });
    if (pool.unavailable || !pool.hasAttachment || !pool.keys.length || pool.keys.length > 32) musicCoverUnavailable();
    let bytes = 0;
    // Whole candidate preflight precedes retrieving/parsing ANY projection.
    for (const key of pool.keys) {
      const bound = rows<{ bytes: number; legacy: number }>(storage.sql.exec("SELECT length(CAST(projection_json AS BLOB)) AS bytes, legacy FROM upstream_grant_projections WHERE grant_key = ?", key))[0];
      const attachment = store.grantAttachment(key);
      if (!bound || bound.legacy || attachment.pending || !attachment.attached || !Number.isSafeInteger(bound.bytes)
        || bound.bytes < 1 || (bytes += bound.bytes) > searchControlBytes) musicCoverUnavailable();
    }
    store.consumeProjectionBytes?.(bytes);
    const candidates = pool.keys.map(key => {
      const row = rows<{ projection_json: string }>(storage.sql.exec("SELECT projection_json FROM upstream_grant_projections WHERE grant_key = ?", key))[0];
      inspectSearchJson(row.projection_json);
      const grant = JSON.parse(row.projection_json) as UpstreamGrant;
      return { key, grant: miniMaxMusicCoverProjection(grant) && grant.credentialGeneration === store.grantAttachment(key).generation ? grant : null,
        runtimeState: currentGrantRuntime(grant, pool.states[key]) };
    });
    const routing = grantRoutingPolicy(policy.policy.grantRouting), now = Date.now();
    const filtered = filterGrantCandidates("minimax", candidates, new Set(), routing, undefined, undefined, now);
    const active = activeOperationCandidates(filtered.available, env);
    if (!active.length) musicCoverUnavailable(403);
    const poolKey = `${encodeURIComponent("minimax")}/${encodeURIComponent(policy.policyId)}/${encodeURIComponent(policy.policy.tenantId ?? "default")}`;
    const choice = store.selectGrant({ poolKey, strategy: routing.strategy,
      stickyHash: routing.stickiness === "identity" || routing.stickiness === "session" ? identityHash : null,
      switchAtUsedPercent: routing.switchAtUsedPercent, hysteresisPercent: routing.hysteresisPercent,
      candidates: active.map(item => ({ key: item.key, weight: grantWeight(item.grant),
        remainingRatio: grantQuotaRatio(item.runtimeState, now, routing.staleAfterSeconds * 1000, "music-cover") })) });
    const selected = active.find(item => item.key === choice.selectedKey);
    if (!selected) musicCoverUnavailable();
    const fresh: AdmissionResult = { credential, policy, owner, connections, pools: { minimax: pool },
      selection: { selected: { ...selected, authorityRevision: store.grantAttachment(selected.key).revision }, hasConfiguredGrant: true } };
    searchJsonBytes(fresh); return fresh;
  });
}

// One owner of candidate filtering and strategy dispatch for both the
// authority transaction and the Worker's isolate-local snapshot selection.
export function selectAdmissionCandidate(
  env: Env,
  input: { provider: CompiledProvider; endpoint: CompiledEndpoint; request: AdmissionSelection; policy: AccessPolicyEntry; poolKey: string; candidates: readonly AdmissionPoolCandidate[]; states: Record<string, GrantRuntimeState>; identityHash: string; fallbackSessionHash: string },
  choose: (choice: GrantChoiceInput & { poolKey: string }) => { selectedKey: string } | null,
  revision: (key: string) => number | undefined,
): GrantSelectionResult {
  const { provider, endpoint, request, policy } = input;
  const routing = grantRoutingPolicy(policy.policy.grantRouting), now = Date.now();
  const requirement = { provider, endpoint, mode: request.mode, model: request.model };
  const candidates = input.candidates.map(({ key, grant }) => ({ key, grant, runtimeState: grant ? currentGrantRuntime(grant, input.states[key]) : null }));
  const filtered = filterGrantCandidates(provider.id, candidates, new Set(request.excludedKeys ?? []), routing, request.pinnedKey, requirement, now);
  const { available, hasConfiguredGrant } = filtered;
  const active = activeOperationCandidates(available, env, requirement);
  const stickyHash = routing.stickiness === "identity" ? input.identityHash : routing.stickiness === "session" ? request.sessionHash ?? input.fallbackSessionHash : null;
  const choice = active.length ? choose({ poolKey: input.poolKey, strategy: routing.strategy, stickyHash, switchAtUsedPercent: routing.switchAtUsedPercent, hysteresisPercent: routing.hysteresisPercent, candidates: active.map(item => ({ key: item.key, weight: grantWeight(item.grant), remainingRatio: grantQuotaRatio(item.runtimeState, now, routing.staleAfterSeconds * 1000, request.model) })) }) : null;
  const selected = active.find(item => item.key === choice?.selectedKey) ?? null;
  const retryAt = selected ? undefined : poolRetryAt(filtered, env, requirement);
  return { selected: selected ? { ...selected, authorityRevision: revision(selected.key) } : null, hasConfiguredGrant, ...(retryAt ? { retryAt } : {}) };
}
