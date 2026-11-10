import { GenerationConsumptionLease, type AdmissionScratchVector } from "./credential-preflight-arena.ts";
import { admitAdmission, admitIdentity, copyIdentity, identityPlan, identityUtf8, identityFailure, identitySourceBudget, type IdentitySourceBudget } from "./identity-admission.ts";
import { authorityCall, type AdmissionResult } from "./authority.ts";
import type { AdmissionPoolSnapshot, AdmissionRequest, AdmissionSelection } from "./authority-admission.ts";
import { selectAdmissionCandidate, selectGenerationAdmissionCandidate } from "./authority-grant-selection.ts";
import { credentialExpired } from "./credential-lifecycle.ts";
import { currentGrantRuntime, type GrantSelectionResult } from "./grant-eligibility.ts";
import { chooseGrantKey, normalizedChoiceCandidates, type GrantChoiceInput } from "./grant-selection-strategies.ts";
import { HotCache, fenceSharedHotCache, hotCacheAcquiredAt, hotCacheConfig, hotCacheNow, registerHotCache, tryRunInBackground, sharedHotCacheFence, type CachePublication, type HotCacheConfig, type HotCacheState } from "./hot-cache.ts";
import { coloGet, coloPut } from "./colo-cache.ts";
import { recordGrantRuntime } from "./grant-selection.ts";
import { mergeGrantRuntimeState } from "./grant-runtime.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { snapshot } from "./providers.ts";
import type { Env, GrantRuntimeState, UpstreamGrant } from "./types";
import { prefetchGrantCredentials } from "./credential-cache.ts";
import { materializeGrantCredentials } from "./grant-credentials.ts";
import { safeEqual } from "./utils.ts";

// Isolate-local admission snapshots for proxy keys. A hit authenticates and
// selects without contacting the authority; revocation, policy and pool changes
// reach this isolate within the configured max age (stale-while-revalidate).
const admissions = registerHotCache(new HotCache<AdmissionResult>(2048));

type CachedAdmissionRequest = AdmissionRequest & { secretSha256: string };

