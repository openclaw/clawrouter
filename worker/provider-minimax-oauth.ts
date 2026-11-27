export type MiniMaxRegion = "global" | "cn";
const regions = {
  global: { account: "https://account.minimax.io", api: "https://api.minimax.io", approval: ["www.minimax.io", "platform.minimax.io", "account.minimax.io"] },
  cn: { account: "https://account.minimaxi.com", api: "https://api.minimaxi.com", approval: ["www.minimaxi.com", "platform.minimaxi.com", "account.minimaxi.com"] },
} as const;
const clientId = "78257093-7e40-4613-99e0-527b14b39113";
const scope = "group_id profile model.completion";
const dateLimit = 8_640_000_000_000_000;
const responseLimit = 8 * 1024;
function requireMiniMax(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`invalid_minimax_${field}`);
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonempty(value: unknown, limit = 4096): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= dateLimit; }
function config(region: MiniMaxRegion) { requireMiniMax(region === "global" || region === "cn", "region"); return regions[region]; }
function body(text: string): Record<string, unknown> {
  requireMiniMax(typeof text === "string" && new TextEncoder().encode(text).length <= responseLimit, "response_limit");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("invalid_minimax_response_json"); }
  const value = record(parsed); requireMiniMax(value, "response_body"); return value;
}
function https(value: unknown): URL {
  requireMiniMax(nonempty(value), "url");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_minimax_url"); }
  requireMiniMax(url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash, "url");
  return url;
}
function binding(expected: string, actual: string) { requireMiniMax(nonempty(expected) && expected === actual, "owner_binding"); }
function formRequest(url: string, values: Record<string, string>, requestId?: string) {
  return { url, init: { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...(requestId ? { "x-request-id": requestId } : {}) }, body: new URLSearchParams(values).toString() } as RequestInit, timeoutMs: 30_000 };
}
function base64url(value: Uint8Array): string {
  return btoa(Array.from(value, byte => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface MiniMaxDeviceSession {
  region: MiniMaxRegion;
  ownerBinding: string;
  verifier: string;
  state: string;
  requestId: string;
}
export interface MiniMaxDeviceAuthorization {
  region: MiniMaxRegion;
  ownerBinding: string;
  state: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalMs: number;
}
export interface MiniMaxResource { region: MiniMaxRegion; origin: string; anthropicBaseUrl: string }
export interface MiniMaxOAuthCredential {
  kind: "oauth";
  region: MiniMaxRegion;
  ownerBinding: string;
  access: string;
  refresh: string;
  expiresAt: number;
  tokenEndpoint: string;
  resource: MiniMaxResource;
}
export interface MiniMaxApiCredential { kind: "api_key"; region: MiniMaxRegion; ownerBinding: string; secret: string }

/** Creates private session data only. The owner must explicitly authorize any subsequent fetch. */
export function createMiniMaxDeviceSession(region: MiniMaxRegion, ownerBinding: string): MiniMaxDeviceSession {
  config(region); requireMiniMax(nonempty(ownerBinding), "owner_binding");
  return { region, ownerBinding, verifier: base64url(crypto.getRandomValues(new Uint8Array(32))), state: base64url(crypto.getRandomValues(new Uint8Array(16))), requestId: crypto.randomUUID() };
}
export async function prepareMiniMaxDeviceRequest(session: MiniMaxDeviceSession, currentOwner: string) {
  binding(session.ownerBinding, currentOwner);
  requireMiniMax(/^[A-Za-z0-9._~-]{43,128}$/.test(session.verifier) && /^[A-Za-z0-9_-]{22,128}$/.test(session.state) && /^[A-Za-z0-9-]{16,128}$/.test(session.requestId), "device_session");
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(session.verifier))));
  return formRequest(`${config(session.region).account}/oauth2/device/code`, { response_type: "code", client_id: clientId, scope, code_challenge: challenge, code_challenge_method: "S256", state: session.state }, session.requestId);
}
export function decodeMiniMaxDeviceAuthorization(text: string, status: number, session: MiniMaxDeviceSession, currentOwner: string, nowMs: number): MiniMaxDeviceAuthorization {
  binding(session.ownerBinding, currentOwner); requireMiniMax(timestamp(nowMs) && status >= 200 && status < 300, "device_response");
  const value = body(text), endpoint = config(session.region);
  requireMiniMax(value.error === undefined && (record(value.base_resp)?.status_code === undefined || record(value.base_resp)?.status_code === 0) && value.state === session.state && nonempty(value.user_code, 256), "device_state");
  requireMiniMax(timestamp(value.expired_in) && value.expired_in > nowMs, "device_expiry");
  const url = https(value.verification_uri);
  requireMiniMax(endpoint.approval.some(host => url.hostname === host), "verification_origin");
  const interval = value.interval;
  const intervalMs = typeof interval === "number" && Number.isSafeInteger(interval) && interval > 0 && interval <= 2_147_483_647 ? interval : 2000;
  return { region: session.region, ownerBinding: session.ownerBinding, state: session.state, userCode: value.user_code, verificationUrl: url.href, expiresAt: value.expired_in, intervalMs };
}
export function miniMaxPollDelay(authorization: MiniMaxDeviceAuthorization, nowMs: number, alreadyWaited = false): number {
  requireMiniMax(timestamp(nowMs) && timestamp(authorization.expiresAt) && Number.isSafeInteger(authorization.intervalMs) && authorization.intervalMs > 0 && authorization.intervalMs <= 2_147_483_647, "poll_time");
  return Math.min(Math.max(0, authorization.expiresAt - nowMs), alreadyWaited ? Math.max(authorization.intervalMs, 2000) : authorization.intervalMs);
}
export function prepareMiniMaxTokenRequest(session: MiniMaxDeviceSession, authorization: MiniMaxDeviceAuthorization, currentOwner: string, nowMs: number) {
  binding(session.ownerBinding, currentOwner); binding(authorization.ownerBinding, currentOwner);
  requireMiniMax(authorization.region === session.region && authorization.state === session.state && timestamp(nowMs) && authorization.expiresAt > nowMs, "authorization_binding");
  requireMiniMax(nonempty(authorization.userCode, 256) && /^[A-Za-z0-9._~-]{43,128}$/.test(session.verifier), "token_request");
  return formRequest(`${config(session.region).account}/oauth2/token`, { grant_type: "urn:ietf:params:oauth:grant-type:user_code", client_id: clientId, user_code: authorization.userCode, code_verifier: session.verifier });
}

