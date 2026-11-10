import { admitIdentity, copyIdentity } from "./identity-admission.ts";
import { grantRevision, grantUsable, REFRESH_MARGIN_MS } from "./grant-eligibility.ts";
import { HotCache, hotCacheConfig, registerHotCache, tryRunInBackground, type HotCacheState } from "./hot-cache.ts";
import type { Env, UpstreamGrant } from "./types";
import { checkOwnedGenerationPrefetch, claimOwnedGenerationPrefetch, finishOwnedGenerationPrefetch,
  materializeOwnedGenerationPrefetch, type OwnedGenerationPrefetch } from "./credential-preflight.ts";
import { GenerationConsumptionLease } from "./credential-preflight-arena.ts";

// Materialized upstream credentials, isolate memory only: never persisted,
// logged or returned to callers. A revoked or rotated credential can be used by
// this isolate until the max age or the token's refresh margin, whichever is first.
const credentials = registerHotCache(new HotCache<UpstreamGrant>(1024));

// The routing projection's generation/revision identify the published credential version.
const entryId = (key: string, grant: UpstreamGrant) => `${key}\n${grant.credentialGeneration ?? ""}\n${grantRevision(grant) ?? ""}`;
const loader = (materialize: () => Promise<UpstreamGrant>) => async () => {
  const materialized = await materialize();
  admitIdentity(materialized, "record");
  const expiresAt = materialized.expiresAt ? Date.parse(materialized.expiresAt) - REFRESH_MARGIN_MS : Number.POSITIVE_INFINITY;
  return { value: materialized, cacheable: grantUsable(materialized), expiresAt: Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY };
};

export async function cachedGrantCredentials(env: Env, key: string, grant: UpstreamGrant, materialize: () => Promise<UpstreamGrant>, observe?: (state: HotCacheState, waitedMs: number) => void): Promise<UpstreamGrant> {
  admitIdentity(grant, "record");
  const config = hotCacheConfig(env), start = performance.now();
  if (!config.maxAgeMs) { const value = await materialize(); admitIdentity(value, "record"); observe?.("off", performance.now() - start); return value; }
  const { value, state } = await credentials.get(entryId(key, grant), config, loader(materialize));
  observe?.(state, performance.now() - start);
  // Callers may decorate the grant; never hand out the shared cached object.
  return copyIdentity(value);
}

/**
 * Warm the exact entry a later lookup for this grant version will use, so an
 * admission round trip and the credential owner round trip overlap. A version
 * mismatch simply leaves the prefetched entry unused.
 */
export function prefetchGrantCredentials(env: Env, key: string, grant: UpstreamGrant, materialize: () => Promise<UpstreamGrant>): void {
  admitIdentity(grant, "record");
  const config = hotCacheConfig(env), id = entryId(key, grant);
  if (!config.maxAgeMs || credentials.peek(id, config)) return;
  tryRunInBackground(() => credentials.load(id, config, loader(materialize)));
}

/** Drop every cached version of a grant (upstream 401/403, credential failure, revoke). */
export function evictGrantCredentials(key: string): void {
  credentials.deleteKeys(id => id.startsWith(`${key}\n`));
}

export type OwnedCredentialPrefetchReceipt = Readonly<{ accepted: false } | { accepted: true; completed: Promise<void> }>;
interface OwnedPrefetchRun {
  cap?: OwnedGenerationPrefetch; command?: { eligible: boolean; id: string; config: import("./hot-cache.ts").HotCacheConfig };
  original?: Promise<unknown>; completed?: Promise<void>; resolve?: () => void; reject?: (error: unknown) => void;
  started: boolean; finished: boolean; claimed: boolean; registrationFailed: boolean; registrationError?: unknown;
}
let ownedPrefetchPermits: WeakMap<object, OwnedGenerationPrefetch> | undefined;
let ownedPrefetchPermitCharge: GenerationConsumptionLease | undefined;
let ownedPrefetchPermitCount = 0;

