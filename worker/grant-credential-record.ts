import snapshotJson from "./generated/provider-snapshot.json" with { type: "json" };
import type { GrantAttachmentStatus } from "./authority.ts";
import { grantUsable, validCredentialBundle } from "./grant-selection.ts";
import { quotaProbeForGrant } from "./provider-auth.ts";
import type { ProviderSnapshot, UpstreamGrant } from "./types";
import { HttpError } from "./utils.ts";
import { tokenExpired } from "./grant-expiry.ts";

const MAX_SECRET_BYTES = 64 * 1024;
const snapshot = snapshotJson as unknown as ProviderSnapshot;
const secretFields = new Set(["accessToken", "access_token", "refreshToken", "refresh_token", "credential", "credentials", "apiKey", "api_key", "token", "secret", "clientSecret", "client_secret", "password"]);

export const CREDENTIAL_INPUT_FIELDS = ["credential", "credentials", "accessToken", "refreshToken", "tokenType", "expiresAt", "scopes", "accountId", "subscription", "refresh"] as const;

export interface CredentialRecord {
  version: 1;
  generation: number;
  lineage?: string;
  enabled?: boolean;
  status: "active" | "reauth_required";
  credential?: string | null;
  credentials?: Record<string, string>;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenType?: string;
  expiresAt?: string | null;
  tokenResponseError?: "invalid_expiry" | null;
  scopes?: string[];
  accountId?: string | null;
  subscription?: { plan?: string | null; subject?: string | null } | null;
  refresh?: UpstreamGrant["refresh"];
  createdAt?: string | null;
  updatedAt: string;
  grantKey?: string;
  providerId?: string | null;
  kind?: UpstreamGrant["kind"];
  maintenance?: { keepWarm: boolean };
  nextQuotaProbeAt?: string | null;
  nextKeepWarmAt?: string | null;
  nextRefreshAttemptAt?: string | null;
  quotaFailureCount?: number;
  revokedAt?: string | null;
  poolSyncPending?: boolean; // Cleared only after scheduling, index and KV acknowledgement.
  poolAdmissionRevision?: number;
  metadata?: UpstreamGrant;
}

export interface CredentialProjection {
  credentialStore: "durable_object";
  credentialGeneration: number;
  credentialLineage?: string;
  credentialStatus: "active" | "reauth_required";
  hasCredential: boolean;
  credentialFields: string[];
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  tokenType?: string;
  expiresAt?: string | null;
  tokenResponseError: "invalid_expiry" | null;
  nextRefreshAttemptAt: string | null;
  scopes?: string[];
  accountId?: string | null;
  subscription?: { plan?: string | null; subject?: string | null } | null;
  refresh?: UpstreamGrant["refresh"];
  createdAt?: string | null;
  updatedAt: string;
}

export function canonicalRecord(record: CredentialRecord): boolean {
  return !!record.metadata && record.enabled !== undefined && !!record.lineage;
}

export function nextCredentialGeneration(generation: number): number {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER - 1) throw new HttpError(409, "grant_generation_exhausted", "account generation is exhausted; operator recovery is required");
  return generation + 1;
}

export function ownerMetadata(record: CredentialRecord, grant: UpstreamGrant, key: string): CredentialRecord {
  const now = Date.now();
  const providerId = grant.provider ?? record.providerId ?? null;
  const kind = grant.kind ?? record.kind;
  const provider = providerId ? snapshot.providers.find((candidate) => candidate.id === providerId) : undefined;
  const transport = provider && kind ? provider.auth.grantTransports[kind] : null;
  const quotaProbe = provider && kind ? quotaProbeForGrant(provider, materializedGrant({ provider: provider.id, kind }, record)) : null;
  const keepWarm = grant.maintenance?.keepWarm ?? record.maintenance?.keepWarm ?? false;
  return {
    ...record,
    enabled: grant.enabled ?? record.enabled ?? true,
    grantKey: key,
    providerId,
    kind,
    maintenance: { keepWarm },
    nextQuotaProbeAt: transport?.maintenance.quotaPoll && quotaProbe
      ? record.nextQuotaProbeAt ?? new Date(now + transport.maintenance.quotaPoll.normalIntervalSeconds * 1_000).toISOString()
      : null,
    nextKeepWarmAt: keepWarm && transport?.maintenance.keepWarm
      ? record.nextKeepWarmAt ?? new Date(now + transport.maintenance.keepWarm.intervalSeconds * 1_000).toISOString()
      : null,
    quotaFailureCount: record.quotaFailureCount ?? 0,
    nextRefreshAttemptAt: record.nextRefreshAttemptAt ?? null,
    revokedAt: null,
    metadata: secretlessGrant(grant),
  };
}

