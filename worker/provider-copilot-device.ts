import { copilotGithubDomain } from "./provider-copilot.ts";

const clientId = "Iv1.b507a08c87ecfe98";
const responseLimit = 8 * 1024;
const contextFields = ["githubDomain", "ownerBinding"];
const authorizationFields = [...contextFields, "deviceCode", "userCode", "verificationUrl", "expiresInMs", "intervalMs"];

export type CopilotDeviceContext = Readonly<{ githubDomain: string; ownerBinding: string }>;
export type CopilotDeviceAuthorization = CopilotDeviceContext & Readonly<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInMs: number;
  intervalMs: number;
}>;
export type CopilotDevicePost = Readonly<{
  url: string;
  init: Readonly<{
    method: "POST";
    redirect: "manual";
    headers: Readonly<{ Accept: "application/json"; "Content-Type": "application/x-www-form-urlencoded" }>;
    body: string;
  }>;
  timeoutMs: 30_000;
}>;
export type CopilotDevicePollResult =
  | Readonly<{ status: "authorized"; githubDomain: string; ownerBinding: string; accessToken: string }>
  | Readonly<{ status: "pending"; reason: "authorization_pending" | "slow_down"; intervalMs: number }>
  | Readonly<{ status: "access_denied" | "expired" }>
  | Readonly<{ status: "error"; code: "invalid_response" | "http_error" | "provider_error" }>;

function requireDevice(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`invalid_copilot_device_${field}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key));
}
function boundDomain(value: unknown, currentOwner: string, allowed: readonly string[]): string {
  requireDevice(record(value) && fields(value, allowed) && Reflect.ownKeys(value).length === allowed.length, "context");
  requireDevice(typeof currentOwner === "string" && currentOwner.length > 0 && currentOwner.length <= 512 && value.ownerBinding === currentOwner, "owner_binding");
  requireDevice(typeof value.githubDomain === "string", "domain");
  try { return copilotGithubDomain(value.githubDomain); } catch { throw new Error("invalid_copilot_device_domain"); }
}
function nonempty(value: unknown, limit = responseLimit): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}
function safeSeconds(value: unknown, positive: boolean): number {
  const normalized = typeof value === "string" ? value.trim() : value;
  const seconds = typeof normalized === "string" && /^[+-]?\d+$/.test(normalized) ? Number(normalized) : normalized;
  requireDevice(typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= (positive ? 1 : 0) && Number.isSafeInteger(seconds * 1000), "duration");
  return seconds * 1000;
}
function boundedText(text: string): void {
  // Check code units first to avoid allocating an unbounded encoder result.
  // This is a TEXT cap, not fatal-UTF8 or chunk-count transport qualification.
  requireDevice(typeof text === "string" && text.length <= responseLimit && new TextEncoder().encode(text).byteLength <= responseLimit, "response_limit");
}
function json(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("invalid_copilot_device_response_json"); }
  requireDevice(record(value), "response_body");
  return value;
}
function ok(status: number): boolean { return Number.isInteger(status) && status >= 200 && status < 300; }
function verification(value: unknown, domain: string): string {
  requireDevice(nonempty(value), "verification_url");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_copilot_device_verification_url"); }
  requireDevice(url.protocol === "https:" && url.hostname === domain && url.pathname === "/login/device" && !url.username && !url.password && !url.port, "verification_url");
  // The approved page is canonical; query/fragment data never crosses to the UI.
  return `https://${domain}/login/device`;
}
function authorizationDomain(value: CopilotDeviceAuthorization, currentOwner: string): string {
  const domain = boundDomain(value, currentOwner, authorizationFields);
  requireDevice(nonempty(value.deviceCode) && new TextEncoder().encode(value.deviceCode).byteLength <= responseLimit && nonempty(value.userCode, 64) && value.userCode === value.userCode.trim(), "authorization");
  requireDevice(value.verificationUrl === verification(value.verificationUrl, domain), "authorization");
  requireDevice(Number.isSafeInteger(value.expiresInMs) && value.expiresInMs > 0 && Number.isSafeInteger(value.intervalMs) && value.intervalMs >= 1000, "authorization");
  return domain;
}
function post(domain: string, path: "/login/device/code" | "/login/oauth/access_token", values: Record<string, string>): CopilotDevicePost {
  return Object.freeze({
    url: `https://${domain}${path}`,
    init: Object.freeze({ method: "POST", redirect: "manual", headers: Object.freeze({ Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }), body: new URLSearchParams(values).toString() }),
    timeoutMs: 30_000,
  });
}

