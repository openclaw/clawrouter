import { publicSession } from "./access";
import { authorityCall, resolveUsers } from "./authority";
import { sameOrigin, trustedExternalOrigin } from "./request-origin";
import type { AccessControlUser, AccessSession, Env } from "./types";
import { errorResponse, json, normalizeEmail, nowIso, readJson, safeEqual, sha256Hex } from "./utils";

const sessionCookieName = "clawrouter_session";
const sessionTtlSeconds = 12 * 60 * 60;
const sessionKeyPrefix = "local/sessions/";
const loginWindowMs = 60_000;
const loginAttemptLimit = 10;
// cf-connecting-ip is client-supplied on a bare workerd host, so per-client buckets are advisory; the global bucket bounds spoofed-header bypass.
const loginGlobalKey = "global";
const loginGlobalLimit = 50;
const loginAttempts = new Map<string, { count: number; resetAtMs: number }>();

interface LocalSessionRecord { email: string; role: "admin" | "user"; createdAt: string; expiresAtMs: number }

export function localAuthEnabled(env: Env): boolean {
  // Cloudflare Access configuration always wins so a stray flag cannot open a login form on a managed deployment.
  if (env.CLAWROUTER_ACCESS_TEAM_DOMAIN || env.CLAWROUTER_ACCESS_AUD) return false;
  return (env.CLAWROUTER_LOCAL_AUTH ?? "").trim().toLowerCase() === "enabled";
}

export async function localSession(request: Request, env: Env): Promise<AccessSession | null> {
  if (!localAuthEnabled(env)) return null;
  const token = sessionCookieValue(request);
  if (!token) return null;
  const record = await env.POLICY_KV.get<LocalSessionRecord>(sessionKey(await sha256Hex(token)), "json");
  // KV TTL eviction can lag; the stored expiry keeps the 12h boundary exact.
  if (!record?.email || record.expiresAtMs <= Date.now()) return null;
  const user = (await resolveUsers(env, [record.email]))[0];
  // Deleting or disabling the user record revokes live sessions; role edits apply on the next request.
  if (!user || user.record.enabled === false) return null;
  return localAccessSession(record, user, env);
}

export async function localLogin(request: Request, env: Env): Promise<Response> {
  if (!localAuthEnabled(env)) return errorResponse("route_not_found", "route not found", 404);
  if (!sameOrigin(request, env)) return errorResponse("access_csrf_required", "same-origin browser request required", 403);
  const client = request.headers.get("cf-connecting-ip") ?? "local";
  const nowMs = Date.now();
  const reservation = reserveLoginAttempt(client, nowMs);
  if (!reservation) return errorResponse("login_rate_limited", "too many sign-in attempts; retry in a minute", 429);
  let rejected = false;
  try {
    const body = await readJson<{ token?: unknown }>(request);
    const submitted = typeof body.token === "string" ? body.token.trim() : "";
    const expected = env.CLAWROUTER_ADMIN_TOKEN_SHA256?.trim().toLowerCase();
    if (!submitted || !expected || !safeEqual(await sha256Hex(submitted), expected)) {
      rejected = true;
      return errorResponse("login_invalid", "invalid sign-in token", 401);
    }
    const email = normalizeEmail(env.CLAWROUTER_LOCAL_ADMIN_EMAIL ?? "admin@local");
    if (!email) return errorResponse("local_auth_misconfigured", "CLAWROUTER_LOCAL_ADMIN_EMAIL must be a valid email address", 500);
    let user = (await resolveUsers(env, [email]))[0];
    if (!user) {
      user = await authorityCall<AccessControlUser>(env, "/users/create", { email, record: { role: "admin", tenantId: env.CLAWROUTER_ACCESS_DEFAULT_TENANT ?? "default", enabled: true, groups: [], contentRetentionDisabled: false } });
    }
    if (user.record.enabled === false) {
      rejected = true;
      return errorResponse("login_invalid", "invalid sign-in token", 401);
    }
    const sessionToken = randomSessionToken();
    const record: LocalSessionRecord = { email, role: "admin", createdAt: nowIso(), expiresAtMs: nowMs + sessionTtlSeconds * 1000 };
    await env.POLICY_KV.put(sessionKey(await sha256Hex(sessionToken)), JSON.stringify(record), { expirationTtl: sessionTtlSeconds });
    return json({ ok: true, session: publicSession(localAccessSession(record, user, env)) }, 200, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "set-cookie": sessionCookieHeader(request, env, sessionToken, sessionTtlSeconds),
    });
  } finally {
    if (rejected) reservation.settle();
    else reservation.release();
  }
}

