import type { Env } from "./types";
import { ExactBodyCharge } from "./body-budget.ts";
import { GenerationMetadataCharge, GenerationRetainedCharge, PreflightTicket } from "./credential-preflight-arena.ts";

// Isolate-local hot-path caches. Entries live only in this isolate's memory:
// nothing here is persisted, logged or shared with other isolates. Staleness is
// bounded by the max age; each isolate converges independently.
export const HOT_CACHE_DEFAULT_MAX_AGE_SECONDS = 60;
export const HOT_CACHE_FRESH_SECONDS = 10;

export interface HotCacheConfig { readonly maxAgeMs: number; readonly freshMs: number }
export type HotCacheState = "hit" | "stale" | "colo" | "joined" | "miss" | "off";

const DISABLED: HotCacheConfig = Object.freeze({ maxAgeMs: 0, freshMs: 0 });

let override: HotCacheConfig | undefined;
/** Test hook: force a config (e.g. disabled for authority-path suites); no argument restores env parsing. */
export function overrideHotCacheConfig(next?: HotCacheConfig): void { override = next; }
export const HOT_CACHE_DISABLED = DISABLED;

export function hotCacheConfig(env: Pick<Env, "CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS">): HotCacheConfig {
  if (override) return override;
  const raw = env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS;
  const seconds = raw === undefined || raw === null || String(raw).trim() === "" ? HOT_CACHE_DEFAULT_MAX_AGE_SECONDS : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return DISABLED;
  const maxAgeMs = Math.min(seconds, 3_600) * 1_000;
  return { maxAgeMs, freshMs: Math.min(HOT_CACHE_FRESH_SECONDS * 1_000, maxAgeMs) };
}

let clock: () => number = () => Date.now();

// Workers resume the code after `await promise` in the I/O context of whichever
// request resolved that promise. Awaiting another request's in-flight load would
// attribute this request's later I/O (upstream fetch, response stream) to it, and
// the runtime rejects that with "Cannot perform I/O on behalf of a different
// request". Waiters therefore poll shared state on their own timers, bounded.
export const JOIN_WAIT_MS = 5_000;
export async function waitForOtherRequest(settled: () => boolean, timeoutMs = JOIN_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (let step = 1; !settled(); step = Math.min(step * 2, 16)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, step));
  }
  return true;
}
export function hotCacheNow(): number { return clock(); }
/** Test hook: inject a clock; call with no argument to restore Date.now. */
export function setHotCacheClock(next?: () => number): void { clock = next ?? (() => Date.now()); }

// Registration bounds logical background custody, not platform execution or
// originating-request I/O lifetime. Facades never release a live registration.
export const BACKGROUND_WORK_LIMIT = 64;
export const BACKGROUND_WORK_BOUND_MS = 25_000;
export const DRAIN_BOUND_MS = 10_000;
let workSeq = 0;
const background = new Map<number, number>();
/** Accepted registration, not task success. Overflow never invokes start. */
export function tryRunInBackground(start: () => unknown): boolean {
  if (background.size >= BACKGROUND_WORK_LIMIT) return false;
  const identity = ++workSeq;
  background.set(identity, performance.now());
  const settled = () => { background.delete(identity); };
  try { void Promise.resolve(start()).then(settled, settled); }
  catch { settled(); }
  return true;
}
/** Scalar sequence boundary, not request identity; interleaved work is included. */
export function backgroundMark(): number { return workSeq; }
export function pendingBackgroundWork(since = 0): Promise<unknown> | null {
  // Monotonic visibility age, independent of the cache TTL/wall clock. Snapshot
  // only scalars; the hard bound and polling timers belong to THIS caller.
  const cohort = [...background].filter(([seq]) => seq > since)
    .map(([seq, at]) => [seq, at + BACKGROUND_WORK_BOUND_MS] as const);
  if (!cohort.length) return null;
  return new Promise<void>(resolve => {
    let poll: ReturnType<typeof setTimeout> | undefined;
    let step = 1, finished = false;
    const finish = () => { finished = true; clearTimeout(bound); clearTimeout(poll); resolve(); };
    const bound = setTimeout(finish, DRAIN_BOUND_MS);
    const inspect = () => {
      if (finished) return;
      if (cohort.every(([seq, until]) => !background.has(seq) || performance.now() >= until)) finish();
      else {
        try { poll = setTimeout(inspect, step); step = Math.min(step * 2, 16); }
        catch { finish(); } // Best-effort facade only; actual custody is unchanged.
      }
    };
    inspect();
  });
}

