import { authorityCall, type AdmissionResult } from "./authority.ts";
import type { AdmissionPoolSnapshot, AdmissionRequest, AdmissionSelection } from "./authority-admission.ts";
import { selectAdmissionCandidate } from "./authority-grant-selection.ts";
import { credentialExpired } from "./credential-lifecycle.ts";
import type { GrantSelectionResult } from "./grant-eligibility.ts";
import { chooseGrantKey, normalizedChoiceCandidates, type GrantChoiceInput } from "./grant-selection-strategies.ts";
import { HotCache, hotCacheConfig, hotCacheNow, registerHotCache, runInBackground, waitForOtherRequest, type HotCacheConfig, type HotCacheState } from "./hot-cache.ts";
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

export async function resolveAdmission(env: Env, request: CachedAdmissionRequest): Promise<{ admission: AdmissionResult; cache: HotCacheState }> {
  const config = hotCacheConfig(env);
  if (!config.maxAgeMs) return { admission: await authorityCall<AdmissionResult>(env, "/admission/resolve", request), cache: "off" };
  const key = cacheKey(request);
  // Failover after an upstream rejection is off the hot path: it always takes a
  // fresh authoritative admission so tenant/pool changes apply to the alternate.
  const cached = request.selection?.excludedKeys?.length ? undefined : admissions.peek(key, config);
  // Every request re-verifies its own secret; a mismatch (wrong key or rotation)
  // always goes back to the authority instead of trusting the cached digest.
  if (cached && safeEqual(request.secretSha256, cached.value.credential!.credential.secretSha256.toLowerCase())) {
    const selection = request.selection ? localSelection(env, cached.value, request.selection) : undefined;
    if (!request.selection || selection) {
      if (!cached.fresh) admissions.revalidate(key, config, () => load(env, config, { ...request, selection: request.selection && { ...request.selection, excludedKeys: undefined }, snapshot: request.selection ? "only" : undefined }));
      rememberSelection(key, request, selection);
      return { admission: { ...cached.value, ...(selection ? { selection } : {}) }, cache: cached.fresh ? "hit" : "stale" };
    }
  }
  prefetchRememberedCredential(env, key, request);
  // Another isolate in this location may have fetched it moments ago.
  const shared = request.selection?.excludedKeys?.length ? undefined : await coloGet<AdmissionResult>("admission", key, config);
  if (shared && cacheable(shared.value, request.secretSha256)) {
    admissions.set(key, shared.value, config, expiryOf(shared.value), shared.fetchedAt);
    const selection = request.selection ? localSelection(env, shared.value, request.selection) : undefined;
    if (!request.selection || selection) {
      if (hotCacheNow() - shared.fetchedAt >= config.freshMs) admissions.revalidate(key, config, () => load(env, config, { ...request, selection: request.selection && { ...request.selection, excludedKeys: undefined }, snapshot: request.selection ? "only" : undefined }));
      rememberSelection(key, request, selection);
      return { admission: { ...shared.value, ...(selection ? { selection } : {}) }, cache: "colo" };
    }
  }
  const failover = !!request.selection?.excludedKeys?.length;
  // A burst of cold requests for one key shares the first authority call: the
  // rest wait for its snapshot, re-verify their own secret and select locally.
  const leader = failover ? undefined : inflightMisses.get(key);
  if (leader) {
    await waitForOtherRequest(() => leader.settled);
    const joined = admissions.peek(key, config);
    if (joined && safeEqual(request.secretSha256, joined.value.credential!.credential.secretSha256.toLowerCase())) {
      const selection = request.selection ? localSelection(env, joined.value, request.selection) : undefined;
      if (!request.selection || selection) {
        rememberSelection(key, request, selection);
        return { admission: { ...joined.value, ...(selection ? { selection } : {}) }, cache: "joined" };
      }
    }
  }
  const flight = (async () => {
    const loaded = await load(env, config, { ...request, snapshot: request.selection ? "select" : undefined });
    if (loaded.cacheable) rememberSelection(key, request, loaded.value.selection);
    if (loaded.cacheable) admissions.set(key, withoutSelection(loaded.value), config, loaded.expiresAt);
    // A wrong secret must not evict the key owner's entry; only an outcome
    // observed with the matching secret (revoked, disabled, missing) does.
    else if (!loaded.value.credential || safeEqual(request.secretSha256, loaded.value.credential.credential.secretSha256.toLowerCase())) admissions.delete(key);
    return loaded;
  })();
  const owns = !failover && !leader;
  const marker = { settled: false };
  if (owns) inflightMisses.set(key, marker);
  try { return { admission: (await flight).value, cache: "miss" }; }
  finally { marker.settled = true; if (owns && inflightMisses.get(key) === marker) inflightMisses.delete(key); }
}