export function metadataGrant(record: CredentialRecord): UpstreamGrant {
  return { ...record.metadata, ...credentialProjection(record), enabled: record.enabled === true, provider: record.providerId, kind: record.kind, maintenance: record.maintenance, revokedAt: record.revokedAt ?? null };
}

export function attachmentStatus(record: CredentialRecord): GrantAttachmentStatus | null {
  if (record.revokedAt) return null;
  if (!record.enabled) return "paused";
  return record.status === "reauth_required" || !grantUsable(metadataGrant(record)) ? "reauth_required" : "active";
}

export function revokedRecord(key: string, metadata: UpstreamGrant | null, generation = metadata?.credentialGeneration ?? 0): CredentialRecord {
  // Tagged CLI grants could contain nested secret fields in refresh metadata.
  // A tombstone must discard these too, including when the owner predates it.
  metadata = stripLegacySecrets(metadata) as UpstreamGrant | null;
  const revokedAt = metadata?.revokedAt ?? new Date().toISOString();
  return {
    version: 1, generation: generation + 1, lineage: crypto.randomUUID(), enabled: false, status: "active", poolSyncPending: true,
    grantKey: key, providerId: metadata?.provider, kind: metadata?.kind,
    tokenType: metadata?.tokenType, expiresAt: metadata?.expiresAt, scopes: metadata?.scopes,
    accountId: metadata?.accountId, subscription: metadata?.subscription, refresh: metadata?.refresh,
    maintenance: { keepWarm: metadata?.maintenance?.keepWarm === true },
    createdAt: metadata?.createdAt, updatedAt: revokedAt, revokedAt, metadata: secretlessGrant(metadata ?? {}),
  };
}

export function secretlessGrant(grant: UpstreamGrant, projection?: CredentialProjection): UpstreamGrant {
  const { credential: _credential, credentials: _credentials, accessToken: _accessToken, refreshToken: _refreshToken, tokenResponseError: _tokenResponseError, nextRefreshAttemptAt: _nextRefreshAttemptAt, credentialInput: _credentialInput, ...safe } = grant as UpstreamGrant & { credentialInput?: unknown };
  return projection ? { ...safe, ...projection } : safe;
}

export function normalizeGrant(value: unknown, existing: UpstreamGrant | null): UpstreamGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_upstream_grant", "upstream grant must be an object");
  const { credentialInput: _credentialInput, ...body } = value as Record<string, unknown>;
  const priority = body.priority ?? existing?.priority ?? 100;
  if (!Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 1_000_000) throw new HttpError(400, "invalid_upstream_grant", "grant priority must be an integer from 0 to 1000000");
  const weight = body.weight ?? existing?.weight ?? 1;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || weight > 1_000_000) throw new HttpError(400, "invalid_upstream_grant", "grant weight must be a number greater than 0 and at most 1000000");
  if (!validCredentialBundle(body.credentials as UpstreamGrant["credentials"])) throw new HttpError(400, "invalid_upstream_grant", "grant credentials must use non-empty string values");
  const credentials = body.credentials && Object.keys(body.credentials).length ? body.credentials : existing?.credentials ?? {};
  const now = new Date().toISOString();
  const grant = {
    ...existing, ...body, version: 1, priority, weight, credentials,
    enabled: body.enabled === undefined ? existing?.enabled ?? true : body.enabled ?? true,
    kind: body.kind === undefined ? existing?.kind ?? "oauth" : body.kind ?? "oauth",
    tokenType: body.tokenType === undefined ? existing?.tokenType ?? "Bearer" : body.tokenType ?? "Bearer",
    scopes: body.scopes === undefined ? existing?.scopes ?? [] : body.scopes ?? [],
    createdAt: existing?.createdAt ?? now, updatedAt: now, revokedAt: null,
  } as UpstreamGrant;
  if (!grant.provider) throw new HttpError(400, "invalid_upstream_grant", "provider is required");
  const provider = snapshot.providers.find((candidate) => candidate.id === grant.provider);
  if (!provider) throw new HttpError(400, "unknown_provider", "upstream grant provider is not registered");
  const defaultKeepWarm = !existing && grant.kind === "subscription" && provider.auth.grantTransports.subscription?.maintenance.keepWarm?.defaultEnabled === true;
  grant.maintenance = normalizeGrantMaintenance(body.maintenance, existing?.maintenance, defaultKeepWarm);
  if (grant.maintenance?.keepWarm && (grant.kind !== "subscription" || !provider.auth.grantTransports.subscription?.maintenance.keepWarm)) throw new HttpError(400, "invalid_upstream_grant", "provider does not declare keep-warm maintenance for this subscription");
  if (!validCredentialBundle(grant.credentials) || [grant.credential, grant.accessToken, grant.refreshToken].some((secret) => secret != null && (typeof secret !== "string" || !secret.trim().length))) throw new HttpError(400, "invalid_upstream_grant", "grant credentials must use non-empty string values");
  // The owner supplies actual material for validation. A denied lifecycle can
  // still receive metadata edits; only explicit primary input may heal it.
  if (!hasPrimaryCredential(grant)) throw new HttpError(400, "invalid_upstream_grant", "grant credential is required");
  return grant;
}
function normalizeGrantMaintenance(value: unknown, existing: UpstreamGrant["maintenance"], defaultKeepWarm: boolean): UpstreamGrant["maintenance"] {
  if (value === undefined) return existing ?? { keepWarm: defaultKeepWarm };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_upstream_grant", "grant maintenance must be an object");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "keepWarm") || body.keepWarm !== undefined && typeof body.keepWarm !== "boolean") throw new HttpError(400, "invalid_upstream_grant", "grant maintenance only accepts boolean keepWarm");
  return { keepWarm: body.keepWarm === true };
}