interface Entry<V> { value: V; storedAt: number; expiresAt: number }
export interface Loaded<V> { value: V; cacheable: boolean; expiresAt?: number; storedAt?: number }
const publicationBrand = Symbol("cache publication");
export interface CachePublication { readonly [publicationBrand]: true; readonly acquiredAt: number }
type Loader<V> = (publication?: CachePublication) => Promise<Loaded<V>>;

export class HotCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly publications = new Map<string, CachePublication>();
  // Invalidated owners remain charged here until their own work settles. Never
  // evict fencing evidence to admit another leader; overflow runs uncached.
  private readonly livePublications = new Set<CachePublication>();
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }

  get size(): number { return this.entries.size; }

  /** Returns a usable entry and whether it is still fresh. Expired entries are dropped. */
  peek(key: string, config: HotCacheConfig): { value: V; fresh: boolean } | undefined {
    if (!config.maxAgeMs) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = hotCacheNow();
    if (now >= entry.expiresAt || now - entry.storedAt >= config.maxAgeMs || now < entry.storedAt) { this.entries.delete(key); return undefined; }
    // Refresh LRU position.
    this.entries.delete(key); this.entries.set(key, entry);
    return { value: entry.value, fresh: now - entry.storedAt < config.freshMs };
  }

  /** `storedAt` lets an entry adopted from the colo cache keep its original fetch time. */
  set(key: string, value: V, config: HotCacheConfig, expiresAt = Number.POSITIVE_INFINITY, storedAt = hotCacheNow()): void {
    this.publications.delete(key);
    this.store(key, value, config, expiresAt, storedAt);
  }

  private store(key: string, value: V, config: HotCacheConfig, expiresAt: number, storedAt: number): void {
    if (!config.maxAgeMs) return;
    if (expiresAt <= storedAt) { this.entries.delete(key); return; }
    // A foreign colo timestamp may exceed this isolate's acquisition clock.
    // Observe it before publication so a later rollback cannot lower the fence.
    if (Number.isFinite(storedAt)) issuedWatermark = Math.max(issuedWatermark, storedAt);
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt, expiresAt });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  values(): IterableIterator<V> { return [...this.entries.values()].map(entry => entry.value)[Symbol.iterator](); }
  delete(key: string): void { this.entries.delete(key); this.publications.delete(key); }
  /** Key-only invalidation also covers versions which have never stored a value. */
  deleteKeys(predicate: (key: string) => boolean): void {
    for (const key of this.entries.keys()) if (predicate(key)) this.entries.delete(key);
    for (const key of this.publications.keys()) if (predicate(key)) this.publications.delete(key);
  }
  deleteWhere(predicate: (key: string, value: V) => boolean): void {
    // Pending values are unknown. Revoke their publication rights conservatively;
    // do not retain predicates or discard unrelated already-stored values.
    this.publications.clear();
    for (const [key, entry] of this.entries) if (predicate(key, entry.value)) this.entries.delete(key);
  }
  clear(): void { this.entries.clear(); this.publications.clear(); }

  publication(key: string): CachePublication | undefined { return this.publications.get(key); }
  ownsPublication(key: string, publication: CachePublication | undefined): boolean {
    return publication !== undefined && this.publications.get(key) === publication;
  }
  beginPublication(key: string): CachePublication | undefined {
    this.publications.delete(key);
    if (this.livePublications.size >= this.limit) return undefined;
    const publication: CachePublication = Object.freeze({ [publicationBrand]: true as const, acquiredAt: hotCacheAcquiredAt() });
    this.livePublications.add(publication);
    this.publications.set(key, publication);
    return publication;
  }
  endPublication(key: string, publication: CachePublication | undefined): void {
    if (!publication) return;
    if (this.ownsPublication(key, publication)) this.publications.delete(key);
    this.livePublications.delete(publication);
  }
  /** Conditional commits never invalidate their own leader. */
  publish(key: string, publication: CachePublication | undefined, value: V, config: HotCacheConfig, expiresAt = Number.POSITIVE_INFINITY, storedAt = publication?.acquiredAt ?? hotCacheNow()): boolean {
    if (!this.ownsPublication(key, publication)) return false;
    this.store(key, value, config, expiresAt, storedAt);
    return true;
  }
  discardPublished(key: string, publication: CachePublication | undefined): void {
    if (this.ownsPublication(key, publication)) this.entries.delete(key);
  }

  /** Poll markers on this request's timers, including replacement leadership. */
  async waitForPublication(key: string, config: HotCacheConfig): Promise<{ value: V; fresh: boolean } | undefined> {
    const deadline = Date.now() + JOIN_WAIT_MS;
    for (let pending = this.publication(key); pending; pending = this.publication(key)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await waitForOtherRequest(() => !this.ownsPublication(key, pending), remaining);
      const entry = this.peek(key, config);
      if (entry) return entry;
    }
    return this.peek(key, config);
  }

  async load(key: string, config: HotCacheConfig, loader: Loader<V>): Promise<Loaded<V>> {
    if (this.publication(key)) {
      await this.waitForPublication(key, config);
      const entry = this.peek(key, config);
      if (entry) return { value: entry.value, cacheable: true };
    }
    // Install ownership before invoking even the synchronous part of the loader.
    const publication = this.beginPublication(key);
    try {
      const loaded = await loader(publication);
      if (loaded.cacheable) this.publish(key, publication, loaded.value, config, loaded.expiresAt, loaded.storedAt ?? publication?.acquiredAt);
      else this.discardPublished(key, publication);
      return loaded;
    } finally { this.endPublication(key, publication); }
  }

  /** Start one background refresh unless a load for this key is already running. */
  revalidate(key: string, config: HotCacheConfig, loader: Loader<V>): void {
    if (!this.publication(key)) tryRunInBackground(() => this.load(key, config, loader));
  }

  /** Serve fresh entries, serve stale entries while one background refresh runs, else load. */
  async get(key: string, config: HotCacheConfig, loader: Loader<V>): Promise<{ value: V; state: HotCacheState }> {
    if (!config.maxAgeMs) return { value: (await loader()).value, state: "off" };
    const cached = this.peek(key, config);
    if (cached?.fresh) return { value: cached.value, state: "hit" };
    if (cached) {
      this.revalidate(key, config, loader);
      return { value: cached.value, state: "stale" };
    }
    return { value: (await this.load(key, config, loader)).value, state: "miss" };
  }
}

