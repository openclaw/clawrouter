const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": [
    "authorization", "content-type", "x-api-key", "anthropic-beta", "anthropic-version",
    "x-request-id", "session-id", "thread-id", "session_id", "x-clawrouter-session-id",
    "x-clawrouter-agent-id", "x-clawrouter-parent-agent-id", "x-clawrouter-project-id",
    "x-clawrouter-client", "anthropic-dangerous-direct-browser-access",
    "x-stainless-retry-count", "x-stainless-timeout", "x-stainless-lang",
    "x-stainless-package-version", "x-stainless-os", "x-stainless-arch",
    "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-helper-method",
    "x-stainless-helper",
  ].join(","),
  "access-control-expose-headers": "x-clawrouter-content-retention,x-clawrouter-upstream-provider",
  "access-control-max-age": "600",
};

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(code: string, message: string, status: number, detail?: unknown): Response {
  return json({ error: { code, message, ...(detail === undefined ? {} : { detail }) } }, status);
}

export function withCors(response: Response): Response {
  const copy = new Response(response.body, response);
  for (const [key, value] of Object.entries(corsHeaders)) copy.headers.set(key, value);
  return copy;
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export function corsEnabled(path: string): boolean {
  return path === "/v1" || path.startsWith("/v1/") || path.startsWith("/api/");
}

export function canonicalPath(path: string): string {
  if (path === "/api/route" || path === "/api/routes") return "/v1/routes";
  if (path === "/api/session") return "/v1/session";
  if (path === "/api/entitlements") return "/v1/entitlements";
  if (path === "/api/me") return "/v1/me";
  if (path === "/api/usage") return "/v1/usage";
  if (path.startsWith("/api/admin/")) return `/v1${path.slice(4)}`;
  return path;
}

export function legacyRedirect(path: string): string | null {
  const redirects: Record<string, string> = {
    "/access": "/dashboard/access", "/admin": "/dashboard/access", "/policies": "/dashboard/access",
    "/account": "/dashboard/users", "/users": "/dashboard/users", "/catalog": "/dashboard/catalog",
    "/console": "/dashboard/catalog", "/routes": "/dashboard/catalog", "/playground": "/dashboard/playground",
    "/usage": "/dashboard/usage",
  };
  return redirects[path] ?? null;
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

export function privateJson(value: unknown, status = 200): Response {
  return json(value, status, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseBearer(headers: Headers): string | null {
  const value = headers.get("authorization");
  return value?.match(/^Bearer[ \t]+(.+)$/i)?.[1].trim() || null;
}

export function parseProxyKey(input: string): { mode: "live" | "test"; kid: string; secret: string } | null {
  const patterns: Array<[string, "live" | "test", string]> = [
    ["clawrouter-live-", "live", "-"], ["clawrouter-test-", "test", "-"],
    ["ocpk_live_", "live", "_"], ["ocpk_test_", "test", "_"],
  ];
  for (const [prefix, mode, delimiter] of patterns) {
    if (!input.startsWith(prefix)) continue;
    const rest = input.slice(prefix.length);
    const separator = rest.indexOf(delimiter);
    if (separator < 0) return null;
    const kid = rest.slice(0, separator);
    const secret = rest.slice(separator + 1);
    if (kid.length < 4 || secret.length < 8 || !tokenish(kid) || !tokenish(secret) || kid.includes(delimiter)) return null;
    return { mode, kid, secret };
  }
  return null;
}

function tokenish(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function cleanId(value: string): string | null {
  const normalized = value.trim();
  return /^[A-Za-z0-9_]{1,128}$/.test(normalized) ? normalized : null;
}

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

export function commaSet(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function nowIso(): string { return new Date().toISOString(); }
export function randomId(prefix: string): string { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }
export function clampAudit(value: string | null, max = 256): string | null { return value ? value.slice(0, max) : null; }

const maxJsonBodyBytes = 8 * 1024 * 1024;

export async function readJson<T>(request: Request): Promise<T> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxJsonBodyBytes) throw new HttpError(413, "request_too_large", "JSON request body exceeds the 8 MiB limit");
  if (!request.body) throw new HttpError(400, "invalid_json", "request body must be valid JSON");
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxJsonBodyBytes) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large", "JSON request body exceeds the 8 MiB limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "request body must be valid JSON");
  }
}

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export function caughtResponse(error: unknown): Response {
  if (error instanceof HttpError) return errorResponse(error.code, error.message, error.status);
  console.error("unhandled request error", error instanceof Error ? error.message : String(error));
  return errorResponse("internal_error", "internal server error", 500);
}