export function hasRawCredential(grant: UpstreamGrant): boolean {
  return grant.credential != null || grant.accessToken != null || grant.refreshToken != null || Object.keys(grant.credentials ?? {}).length > 0;
}

export function credentialRecord(grant: UpstreamGrant, generation: number): CredentialRecord {
  if (!hasPrimaryCredential(grant)) throw new HttpError(400, "invalid_upstream_grant", "upstream grant requires a primary credential");
  const now = new Date().toISOString();
  const credentials = grant.credentials && Object.keys(grant.credentials).length ? normalizedCredentials(grant.credentials) : undefined;
  return {
    version: 1,
    generation,
    lineage: crypto.randomUUID(),
    poolSyncPending: true,
    enabled: grant.enabled ?? true,
    status: "active",
    credential: optionalSecret(grant.credential, "credential"),
    credentials,
    accessToken: optionalSecret(grant.accessToken, "access token"),
    refreshToken: optionalSecret(grant.refreshToken, "refresh token"),
    tokenType: grant.tokenType,
    expiresAt: validTimestamp(grant.expiresAt),
    scopes: normalizedScopes(grant.scopes),
    accountId: grant.accountId,
    subscription: grant.subscription,
    refresh: grant.refresh,
    createdAt: grant.createdAt ?? now,
    updatedAt: grant.updatedAt ?? now,
  };
}

export function updatedCredentialRecord(current: CredentialRecord | undefined, grant: UpstreamGrant): CredentialRecord {
  if (!current) throw new HttpError(400, "invalid_upstream_grant", "upstream grant requires a primary credential");
  const fresh = hasPrimaryCredential(grant);
  const updated: CredentialRecord = {
    ...current,
    generation: current.generation + 1,
    poolSyncPending: true,
    enabled: grant.enabled ?? current.enabled ?? true,
    status: fresh ? "active" : current.status,
    tokenResponseError: fresh ? null : current.tokenResponseError,
    nextRefreshAttemptAt: fresh ? null : current.nextRefreshAttemptAt,
    credential: grant.credential === undefined ? current.credential : optionalSecret(grant.credential, "credential"),
    credentials: grant.credentials && Object.keys(grant.credentials).length ? normalizedCredentials(grant.credentials) : current.credentials,
    accessToken: grant.accessToken === undefined ? current.accessToken : optionalSecret(grant.accessToken, "access token"),
    refreshToken: grant.refreshToken === undefined ? current.refreshToken : optionalSecret(grant.refreshToken, "refresh token"),
    tokenType: grant.tokenType ?? current.tokenType,
    expiresAt: grant.expiresAt === undefined ? fresh ? null : current.expiresAt : validTimestamp(grant.expiresAt),
    scopes: grant.scopes === undefined ? current.scopes : normalizedScopes(grant.scopes),
    accountId: grant.accountId === undefined ? current.accountId : grant.accountId,
    subscription: grant.subscription === undefined ? current.subscription : grant.subscription,
    refresh: grant.refresh === undefined ? current.refresh : grant.refresh,
    updatedAt: grant.updatedAt ?? new Date().toISOString(),
  };
  if (![updated.credential, updated.accessToken, ...Object.values(updated.credentials ?? {})].some((value) => typeof value === "string" && value.length > 0)) throw new HttpError(400, "invalid_upstream_grant", "upstream grant requires a primary credential");
  // Explicit credential/account replacement is not a refresh, even when the
  // operator keeps the same account label. Refresh-token replacement also can
  // change the next upstream account, so it invalidates continuation ownership.
  if (credentialIdentityChanged(current, updated, grant)) updated.lineage = crypto.randomUUID();
  return fresh ? updated : preserveExpiredAuthority(current, updated);
}

