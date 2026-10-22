export type NativeErrorFormat = "openai" | "anthropic";
export interface NativeErrorContext { format: NativeErrorFormat; requestId: string }
export interface NativeErrorDetails { message?: string; type?: string; code?: string | number | null; param?: unknown; requestId?: string | null }

// Brand only router-owned errors. Never inspect or rewrite an opaque upstream
// response merely because its JSON happens to resemble a router error.
const localErrors = new WeakMap<Response, { code: string; message: string }>();
export function markLocalError(response: Response, code: string, message: string): Response {
  localErrors.set(response, { code, message });
  return response;
}

export function inheritLocalError(source: Response, copy: Response): Response {
  const error = localErrors.get(source);
  if (error) localErrors.set(copy, error);
  return copy;
}

export function nativeErrorFormat(path: string): NativeErrorFormat | undefined {
  const provider = path.match(/^\/v1\/(?:playground\/)?(?:native|proxy)\/([^/]+)\//)?.[1];
  if (provider) {
    try { const id = decodeURIComponent(provider); if (id === "anthropic" || id === "openai") return id; } catch { /* Invalid provider IDs have no native format. */ }
  }
  if (/^\/v1\/messages(?:\/|$)/.test(path)) return "anthropic";
  // Unified routes speak OpenAI's protocol even when the backend is compatible.
  const unified = path.replace(/^\/v1\/playground/, "");
  if (/^\/v1\/(?:chat\/completions|responses|decisions|embeddings|audio\/(?:speech|transcriptions)|images\/generations|realtime)(?:\/|$)/.test(unified)) return "openai";
  return undefined;
}

export function nativeErrorEnvelope(context: NativeErrorContext, status: number, details: NativeErrorDetails) {
  const message = details.message ?? "upstream request failed";
  if (context.format === "anthropic") return {
    type: "error", error: { type: details.type ?? anthropicErrorType(status), message },
    request_id: details.requestId === undefined ? context.requestId : details.requestId,
  };
  return { error: {
    message, type: details.type ?? (status >= 500 ? "server_error" : status === 429 ? "rate_limit_error" : "invalid_request_error"),
    param: details.param ?? null, code: details.code === undefined ? status : details.code,
  } };
}

function anthropicErrorType(status: number): string {
  const types: Record<number, string> = { 401: "authentication_error", 402: "billing_error", 403: "permission_error", 404: "not_found_error", 409: "conflict_error", 413: "request_too_large", 429: "rate_limit_error", 504: "timeout_error", 529: "overloaded_error" };
  return types[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");
}

export function withNativeLocalError(response: Response, path: string, requestId: string): Response {
  const error = localErrors.get(response), format = nativeErrorFormat(path);
  if (!error || !format) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  // Native Anthropic has no error.code. Keep router diagnostics separate from
  // its native body, just as router correlation is separate from provider IDs.
  headers.set("x-clawrouter-error-code", error.code);
  if (format === "anthropic") headers.set("request-id", requestId);
  return Response.json(nativeErrorEnvelope({ format, requestId }, response.status, error), { status: response.status, headers });
}