// Concurrent misses wait on this flag with their own timers, never on the
// leader's promise (see waitForOtherRequest).
const inflightMisses = new Map<string, { settled: boolean }>();

async function load(env: Env, config: HotCacheConfig, request: CachedAdmissionRequest) {
  const value = await authorityCall<AdmissionResult>(env, "/admission/resolve", request);
  const ok = config.maxAgeMs > 0 && cacheable(value, request.secretSha256);
  // Publish the secretless snapshot for other isolates in this location.
  if (ok) coloPut("admission", cacheKey(request), withoutSelection(value), hotCacheNow(), config);
  return { value: request.snapshot === "only" ? withoutSelection(value) : value, cacheable: ok, expiresAt: expiryOf(value) };
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
  if (!provider) return;
  prefetchGrantCredentials(env, hint.key, hint.grant, () => materializeGrantCredentials(env, hint.key, hint.grant, provider.id, provider.auth.refresh, false));
}

function cacheKey(request: AdmissionRequest): string {
  return JSON.stringify([request.credentialId, (request.providers ?? []).map(item => `${item.id}:${item.tokenRef}`).sort(), !!request.allConnections]);
}

// Only fully admitted outcomes are cached; failures always re-ask the authority.
function cacheable(result: AdmissionResult, secretSha256: string): boolean {
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

function localSelection(env: Env, admission: AdmissionResult, request: AdmissionSelection): GrantSelectionResult | undefined {
  const pool = admission.pools[request.providerId], snap = admission.snapshots?.[request.providerId], policy = admission.policy;
  if (!pool || !snap || !policy) return undefined;
  const provider = snapshot.providers.find(item => item.id === request.providerId);
  const endpoint = provider?.endpoints.find(item => item.id === request.endpointId);
  if (!provider || !endpoint) return undefined;
  // Mirror the authority's early exits; the Worker then reports the denial itself.
  if (policy.policy.providers.length && !policy.policy.providers.includes(provider.id) || admission.connections.find(item => item.providerId === provider.id)?.enabled === false) return undefined;
  try { assertPolicyModel(policy.policy, { model: request.catalogModelId ? { id: request.catalogModelId } : null, endpoint, capability: request.capability }); } catch { return undefined; }
  const result = selectAdmissionCandidate(env, { provider, endpoint, request, policy, poolKey: snap.poolKey, candidates: snap.candidates, states: pool.states, identityHash: snap.identityHash, fallbackSessionHash: snap.fallbackSessionHash }, choice => chooseLocally(env, snap, choice), key => snap.revisions[key]);
  // The snapshot is shared by concurrent requests; hand out a private copy.
  return result.selected ? { ...result, selected: structuredClone(result.selected) } : result;
}

function chooseLocally(env: Env, snap: AdmissionPoolSnapshot, input: GrantChoiceInput): { selectedKey: string } {
  const choice = chooseGrantKey(input, normalizedChoiceCandidates(input.candidates), { cursorKey: snap.cursorKey, counts: new Map(Object.entries(snap.counts)) });
  const now = Date.now();
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
let flushScheduled = false;
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
  flushScheduled = true;
  runInBackground(new Promise(resolve => setTimeout(resolve, flushWindowMs)).then(() => flushSelections(env)));
}

export async function flushSelections(env: Env): Promise<void> {
  flushScheduled = false;
  const records = [...pendingSelections.values()];
  pendingSelections.clear();
  const runtime = [...pendingRuntime];
  pendingRuntime.clear();
  const feedback = Promise.all(runtime.map(([key, state]) => recordGrantRuntime(env, key, state).catch(() => undefined)));
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

/** Apply observed quota/cooldown state to this isolate's snapshots immediately. */
export function applyLocalGrantRuntime(key: string, state: GrantRuntimeState): void {
  for (const admission of admissions.values()) {
    for (const pool of Object.values(admission.pools)) if (pool.keys.includes(key)) pool.states[key] = state;
  }
}

/** Same-isolate invalidation after a mutation; other isolates converge by max age. */
export function invalidateAdmissions(predicate: (admission: AdmissionResult) => boolean = () => true): void {
  admissions.deleteWhere((_key, admission) => predicate(admission));
}
