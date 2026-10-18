import type { Env } from "./types";
import { HttpError } from "./utils.ts";

const dayMs = 86_400_000;
export function credentialExpired(credential: { expiresAt?: string | null }, at = Date.now()): boolean {
  return credential.expiresAt != null && (!Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= at);
}
export function credentialExpiryError(expiresAt: string): HttpError {
  return new HttpError(401, "proxy_key_expired", `Proxy key expired on ${expiresAt}; create a new key in the ClawRouter dashboard.`);
}
export function credentialExpiry(value: unknown, env: Partial<Env> | undefined, scope: "admin" | "personal", at = Date.now()): string {
  const days = (value: unknown, fallback: number) => value === undefined ? fallback : Number(value);
  const max = days(env?.CLAWROUTER_CREDENTIAL_MAX_TTL_DAYS, 366);
  const defaultDays = days(env?.CLAWROUTER_CREDENTIAL_DEFAULT_TTL_DAYS, 180);
  if (![max, defaultDays].every(n => Number.isFinite(n) && n > 0)) throw new HttpError(503, "credential_ttl_invalid", "Credential lifetime configuration must be positive days.");
  const limit = scope === "personal" ? Math.min(defaultDays, max) : max;
  if (value === undefined) return new Date(at + Math.min(defaultDays, max) * dayMs).toISOString();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new HttpError(400, "invalid_credential", "expiresAt must be an ISO-8601 UTC timestamp");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19) || timestamp <= at || timestamp > at + limit * dayMs) throw new HttpError(400, "invalid_credential", `expiresAt must be in the future and at most ${limit} days away`);
  return new Date(timestamp).toISOString();
}