export async function resolveAdmission(env: Env, request: CachedAdmissionRequest, freshness: "cached" | "authoritative" = "cached"): Promise<{ admission: AdmissionResult; cache: HotCacheState }> {
  admitIdentity(request);
  const source = identitySourceBudget(), config = hotCacheConfig(env);
  // Delayed uploads re-admit after the body is complete. They must not reuse a
  // pre-upload isolate/colo snapshot or join another request's old admission.
  if (!config.maxAgeMs || freshness === "authoritative") return { admission: await authorityCall<AdmissionResult>(env, "/admission/resolve", request, "policy-bindings", undefined, undefined, undefined, undefined, undefined, source), cache: "off" };
  const key = cacheKey(request);
  // Failover after an upstream rejection is off the hot path: it always takes a
  // fresh authoritative admission so tenant/pool changes apply to the alternate.
  const cached = request.selection?.excludedKeys?.length ? undefined : admissions.peek(key, config);
  // Every request re-verifies its own secret; a mismatch (wrong key or rotation)
  // always goes back to the authority instead of trusting the cached digest.
  if (cached && safeEqual(request.secretSha256, cached.value.credential!.credential.secretSha256.toLowerCase())) {
    const selection = request.selection ? localSelection(env, cached.value, request.selection) : undefined;
    if (!request.selection || selection) {
      rememberSelection(key, request, selection);
      if (!cached.fresh) admissions.revalidate(key, config, publication => load(env, config, { ...request, selection: request.selection && { ...request.selection, excludedKeys: undefined }, snapshot: request.selection ? "only" : undefined }, publication));
      return { admission: { ...cached.value, ...(selection ? { selection } : {}) }, cache: cached.fresh ? "hit" : "stale" };
    }
  }
  const failover = !!request.selection?.excludedKeys?.length;
  // A burst of cold requests for one key shares the first lookup: the rest wait
  // for its snapshot, re-verify their own secret and select locally. Leadership
  // is claimed before the colo read, or a burst landing during that read would
  // bypass coalescing and each call the authority.
  const leader = failover ? undefined : admissions.publication(key);
  if (leader) {
    await admissions.waitForPublication(key, config);
    const joined = admissions.peek(key, config);
    if (joined && safeEqual(request.secretSha256, joined.value.credential!.credential.secretSha256.toLowerCase())) {
      const selection = request.selection ? localSelection(env, joined.value, request.selection) : undefined;
      if (!request.selection || selection) {
        rememberSelection(key, request, selection);
        return { admission: { ...joined.value, ...(selection ? { selection } : {}) }, cache: "joined" };
      }
    }
  }
  const publication = admissions.beginPublication(key);
  try {
    prefetchRememberedCredential(env, key, request);
    // Another isolate in this location may have fetched it moments ago.
    const shared = failover || !publication ? undefined : await coloGet<AdmissionResult>("admission", key, config, source);
    if (shared && admissions.ownsPublication(key, publication) && shared.fetchedAt > sharedHotCacheFence() && cacheable(shared.value, request.secretSha256)) {
      applyPendingRuntime(shared.value); admitAdmission(shared.value);
      admissions.publish(key, publication, shared.value, config, expiryOf(shared.value), shared.fetchedAt);
      const selection = request.selection ? localSelection(env, shared.value, request.selection) : undefined;
      if (!request.selection || selection) {
        rememberSelection(key, request, selection);
        admissions.endPublication(key, publication);
        if (hotCacheNow() - shared.fetchedAt >= config.freshMs) admissions.revalidate(key, config, next => load(env, config, { ...request, selection: request.selection && { ...request.selection, excludedKeys: undefined }, snapshot: request.selection ? "only" : undefined }, next));
        return { admission: { ...shared.value, ...(selection ? { selection } : {}) }, cache: "colo" };
      }
    }
    const loaded = await load(env, config, { ...request, snapshot: request.selection ? "select" : undefined }, publication, source);
    if (loaded.cacheable && admissions.ownsPublication(key, publication)) rememberSelection(key, request, loaded.value.selection);
    if (loaded.cacheable) admissions.publish(key, publication, withoutSelection(loaded.value), config, loaded.expiresAt, loaded.storedAt);
    // A wrong secret must not evict the key owner's entry; only an outcome
    // observed with the matching secret (revoked, disabled, missing) does.
    else if (!loaded.value.credential || safeEqual(request.secretSha256, loaded.value.credential.credential.secretSha256.toLowerCase())) admissions.discardPublished(key, publication);
    return { admission: loaded.value, cache: "miss" };
  }
  finally { admissions.endPublication(key, publication); }
}

async function load(env: Env, config: HotCacheConfig, request: CachedAdmissionRequest, publication: CachePublication | undefined, source: IdentitySourceBudget = identitySourceBudget()) {
  // While feedback is pending, ask for an authorized snapshot rather than
  // incrementing an authority selection that may already be locally ineligible.
  const deferred = request.snapshot === "select" && !!request.selection && pendingRuntime.size > 0;
  const storedAt = hotCacheAcquiredAt();
  const value = await authorityCall<AdmissionResult>(env, "/admission/resolve", deferred ? { ...request, snapshot: "only" } : request, "policy-bindings", undefined, undefined, undefined, undefined, undefined, source);
  admitAdmission(value);
  const overlaid = applyPendingRuntime(value);
  const ok = config.maxAgeMs > 0 && cacheable(value, request.secretSha256);
  if (ok && request.selection && (deferred || overlaid && value.selection)) {
    const selection = localSelection(env, value, request.selection, value.selection?.selected?.key);
    if (selection) value.selection = selection;
  }
  admitAdmission(value);
  // A current owner may publish even at an equal/rolled-back clock. The shared
  // timestamp fence governs adoption; it does not revoke new publication rights.
  if (ok && admissions.ownsPublication(cacheKey(request), publication)) coloPut("admission", cacheKey(request), withoutSelection(value), storedAt, config);
  return { value: request.snapshot === "only" ? withoutSelection(value) : value, cacheable: ok, expiresAt: expiryOf(value), storedAt };
}

function expiryOf(value: AdmissionResult): number {
  const expiresAt = value.credential?.credential.expiresAt ? Date.parse(value.credential.credential.expiresAt) : Number.POSITIVE_INFINITY;
  return Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY;
}

