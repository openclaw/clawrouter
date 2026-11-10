import { identityPlan, identityUtf8, identityFailure, admitAdmission, admitIdentity, admitIdentityBytes, admitIdentityCount, identityJson, isIdentityFailure, parseIdentity, readIdentityKv, type IdentitySourceBudget } from "./identity-admission.ts";
import { videoControlVersion, videoControlBytes, videoJsonBytes } from "./minimax-video-operation.ts";
import { inspectSearchJson, searchControlVersion, searchControlBytes, searchJsonBytes, searchUnavailable } from "./minimax-search-operation.ts";
import { credentialExpired } from "./credential-lifecycle.ts";
import snapshotJson from "./generated/provider-snapshot.json" with { type: "json" };
import type { AccessControlUser, AccessPolicyEntry, CompiledEndpoint, CompiledProvider, Env, GrantRuntimeState, ProviderConnection, ProviderSnapshot, ProxyCredentialEntry, UpstreamGrant } from "./types";
import type { AdmissionPool, AdmissionPoolCandidate, AdmissionPoolSnapshot, AdmissionRequest, AdmissionResult, AdmissionSelection } from "./authority-admission.ts";
import type { GrantSelectionResult } from "./grant-eligibility.ts";
import type { GrantChoiceInput } from "./grant-selection-strategies.ts";
import type { AdmissionJournalEntry, GrantAttachmentSnapshot } from "./authority.ts";
import { routingProjection } from "./grant-projection.ts";
import { activeOperationCandidates, filterGrantCandidates, currentGrantRuntime, grantRoutingPolicy, grantPriority, grantWeight, poolRetryAt } from "./grant-eligibility.ts";
import { privateGrantRoutingPolicy, planPrivateGrantRouting } from "./grant-routing.ts";
import { assertOperationConfiguration, type GrantRequirement } from "./provider-auth.ts";
import { isPreparationLimit, PreparationAdmission } from "./provider-templates.ts";
import type { AdmissionScratchVector } from "./credential-preflight-arena.ts";
import { grantQuotaRatio } from "./grant-quota.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { HttpError, normalizeEmail, safeEqual, sha256Hex } from "./utils.ts";
import { musicCoverControlVersion, musicCoverUnavailable } from "./minimax-music-cover-control.ts";
import { miniMaxMusicCoverProjection } from "./native-media-credential.ts";

