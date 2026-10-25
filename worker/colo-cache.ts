import { hotCacheNow, runInBackground, sharedHotCacheFence, type HotCacheConfig } from "./hot-cache.ts";
import { sha256Hex } from "./utils.ts";

// Per-colo layer under the isolate hot cache, backed by the Workers Cache API:
// a cold isolate can adopt a snapshot another isolate in the same location just
// fetched. Only secretless snapshots belong here; credentials never do. Entries
// keep their original fetch time, so the hot-cache max age still bounds them.
const ORIGIN = "https://hot-cache.clawrouter.internal";
const VERSION = 1;

function sharedCache(): Cache | undefined {
  try { return typeof caches === "undefined" ? undefined : (caches as unknown as { default?: Cache }).default; }
  catch { return undefined; }
}

async function entryUrl(namespace: string, key: string): Promise<string> {
  return `${ORIGIN}/v${VERSION}/${namespace}/${await sha256Hex(`${namespace}\n${key}`)}`;
}

export async function coloGet<V>(namespace: string, key: string, config: HotCacheConfig): Promise<{ value: V; fetchedAt: number } | undefined> {
  const cache = sharedCache();
  if (!cache || !config.maxAgeMs) return undefined;
  try {
    const response = await cache.match(await entryUrl(namespace, key));
    if (!response) return undefined;
    const entry = await response.json<{ version: number; fetchedAt: number; value: V }>();
    const age = hotCacheNow() - entry.fetchedAt;
    if (entry.version !== VERSION || !Number.isFinite(age) || age < 0 || age >= config.maxAgeMs || entry.fetchedAt <= sharedHotCacheFence()) return undefined;
    return { value: entry.value, fetchedAt: entry.fetchedAt };
  } catch { return undefined; } // The colo layer is an optimization; failures fall through to the authority.
}

export function coloPut(namespace: string, key: string, value: unknown, fetchedAt: number, config: HotCacheConfig): void {
  const cache = sharedCache();
  if (!cache || !config.maxAgeMs) return;
  const ttl = Math.max(1, Math.ceil((config.maxAgeMs - (hotCacheNow() - fetchedAt)) / 1_000));
  runInBackground((async () => {
    await cache.put(await entryUrl(namespace, key), new Response(JSON.stringify({ version: VERSION, fetchedAt, value }), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
    }));
  })());
}