export function prepareCopilotDeviceRequest(context: CopilotDeviceContext, currentOwner: string): CopilotDevicePost {
  const domain = boundDomain(context, currentOwner, contextFields);
  return post(domain, "/login/device/code", { client_id: clientId, scope: "read:user" });
}

export function decodeCopilotDeviceAuthorization(text: string, status: number, context: CopilotDeviceContext, currentOwner: string): CopilotDeviceAuthorization {
  const domain = boundDomain(context, currentOwner, contextFields);
  boundedText(text);
  requireDevice(ok(status), "http_status");
  const value = json(text);
  requireDevice(fields(value, ["device_code", "user_code", "verification_uri", "expires_in", "interval"]), "authorization_response");
  requireDevice(nonempty(value.device_code) && nonempty(value.user_code) && value.user_code.trim().length <= 64, "authorization_response");
  return Object.freeze({ githubDomain: domain, ownerBinding: currentOwner,
    deviceCode: value.device_code, userCode: value.user_code.trim(), verificationUrl: verification(value.verification_uri, domain),
    expiresInMs: safeSeconds(value.expires_in, true),
    // Even an explicit native zero interval requires waiting before first poll.
    intervalMs: value.interval === undefined ? 5000 : Math.max(1000, safeSeconds(value.interval, false)),
  });
}

// A descriptor is not permission to poll: the durable owner enforces the
// current interval, absolute expiry, cancellation and generation before HTTP.
export function prepareCopilotDevicePollRequest(authorization: CopilotDeviceAuthorization, currentOwner: string): CopilotDevicePost {
  const domain = authorizationDomain(authorization, currentOwner);
  return post(domain, "/login/oauth/access_token", { client_id: clientId, device_code: authorization.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
}

export function decodeCopilotDevicePoll(text: string, status: number, authorization: CopilotDeviceAuthorization, currentOwner: string, intervalMs: number): CopilotDevicePollResult {
  const domain = authorizationDomain(authorization, currentOwner);
  requireDevice(Number.isSafeInteger(intervalMs) && intervalMs >= authorization.intervalMs, "poll_interval");
  const failure = (code: "invalid_response" | "http_error" | "provider_error"): CopilotDevicePollResult => ({ status: "error", code });
  try {
    boundedText(text);
    if (!ok(status)) return failure("http_error");
    const value = json(text);
    if (Object.hasOwn(value, "access_token")) {
      requireDevice(fields(value, ["access_token", "token_type", "scope"]), "token_response");
      requireDevice(typeof value.access_token === "string" && /^[A-Za-z0-9._~+/-]+=*$/.test(value.access_token), "token_response");
      requireDevice(value.token_type === undefined || typeof value.token_type === "string" && value.token_type.toLowerCase() === "bearer", "token_response");
      requireDevice(value.scope === undefined || typeof value.scope === "string", "token_response");
      // No refresh token, expiry fiction or scope-to-entitlement inference.
      return Object.freeze({ status: "authorized", githubDomain: domain, ownerBinding: currentOwner, accessToken: value.access_token });
    }
    requireDevice(fields(value, ["error", "error_description", "error_uri", "interval"]) && typeof value.error === "string" && value.error.length > 0, "poll_response");
    for (const field of ["error_description", "error_uri"]) requireDevice(value[field] === undefined || typeof value[field] === "string", "poll_response");
    const providerInterval = value.interval === undefined ? 0 : safeSeconds(value.interval, false);
    if (value.error === "authorization_pending") return { status: "pending", reason: "authorization_pending", intervalMs };
    if (value.error === "slow_down") return { status: "pending", reason: "slow_down", intervalMs: Math.max(Math.min(Number.MAX_SAFE_INTEGER, intervalMs + 5000), providerInterval) };
    if (value.error === "expired_token") return { status: "expired" };
    if (value.error === "access_denied") return { status: "access_denied" };
    return failure("provider_error");
  } catch { return failure("invalid_response"); }
}
