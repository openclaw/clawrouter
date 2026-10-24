import { grantRevision, grantUsable, REFRESH_MARGIN_MS } from "./grant-eligibility.ts";
import { HotCache, hotCacheConfig, registerHotCache } from "./hot-cache.ts";
import type { Env, UpstreamGrant } from "./types";

// Materialized upstream credentials, isolate memory only: never persisted,
// logged or returned to callers. A revoked or rotated credential can be used by
// this isolate until the max age or the token's refresh margin, whichever is first.
const credentials = registerHotCache(new HotCache<UpstreamGrant>(1024));

export async function cachedGrantCredentials(env: Env, key: string, grant: UpstreamGrant, materialize: () => Promise<UpstreamGrant>): Promise<UpstreamGrant> {
  const config = hotCacheConfig(env);
  if (!config.maxAgeMs) return materialize();
  // The routing projection's generation/revision identify the published credential version.
  const id = `${key}\n${grant.credentialGeneration ?? ""}\n${grantRevision(grant) ?? ""}`;
  const { value } = await credentials.get(id, config, async () => {
    const materialized = await materialize();
    const expiresAt = materialized.expiresAt ? Date.parse(materialized.expiresAt) - REFRESH_MARGIN_MS : Number.POSITIVE_INFINITY;
    return { value: materialized, cacheable: grantUsable(materialized), expiresAt: Number.isFinite(expiresAt) ? expiresAt : Number.POSITIVE_INFINITY };
  });
  // Callers may decorate the grant; never hand out the shared cached object.
  return structuredClone(value);
}

/** Drop every cached version of a grant (upstream 401/403, credential failure, revoke). */
export function evictGrantCredentials(key: string): void {
  credentials.deleteWhere(id => id.startsWith(`${key}\n`));
}