// The last grant each key selected per operation: secretless routing data used
// only to start that grant's credential load alongside a foreground admission.
interface SelectionHint { secretSha256: string; key: string; grant: UpstreamGrant }
const selectionHints = registerHotCache(new Map<string, SelectionHint>());
const hintKey = (key: string, selection: AdmissionSelection) => `${key}\n${selection.providerId}\n${selection.endpointId}\n${selection.mode}\n${selection.model ?? ""}`;

function rememberSelection(key: string, request: CachedAdmissionRequest, selection: GrantSelectionResult | undefined): void {
  const selected = selection?.selected;
  if (!request.selection || !selected) return;
  const id = hintKey(key, request.selection);
  selectionHints.delete(id);
  selectionHints.set(id, { secretSha256: request.secretSha256, key: selected.key, grant: selected.grant });
  if (selectionHints.size > 2048) selectionHints.delete(selectionHints.keys().next().value!);
}

function prefetchRememberedCredential(env: Env, key: string, request: CachedAdmissionRequest): void {
  if (!request.selection || request.selection.excludedKeys?.length || request.selection.pinnedKey) return;
  const hint = selectionHints.get(hintKey(key, request.selection));
  // Only the secret that earned the hint may start an owner call.
  if (!hint || !safeEqual(request.secretSha256, hint.secretSha256)) return;
  const provider = snapshot.providers.find(item => item.id === request.selection!.providerId);
  // Vertex exchange and MiniMax image/music secret reads follow foreground budget
  // and operation-specific authority checks, never speculative prefetch.
  if (!provider || provider.id === "anthropic-vertex"
    || provider.id === "minimax" && provider.endpoints.some(endpoint => endpoint.id === request.selection!.endpointId
      && (endpoint.request_format === "minimax.images" || endpoint.request_format === "minimax.music"))) return;
  prefetchGrantCredentials(env, hint.key, hint.grant, () => materializeGrantCredentials(env, hint.key, hint.grant, provider.id, provider.auth.refresh, false));
}

function cacheKey(request: AdmissionRequest): string {
  return JSON.stringify([request.credentialId, (request.providers ?? []).map(item => `${item.id}:${item.tokenRef}`).sort(), !!request.allConnections]);
}

// Only fully admitted outcomes are cached; failures always re-ask the authority.
function cacheable(result: AdmissionResult, secretSha256: string): boolean {
  admitAdmission(result);
  const credential = result.credential?.credential;
  if (!credential || !result.policy || result.policyUnavailable || result.ownerUnavailable || result.connectionsUnavailable) return false;
  if (!safeEqual(secretSha256, credential.secretSha256.toLowerCase())) return false;
  if (!credential.enabled || credentialExpired(credential) || !result.policy.policy.enabled || credential.policyGeneration !== result.policy.policy.generation || result.owner?.record.enabled === false) return false;
  return !Object.values(result.pools).some(pool => pool.unavailable);
}

function withoutSelection(result: AdmissionResult): AdmissionResult {
  const { selection: _selection, ...rest } = result;
  return rest;
}

function localSelection(env: Env, admission: AdmissionResult, request: AdmissionSelection, alreadySelected?: string): GrantSelectionResult | undefined {
  admitAdmission(admission); admitIdentity(request);
  const pool = admission.pools[request.providerId], snap = admission.snapshots?.[request.providerId], policy = admission.policy;
  if (!pool || !snap || !policy) return undefined;
  const provider = snapshot.providers.find(item => item.id === request.providerId);
  const endpoint = provider?.endpoints.find(item => item.id === request.endpointId);
  if (!provider || !endpoint) return undefined;
  // Mirror the authority's early exits; the Worker then reports the denial itself.
  if (policy.policy.providers.length && !policy.policy.providers.includes(provider.id) || admission.connections.find(item => item.providerId === provider.id)?.enabled === false) return undefined;
  try { assertPolicyModel(policy.policy, { model: request.catalogModelId ? { id: request.catalogModelId } : null, endpoint, capability: request.capability }); } catch { return undefined; }
  const result = selectAdmissionCandidate(env, { provider, endpoint, request, policy, poolKey: snap.poolKey, candidates: snap.candidates, states: pool.states, identityHash: snap.identityHash, fallbackSessionHash: snap.fallbackSessionHash }, choice => alreadySelected && choice.candidates.some(candidate => candidate.key === alreadySelected)
    ? { selectedKey: alreadySelected } // Keep an eligible authority choice without counting it twice.
    : chooseLocally(env, admission, snap, choice), key => snap.revisions[key]);
  // The snapshot is shared by concurrent requests; hand out a private copy.
  return result.selected ? { ...result, selected: copyIdentity(result.selected) } : result;
}