const caches = new Set<{ clear(): void }>();
export function registerHotCache<V extends { clear(): void }>(cache: V): V { caches.add(cache); return cache; }
/** Test hook and local invalidation after same-isolate admin mutations. */
export function clearHotCaches(): void { for (const cache of caches) cache.clear(); }

// Shared (colo) entries fetched before a mutation served by this isolate are
// ignored here, so this isolate's own changes still apply immediately.
let sharedFence = 0;
let issuedWatermark = 0;
/** Original acquisition time, never a completion-time freshness extension. */
export function hotCacheAcquiredAt(): number {
  const acquiredAt = hotCacheNow();
  issuedWatermark = Math.max(issuedWatermark, acquiredAt);
  return acquiredAt;
}
export function fenceSharedHotCache(): void { sharedFence = Math.max(sharedFence, issuedWatermark, hotCacheNow()); }
export function sharedHotCacheFence(): number { return sharedFence; }
/** Test hook: forget the fence between independent tests. */
export function resetSharedHotCacheFence(): void { sharedFence = 0; issuedWatermark = 0; }

// PRIVATE retained generations only. Ordinary HotCache publication is unchanged
// and is never used as a funding receipt. All coordinates are aggregate across
// this isolate; they are logical application quantities, not native heap sizes.
export interface PrivateCacheVector { serializedBytes: number; payloadBytes: number; structure: number }
export const privateCacheLimits = Object.freeze({ valueBytes: 2097152, serializedBytes: 8388608, payloadBytes: 8388608, structure: 524288 });
let privateSerialized = 0, privatePayload = 0, privateStructure = 0;
let privateMetadata: WeakMap<GenerationMetadataCharge, PrivateCacheReservation> | undefined;
let privateMetadataOwners = 0;
export class PrivateCacheReservation {
  private serialized: number;
  private payload: number;
  private fields: number;
  private charge?: ExactBodyCharge | GenerationRetainedCharge;
  private metadata?: GenerationMetadataCharge;
  private constructor(serialized: number, payload: number, fields: number, charge?: ExactBodyCharge | GenerationRetainedCharge, metadata?: GenerationMetadataCharge) {
    this.serialized = serialized; this.payload = payload; this.fields = fields; this.charge = charge; this.metadata = metadata;
  }
  static reserve(vector: PrivateCacheVector): PrivateCacheReservation | null {
    if (!this.fits(vector.serializedBytes, vector.payloadBytes, vector.structure)) return null;
    // The temporary ticket is STILL funded while the exact destination reserves.
    const charge = ExactBodyCharge.reserve(vector.payloadBytes);
    if (!charge) return null;
    return this.commit(vector.serializedBytes, vector.payloadBytes, vector.structure, charge);
  }
  static transfer(vector: PrivateCacheVector, ticket: PreflightTicket): PrivateCacheReservation | null {
    if (!this.fits(vector.serializedBytes, vector.payloadBytes, vector.structure)) return null;
    // This synchronous provisional ledger verdict earmarks the SAME ready
    // source backing. It creates no independently spendable extra credit.
    const charge = ticket.transferGeneration(vector.payloadBytes);
    if (!charge) return null;
    return this.commit(vector.serializedBytes, vector.payloadBytes, vector.structure, charge);
  }
  static adoptMetadata(funding: GenerationMetadataCharge): PrivateCacheReservation | null {
    if (!(funding instanceof GenerationMetadataCharge) || funding.bytes !== funding.payloadBytes || privateMetadata?.has(funding)) return null;
    if (!this.fits(0, funding.payloadBytes, funding.structure)) return null;
    // Funding stays with its original dynamic owner. This receipt adds only the
    // shared-vector claim; no second common-arena charge or ownership gap.
    const receipt = this.commit(0, funding.payloadBytes, funding.structure, undefined, funding);
    // Each metadata owner prepays the fixed shared-index products. The last
    // owner clears the index; an earlier retirement never leaves it unfunded.
    privateMetadata ??= new WeakMap(); privateMetadata.set(funding, receipt); privateMetadataOwners++; return receipt;
  }
  private static fits(serialized: number, payload: number, fields: number): boolean {
    return Number.isSafeInteger(serialized) && serialized >= 0 && serialized <= privateCacheLimits.valueBytes
      && Number.isSafeInteger(payload) && payload > 0 && Number.isSafeInteger(fields) && fields > 0
      && serialized <= privateCacheLimits.serializedBytes - privateSerialized
      && payload <= privateCacheLimits.payloadBytes - privatePayload
      && fields <= privateCacheLimits.structure - privateStructure;
  }
  private static commit(serialized: number, payload: number, fields: number, charge?: ExactBodyCharge | GenerationRetainedCharge, metadata?: GenerationMetadataCharge): PrivateCacheReservation {
    const receipt = new PrivateCacheReservation(serialized, payload, fields, charge, metadata);
    privateSerialized += serialized; privatePayload += payload; privateStructure += fields;
    return receipt;
  }
  demoteForBorrow(): GenerationRetainedCharge | null {
    const charge = this.charge;
    if (!(charge instanceof GenerationRetainedCharge) || !charge.expandForBorrow()) return null;
    // Only the graph leaves the optional cache. Every existing metadata receipt
    // remains charged until its actual owner retires. The caller takes this SAME
    // backing synchronously, before publication or the ledger claim is removed.
    this.charge = undefined;
    this.release();
    return charge;
  }
  release(): void {
    privateSerialized -= this.serialized; privatePayload -= this.payload; privateStructure -= this.fields;
    this.serialized = 0; this.payload = 0; this.fields = 0;
    if (this.metadata) { privateMetadata!.delete(this.metadata); if (--privateMetadataOwners === 0) privateMetadata = undefined; }
    this.metadata = undefined; this.charge?.release(); this.charge = undefined;
  }
}
export function privateCacheCharged(): PrivateCacheVector {
  return { serializedBytes: privateSerialized, payloadBytes: privatePayload, structure: privateStructure };
}
