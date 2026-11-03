import { HttpError } from "./utils.ts";

const MAX_SECRET_BYTES = 64 * 1024;
export const MAX_REFRESH_RESPONSE_BYTES = 128 * 1024;

export async function boundedRefreshJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await boundedResponseJson(response, MAX_REFRESH_RESPONSE_BYTES);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    throw new HttpError(502, "grant_refresh_failed", "provider refresh response was invalid");
  }
}

export async function boundedResponseJson(response: Response, limit: number): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new HttpError(502, "grant_response_invalid", "provider response was invalid");
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(502, "grant_response_invalid", "provider response was invalid");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try {
    const value = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

export function permanentRefreshFailure(status: number, code: unknown): boolean {
  return [400, 401].includes(status) && typeof code === "string" && ["invalid_grant", "invalid_token", "refresh_token_reused"].includes(code);
}

// Strict allowlist, not truncation: even a short provider "code" can contain a
// credential fragment. Unknown strings/descriptions never cross the owner boundary.
export function safeOAuthError(code: unknown): string {
  return typeof code === "string" && ["invalid_grant", "invalid_token", "refresh_token_reused", "invalid_client", "unauthorized_client", "invalid_request", "unsupported_grant_type", "invalid_scope", "temporarily_unavailable", "server_error", "network_error", "invalid_response", "outcome_unknown", "persistence_failed"].includes(code) ? code : "unknown_error";
}

export function optionalSecret(value: string | null | undefined, name: string): string | null | undefined {
  return value == null ? value : boundedSecret(value, name);
}

export function boundedSecret(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES) throw new HttpError(400, "invalid_upstream_grant", `${name} must be a non-empty bounded string`);
  return value;
}

export function normalizedScopes(value: string[] | undefined): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 128 || value.some((scope) => typeof scope !== "string" || !scope || scope.length > 512)) throw new HttpError(400, "invalid_upstream_grant", "grant scopes are invalid");
  return [...new Set(value)];
}

export function validTimestamp(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  if (!Number.isFinite(Date.parse(value))) throw new HttpError(400, "invalid_upstream_grant", "grant expiry is invalid");
  return new Date(value).toISOString();
}

export { envValue } from "./utils.ts";

/** Equal jitter, 15–30s initially, exponential to a 2m cap. Preserve at least
 * another attempt before access expiry where possible; Retry-After is a floor,
 * even when the provider asks us to wait past expiry. Never turn it into a loop. */
export function refreshRetryAt(attempt: number, expiresAt?: string | null, retryAfter?: string | null): string {
  const now = Date.now();
  const ceiling = Math.min(120_000, 30_000 * 2 ** Math.min(10, Math.max(0, attempt - 1)));
  let delay = Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
  const remaining = Date.parse(expiresAt ?? "") - now;
  if (remaining > 2_000) delay = Math.min(delay, Math.max(1_000, Math.floor(remaining / 2)));
  const providerTime = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? now + Number(retryAfter) * 1_000 : Date.parse(retryAfter ?? "");
  const next = Math.max(now + 1_000, now + delay, Number.isFinite(providerTime) && providerTime <= 8.64e15 ? providerTime : 0);
  return new Date(next).toISOString();
}