function chooseLocally(env: Env, admission: AdmissionResult, snap: AdmissionPoolSnapshot, input: GrantChoiceInput): { selectedKey: string } {
  const choice = chooseGrantKey(input, normalizedChoiceCandidates(input.candidates), { cursorKey: snap.cursorKey, counts: new Map(Object.entries(snap.counts)) });
  const now = Date.now(), next = { count: (snap.counts[choice.selectedKey]?.count ?? 0) + 1, lastMs: now };
  const plan = identityPlan();
  plan.object(0, field => {
    for (const key in admission) if (Object.hasOwn(admission, key)) {
      if (key !== "snapshots") field(key, admission[key as keyof AdmissionResult]);
      else field(key, undefined, () => plan.object(1, snapshot => {
        for (const id in admission.snapshots) if (Object.hasOwn(admission.snapshots, id)) {
          const value = admission.snapshots![id];
          if (value !== snap) snapshot(id, value);
          else snapshot(id, undefined, () => plan.object(2, part => {
            for (const name in snap) if (Object.hasOwn(snap, name)) {
              if (name === "cursorKey") part(name, choice.cursorKey ?? snap.cursorKey);
              else if (name !== "counts") part(name, snap[name as keyof AdmissionPoolSnapshot]);
              else part(name, undefined, () => plan.object(3, counter => {
                for (const grant in snap.counts) if (Object.hasOwn(snap.counts, grant) && grant !== choice.selectedKey) counter(grant, snap.counts[grant]);
                counter(choice.selectedKey, next);
              }));
            }
          }));
        }
      }));
    }
  });
  const selected = snap.candidates.find(candidate => candidate.key === choice.selectedKey);
  let state: GrantRuntimeState | undefined;
  for (const key in admission.snapshots) if (Object.hasOwn(admission.snapshots, key) && admission.snapshots![key] === snap) state = admission.pools[key]?.states[choice.selectedKey];
  if (selected?.grant) identityPlan("record").object(0, field => {
    field("key", selected.key); field("grant", selected.grant);
    field("runtimeState", currentGrantRuntime(selected.grant!, state));
    field("authorityRevision", snap.revisions[selected.key]);
  }); // Before advisory mutation and the later private clone.
  const counter = snap.counts[choice.selectedKey] ??= { count: 0, lastMs: 0 };
  counter.count++; counter.lastMs = now;
  if (choice.cursorKey) snap.cursorKey = choice.cursorKey;
  recordSelection(env, snap.poolKey, choice.selectedKey, now, choice.cursorKey);
  return choice;
}

// Selection counters and quota feedback are advisory; coalesce them into one
// background flush per window instead of one global-authority write per request.
let flushWindowMs = 250;
/** Test hook: shorten the coalescing window. */
export function setCoalesceWindowMs(ms: number): void { flushWindowMs = ms; }
const pendingRuntime = new Map<string, GrantRuntimeState>();
const pendingSelections = new Map<string, { poolKey: string; key: string; count: number; lastMs: number; cursorKey?: string | null }>();
const pendingCursors = new Map<string, string>();
let flushScheduled: object | false = false;
// Pending counters are writes, not cached state: invalidation never drops them.

function recordSelection(env: Env, poolKey: string, key: string, lastMs: number, cursorKey?: string): void {
  const id = `${poolKey}\n${key}`;
  const pending = pendingSelections.get(id);
  if (pending) { pending.count++; pending.lastMs = lastMs; }
  else pendingSelections.set(id, { poolKey, key, count: 1, lastMs });
  if (cursorKey) pendingCursors.set(poolKey, cursorKey);
  scheduleFlush(env);
}

