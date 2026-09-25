import { HttpError } from "./utils.ts";

export const REFRESH_MARGIN_MS = 5 * 60_000;
export type TokenValidity = { expiresAt?: string | null; tokenResponseError?: "invalid_expiry" | null };

// RFC 6749 permits omission. It describes the new token, never the previous
// token's deadline; an explicit malformed value must not become unknown/valid.
export function tokenResponseExpiry(payload: Record<string, unknown>, now: number): Required<TokenValidity> {
  if (!Object.hasOwn(payload, "expires_in")) return { expiresAt: null, tokenResponseError: null };
  const seconds = payload.expires_in;
  const deadline = typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1_000 : NaN;
  const date = new Date(deadline);
  return Number.isFinite(date.getTime())
    ? { expiresAt: date.toISOString(), tokenResponseError: null }
    : { expiresAt: null, tokenResponseError: "invalid_expiry" };
}

export function tokenExpired(value: TokenValidity, now = Date.now()): boolean {
  return !!value.expiresAt && Date.parse(value.expiresAt) <= now;
}

export function tokenDenied(value: TokenValidity, now = Date.now()): boolean {
  return value.tokenResponseError === "invalid_expiry" || tokenExpired(value, now);
}

export function assertTokenUsable(value: TokenValidity): void {
  if (value.tokenResponseError === "invalid_expiry") throw new HttpError(502, "grant_refresh_failed", "provider returned invalid token expiry; account renewal is required");
  if (tokenExpired(value)) throw new HttpError(502, "grant_refresh_failed", "upstream access token has expired; account renewal is required");
}
