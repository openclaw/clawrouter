import type { Env } from "./types";

// Isolate-local hot-path caches. Entries live only in this isolate's memory:
// nothing here is persisted, logged or shared with other isolates. Staleness is
// bounded by the max age; each isolate converges independently.
export const HOT_CACHE_DEFAULT_MAX_AGE_SECONDS = 60;
export const HOT_CACHE_FRESH_SECONDS = 10;

export interface HotCacheConfig { readonly maxAgeMs: number; readonly freshMs: number }
export type HotCacheState = "hit" | "stale" | "miss" | "off";

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
export function hotCacheNow(): number { return clock(); }
/** Test hook: inject a clock; call with no argument to restore Date.now. */
export function setHotCacheClock(next?: () => number): void { clock = next ?? (() => Date.now()); }

// Work that must outlive the current response (stale refreshes, coalesced
// counters). The Worker entry hands the pending set to ctx.waitUntil. A hung
// backend call leaves the set after the bound, so later requests never keep
// extending their waitUntil for it.
export const BACKGROUND_WORK_BOUND_MS = 25_000;
const background = new Set<Promise<unknown>>();
export function runInBackground(work: Promise<unknown>): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>(resolve => { timer = setTimeout(resolve, BACKGROUND_WORK_BOUND_MS); });
  const tracked: Promise<unknown> = Promise.race([work.catch(() => undefined), bound]).finally(() => { clearTimeout(timer); background.delete(tracked); });
  background.add(tracked);
}
export function pendingBackgroundWork(): Promise<unknown> | null {
  return background.size ? Promise.allSettled([...background]) : null;
}

interface Entry<V> { value: V; storedAt: number; expiresAt: number }
export interface Loaded<V> { value: V; cacheable: boolean; expiresAt?: number }

export class HotCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<Loaded<V>>>();
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

  set(key: string, value: V, config: HotCacheConfig, expiresAt = Number.POSITIVE_INFINITY): void {
    if (!config.maxAgeMs) return;
    const storedAt = hotCacheNow();
    if (expiresAt <= storedAt) { this.entries.delete(key); return; }
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt, expiresAt });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  values(): IterableIterator<V> { return [...this.entries.values()].map(entry => entry.value)[Symbol.iterator](); }
  delete(key: string): void { this.entries.delete(key); }
  deleteWhere(predicate: (key: string, value: V) => boolean): void {
    for (const [key, entry] of this.entries) if (predicate(key, entry.value)) this.entries.delete(key);
  }
  clear(): void { this.entries.clear(); this.inflight.clear(); }

  /** Single-flight load; a cacheable result is stored before callers resume. */
  load(key: string, config: HotCacheConfig, loader: () => Promise<Loaded<V>>): Promise<Loaded<V>> {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const started = (async () => {
      try {
        const loaded = await loader();
        if (loaded.cacheable) this.set(key, loaded.value, config, loaded.expiresAt);
        else this.entries.delete(key);
        return loaded;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, started);
    return started;
  }

  /** Start one background refresh unless a load for this key is already running. */
  revalidate(key: string, config: HotCacheConfig, loader: () => Promise<Loaded<V>>): void {
    if (!this.inflight.has(key)) runInBackground(this.load(key, config, loader));
  }

  /** Serve fresh entries, serve stale entries while one background refresh runs, else load. */
  async get(key: string, config: HotCacheConfig, loader: () => Promise<Loaded<V>>): Promise<{ value: V; state: HotCacheState }> {
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
