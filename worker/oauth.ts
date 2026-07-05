import { authorizeAdmin, verifiedAccessSession } from "./access";
import { authorityCall } from "./authority";
import { providerById } from "./providers";
import type { Env, OAuthState, UpstreamGrant } from "./types";
import { errorResponse, nowIso, privateJson } from "./utils";

export async function startOAuth(request: Request, env: Env, grantKey: string, providerId: string): Promise<Response> {
  const actor = await authorizeAdmin(request, env);
  if (actor instanceof Response) return actor;
  if (actor.email === "token-admin") return errorResponse("access_admin_required", "browser OAuth requires a Cloudflare Access admin session", 403);
  const provider = providerById(providerId), config = provider?.auth.authorization;
  if (!provider || !config) return errorResponse("oauth_not_supported", "provider does not declare browser OAuth", 400);
  const clientId = config.clientId ?? (config.clientIdConfig ? envString(env, config.clientIdConfig) : null);
  if (!clientId) return errorResponse("oauth_not_configured", "provider OAuth client id is not configured", 503);
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const stateId = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const callback = `${new URL(request.url).origin}/v1/oauth/callback`;
  const state: OAuthState = { state: stateId, verifier, actorEmail: actor.email, grantKey, provider: providerId, redirectUri: callback, expiresAtMs: Date.now() + 10 * 60_000 };
  await authorityCall(env, "/oauth-states/put", state);
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code"); url.searchParams.set("client_id", clientId); url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("scope", config.scopes.join(" ")); url.searchParams.set("state", stateId); url.searchParams.set("code_challenge", challenge); url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(config.extraAuthorizeParams)) url.searchParams.set(key, value);
  return privateJson({ authorizationUrl: url.toString() });
}

export async function oauthCallback(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session || session.role !== "admin") return errorResponse("access_admin_required", "OAuth callback requires a verified Access admin", 403);
  const url = new URL(request.url), stateId = url.searchParams.get("state"), code = url.searchParams.get("code"), providerError = url.searchParams.get("error");
  if (!stateId) return errorResponse("invalid_oauth_callback", "OAuth state is missing", 400);
  const consumed = await authorityCall<{ state: OAuthState | null }>(env, "/oauth-states/consume", { state: stateId, actorEmail: session.email });
  if (!consumed.state) return errorResponse("invalid_oauth_state", "OAuth state is invalid or expired", 400);
  if (providerError) return callbackPage(false, `Provider denied authorization: ${providerError}`);
  if (!code) return errorResponse("invalid_oauth_callback", "authorization code is missing", 400);
  const state = consumed.state, provider = providerById(state.provider), config = provider?.auth.authorization;
  if (!provider || !config) return errorResponse("oauth_not_supported", "provider OAuth configuration is unavailable", 400);
  const clientId = config.clientId ?? (config.clientIdConfig ? envString(env, config.clientIdConfig) : null);
  if (!clientId) return errorResponse("oauth_not_configured", "provider OAuth client id is not configured", 503);
  const form = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: state.verifier, redirect_uri: state.redirectUri });
  if (config.clientSecretConfig) {
    const secret = envString(env, config.clientSecretConfig); if (!secret) return errorResponse("oauth_not_configured", "provider OAuth client secret is not configured", 503); form.set("client_secret", secret);
  }
  for (const [key, value] of Object.entries(config.extraTokenParams)) form.set(key, value);
  const tokenResponse = await fetch(config.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form });
  const payload: Record<string, unknown> = await tokenResponse.json<Record<string, unknown>>().catch(() => ({}));
  if (!tokenResponse.ok || typeof payload.access_token !== "string") return callbackPage(false, "Provider token exchange failed.");
  const existing = await env.POLICY_KV.get<UpstreamGrant>(state.grantKey, "json");
  const idPayload = typeof payload.id_token === "string" ? decodeJwtPayload(payload.id_token) : {};
  const now = nowIso(), expires = typeof payload.expires_in === "number" ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : null;
  const grant: UpstreamGrant = {
    ...existing, version: 1, enabled: true, kind: config.grantKind as UpstreamGrant["kind"], provider: provider.id,
    label: existing?.label ?? `${provider.display_name} OAuth`, accessToken: payload.access_token as string,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : existing?.refreshToken,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : "Bearer", expiresAt: expires,
    scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : config.scopes,
    accountId: jsonPointer(idPayload, config.accountIdJsonPointer) ?? existing?.accountId,
    subscription: { ...existing?.subscription, plan: jsonPointer(idPayload, config.subscriptionPlanJsonPointer) ?? existing?.subscription?.plan },
    createdAt: existing?.createdAt ?? now, updatedAt: now, revokedAt: null,
  };
  await env.POLICY_KV.put(state.grantKey, JSON.stringify(grant));
  return callbackPage(true, `${provider.display_name} connection saved.`);
}

function callbackPage(ok: boolean, message: string): Response {
  const safe = message.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
  return new Response(`<!doctype html><meta charset="utf-8"><title>ClawRouter OAuth</title><style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f7f5;color:#17231d}main{padding:24px;border:1px solid #ccd6ce;background:white;max-width:420px}button{padding:8px 12px}</style><main><h1>${ok ? "Connected" : "Connection failed"}</h1><p>${safe}</p><button onclick="location.href='/dashboard/access'">Return to ClawRouter</button></main>`, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function envString(env: Env, name: string): string | null { const value = env[name]; return typeof value === "string" && value.trim() ? value : null; }
function base64Url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function decodeJwtPayload(token: string): Record<string, unknown> { try { const part = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/"); return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))); } catch { return {}; } }
function jsonPointer(value: unknown, pointer: string | null): string | null {
  if (!pointer || !value || typeof value !== "object") return null;
  let current: unknown = value;
  for (const part of pointer.slice(1).split("/").map((item) => item.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!current || typeof current !== "object") return null; current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : null;
}