/** Native resource selection never authorizes a different credential origin or region. */
export function resolveMiniMaxResource(region: MiniMaxRegion, value?: string): MiniMaxResource {
  const endpoint = config(region), url = https(value ?? `${endpoint.api}/anthropic`);
  const allowed = url.origin === endpoint.api || (region === "cn" && url.origin === "https://api.minimax.cn");
  requireMiniMax(allowed && !url.search && ["", "/", "/anthropic", "/anthropic/"].includes(url.pathname), "resource_origin");
  return { region, origin: url.origin, anthropicBaseUrl: `${url.origin}/anthropic` };
}

/** Frozen MiniMax expiry accepts duration seconds, epoch seconds or epoch milliseconds. */
export function miniMaxTokenExpiresAt(value: unknown, nowMs: number): number | null {
  if (!timestamp(nowMs)) return null;
  const parsed = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0) return null;
  const expires = parsed < 1_000_000_000 ? nowMs + parsed * 1000 : parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
  return timestamp(expires) && expires > nowMs ? expires : null;
}
export type MiniMaxTokenResult =
  | { status: "success"; credential: MiniMaxOAuthCredential }
  | { status: "pending" }
  | { status: "error"; code: "invalid_response" | "authorization_failed" | "refresh_failed" | "expired_token"; retryable: boolean };

