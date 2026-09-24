import type { AccountCredentialMutationReceipt, AccountCredentialView, UpstreamGrant } from "../../shared/contracts";
import type { UpstreamGrantForm } from "./ui-types";

type ObservationField = "selectedCount" | "lastSelectedAt" | "quotaStatus" | "quotaObservedAt" | "cooldownUntil" | "quotaSource" | "lastProviderSignal" | "quotaWindows";
type AccountFacts = Omit<UpstreamGrant, ObservationField>;
export type AccountIdentity = Pick<UpstreamGrant, "scope" | "scopeId" | "tokenRef">;
export type AccountRow = ({ source: "owner" } & AccountCredentialView | { source: "inventory" | "mutation" } & Omit<UpstreamGrant, ObservationField>) & { observations?: Pick<UpstreamGrant, ObservationField> };
export type AccountIntent = "create" | "edit" | "replace" | "legacy-replace";
export type AccountField = keyof UpstreamGrantForm;

export function accountKey(identity: AccountIdentity): string {
  return identity.scope === "tenants" ? `oauth/tenants/${identity.scopeId}/${identity.tokenRef}` : `oauth/${identity.scopeId}/${identity.tokenRef}`;
}

export function accountPath(identity: AccountIdentity): string {
  return `/v1/admin/upstream-grants/${identity.scope}/${encodeURIComponent(identity.scopeId)}/${encodeURIComponent(identity.tokenRef)}`;
}

export function accountFromInventory(grant: UpstreamGrant): AccountRow {
  const { selectedCount, lastSelectedAt, quotaStatus, quotaObservedAt, cooldownUntil, quotaSource, lastProviderSignal, quotaWindows, ...credential } = grant;
  return { ...credential, source: "inventory", observations: { selectedCount, lastSelectedAt, quotaStatus, quotaObservedAt, cooldownUntil, quotaSource, lastProviderSignal, quotaWindows } };
}

export function mergeAccountInventory(previous: AccountRow[], inventory: UpstreamGrant[]): AccountRow[] {
  const next = inventory.map(grant => {
    const report = accountFromInventory(grant), owner = previous.find(row => row.key === grant.key && row.source !== "inventory");
    // Bootstrap can lag a committed owner indefinitely. It owns reporting, not
    // credential generations or publication (which can change at one generation).
    return owner ? { ...owner, observations: report.observations } : report;
  });
  return [...next, ...previous.filter(row => row.source !== "inventory" && !next.some(item => item.key === row.key))];
}

export function sameAccount(value: unknown, identity: AccountIdentity): value is AccountFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<UpstreamGrant>;
  return row.key === accountKey(identity) && row.scope === identity.scope && row.scopeId === identity.scopeId && row.tokenRef === identity.tokenRef
    && typeof row.enabled === "boolean" && ["api_key", "oauth", "subscription"].includes(row.kind ?? "")
    && Number.isFinite(row.version) && Number.isFinite(row.priority) && Number.isFinite(row.weight) && typeof row.tokenType === "string"
    && typeof row.hasCredential === "boolean" && typeof row.hasAccessToken === "boolean" && typeof row.hasRefreshToken === "boolean"
    && typeof row.refreshConfigured === "boolean" && typeof row.usable === "boolean"
    && Array.isArray(row.scopes) && row.scopes.every(item => typeof item === "string")
    && Array.isArray(row.credentialFields) && row.credentialFields.every(item => typeof item === "string");
}

export function readLegacyAccount(value: unknown, identity: AccountIdentity): AccountRow {
  if (!sameAccount(value, identity) || !("selectedCount" in value) || typeof value.selectedCount !== "number"
    || !("quotaStatus" in value) || !["unknown", "available", "limited", "cooldown"].includes(String(value.quotaStatus))
    || !("quotaWindows" in value) || !Array.isArray(value.quotaWindows)) throw new Error("invalid account mutation response");
  const quotaStatus = value.quotaStatus as UpstreamGrant["quotaStatus"];
  return { ...accountFromInventory({ ...value, selectedCount: value.selectedCount, quotaStatus, quotaWindows: value.quotaWindows }), source: "mutation" };
}

export function readAccountView(value: unknown, identity: AccountIdentity): AccountCredentialView {
  const row = value as Partial<AccountCredentialView> | null;
  if (!sameAccount(value, identity) || !row || !Number.isSafeInteger(row.credentialGeneration) || row.credentialGeneration! < 1
    || !["ready", "pending"].includes(row.publication ?? "") || typeof row.hasCredential !== "boolean"
    || typeof row.hasAccessToken !== "boolean" || typeof row.hasRefreshToken !== "boolean" || typeof row.usable !== "boolean") throw new Error("invalid account owner response");
  return value as AccountCredentialView;
}

export function readAccountReceipt(value: unknown, identity: AccountIdentity): AccountCredentialView {
  const receipt = value as Partial<AccountCredentialMutationReceipt> | null;
  if (!receipt || receipt.outcome !== "committed") throw new Error("account mutation was not confirmed");
  return readAccountView(receipt.grant, identity);
}

export function upstreamGrantFormFromGrant(grant: Omit<UpstreamGrant, ObservationField>): UpstreamGrantForm {
  return { scope: grant.scope, scopeId: grant.scopeId, tokenRef: grant.tokenRef, kind: grant.kind, provider: grant.provider ?? "", label: grant.label ?? "", enabled: grant.enabled,
    priority: String(grant.priority), weight: String(grant.weight), credential: "", credentialBundle: "", accessToken: "", refreshToken: "", removeRefreshToken: false,
    accountId: grant.accountId ?? "", expiresAt: grant.expiresAt ?? "", keepWarm: grant.maintenance?.keepWarm === true };
}

