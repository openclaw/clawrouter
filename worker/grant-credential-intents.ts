import snapshotJson from "./generated/provider-snapshot.json" with { type: "json" };
import {
  credentialIdentityChanged, credentialRecord, hasPrimaryCredential, metadataGrant,
  nextCredentialGeneration, normalizedScopes, ownerMetadata, validTimestamp, type CredentialRecord,
} from "./grant-credential-record.ts";
import { grantResponse } from "./grant-credential-view.ts";
import type { ProviderSnapshot, UpstreamGrant } from "./types";
import type { AccountCredentialView } from "../shared/contracts.ts";
import { HttpError } from "./utils.ts";

export type GrantCredentialIntent = "create" | "patch" | "replace";
const metadataFields = ["label", "enabled", "priority", "weight", "maintenance", "expiresAt", "scopes", "accountId", "subscription", "refresh"];
const credentialFields = ["provider", "kind", "credential", "credentials", "accessToken", "refreshToken", "tokenType"];
const snapshot = snapshotJson as unknown as ProviderSnapshot;

export function accountCredentialView(record: CredentialRecord): AccountCredentialView {
  return { ...grantResponse(record.grantKey!, metadataGrant(record)), version: record.version, credentialGeneration: record.generation, publication: record.poolSyncPending ? "pending" : "ready" };
}

export function grantIntentBody(value: unknown, intent: GrantCredentialIntent): Record<string, unknown> {
  const body = object(value, "account mutation");
  const fields = intent === "patch" ? [...metadataFields, "refreshToken", "expectedCredentialGeneration"]
    : [...metadataFields, ...credentialFields, ...(intent === "replace" ? ["expectedCredentialGeneration"] : [])];
  if (Object.keys(body).some(key => !fields.includes(key))) invalid("account mutation contains an unsupported field");
  if (intent !== "create" && (!Number.isSafeInteger(body.expectedCredentialGeneration) || (body.expectedCredentialGeneration as number) < 1)) invalid("expectedCredentialGeneration must be a positive safe integer");
  if (intent === "patch" && body.refreshToken !== undefined && body.refreshToken !== null) invalid("metadata updates may only clear refreshToken with null");
  return body;
}

export function assertNewAccountRef(key: string): void {
  if (!/^acct_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key.split("/").at(-1) ?? "")) invalid("create requires a caller-generated acct_UUIDv4 token reference retained before POST");
}

export function strictCredentialRecord(key: string, intent: GrantCredentialIntent, body: Record<string, unknown>, current?: CredentialRecord): CredentialRecord {
  const { expectedCredentialGeneration: _expected, ...fields } = body;
  const grant = normalizeFields(fields);
  const now = new Date().toISOString();
  if (intent === "patch") {
    if (!current) throw new HttpError(404, "grant_credential_missing", "account owner is not initialized; use explicit replacement or revocation for legacy grants");
    if (current.revokedAt && grant.enabled === true) throw new HttpError(409, "grant_reconnect_required", "revoked accounts require fresh replacement credentials before enabling");
    const merged = { ...metadataGrant(current), ...grant, updatedAt: now };
    if (grant.maintenance?.keepWarm) validateProvider(merged);
    let updated: CredentialRecord = { ...current, generation: nextCredentialGeneration(current.generation), poolSyncPending: true, updatedAt: now };
    for (const field of ["expiresAt", "scopes", "accountId", "subscription", "refresh", "refreshToken"] as const) {
      if (Object.hasOwn(grant, field)) Object.assign(updated, { [field]: grant[field] });
    }
    if (credentialIdentityChanged(current, updated, grant)) updated.lineage = crypto.randomUUID();
    updated = ownerMetadata(updated, merged, key);
    // Metadata never heals reauthorization or a tombstone. Keep/clear applies
    // only to explicitly supplied fields; cosmetic edits preserve continuity.
    return { ...updated, status: current.status, revokedAt: current.revokedAt };
  }
  const fresh: UpstreamGrant = {
    version: 1, provider: current?.providerId, kind: current?.kind ?? "oauth",
    label: current?.metadata?.label, priority: current?.metadata?.priority ?? 100, weight: current?.metadata?.weight ?? 1,
    maintenance: current?.maintenance, ...grant,
    enabled: grant.enabled ?? current?.enabled ?? true,
    tokenType: grant.tokenType ?? "Bearer", scopes: grant.scopes ?? [],
    createdAt: current?.createdAt ?? now, updatedAt: now,
  };
  validateProvider(fresh);
  if (!hasPrimaryCredential(fresh)) invalid("account creation and replacement require a fresh primary credential");
  // No old credential/account metadata is spread into replacement material.
  // Even a revoked owner stays disabled unless the operator explicitly enables it.
  return ownerMetadata(credentialRecord(fresh, nextCredentialGeneration(current?.generation ?? 0)), fresh, key);
}