/**
 * Observed quota/cooldown state: applied to this isolate at once, sent to the
 * authority coalesced per grant (merged with the authority's own merge rule).
 * With the hot cache disabled it is written immediately, as before.
 */
export function queueGrantRuntime(env: Env, key: string, state: GrantRuntimeState): Promise<void> | undefined {
  applyLocalGrantRuntime(key, state);
  if (!hotCacheConfig(env).maxAgeMs) return recordGrantRuntime(env, key, state).catch(() => undefined);
  const pending = pendingRuntime.get(key);
  try { pendingRuntime.set(key, pending ? mergeGrantRuntimeState(pending, state) : state); }
  catch { pendingRuntime.set(key, state); }
  scheduleFlush(env);
  return undefined;
}

function scheduleFlush(env: Env): void {
  if (flushScheduled) return;
  tryRunInBackground(() => {
    const generation = {};
    flushScheduled = generation;
    return new Promise<void>(resolve => setTimeout(resolve, flushWindowMs)).then(() => {
      if (flushScheduled === generation) return flushSelections(env);
    }).finally(() => {
      // A manual flush or reentrant registration may have installed a successor.
      if (flushScheduled === generation) flushScheduled = false;
    });
  });
}

export async function flushSelections(env: Env): Promise<void> {
  flushScheduled = false;
  const records = [...pendingSelections.values()];
  pendingSelections.clear();
  const runtime = [...pendingRuntime];
  const feedback = Promise.all(runtime.map(async ([key, state]) => {
    try { await recordGrantRuntime(env, key, state); } catch { /* Advisory feedback remains best effort. */ }
    finally { if (pendingRuntime.get(key) === state) pendingRuntime.delete(key); }
  }));
  for (const [poolKey, cursorKey] of pendingCursors) {
    const record = records.find(item => item.poolKey === poolKey && item.key === cursorKey) ?? records.find(item => item.poolKey === poolKey);
    if (record) record.cursorKey = cursorKey;
  }
  pendingCursors.clear();
  for (let offset = 0; offset < records.length; offset += 256) {
    try { await authorityCall(env, "/grant-pools/record", { records: records.slice(offset, offset + 256) }); }
    catch { /* Advisory counters: a lost flush only skews least-used/round-robin statistics. */ }
  }
  await feedback;
}

// Failover can reload admission before its rejected attempt's feedback reaches
// the authority. Overlay pending observations until the write has settled.
function applyPendingRuntime(admission: AdmissionResult): boolean {
  let applied = false;
  for (const pool of Object.values(admission.pools)) for (const key of pool.keys) {
    const pending = pendingRuntime.get(key);
    if (pending) { pool.states[key] = mergeGrantRuntimeState(pool.states[key] ?? null, pending); applied = true; }
  }
  return applied;
}

/** Apply observed quota/cooldown state to this isolate's snapshots immediately. */
export function applyLocalGrantRuntime(key: string, state: GrantRuntimeState): void {
  for (const admission of admissions.values()) {
    for (const pool of Object.values(admission.pools)) if (pool.keys.includes(key)) pool.states[key] = mergeGrantRuntimeState(pool.states[key] ?? null, state);
  }
}

/** Same-isolate invalidation after a mutation; other isolates converge by max age. */
export function invalidateAdmissions(predicate: (admission: AdmissionResult) => boolean = () => true): void {
  admissions.deleteWhere((_key, admission) => predicate(admission));
  selectionHints.clear();
  fenceSharedHotCache();
}