export function accountMutationBody(form: UpstreamGrantForm, intent: AccountIntent, changed: Set<AccountField>, generation: number | null): Record<string, unknown> {
  if (!form.scopeId.trim() || !form.tokenRef || !form.provider) throw new Error("scope and provider are required");
  const metadata: Record<string, unknown> = {};
  const include = (field: AccountField) => intent !== "edit" || changed.has(field);
  for (const field of ["label", "accountId", "expiresAt"] as const) if (include(field)) metadata[field] = form[field].trim() || null;
  if (include("enabled")) metadata.enabled = form.enabled;
  if (include("priority")) {
    const value = Number(form.priority);
    if (!form.priority.trim() || !Number.isInteger(value) || value < 0 || value > 1_000_000) throw new Error("priority must be an integer from 0 to 1000000");
    metadata.priority = value;
  }
  if (include("weight")) {
    const value = Number(form.weight);
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) throw new Error("weight must be greater than 0 and at most 1000000");
    metadata.weight = value;
  }
  if (include("keepWarm")) metadata.maintenance = { keepWarm: form.kind === "subscription" && form.keepWarm };
  if (intent === "edit") {
    if (changed.has("removeRefreshToken") && form.removeRefreshToken) metadata.refreshToken = null;
  } else {
    const credentials = parseCredentialBundle(form.credentialBundle);
    const primary = form.kind === "api_key" ? form.credential.trim() || Object.keys(credentials).length : form.accessToken.trim();
    if (!primary) throw new Error("a fresh primary credential is required");
    if (form.credential.trim() && Object.keys(credentials).length) throw new Error("provide an API key or a credential bundle, not both");
    Object.assign(metadata, { provider: form.provider, kind: form.kind });
    if (form.kind === "api_key") {
      if (form.credential.trim()) metadata.credential = form.credential.trim();
      else metadata.credentials = credentials;
    } else {
      metadata.accessToken = form.accessToken.trim();
      if (form.refreshToken.trim()) metadata.refreshToken = form.refreshToken.trim();
    }
  }
  if (intent === "edit" || intent === "replace") {
    if (!Number.isSafeInteger(generation) || generation! < 1) throw new Error("inspect the account before editing it");
    metadata.expectedCredentialGeneration = generation;
  }
  return metadata;
}

export function parseCredentialBundle(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("credential bundle must be valid JSON"); }
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("credential bundle must be a JSON object");
  const credentials: Record<string, string> = {};
  for (const [name, secret] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || typeof secret !== "string" || !secret.trim()) throw new Error("credential bundle fields must use non-empty string secrets");
    credentials[name] = secret;
  }
  return credentials;
}

export function demoAccountView(row: AccountRow): AccountCredentialView {
  const { source: _source, observations: _observations, ...grant } = row;
  return { ...grant, credentialGeneration: row.source === "owner" ? row.credentialGeneration : 1, publication: "ready", refreshTokenUrl: null, clientIdConfig: null, clientSecretConfig: null };
}

export function demoAccountMutation(form: UpstreamGrantForm, intent: AccountIntent, body: Record<string, unknown>, existing?: AccountRow): AccountCredentialView {
  const old = existing ? demoAccountView(existing) : null;
  if (intent === "edit" && old?.revokedAt && body.enabled === true) throw new Error("revoked accounts require fresh replacement credentials before enabling");
  const replacing = intent !== "edit", now = new Date().toISOString();
  const credentialFields = replacing ? Object.keys((body.credentials ?? {}) as object) : old?.credentialFields ?? [];
  const hasCredential = replacing ? Boolean(body.credential) || credentialFields.length > 0 : old?.hasCredential ?? false;
  const hasAccessToken = replacing ? Boolean(body.accessToken) : old?.hasAccessToken ?? false;
  const hasRefreshToken = replacing ? Boolean(body.refreshToken) : body.refreshToken === null ? false : old?.hasRefreshToken ?? false;
  return {
    key: accountKey(form), scope: form.scope, scopeId: form.scopeId, tokenRef: form.tokenRef, version: 1, provider: form.provider, kind: form.kind,
    enabled: form.enabled, label: form.label || null, priority: Number(form.priority), weight: Number(form.weight), maintenance: { keepWarm: form.keepWarm },
    tokenType: replacing ? "Bearer" : old?.tokenType ?? "Bearer", scopes: replacing ? [] : old?.scopes ?? [],
    expiresAt: form.expiresAt || null, accountId: form.accountId || null, subscription: replacing ? null : old?.subscription ?? null,
    createdAt: old?.createdAt ?? now, updatedAt: now, revokedAt: replacing ? null : old?.revokedAt ?? null,
    hasCredential, credentialFields, hasAccessToken, hasRefreshToken, credentialStatus: replacing ? "active" : old?.credentialStatus ?? "active",
    refreshConfigured: old?.refreshConfigured ?? false, usable: form.enabled && (hasCredential || hasAccessToken) && (replacing || old?.credentialStatus !== "reauth_required") && (replacing || !old?.revokedAt),
    credentialGeneration: (old?.credentialGeneration ?? 0) + 1, publication: "ready", refreshTokenUrl: null, clientIdConfig: null, clientSecretConfig: null,
  };
}
