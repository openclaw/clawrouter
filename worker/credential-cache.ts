import { grantRevision, grantUsable, REFRESH_MARGIN_MS } from "./grant-eligibility.ts";
import { HotCache, hotCacheConfig, registerHotCache, runInBackground, type HotCacheState } from "./hot-cache.ts";
import type { Env, UpstreamGrant } from "./types";

// Materialized upstream credentials, isolate memory only: never persisted,
// logged or returned to callers. A revoked or rotated credential can be used by
// this isolate until the max age or the token's refresh margin, whichever is first.
const credentials = registerHotCache(new HotCache<UpstreamGrant>(1024));

// The routing projection's generation/revision identify the published credential version.
const entryId = (key: string, grant: UpstreamGrant) => `${key}\n${grant.credentialGeneration ?? ""}\n${grantRevision(grant) ?? ""}`;
const loader = (materialize: () => Promise<UpstreamGrant>) => async () => {
  const materialized = await materialize();
  const expiresAt = materialized.expiresAt ? Date.parse(materialized.expiresAt) - REFRESH_MARGIN_MS : Number.POSITIVE_INFINITY;
  return { value: materialized, cacheable: grantUsable(materialized), expiresAt: Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY };
};

export async function cachedGrantCredentials(env: Env, key: string, grant: UpstreamGrant, materialize: () => Promise<UpstreamGrant>, observe?: (state: HotCacheState, waitedMs: number) => void): Promise<UpstreamGrant> {
  const config = hotCacheConfig(env), start = performance.now();
  if (!config.maxAgeMs) { const value = await materialize(); observe?.("off", performance.now() - start); return value; }
  const { value, state } = await credentials.get(entryId(key, grant), config, loader(materialize));
  observe?.(state, performance.now() - start);
  // Callers may decorate the grant; never hand out the shared cached object.
  return structuredClone(value);
}

/**
 * Warm the exact entry a later lookup for this grant version will use, so an
 * admission round trip and the credential owner round trip overlap. A version
 * mismatch simply leaves the prefetched entry unused.
 */
export function prefetchGrantCredentials(env: Env, key: string, grant: UpstreamGrant, materialize: () => Promise<UpstreamGrant>): void {
  const config = hotCacheConfig(env), id = entryId(key, grant);
  if (!config.maxAgeMs || credentials.peek(id, config)) return;
  runInBackground(credentials.load(id, config, loader(materialize)));
}

/** Drop every cached version of a grant (upstream 401/403, credential failure, revoke). */
export function evictGrantCredentials(key: string): void {
  credentials.deleteWhere(id => id.startsWith(`${key}\n`));
}