export function decodeMiniMaxTokenResponse(text: string, status: number, region: MiniMaxRegion, currentOwner: string, nowMs: number, previous?: MiniMaxOAuthCredential): MiniMaxTokenResult {
  const endpoint = `${config(region).account}/oauth2/token`;
  requireMiniMax(nonempty(currentOwner) && timestamp(nowMs), "token_owner");
  if (previous) {
    binding(previous.ownerBinding, currentOwner);
    requireMiniMax(previous.region === region && previous.tokenEndpoint === endpoint, "refresh_region");
  }
  const failure = (code: "invalid_response" | "authorization_failed" | "refresh_failed" | "expired_token", retryable = false): MiniMaxTokenResult => ({ status: "error", code, retryable });
  let value: Record<string, unknown>;
  try { value = body(text); } catch { return failure("invalid_response"); }
  const base = record(value.base_resp);
  if (status < 200 || status >= 300 || value.error !== undefined || value.status === "error" || (base?.status_code !== undefined && base.status_code !== 0)) return failure(previous ? "refresh_failed" : "authorization_failed", status === 429 || status >= 500);
  if (value.status !== "success") return previous ? failure("refresh_failed") : { status: "pending" };
  const refresh = value.refresh_token === undefined ? previous?.refresh : value.refresh_token;
  if (!nonempty(value.access_token) || !nonempty(refresh)) return failure("invalid_response");
  const expiresAt = miniMaxTokenExpiresAt(value.expired_in, nowMs);
  if (expiresAt === null) return failure("expired_token");
  let resource: MiniMaxResource;
  try {
    if (value.resource_url !== undefined && typeof value.resource_url !== "string") return failure("invalid_response");
    // Refresh rotates secrets/expiry only; it cannot silently redirect the original grant.
    resource = previous ? resolveMiniMaxResource(region, previous.resource.anthropicBaseUrl) : resolveMiniMaxResource(region, value.resource_url as string | undefined);
    if (previous && value.resource_url !== undefined) {
      const returned = resolveMiniMaxResource(region, value.resource_url as string);
      if (returned.anthropicBaseUrl !== resource.anthropicBaseUrl) return failure("invalid_response");
    }
  } catch { return failure("invalid_response"); }
  return { status: "success", credential: { kind: "oauth", region, ownerBinding: currentOwner, access: value.access_token, refresh, expiresAt, tokenEndpoint: endpoint, resource } };
}
export function prepareMiniMaxRefreshRequest(credential: MiniMaxOAuthCredential, currentOwner: string, configuredBaseUrl?: string) {
  binding(credential.ownerBinding, currentOwner);
  const endpoint = `${config(credential.region).account}/oauth2/token`;
  requireMiniMax(credential.tokenEndpoint === endpoint && nonempty(credential.refresh), "refresh_binding");
  const resource = resolveMiniMaxResource(credential.region, configuredBaseUrl ?? credential.resource.anthropicBaseUrl);
  requireMiniMax(resource.anthropicBaseUrl === credential.resource.anthropicBaseUrl, "refresh_resource");
  return formRequest(endpoint, { grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refresh });
}

/** Receives a validated Anthropic body and an admitted model; never refreshes on the hot path. */
export function prepareMiniMaxAnthropicRequest(value: unknown, selectedModel: string, credential: MiniMaxOAuthCredential | MiniMaxApiCredential, currentOwner: string, nowMs: number) {
  binding(credential.ownerBinding, currentOwner);
  requireMiniMax(nonempty(selectedModel, 256) && timestamp(nowMs), "inference_binding");
  const payload = record(value); requireMiniMax(payload && Array.isArray(payload.messages), "anthropic_body");
  let resource: MiniMaxResource, secret: string;
  if (credential.kind === "oauth") {
    requireMiniMax(credential.tokenEndpoint === `${config(credential.region).account}/oauth2/token` && timestamp(credential.expiresAt) && credential.expiresAt > nowMs + 60_000, "access_expiry");
    resource = resolveMiniMaxResource(credential.region, credential.resource.anthropicBaseUrl); secret = credential.access;
  } else {
    requireMiniMax(credential.kind === "api_key", "credential_kind"); resource = resolveMiniMaxResource(credential.region); secret = credential.secret;
  }
  requireMiniMax(nonempty(secret), "access_token");
  return { url: `${resource.anthropicBaseUrl}/v1/messages`, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" }, redirect: "manual" as const, body: { ...payload, model: selectedModel } };
}