export async function localLogout(request: Request, env: Env): Promise<Response> {
  if (!localAuthEnabled(env)) return errorResponse("route_not_found", "route not found", 404);
  if (!sameOrigin(request, env)) return errorResponse("access_csrf_required", "same-origin browser request required", 403);
  const token = sessionCookieValue(request);
  if (token) await env.POLICY_KV.delete(sessionKey(await sha256Hex(token)));
  return json({ ok: true }, 200, { "cache-control": "no-store", "set-cookie": sessionCookieHeader(request, env, "", 0) });
}

function localAccessSession(record: LocalSessionRecord, user: AccessControlUser, env: Env): AccessSession {
  return {
    authenticated: true,
    auth: "local",
    role: user.record.role ?? record.role,
    email: record.email,
    subject: null,
    tenantId: user.record.tenantId ?? env.CLAWROUTER_ACCESS_DEFAULT_TENANT ?? "default",
    groups: [...new Set(user.record.groups ?? [])].sort(),
    contentRetentionDisabled: user.record.contentRetentionDisabled ?? false,
  };
}

function sessionKey(tokenSha256: string): string { return `${sessionKeyPrefix}${tokenSha256}`; }

function randomSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sessionCookieValue(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== sessionCookieName) continue;
    const value = part.slice(separator + 1).trim();
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  }
  return null;
}

function sessionCookieHeader(request: Request, env: Env, value: string, maxAgeSeconds: number): string {
  // Secure is omitted on plain-http origins so the loopback-only self-host default still receives the cookie.
  // Forwarded headers affect cookie security only when they exactly match the operator-declared public origin.
  const externalOrigin = trustedExternalOrigin(request, env);
  const secure = new URL(request.url).protocol === "https:" || externalOrigin?.startsWith("https://") ? "; Secure" : "";
  return `${sessionCookieName}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function reserveLoginAttempt(client: string, nowMs: number): { release(): void; settle(): void } | null {
  for (const [key, entry] of loginAttempts) if (entry.resetAtMs <= nowMs) loginAttempts.delete(key);
  const clientKey = `client:${client.slice(0, 256)}`;
  const currentClient = loginAttempts.get(clientKey);
  const currentGlobal = loginAttempts.get(loginGlobalKey);
  if ((currentClient?.count ?? 0) >= loginAttemptLimit || (currentGlobal?.count ?? 0) >= loginGlobalLimit) return null;

  const clientEntry = currentClient ?? { count: 0, resetAtMs: nowMs + loginWindowMs };
  const globalEntry = currentGlobal ?? { count: 0, resetAtMs: nowMs + loginWindowMs };
  clientEntry.count += 1;
  globalEntry.count += 1;
  loginAttempts.set(clientKey, clientEntry);
  loginAttempts.set(loginGlobalKey, globalEntry);

  let active = true;
  return {
    release() {
      if (!active) return;
      active = false;
      releaseBucket(clientKey, clientEntry);
      releaseBucket(loginGlobalKey, globalEntry);
    },
    settle() { active = false; },
  };
}

function releaseBucket(key: string, reserved: { count: number; resetAtMs: number }): void {
  if (loginAttempts.get(key) !== reserved) return;
  reserved.count -= 1;
  if (reserved.count === 0) loginAttempts.delete(key);
}