// Inactive generation-only sidecar. Its immutable admission is never installed
// in the ordinary cache above. A successor creates an EMPTY overlay and reads
// untouched authoritative counts/cursors from its own snapshot.
export interface GenerationSelectionPlan {
  result: GrantSelectionResult; providerId: string; poolKey: string;
  selectedKey?: string; cursorKey?: string; count?: number; lastMs?: number;
}
export class GenerationAdvisoryState {
  readonly counts = new Map<string, { providerId: string; key: string; count: number; lastMs: number }>();
  readonly cursors = new Map<string, string>();
  readonly runtime = new Map<string, GrantRuntimeState>();
  readonly runtimeCharges = new Map<string, GenerationConsumptionLease>();
  private constructor(privateLease: GenerationConsumptionLease) { this.lease = privateLease; }
  private lease: GenerationConsumptionLease;
  private admittedBytes = 4096;
  static create(): GenerationAdvisoryState { return new GenerationAdvisoryState(GenerationConsumptionLease.reserve(4096)); }
  // All retained values are detached JSON copies or belong to the still-funded
  // generation. Read-only inspection does not publish an AuthorizedIdentity.
  dispose(): void { this.counts.clear(); this.cursors.clear(); this.runtime.clear(); for (const charge of this.runtimeCharges.values()) charge.release(); this.runtimeCharges.clear(); this.lease.release(); }
  admitSelection(plan: GenerationSelectionPlan): void {
    let units = 0, rows = 0;
    for (const item of this.counts.values()) {
      if (item.providerId === plan.providerId && item.key === plan.selectedKey) continue;
      units += 2 * item.providerId.length + 2 * item.key.length + 1; rows++;
    }
    for (const [provider, cursor] of this.cursors) if (provider !== plan.providerId || !plan.cursorKey) { units += provider.length + cursor.length; rows++; }
    if (plan.selectedKey) { units += 2 * plan.providerId.length + 2 * plan.selectedKey.length + 1; rows++; }
    if (plan.cursorKey) { units += plan.providerId.length + plan.cursorKey.length; rows++; }
    // Each row's Map cells, object fields, numeric cells and fixed field names.
    this.admittedBytes = 4096 + 256 * rows + 2 * units;
    this.lease.replace(Math.max(this.lease.bytes, this.admittedBytes) + 512 + 4 * (plan.providerId.length + (plan.selectedKey?.length ?? 0) + (plan.cursorKey?.length ?? 0)));
  }
  commitSelection(plan: GenerationSelectionPlan): void {
    if (!plan.selectedKey) { this.lease.replace(this.admittedBytes); return; }
    const id = `${plan.providerId}\n${plan.selectedKey}`;
    this.counts.set(id, { providerId: plan.providerId, key: plan.selectedKey, count: plan.count!, lastMs: plan.lastMs! });
    if (plan.cursorKey) this.cursors.set(plan.providerId, plan.cursorKey);
    this.lease.replace(this.admittedBytes);
  }
}

// Counts are actual admitted input lengths. This is a prospective simultaneous
// passive working-vector allowance, distinct from the immutable owner graph.
export function generationSelectionWorkingBytes(admission: AdmissionResult, request: AdmissionSelection): number {
  const snap = admission.snapshots?.[request.providerId];
  if (!snap) return 4096;
  let units = 0, countRows = 0, stateRows = 0, excludedUnits = 0;
  for (const candidate of snap.candidates) units += candidate.key.length;
  for (const key in snap.counts) if (Object.hasOwn(snap.counts, key)) { units += key.length; countRows++; }
  for (const key in admission.pools[request.providerId]?.states) if (Object.hasOwn(admission.pools[request.providerId].states, key)) { units += key.length; stateRows++; }
  for (const key of request.excludedKeys ?? []) excludedUnits += key.length;
  const plan = identityPlan("record"); plan.item(admission.policy!.policy.grantRouting ?? null, 0);
  const routing = plan.counts;
  const modelUnits = typeof request.model === "string" ? request.model.length + identityUtf8(request.model) : 0;
  // candidate/configured/available/active/recovering/choice + normalize Map,
  // pair and sorted/filter vectors; per-candidate quota scratch is sequential.
  return 4096 + 8 * (32 + 62 * snap.candidates.length + 7 * countRows + 2 * stateRows + 2 * (request.excludedKeys?.length ?? 0)
    + routing.containers + 2 * routing.members + routing.entries + routing.values + 1024)
    + 2 * (8 * units + 80 * snap.candidates.length + 2 * routing.units + modelUnits + excludedUnits + 32768);
}