function normalizeFields(body: Record<string, unknown>): UpstreamGrant {
  const grant = { ...body } as UpstreamGrant;
  for (const name of ["label", "accountId"] as const) if (body[name] !== undefined) nullableString(body[name], name, name === "label" ? 256 : 2048);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") invalid("enabled must be boolean");
  if (body.priority !== undefined && (!Number.isInteger(body.priority) || (body.priority as number) < 0 || (body.priority as number) > 1_000_000)) invalid("priority must be an integer from 0 to 1000000");
  if (body.weight !== undefined && (typeof body.weight !== "number" || !Number.isFinite(body.weight) || body.weight <= 0 || body.weight > 1_000_000)) invalid("weight must be greater than 0 and at most 1000000");
  if (body.expiresAt !== undefined) {
    nullableString(body.expiresAt, "expiresAt", 128);
    grant.expiresAt = validTimestamp(grant.expiresAt);
  }
  if (body.scopes !== undefined) {
    if (body.scopes === null) invalid("scopes must be an array; use [] to clear");
    grant.scopes = normalizedScopes(grant.scopes);
  }
  if (body.maintenance !== undefined) {
    const maintenance = object(body.maintenance, "maintenance");
    if (Object.keys(maintenance).some(key => key !== "keepWarm") || typeof maintenance.keepWarm !== "boolean") invalid("maintenance accepts only boolean keepWarm");
    grant.maintenance = { keepWarm: maintenance.keepWarm };
  }
  if (body.subscription !== undefined && body.subscription !== null) {
    const subscription = object(body.subscription, "subscription");
    if (Object.keys(subscription).some(key => !["plan", "subject"].includes(key))) invalid("subscription accepts only plan and subject");
    for (const key of ["plan", "subject"]) if (subscription[key] !== undefined) nullableString(subscription[key], key, 2048);
  }
  if (body.refresh !== undefined && body.refresh !== null) {
    const refresh = object(body.refresh, "refresh");
    if (Object.keys(refresh).some(key => !["tokenUrl", "clientId", "clientIdConfig", "clientSecretConfig", "requestFormat", "extraParams"].includes(key))) invalid("refresh contains an unsupported field");
    if (typeof refresh.tokenUrl !== "string" || !/^https?:\/\//.test(refresh.tokenUrl) || !URL.canParse(refresh.tokenUrl)) invalid("refresh tokenUrl must be an HTTP(S) URL");
    for (const key of ["clientId", "clientIdConfig", "clientSecretConfig"]) if (refresh[key] !== undefined) nullableString(refresh[key], key, 2048);
    if (refresh.requestFormat !== undefined && !["form", "json"].includes(refresh.requestFormat as string)) invalid("refresh requestFormat must be form or json");
    if (refresh.extraParams !== undefined) {
      const params = object(refresh.extraParams, "refresh extraParams");
      if (Object.keys(params).length > 32 || Object.values(params).some(value => typeof value !== "string" || value.length > 2048)) invalid("refresh extraParams must contain at most 32 bounded strings");
    }
  }
  if (body.tokenType !== undefined && (typeof body.tokenType !== "string" || !body.tokenType || body.tokenType.length > 128)) invalid("tokenType must be a bounded non-empty string");
  return grant;
}

function validateProvider(grant: UpstreamGrant): void {
  const provider = snapshot.providers.find(candidate => candidate.id === grant.provider);
  if (!provider) throw new HttpError(400, "unknown_provider", "account provider is not registered");
  if (!["api_key", "oauth", "subscription"].includes(grant.kind ?? "")) invalid("kind must be api_key, oauth or subscription");
  if (grant.kind === "subscription" && !provider.auth.grantTransports.subscription) invalid("provider does not declare a subscription transport");
  if (grant.maintenance?.keepWarm && (grant.kind !== "subscription" || !provider.auth.grantTransports.subscription?.maintenance.keepWarm)) invalid("provider does not declare keep-warm maintenance for this subscription");
  if (grant.maintenance === undefined) grant.maintenance = { keepWarm: grant.kind === "subscription" && provider.auth.grantTransports.subscription?.maintenance.keepWarm?.defaultEnabled === true };
}

function nullableString(value: unknown, name: string, limit: number): void {
  if (value !== null && (typeof value !== "string" || !value.trim() || value.length > limit)) invalid(`${name} must be a bounded non-empty string or null`);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function invalid(message: string): never { throw new HttpError(400, "invalid_upstream_grant", message); }
