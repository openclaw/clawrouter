/** Display-only deadlines: never change credential eligibility from this hint. */
export type RefreshExpiryWarning = "unknown" | "none" | "warning" | "critical" | "expired";

export function refreshExpiryWarning(expiresAt: string | null | undefined, now = Date.now()): RefreshExpiryWarning {
  const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiry)) return "unknown";
  const remaining = expiry - now;
  if (remaining <= 0) return "expired";
  if (remaining <= 12 * 60 * 60_000) return "critical";
  return remaining <= 3 * 24 * 60 * 60_000 ? "warning" : "none";
}

/** Provider seconds, not access-token lifetime or an estimated session length. */
export function refreshExpiryFromSeconds(value: unknown, now = Date.now()): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  const expiry = now + value * 1000;
  if (!Number.isSafeInteger(expiry) || expiry > 8.64e15) return null;
  return new Date(expiry).toISOString();
}

/** Claude Code bundles use epoch milliseconds; the stored/admin form is ISO. */
export function authorizationTimestamp(value: unknown): string | null {
  if (value == null) return null;
  const ms = typeof value === "number" && Number.isSafeInteger(value) ? value
    : typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
}