export function planGenerationSelection(env: Env, admission: AdmissionResult, overlay: GenerationAdvisoryState,
  request: AdmissionSelection, scratch: <T>(vector: AdmissionScratchVector, run: () => T) => T): GenerationSelectionPlan | undefined {
  const pool = admission.pools[request.providerId], snap = admission.snapshots?.[request.providerId], policy = admission.policy;
  if (!pool || !snap || !policy) return undefined;
  const provider = snapshot.providers.find(item => item.id === request.providerId), endpoint = provider?.endpoints.find(item => item.id === request.endpointId);
  if (!provider || !endpoint) return undefined;
  if (policy.policy.providers.length && !policy.policy.providers.includes(provider.id)
    || admission.connections.find(item => item.providerId === provider.id)?.enabled === false) return undefined;
  try { assertPolicyModel(policy.policy, { model: request.catalogModelId ? { id: request.catalogModelId } : null, endpoint, capability: request.capability }); } catch { return undefined; }
  const states: Record<string, GrantRuntimeState> = Object.create(null);
  for (const key in pool.states) if (Object.hasOwn(pool.states, key)) states[key] = overlay.runtime.get(key) ?? pool.states[key];
  for (const key of pool.keys) if (overlay.runtime.has(key)) states[key] = overlay.runtime.get(key)!;
  let selectedKey: string | undefined, cursorKey: string | undefined, count: number | undefined, lastMs: number | undefined;
  const result = selectGenerationAdmissionCandidate(env, { provider, endpoint, request, policy, poolKey: snap.poolKey,
    candidates: snap.candidates, states, identityHash: snap.identityHash, fallbackSessionHash: snap.fallbackSessionHash }, input => {
      const counts = new Map<string, { count: number; lastMs: number }>();
      for (const key in snap.counts) if (Object.hasOwn(snap.counts, key)) counts.set(key, snap.counts[key]);
      for (const value of overlay.counts.values()) if (value.providerId === request.providerId) counts.set(value.key, value);
      const choice = chooseGrantKey(input, normalizedChoiceCandidates(input.candidates), { cursorKey: overlay.cursors.get(request.providerId) ?? snap.cursorKey, counts });
      selectedKey = choice.selectedKey; cursorKey = choice.cursorKey;
      count = (counts.get(selectedKey)?.count ?? 0) + 1; lastMs = Date.now();
      return choice;
    }, key => snap.revisions[key], scratch);
  // The closed owner admits and detaches result.selected, and funds its pending
  // record/hint, BEFORE invoking commitSelection. Planning has no side effects.
  return { result, providerId: request.providerId, poolKey: snap.poolKey, selectedKey, cursorKey, count, lastMs };
}

// A detached runtime delta has its own positive common-arena owner. BOTH merge
// inputs stay owned until the detached output is admitted; account/extraUsage
// and snapshot aliases never escape under an already-released input lease.
const generationLookupGetter = (Object.prototype as { __lookupGetter__?: (key: string) => unknown }).__lookupGetter__;
const generationLookupSetter = (Object.prototype as { __lookupSetter__?: (key: string) => unknown }).__lookupSetter__;
function generationRuntimeCopyBytes(value: unknown, depth = 0): number {
  if (value == null || typeof value === "boolean" || typeof value === "number") return 8;
  if (typeof value === "string") return 2 * value.length;
  if (typeof value !== "object" || depth >= 24) throw identityFailure("protocol");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) throw identityFailure("protocol");
  if (typeof generationLookupGetter !== "function" || typeof generationLookupSetter !== "function") throw identityFailure("protocol");
  let bytes = 8;
  // Unlike JSON planning, structuredClone copies every enumerable own STRING
  // property, including undefined and array extras. Borrow one key at a time;
  // no descriptor-value carrier or whole key vector is constructed.
  for (const key in value) if (Object.hasOwn(value, key)) {
    if (generationLookupGetter.call(value, key) !== undefined || generationLookupSetter.call(value, key) !== undefined) throw identityFailure("protocol");
    bytes += 16 + 2 * key.length + generationRuntimeCopyBytes((value as Record<string, unknown>)[key], depth + 1);
    if (!Number.isSafeInteger(bytes) || bytes > 33554432) throw identityFailure("limit");
  }
  return bytes;
}
export function generationRuntimeWorkingBytes(previous: GrantRuntimeState | undefined, incoming: GrantRuntimeState): number {
  admitIdentity(previous ?? null, "record"); admitIdentity(incoming, "record");
  return 4096 + 4 * (generationRuntimeCopyBytes(previous) + generationRuntimeCopyBytes(incoming));
}
export function detachedGenerationRuntime(previous: GrantRuntimeState | undefined, incoming: GrantRuntimeState): GrantRuntimeState {
  const merged = mergeGrantRuntimeState(previous ?? null, incoming);
  return copyIdentity(merged);
}