// No exported mint or permit getter. The permit itself never leaves this module;
// the preflight module accepts its closed command only for this genuine pair.
export function ownsCredentialPrefetchPermit(permit: object, cap: OwnedGenerationPrefetch): boolean {
  return ownedPrefetchPermits?.get(permit) === cap;
}
function retireOwnedPrefetch(run: OwnedPrefetchRun, hasPrimary: boolean, primary?: unknown): void {
  if (run.finished) return;
  run.finished = true;
  const failures: unknown[] = [];
  if (run.registrationFailed) failures.push(run.registrationError);
  run.registrationError = undefined;
  const cap = run.cap; run.cap = undefined; run.command = undefined; run.original = undefined;
  // ORIGINAL load has settled, including its publication-finally and the
  // materialization reader's ORIGINAL read/FIRSTcancel/unlock jointail. Neither
  // cache publication nor the background registry's scalar lifetime proves this.
  try {
    if (cap) { if (run.claimed) finishOwnedGenerationPrefetch(cap, run); else cap.dispose(); }
  } catch (error) { failures.push(error); }
  ownedPrefetchPermits!.delete(run);
  if (!--ownedPrefetchPermitCount) {
    ownedPrefetchPermits = undefined;
    const charge = ownedPrefetchPermitCharge; ownedPrefetchPermitCharge = undefined;
    try { charge?.release(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "owned credential prefetch cleanup");
  if (hasPrimary) throw primary;
}
function settleOwnedPrefetch(run: OwnedPrefetchRun, hasPrimary: boolean, primary?: unknown): void {
  const resolve = run.resolve!, reject = run.reject!;
  run.resolve = undefined; run.reject = undefined; run.completed = undefined;
  try { retireOwnedPrefetch(run, hasPrimary, primary); resolve(); }
  catch (error) { reject(error); }
}
function startOwnedPrefetch(run: OwnedPrefetchRun): Promise<void> {
  run.started = true;
  const completed = run.completed!;
  try {
    // Capture the ACTUAL load promise. A joining request still owns its child
    // while it polls, and can become the loader under that same child afterwards.
    run.original = credentials.load(run.command!.id, run.command!.config,
      loader(() => materializeOwnedGenerationPrefetch(run.cap!, run)));
  } catch (error) {
    // tryRunInBackground treats a synchronous start throw as accepted. Turn it
    // into this same accepted operation's immediately observed failure instead.
    run.original = Promise.reject(error);
  }
  void run.original.then(() => settleOwnedPrefetch(run, false), error => settleOwnedPrefetch(run, true, error));
  return completed;
}

/** Inactive, closed hint-only ownership. Ordinary prefetch remains unchanged. */
export function prefetchOwnedGrantCredentials(cap: OwnedGenerationPrefetch): OwnedCredentialPrefetchReceipt {
  checkOwnedGenerationPrefetch(cap);
  // The genuine cap already owns the complete temporary component and a child.
  // A separately charged lazy registry cannot disappear while another run lives.
  if (!ownedPrefetchPermits) {
    try { ownedPrefetchPermitCharge = GenerationConsumptionLease.reserve(512); ownedPrefetchPermits = new WeakMap(); }
    catch (primary) { try { cap.dispose(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "owned prefetch registration"); } throw primary; }
  }
  const run: OwnedPrefetchRun = { cap, started: false, finished: false, claimed: false, registrationFailed: false };
  ownedPrefetchPermits.set(run, cap); ownedPrefetchPermitCount++;
  try {
    run.command = claimOwnedGenerationPrefetch(cap, run); run.claimed = true;
    if (!run.command.eligible || !run.command.config.maxAgeMs || credentials.peek(run.command.id, run.command.config)) {
      retireOwnedPrefetch(run, false); return Object.freeze({ accepted: false });
    }
    const completed = new Promise<void>((resolve, reject) => { run.resolve = resolve; run.reject = reject; });
    run.completed = completed;
    void completed.then(() => undefined, () => undefined);
    let accepted: boolean;
    try { accepted = tryRunInBackground(() => startOwnedPrefetch(run)); }
    catch (error) {
      if (!run.started) throw error;
      run.registrationFailed = true; run.registrationError = error; accepted = true;
    }
    if (!accepted && !run.started) {
      // No loader/timer/materializer started. Settle the unexposed follower only
      // after unwinding the provisional child, preserving the existing hint.
      const resolve = run.resolve!;
      retireOwnedPrefetch(run, false);
      run.resolve = undefined; run.reject = undefined; run.completed = undefined;
      resolve(); return Object.freeze({ accepted: false });
    }
    return Object.freeze({ accepted: true, completed });
  } catch (primary) {
    if (!run.started) {
      const reject = run.reject; run.resolve = undefined; run.reject = undefined; run.completed = undefined;
      if (!run.finished) {
        try { retireOwnedPrefetch(run, true, primary); }
        catch (failure) { reject?.(failure); throw failure; }
      }
      reject?.(primary);
    }
    throw primary;
  }
}