export function preserveExpiredAuthority(current: CredentialRecord, updated: CredentialRecord): CredentialRecord {
  // An accepted metadata edit cannot renew an already expired primary token.
  // Fold its denial into the mutation generation, after the caller's CAS check.
  if (tokenExpired(current)) updated.expiresAt = current.expiresAt;
  if (!updated.tokenResponseError && !updated.refreshToken && tokenExpired(updated)) updated.status = "reauth_required";
  return updated;
}

export function credentialProjection(record: CredentialRecord): CredentialProjection {
  return {
    credentialStore: "durable_object",
    credentialGeneration: record.generation,
    credentialLineage: record.lineage,
    credentialStatus: record.status,
    hasCredential: !!record.credential || Object.keys(record.credentials ?? {}).length > 0,
    credentialFields: Object.keys(record.credentials ?? {}).sort(),
    hasAccessToken: !!record.accessToken,
    hasRefreshToken: !!record.refreshToken,
    tokenType: record.tokenType,
    expiresAt: record.expiresAt,
    tokenResponseError: record.tokenResponseError ?? null,
    nextRefreshAttemptAt: record.nextRefreshAttemptAt ?? null,
    scopes: record.scopes,
    accountId: record.accountId,
    subscription: record.subscription,
    refresh: record.refresh,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function materializedGrant(metadata: UpstreamGrant, record: CredentialRecord): UpstreamGrant {
  return {
    ...metadata,
    credential: record.credential,
    credentials: record.credentials,
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    tokenType: record.tokenType,
    expiresAt: record.expiresAt,
    tokenResponseError: record.tokenResponseError ?? null,
    nextRefreshAttemptAt: record.nextRefreshAttemptAt ?? null,
    scopes: record.scopes,
    accountId: record.accountId,
    subscription: record.subscription,
    refresh: record.refresh,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    credentialGeneration: record.generation,
    credentialLineage: record.lineage,
    credentialStatus: record.status,
  };
}

export function hasPrimaryCredential(grant: UpstreamGrant): boolean {
  return [grant.credential, grant.accessToken, ...Object.values(grant.credentials ?? {})].some((value) => typeof value === "string" && value.length > 0);
}

export function stripLegacySecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLegacySecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => !secretFields.has(name)).map(([name, item]) => [name, stripLegacySecrets(item)]));
}

export function isRefreshAuthenticationParameter(name: string): boolean {
  return name === "grant_type" || name === "client_id" || secretFields.has(name);
}

function normalizedCredentials(value: Record<string, string>): Record<string, string> {
  if (Array.isArray(value) || typeof value !== "object") throw new HttpError(400, "invalid_upstream_grant", "credential bundle must be an object");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 32) throw new HttpError(400, "invalid_upstream_grant", "credential bundle must contain 1 to 32 fields");
  return Object.fromEntries(entries.map(([name, secret]) => {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new HttpError(400, "invalid_upstream_grant", "credential bundle contains an invalid field name");
    return [name, boundedSecret(secret, `credential ${name}`)];
  }));
}

export function normalizedScopes(value: string[] | undefined): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 128 || value.some((scope) => typeof scope !== "string" || !scope || scope.length > 512)) throw new HttpError(400, "invalid_upstream_grant", "grant scopes are invalid");
  return [...new Set(value)];
}

function optionalSecret(value: string | null | undefined, name: string): string | null | undefined {
  return value == null ? value : boundedSecret(value, name);
}

export function boundedSecret(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim().length || new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES) throw new HttpError(400, "invalid_upstream_grant", `${name} must be a non-empty bounded string`);
  return value;
}

export function validTimestamp(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  if (!Number.isFinite(Date.parse(value))) throw new HttpError(400, "invalid_upstream_grant", "grant expiry is invalid");
  return new Date(value).toISOString();
}

export function credentialIdentityChanged(current: CredentialRecord, updated: CredentialRecord, grant: UpstreamGrant): boolean {
  return ["credential", "accessToken", "refreshToken", "accountId"].some(key => updated[key as keyof CredentialRecord] !== current[key as keyof CredentialRecord])
    || JSON.stringify(Object.entries(updated.credentials ?? {}).sort()) !== JSON.stringify(Object.entries(current.credentials ?? {}).sort())
    || updated.subscription?.subject !== current.subscription?.subject
    || JSON.stringify(updated.refresh) !== JSON.stringify(current.refresh)
    || grant.provider !== undefined && grant.provider !== current.providerId || grant.kind !== undefined && grant.kind !== current.kind;
}