// Prospectively visit the logical ordinary admission view, without cloning its
// frozen graph. Overlay representation does not weaken the complete profile.
export function admitGenerationOverlay(admission: AdmissionResult, overlay: GenerationAdvisoryState,
  selection?: GenerationSelectionPlan, runtime?: { key: string; value: GrantRuntimeState }): void {
  const plan = identityPlan();
  plan.object(0, root => {
    for (const field in admission) if (Object.hasOwn(admission, field)) {
      if (field === "selection" && selection) root(field, selection.result);
      else if (field === "pools") root(field, undefined, () => plan.object(1, pools => {
        for (const provider in admission.pools) if (Object.hasOwn(admission.pools, provider)) {
          const pool = admission.pools[provider];
          pools(provider, undefined, () => plan.object(2, member => {
            for (const name in pool) if (Object.hasOwn(pool, name)) {
              if (name !== "states") member(name, pool[name as keyof typeof pool]);
              else member(name, undefined, () => plan.object(3, state => {
                for (const key in pool.states) if (Object.hasOwn(pool.states, key)) state(key,
                  runtime?.key === key ? runtime.value : overlay.runtime.get(key) ?? pool.states[key]);
                for (const key of pool.keys) if (!Object.hasOwn(pool.states, key)) {
                  const value = runtime?.key === key ? runtime.value : overlay.runtime.get(key);
                  if (value) state(key, value);
                }
              }));
            }
          }));
        }
      }));
      else if (field === "snapshots") root(field, undefined, () => plan.object(1, snapshots => {
        for (const provider in admission.snapshots) if (Object.hasOwn(admission.snapshots, provider)) {
          const snap = admission.snapshots[provider];
          snapshots(provider, undefined, () => plan.object(2, member => {
            for (const name in snap) if (Object.hasOwn(snap, name)) {
              if (name === "cursorKey") member(name, selection?.providerId === provider && selection.cursorKey
                ? selection.cursorKey : overlay.cursors.get(provider) ?? snap.cursorKey);
              else if (name !== "counts") member(name, snap[name as keyof typeof snap]);
              else member(name, undefined, () => plan.object(3, counts => {
                const emit = (key: string, value: { count: number; lastMs: number }) => counts(key, undefined,
                  () => plan.object(4, counter => { counter("count", value.count); counter("lastMs", value.lastMs); }));
                for (const key in snap.counts) if (Object.hasOwn(snap.counts, key)) {
                  if (selection?.providerId === provider && selection.selectedKey === key) emit(key, { count: selection.count!, lastMs: selection.lastMs! });
                  else emit(key, overlay.counts.get(`${provider}\n${key}`) ?? snap.counts[key]);
                }
                for (const value of overlay.counts.values()) if (value.providerId === provider && !Object.hasOwn(snap.counts, value.key)) {
                  emit(value.key, selection?.providerId === provider && selection.selectedKey === value.key ? { count: selection.count!, lastMs: selection.lastMs! } : value);
                }
                if (selection?.providerId === provider && selection.selectedKey && !Object.hasOwn(snap.counts, selection.selectedKey)
                  && !overlay.counts.has(`${provider}\n${selection.selectedKey}`)) emit(selection.selectedKey, { count: selection.count!, lastMs: selection.lastMs! });
              }));
            }
          }));
        }
      }));
      else root(field, admission[field as keyof AdmissionResult]);
    }
    if (selection && !Object.hasOwn(admission, "selection")) root("selection", selection.result);
  });
}
