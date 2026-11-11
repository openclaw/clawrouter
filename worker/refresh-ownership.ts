import type { Env, UpstreamGrant } from "./types.ts";
import { boundedSecret } from "./grant-refresh-diagnosis.ts";
import { HttpError, readJson } from "./utils.ts";

// Reuse the credential binding, with a reserved non-grant object name. Its
// random HMAC key and full digests stay private to this object, never in KV,
// grant projections, diagnostic records, or logs. No new deployment secret.
const INDEX = "clawrouter:refresh-ownership:v1";
export const OWNERSHIP_CLAIM = "/refresh-ownership/claim";
export const OWNERSHIP_CURRENT = "/refresh-ownership/current";

export async function claimRefreshOwnership(env: Env, key: string, token: string, options: { current?: boolean; consume?: boolean } = {}): Promise<void> {
  const response = await env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(INDEX)).fetch(`https://clawrouter.internal${OWNERSHIP_CLAIM}`, {
    method: "POST", body: JSON.stringify({ key, token, ...options }),
  });
  if (response.status === 409) throw new HttpError(409, "refresh_token_already_owned", "refresh token is already owned by another grant; use a fresh dedicated login");
  if (response.status === 422) throw new HttpError(409, "refresh_token_previously_used", "this refresh token was already sent to the provider; use a fresh dedicated login rather than replaying an old token");
  if (!response.ok) throw new HttpError(503, "refresh_ownership_unavailable", "refresh ownership could not be verified; retry before importing credentials");
}

/** Called under the reserved object's serialized tail, including discovery. */
export async function reserveRefreshOwnership(storage: DurableObjectStorage, env: Env, request: Request): Promise<Response> {
  const { key, token, current, consume } = await readJson<{ key: string; token: string; current?: boolean; consume?: boolean }>(request);
  if (typeof key !== "string" || !/^oauth\/(?:tenants\/)?[^/]+\/[^/]+$/.test(key)) throw new HttpError(400, "invalid_upstream_grant", "invalid credential owner");
  boundedSecret(token, "refresh token");
  let secret = await storage.get<Uint8Array>("ownership-key");
  if (!secret) { secret = crypto.getRandomValues(new Uint8Array(32)); await storage.put("ownership-key", secret); }
  const hmac = await crypto.subtle.importKey("raw", secret.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const fingerprint = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode("clawrouter:refresh:v1\0" + value))), byte => byte.toString(16).padStart(2, "0")).join("");
  const id = "owner:" + await fingerprint(token);
  const reservation = await storage.get<{ owner: string; used: boolean }>(id);
  if (reservation) {
    if (reservation.owner !== key) return new Response(null, { status: 409 });
    if (reservation.used && !current) return new Response(null, { status: 422 });
    if (consume) await storage.put(id, { owner: key, used: true });
    return new Response(null, { status: 204 });
  }

  // Pre-index grants remain protected. KV is discovery only: consult an existing
  // owner directly, even when disabled or its projection is stale. This private
  // read bypasses its tail so two simultaneous imports cannot deadlock the index.
  // Every new/rotated token is reserved before its credential write, so eventual
  // KV discovery cannot miss newly installed owners. Failed reservations stay
  // with that owner (fail closed); old digests are never transferred to a copy.
  let cursor: string | undefined;
  do {
    const page = await env.POLICY_KV.list({ prefix: "oauth/", cursor });
    for (const item of page.keys) {
      if (item.name === key) continue;
      const response = await env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(item.name)).fetch(`https://clawrouter.internal${OWNERSHIP_CURRENT}`, { method: "POST" });
      if (!response.ok) throw new HttpError(503, "refresh_ownership_unavailable", "existing refresh ownership could not be verified");
      const current = await response.json<{ exists: boolean; refreshToken?: string | null; pendingRefreshToken?: string | null }>();
      let other = current.refreshToken;
      if (!current.exists) {
        // Match legacyGrantMetadata: plain strings are access-only grants;
        // object-shaped data must parse successfully (corruption stays closed).
        const raw = await env.POLICY_KV.get(item.name, "text");
        const legacy = raw?.trim().startsWith("{") ? JSON.parse(raw) as UpstreamGrant : null;
        other = legacy?.refreshToken;
      }
      const tokens = [other, current.pendingRefreshToken];
      if ((await Promise.all(tokens.map(value => typeof value === "string" && value ? fingerprint(value) : null))).includes(id.slice(6))) {
        await storage.put(id, { owner: item.name, used: false });
        return new Response(null, { status: 409 });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await storage.put(id, { owner: key, used: consume === true });
  return new Response(null, { status: 204 });
}