interface SelectionStore {
  identity?: IdentitySourceBudget;
  privateBridge?: {
    read(key: string): Promise<UpstreamGrant | null>;
    connections(providers: NonNullable<AdmissionRequest["providers"]>): ProviderConnection[];
    pool(input: { providerId: string; policyId: string; tenantId: string }, tokenRef: string): AdmissionPool;
    choice<T>(run: () => T): T;
    scratch<T>(vector: AdmissionScratchVector, run: () => T, retained?: boolean): T;
    materialize<T>(bytes: number, run: () => T): T;
    current(result: AdmissionResult): void;
    hashes(identity: string): Promise<[string, string]>;
    stage(entry?: AdmissionJournalEntry): void;
    projection(key: string): Extract<AdmissionJournalEntry, { kind: "projection" }> | undefined;
  };
  afterAdmission?(action: () => void): void;
  planGrant?(input: GrantChoiceInput & { poolKey: string }): { result: { selectedKey: string; selectedCount: number; lastSelectedAt: string }; state?: { cursorKey: string | null; counts: Record<string, { count: number; lastMs: number }> }; commit?: () => void; journal?: Extract<AdmissionJournalEntry, { kind: "selection" }> };
  consumeProjectionBytes?(bytes: number, text?: string): void;
  getCredential(id: string): ProxyCredentialEntry | null;
  getPolicy(id: string): AccessPolicyEntry | null;
  getUser(email: string): AccessControlUser | null;
  resolveConnections(ids: string[]): { connections: ProviderConnection[] };
  resolveGrantPool(input: { providerId: string; policyId: string; tenantId: string; defaultKeys?: string[] }): AdmissionPool;
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
  const tokenRef = provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id;
  const poolInput = { providerId: provider.id, policyId: result.policy.policyId, tenantId: result.policy.policy.tenantId ?? "default",
    defaultKeys: store.privateBridge ? undefined : [`oauth/${result.policy.policyId}/${tokenRef}`, `oauth/tenants/${result.policy.policy.tenantId ?? "default"}/${tokenRef}`] };
  const resolvePool = () => store.privateBridge ? store.privateBridge.pool(poolInput, tokenRef) : store.resolveGrantPool(poolInput);
  const keys = resolvePool().keys;
  // One bounded import attempt per key. Recheck both the row marker and the
  // attachment revision after KV yields; an owner publication always wins.
  if ((input.search === searchControlVersion || input.video === videoControlVersion) && keys.length > 32) searchUnavailable();
  if (store.identity) { admitIdentityCount(keys.length, 256); admitIdentity(keys); }
  const missing = store.privateBridge ? [] : keys.filter(key => !rows(sql.exec("SELECT 1 FROM upstream_grant_projections WHERE grant_key = ?", key)).length);
  if ((input.search === searchControlVersion || input.video === videoControlVersion) && missing.length) searchUnavailable();
  const versions = store.privateBridge ? undefined : new Map(missing.map(key => [key, store.grantAttachment(key).revision]));
  let backfillFailed = false;
  const staged = store.privateBridge ? undefined : new Map<string, { text: string | null; legacy: number; revision: number }>();
  if (store.privateBridge) for (const key of keys) {
    if (rows(sql.exec("SELECT 1 FROM upstream_grant_projections WHERE grant_key = ?", key)).length) continue;
    const revision = store.grantAttachment(key).revision;
    let grant = await store.privateBridge.read(key);
    try {
      // Incremental projection: no retained full-grant map across KV awaits.
      if (rows(sql.exec("SELECT 1 FROM upstream_grant_projections WHERE grant_key = ?", key)).length || store.grantAttachment(key).revision !== revision) continue;
      const version = store.grantAttachment(key);
      if (!grant && (version.attached || version.pending || version.generation > 0)) continue;
      const legacy = !!grant && (grant.credentialStore !== "durable_object" || grant.credentialGeneration !== version.generation || version.pending);
      const text = grant && !legacy ? store.privateBridge.scratch(privateProjectionScratch(grant), () =>
        (admitIdentity(grant, "record"), identityJson(routingProjection(privateProjectionView(grant!)), "record")), true) : null;
      store.privateBridge.stage(); // journal entry/index admission precedes construction
      store.privateBridge.stage({ kind: "projection", key, text, legacy: legacy ? 1 : 0, revision, eligible: false });
    } finally { grant = null; }
  }
  if (missing.length) {
    try {
      const grants = store.identity ? new Map<string, UpstreamGrant | null>() : await env.POLICY_KV.get<UpstreamGrant>(missing, "json");
      if (store.identity) for (const key of missing) grants.set(key, await readIdentityKv<UpstreamGrant>(() => env.POLICY_KV.get(key, "stream"), store.identity!));
      storage.transactionSync(() => {
        for (const key of missing) {
          if (rows(sql.exec("SELECT 1 FROM upstream_grant_projections WHERE grant_key = ?", key)).length || store.grantAttachment(key).revision !== versions!.get(key)) continue;
          const grant = grants.get(key);
          const version = store.grantAttachment(key);
          if (!grant && (version.attached || version.pending || version.generation > 0)) continue;
          const legacy = !!grant && (grant.credentialStore !== "durable_object" || grant.credentialGeneration !== version.generation || version.pending);
          const text = grant && !legacy ? (store.identity ? (admitIdentity(grant, "record"), identityJson(routingProjection(grant), "record")) : JSON.stringify(routingProjection(grant))) : null;
          if (store.identity) staged!.set(key, { text, legacy: legacy ? 1 : 0, revision: version.revision });
          else sql.exec("INSERT INTO upstream_grant_projections (grant_key, projection_json, legacy) VALUES (?, ?, ?)", key, text, legacy ? 1 : 0);
        }
      });
    } catch (error) { if (isIdentityFailure(error)) throw error; backfillFailed = true; } // Migration failures retain the old read path.
  }
  const identity = result.credential!.credential.principalId ?? result.credential!.credentialId;
  const [identityHash, fallbackSessionHash] = store.privateBridge ? await store.privateBridge.hashes(identity)
    : await Promise.all([sha256Hex(`identity:${identity}`), sha256Hex(`session:${identity}`)]);
  return storage.transactionSync(() => {
    // Imports/hashing yielded. Reread authorization and the entire pool before
    // filtering and updating counters in this same synchronous transaction.
    const credential = store.getCredential(input.credentialId);
    const policy = credential ? store.getPolicy(credential.credential.policyId) : null;
    const owner = credential?.credential.principalId ? store.getUser(store.privateBridge ? credential.credential.principalId : normalizeEmail(credential.credential.principalId) ?? credential.credential.principalId) : null;
    const fresh: AdmissionResult = { ...result, credential, policy, owner };
    if (!credential || !policy || !credential.credential.enabled || credentialExpired(credential.credential) || !policy.policy.enabled || credential.credential.policyGeneration !== policy.policy.generation || owner?.record.enabled === false || !input.secretSha256 || !safeEqual(input.secretSha256, credential.credential.secretSha256)) return fresh;
    if (credential.credential.principalId !== result.credential!.credential.principalId || policy.policyId !== poolInput.policyId || (policy.policy.tenantId ?? "default") !== poolInput.tenantId) return { ...fresh, pools: {} };
    fresh.connections = store.privateBridge ? store.privateBridge.connections(input.providers ?? [])
      : store.resolveConnections((input.providers ?? []).map(item => item.id)).connections;
    if (policy.policy.providers.length && !policy.policy.providers.includes(provider.id) || fresh.connections.find(item => item.providerId === provider.id)?.enabled === false) return fresh;
    try { assertPolicyModel(policy.policy, { model: request.catalogModelId ? { id: request.catalogModelId } : null, endpoint, capability: request.capability }); } catch { return fresh; }
    const pool = resolvePool();
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
    // Register the whole current pool before a legacy candidate can return early.
    // Publication still waits for successful admission and final serialization.
    for (const key of pool.keys) {
      const pending = store.privateBridge ? store.privateBridge.projection(key) : staged!.get(key);
      if (!pending || rows(sql.exec("SELECT 1 FROM upstream_grant_projections WHERE grant_key = ?", key)).length
        || store.grantAttachment(key).revision !== pending.revision) continue;
      if (store.privateBridge) { store.privateBridge.projection(key)!.eligible = true; continue; }
      store.afterAdmission!(() => sql.exec("INSERT OR IGNORE INTO upstream_grant_projections (grant_key, projection_json, legacy) VALUES (?, ?, ?)", key, pending.text, pending.legacy));
    }
    if (store.privateBridge) { store.privateBridge.current(fresh); return store.privateBridge.choice(() => finishPrivateSelectedResult(env, input, fresh, provider, endpoint, request, policy, poolInput.tenantId, pool, identityHash, fallbackSessionHash, store, sql)); }
    const candidates: AdmissionPoolCandidate[] = [];
    for (const key of pool.keys) {
      let row = rows<{ projection_json: string | null; legacy: number }>(sql.exec("SELECT projection_json, legacy FROM upstream_grant_projections WHERE grant_key = ?", key))[0];
      const pending = staged!.get(key); let usedStaged = false;
      if (!row && pending && store.grantAttachment(key).revision === pending.revision) {
        // The already-admitted private projection is not another original SQL read.
        usedStaged = true; row = { projection_json: pending.text, legacy: pending.legacy };
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
    if (planned?.commit) store.afterAdmission!(planned.commit); // Final serialization precedes all selected writes.
    return reply;
  });
}

// Join BOTH originals even when one fails; only fixed errors cross the await.
export async function privateAdmissionHashes(identity: string): Promise<[string, string]> {
  const first = sha256Hex(`identity:${identity}`).then(value => ({ value }), () => ({ value: null }));
  const second = sha256Hex(`session:${identity}`).then(value => ({ value }), () => ({ value: null }));
  identity = "";
  const one = await first, two = await second;
  if (one.value === null || two.value === null) throw identityFailure("transport");
  return [one.value, two.value];
}

export function privateHashScratch(identity: string): AdmissionScratchVector {
  return { C: 4, P: 128, N: 64, U: 2 * identity.length + 17 + 256,
    B: 2 * identityUtf8(identity) + 17 + 64 };
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


// Retained-generation consumers use the ordinary accepted candidate range.
// The caller reserves the complete passive working vector before entering.
// Configuration probes additionally acquire their existing preparation owner;
// capacity is never mistaken for a configured-pool miss.
export function selectGenerationAdmissionCandidate(env: Env,
  input: Parameters<typeof selectAdmissionCandidate>[1], choose: Parameters<typeof selectAdmissionCandidate>[2],
  revision: Parameters<typeof selectAdmissionCandidate>[3],
  scratch: <T>(vector: AdmissionScratchVector, run: () => T) => T): GrantSelectionResult {
  const { provider, endpoint, request, policy } = input;
  const routing = privateGrantRoutingPolicy(policy.policy.grantRouting, emit => { const plan = identityPlan("record"); emit(plan, 0); }), now = Date.now();
  const requirement = { provider, endpoint, mode: request.mode, model: request.model };
  const candidates = input.candidates.map(({ key, grant }) => ({ key, grant, runtimeState: grant ? currentGrantRuntime(grant, input.states[key]) : null }));
  const filterVector = { C: 0, P: 0, N: 0, U: 0, B: 0 };
  for (const candidate of candidates) if (candidate.grant) {
    const plan = identityPlan("record"); plan.item(candidate.grant, 0); const n = plan.counts;
    filterVector.C = Math.max(filterVector.C, 4 * n.containers + 8);
    filterVector.P = Math.max(filterVector.P, 8 * n.members + 4 * n.entries + 16);
    filterVector.N = Math.max(filterVector.N, 4 * n.values + 16);
    filterVector.U = Math.max(filterVector.U, 4 * n.units);
  }
  // Per-candidate credentials/binding/scope inspection finishes before the
  // next configuration preparation. Escaping filtered vectors were funded by
  // the outer working owner; no temporary-record alias escapes this callback.
  const filtered = scratch(filterVector, () => filterGrantCandidates(provider.id, candidates, new Set(request.excludedKeys ?? []), routing, request.pinnedKey, requirement, now));
  const configured = filtered.available.filter(({ grant }) => privateOperationConfigured(grant, env, requirement, scratch));
  let priority = Infinity;
  for (const item of configured) priority = Math.min(priority, grantPriority(item.grant));
  const active = configured.filter(({ grant }) => grantPriority(grant) === priority);
  const stickyHash = routing.stickiness === "identity" ? input.identityHash : routing.stickiness === "session" ? request.sessionHash ?? input.fallbackSessionHash : null;
  const choice = active.length ? choose({ poolKey: input.poolKey, strategy: routing.strategy, stickyHash,
    switchAtUsedPercent: routing.switchAtUsedPercent, hysteresisPercent: routing.hysteresisPercent,
    candidates: active.map(item => ({ key: item.key, weight: grantWeight(item.grant), remainingRatio: grantQuotaRatio(item.runtimeState, now, routing.staleAfterSeconds * 1000, request.model) })) }) : null;
  const selected = active.find(item => item.key === choice?.selectedKey) ?? null;
  let retryMs = Infinity;
  if (!selected) for (const item of filtered.recovering ?? []) {
    if (privateOperationConfigured(item.entry.grant, env, requirement, scratch)) retryMs = Math.min(retryMs, item.atMs);
  }
  return { selected: selected ? { ...selected, authorityRevision: revision(selected.key) } : null,
    hasConfiguredGrant: filtered.hasConfiguredGrant, ...(!selected && retryMs < Infinity ? { retryAt: new Date(retryMs).toISOString() } : {}) };
}


// Private streaming filter: preserve the shared predicates/operation checks but
// never retain configured/available/active/filter batches. Each singleton and
// its outcomes are dropped before the next candidate. Full snapshot records
// remain untouched; only fresh scalar choice records are transferred.
export function selectPrivateAdmissionCandidate(env: Env, input: Parameters<typeof selectAdmissionCandidate>[1],
  choose: Parameters<typeof selectAdmissionCandidate>[2], revision: Parameters<typeof selectAdmissionCandidate>[3],
  visit: Iterable<AdmissionPoolCandidate> = input.candidates,
  load: (key: string | undefined) => AdmissionPoolCandidate | undefined = key => input.candidates.find(candidate => candidate.key === key),
  complete: () => boolean = () => true,
  scratch: <T>(vector: AdmissionScratchVector, run: () => T, retained?: boolean) => T = (_vector, run) => run()): GrantSelectionResult | null {
  return scratch(privateChoiceScratch(input.policy.policy.grantRouting, input.request.model), () => {
    const { provider, endpoint, request, policy } = input;
    const routing = privateGrantRoutingPolicy(policy.policy.grantRouting, emit => { const plan = identityPlan("record"); emit(plan, 0); }), now = Date.now();
    const requirement = { provider, endpoint, mode: request.mode, model: request.model };
    const owned: GrantChoiceInput["candidates"] = [];
    let priority = Infinity, retryMs = Infinity, activeCount = 0;
    let hasConfiguredGrant = filterGrantCandidates(provider.id, [], new Set(), routing, request.pinnedKey, requirement, now).hasConfiguredGrant;
    try {
      for (const candidate of visit) {
        const item = { key: candidate.key, grant: candidate.grant ? privateProjectionView(candidate.grant) : null, runtimeState: candidate.grant ? currentGrantRuntime(candidate.grant, input.states[candidate.key]) : null };
        // The shared filter only probes this singleton's key. At most one Set
        // entry replaces a duplicate whole-request exclusion index.
        const excluded = new Set<string>(); if (request.excludedKeys?.includes(item.key)) excluded.add(item.key);
        const filtered = filterGrantCandidates(provider.id, [item], excluded, routing, request.pinnedKey, requirement, now);
        hasConfiguredGrant ||= filtered.hasConfiguredGrant;
        // This is a singleton. Keep the shared operation check and its ordinary
        // HttpError disposition, but acquire the actual bounded preparation owner
        // BEFORE any Env/configuration helper. Capacity must escape suppression.
        const available = filtered.available[0];
        const active = available && privateOperationConfigured(available.grant, env, requirement, scratch) ? available : undefined;
        if (active) {
          const nextPriority = grantPriority(active.grant);
          if (nextPriority < priority) { owned.length = 0; activeCount = 0; priority = nextPriority; }
          if (nextPriority === priority && ++activeCount <= 98) owned.push({ key: active.key, weight: grantWeight(active.grant), remainingRatio: grantQuotaRatio(active.runtimeState, now, routing.staleAfterSeconds * 1000, request.model) });
        }
        const recovering = filtered.recovering?.[0];
        const retry = recovering && privateOperationConfigured(recovering.entry.grant, env, requirement, scratch)
          ? new Date(recovering.atMs).toISOString() : undefined;
        if (retry !== undefined) retryMs = Math.min(retryMs, Date.parse(retry));
      }
      if (!complete()) return null;
      if (activeCount > 98) throw new HttpError(400, "authority_error", "grant selection candidates must be a bounded array");
      const stickyHash = routing.stickiness === "identity" ? input.identityHash : routing.stickiness === "session" ? request.sessionHash ?? input.fallbackSessionHash : null;
      const choice = owned.length ? choose({ poolKey: input.poolKey, strategy: routing.strategy, stickyHash,
        switchAtUsedPercent: routing.switchAtUsedPercent, hysteresisPercent: routing.hysteresisPercent, candidates: owned }) : null;
      const selected = load(choice?.selectedKey);
      return { selected: selected?.grant ? { key: selected.key, grant: selected.grant, runtimeState: currentGrantRuntime(selected.grant, input.states[selected.key]), authorityRevision: revision(selected.key) } : null,
        hasConfiguredGrant, ...(!selected && retryMs < Infinity ? { retryAt: new Date(retryMs).toISOString() } : {}) };
    } finally { owned.length = 0; }
  }, true); // Returned selection/retry fields remain owned until the result clears.
}

// The owner, facts and configuration scratch do not escape this boolean call.
// Original shared helpers still own validation order and ordinary HttpErrors.
// The guard callback itself and PreparationAdmission are CONTROL, not DATA.
function privateOperationConfigured(grant: UpstreamGrant, env: Env, requirement: GrantRequirement,
  scratch: <T>(vector: AdmissionScratchVector, run: () => T, retained?: boolean) => T): boolean {
  return scratch(privatePreparationScratch(requirement, grant), () => {
    let owner: PreparationAdmission | undefined = new PreparationAdmission();
    try { assertOperationConfiguration(requirement, grant, env, owner); return true; }
    catch (error) {
      if (isPreparationLimit(error)) throw identityFailure("limit");
      if (isIdentityFailure(error)) throw error;
      if (error instanceof HttpError) return false;
      throw error;
    } finally { owner = undefined; }
  });
}

// Exact choice/quota collection multiplicities. The complete routing output is
// prospectively counted too; no input/source allowance is converted to scratch.
export function privateChoiceScratch(routing: unknown, model?: string | null): AdmissionScratchVector {
  const plan = identityPlan("record"); planPrivateGrantRouting(routing, plan, 0);
  const counts = plan.counts;
  return {
    C: counts.containers + 99 + 2 + 2 + 8,
    P: 2 * counts.members + counts.entries + 686 + 256 + 129 + 22,
    N: counts.values + 196 + 128 + 129 + 4,
    U: counts.units + 102606 + 2 * 1024 + 2 * (64 + 1 + 1024)
      + (typeof model === "string" ? model.length + identityUtf8(model) : 0),
    B: 4,
  };
}

// This inventory is BEFORE the owner/facts/CSV/template factories. In particular
// preparationReplace retains up to 256 references to a 16384-unit replacement
// BEFORE its final expanded-output test. Every occurrence is funded, not interned.
export function privatePreparationScratch(requirement: GrantRequirement, grant: UpstreamGrant): AdmissionScratchVector {
  const { provider, endpoint } = requirement;
  let pairs = 0, units = 0;
  const fields = (values: Record<string, string> | undefined) => {
    if (!values) return;
    for (const key in values) if (Object.hasOwn(values, key)) { pairs++; units += key.length + values[key].length; }
  };
  fields(provider.adapter.injectHeaders); fields(endpoint.headers);
  fields(provider.adapter.injectQuery); fields(endpoint.query);
  const transport = grant.kind ? provider.auth.grantTransports[grant.kind] : undefined;
  fields(transport?.headers); fields(transport?.appendHeaders); fields(transport?.endpointPaths);
  // Counts for manifest-derived vectors are actual frozen graph lengths, not
  // assumptions about Env size. Env is first examined by the acquired owner.
  let configUnits = 0;
  for (const key of provider.config_keys) configUnits += key.length;
  for (const key of provider.optional_config_keys) configUnits += key.length;
  return {
    C: 129 + 2 + 2 + pairs + 4,
    P: 384 + 1024 + 128 + 256 + 128 + 3 * pairs + provider.models.length,
    N: 128,
    U: 65536 + 2 * 32768 + 256 * 16384 + 2 * configUnits + 2 * units
      + 3 * 256 + 2 * 8192 + 2 * 16384 + 32768,
    B: 0,
  };
}


// Only the private projection/eligibility path uses this borrowed read view.
// Each unchanged reader returns null for excess fields; pre-count those fields
// before its Object.keys call. Valid bindings and EVERY other grant property
// are forwarded unchanged. No raw grant/snapshot mutation or full-key clone.
function privateProjectionView(grant: UpstreamGrant): UpstreamGrant {
  const limits = { minimaxSearchBinding: 8, minimaxVideoBinding: 9, minimaxImageBinding: 8,
    vertexAnthropicBinding: 6, minimaxAnthropicBinding: 6, nativeMediaBinding: 9 } as const;
  let view: UpstreamGrant | undefined;
  for (const name in limits) {
    const key = name as keyof typeof limits, value = grant[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    let count = 0;
    for (const field in value) if (Object.hasOwn(value, field) && ++count > limits[key]) {
      view ??= Object.create(grant) as UpstreamGrant;
      Object.defineProperty(view, key, { value: null, enumerable: true }); break;
    }
  }
  return view ?? grant;
}


// The fixed projection allowlist copies only admitted children. Its new root,
// fixed binding outputs, key/value occurrences and serialized text coexist with
// the original grant until the private backfill caller clears it.
export function privateProjectionScratch(grant: UpstreamGrant): AdmissionScratchVector {
  const plan = identityPlan("record"); plan.item(grant, 0);
  return { C: plan.counts.containers + 64, P: 2 * plan.counts.members + plan.counts.entries + 1024,
    N: plan.counts.values + 256, U: 2 * plan.counts.units + plan.counts.text + 8192, B: 0 };
}

// Passive OUTPUT occurrences, separate from SQL graph/source allowances. The
// complete pool upper bound funds both snapshot modes before any growth; no
// lease/guard survives into the already-tight choice window.
export function privateSnapshotScratch(fresh: AdmissionResult, providerId: string, policyId: string, tenantId: string,
  keys: readonly string[], identityHash: string, fallbackSessionHash: string, snapshot: boolean): AdmissionScratchVector {
  let fields = 0, units = 0, primitives = 0;
  for (const key in fresh) if (Object.hasOwn(fresh, key)) {
    fields++; units += key.length;
    const value = (fresh as unknown as Record<string, unknown>)[key];
    if (typeof value === "string") units += value.length;
    else if (value == null || typeof value === "number" || typeof value === "boolean") primitives++;
  }
  let keyUnits = 0;
  if (snapshot) for (const key of keys) keyUnits += key.length;
  const count = snapshot ? keys.length : 0;
  // Each encoded component <= 3*UTF8 units; components, local poolKey,
  // selection input and returned snapshot occurrences overlap.
  const encoded = 3 * (identityUtf8(providerId) + identityUtf8(policyId) + identityUtf8(tenantId));
  return { C: count + 5, P: 7 * count + 2 * fields + 24, N: count + primitives + 2,
    U: 2 * keyUnits + 8 * count + units + providerId.length + 4 * encoded + 8
      + 2 * (identityHash.length + fallbackSessionHash.length) + 512, B: 0 };
}

// Original projection rows are streamed when the public result does not request
// a snapshot. A selected reread is metered again BEFORE any journal effect.
// Snapshot data is prospectively admitted as part of the full result before
// retaining each record; no additional unbounded working copy is constructed.
function finishPrivateSelectedResult(env: Env, input: AdmissionRequest, fresh: AdmissionResult,
  provider: CompiledProvider, endpoint: CompiledEndpoint, request: AdmissionSelection, policy: AccessPolicyEntry,
  tenantId: string, pool: AdmissionPool, identityHash: string, fallbackSessionHash: string, store: SelectionStore, sql: SqlStorage): AdmissionResult {
  // Reserve ALL prospective output occurrences before even the empty array.
  // This one-shot lease transfers into the ticket before selection factories;
  // data remains held until final result/journal aliases clear, not return.
  store.privateBridge!.scratch(privateSnapshotScratch(fresh, provider.id, policy.policyId, tenantId, pool.keys,
    identityHash, fallbackSessionHash, !!input.snapshot), () => undefined, true);
  const retained: AdmissionPoolCandidate[] = [];
  const poolKey = `${encodeURIComponent(provider.id)}/${encodeURIComponent(policy.policyId)}/${encodeURIComponent(tenantId)}`;
  const revision = (key: string) => store.grantAttachment(key).revision;
  let legacy = false, handedOff = false;
  let planned: ReturnType<NonNullable<SelectionStore["planGrant"]>> | undefined;
  const read = (key: string, repeated = false): AdmissionPoolCandidate | undefined => {
    const size = rows<{ bytes: number | null }>(sql.exec("SELECT length(CAST(projection_json AS BLOB)) AS bytes FROM upstream_grant_projections WHERE grant_key = ?", key))[0];
    if (repeated && size?.bytes != null) admitIdentityBytes(store.identity!, size.bytes);
    const pending = store.privateBridge!.projection(key);
    const bytes = size?.bytes ?? (pending?.text ? identityUtf8(pending.text) : 0);
    return store.privateBridge!.materialize(bytes, () => {
      let row: { projection_json: string | null; legacy: number } | undefined = rows<{ projection_json: string | null; legacy: number }>(sql.exec("SELECT projection_json, legacy FROM upstream_grant_projections WHERE grant_key = ?", key))[0];
      let staged = false;
      if (!row && pending && revision(key) === pending.revision) { row = { projection_json: pending.text, legacy: pending.legacy }; staged = true; }
      if (!row || row.legacy) { legacy = true; return; }
      // This full projection is an execution dependency, including unselected and
      // snapshot-only candidates. The fixed journal factory owns its receipt;
      // it is never a free passive index. Staged entries share the same slot.
      store.privateBridge!.scratch({ C: 0, P: 0, N: 2, U: key.length + "dependency".length + (row.projection_json?.length ?? 0), B: 0 },
        () => store.privateBridge!.stage({ kind: "dependency", key, revision: revision(key), text: row!.projection_json, legacy: row!.legacy }), true);
      const grant = row.projection_json ? (staged ? JSON.parse(row.projection_json) : parseIdentity(row.projection_json, store.identity!)) as UpstreamGrant : null;
      row = undefined;
      return { key, grant };
    });
  };
  const admitSnapshotRecord = (next: AdmissionPoolCandidate) => {
    const plan = identityPlan();
    plan.object(0, field => {
      for (const key in fresh) if (Object.hasOwn(fresh, key) && key !== "snapshots") field(key, (fresh as unknown as Record<string, unknown>)[key]);
      field("snapshots", undefined, () => plan.object(1, snapshot => snapshot(provider.id, undefined, () => plan.object(2, member => {
        member("poolKey", poolKey);
        member("candidates", undefined, () => plan.array(3, entry => { for (const candidate of retained) entry(candidate); entry(next); }));
        member("revisions", undefined, () => plan.object(3, item => { for (const candidate of retained) item(candidate.key, revision(candidate.key)); item(next.key, revision(next.key)); }));
        member("cursorKey", null); member("counts", {}); member("identityHash", identityHash); member("fallbackSessionHash", fallbackSessionHash);
      }))));
    });
  };
  function* visit(): Generator<AdmissionPoolCandidate> {
    for (const key of pool.keys) {
      let candidate = read(key); if (!candidate) return;
      if (input.snapshot) { admitSnapshotRecord(candidate); retained.push(candidate); }
      yield candidate; candidate = undefined;
    }
  }
  const snapshot = (): AdmissionPoolSnapshot => {
    const state = planned?.state ?? store.selectionState(poolKey);
    // The ORIGINAL history owner funds its cursor; this is the additional
    // returned snapshot string occurrence. Admit actual length before copying.
    store.privateBridge!.scratch({ C: 0, P: 0, N: 0, U: state.cursorKey?.length ?? 0, B: 0 }, () => undefined, true);
    const plan = identityPlan();
    plan.object(0, field => {
      for (const key in fresh) if (Object.hasOwn(fresh, key) && key !== "snapshots") field(key, (fresh as unknown as Record<string, unknown>)[key]);
      field("snapshots", undefined, () => plan.object(1, providers => providers(provider.id, undefined, () => plan.object(2, member => {
        member("poolKey", poolKey); member("candidates", retained);
        member("revisions", undefined, () => plan.object(3, item => { for (const candidate of retained) item(candidate.key, revision(candidate.key)); }));
        member("cursorKey", state.cursorKey); member("counts", state.counts); member("identityHash", identityHash); member("fallbackSessionHash", fallbackSessionHash);
      }))));
    });
    const revisions: Record<string, number> = Object.create(null);
    for (const candidate of retained) revisions[candidate.key] = revision(candidate.key);
    return { poolKey, candidates: retained, revisions, cursorKey: state.cursorKey, counts: state.counts, identityHash, fallbackSessionHash };
  };
  try {
    if (input.snapshot === "only") {
      for (const _ of visit()) { /* fully original rows, no choice or counter effect */ }
      if (legacy) return fresh;
      const reply = { ...fresh, snapshots: { [provider.id]: snapshot() } }; admitAdmission(reply); handedOff = true; return reply;
    }
    const selection = selectPrivateAdmissionCandidate(env, { provider, endpoint, request, policy, poolKey, candidates: retained,
      states: pool.states, identityHash, fallbackSessionHash }, choice => { planned = store.planGrant!(choice); return planned.result; }, revision,
      visit(), key => key === undefined ? undefined : input.snapshot ? retained.find(candidate => candidate.key === key) : read(key, true), () => !legacy, store.privateBridge!.scratch);
    if (legacy || !selection) return fresh;
    const reply = { ...fresh, selection, ...(input.snapshot === "select" ? { snapshots: { [provider.id]: snapshot() } } : {}) };
    admitAdmission(reply);
    if (planned?.journal) store.privateBridge!.stage(planned.journal);
    handedOff = true; return reply;
  } finally { planned = undefined; if (!handedOff || !input.snapshot) retained.length = 0; }
}
