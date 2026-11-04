import { miniMaxOwnerBinding, type MiniMaxAnthropicBinding } from "./minimax-anthropic-binding.ts";
import { miniMaxApiKeySecret } from "./native-media-credential.ts";
import type { UpstreamGrant, RefreshConfig } from "./types.ts";
import { readNativeMediaBinding, type NativeMediaBinding } from "../shared/native-media-binding.ts";

interface CredentialMetadata extends Pick<UpstreamGrant,
  "tokenType" | "expiresAt" | "refreshTokenExpiresAt" | "lastManualAuthorizationAt" |
  "scopes" | "accountId" | "subscription" | "refresh" | "createdAt"
> {
  updatedAt: string;
}

export interface CredentialRecord extends CredentialMetadata, Pick<UpstreamGrant, "credential" | "credentials" | "accessToken" | "refreshToken"> {
  minimaxAnthropicBinding?: MiniMaxAnthropicBinding | null;
  nativeMediaBinding?: NativeMediaBinding | null;
  version: 1;
  generation: number;
  lineage?: string;
  enabled?: boolean;
  status: "active" | "reauth_required";
  refreshDiagnosis?: UpstreamGrant["refreshDiagnosis"];
  credentialProvenance?: "clawrouter_oauth" | "imported";
  refreshAttempt?: { id: string; generation: number } | null;
  grantKey?: string;
  providerId?: string | null;
  kind?: UpstreamGrant["kind"];
  maintenance?: { keepWarm: boolean };
  nextQuotaProbeAt?: string | null;
  nextKeepWarmAt?: string | null;
  nextRefreshAttemptAt?: string | null;
  quotaFailureCount?: number;
  quotaRetryAt?: Record<string, string>;
  revokedAt?: string | null;
  poolSyncPending?: boolean;
  refreshRoutingPublished?: boolean;
  poolAdmissionRevision?: number;
  metadata?: UpstreamGrant;
}

export interface CredentialProjection extends CredentialMetadata {
  minimaxAnthropicBinding: MiniMaxAnthropicBinding | null;
  nativeMediaBinding: NativeMediaBinding | null;
  credentialStore: "durable_object";
  credentialGeneration: number;
  credentialLineage?: string;
  credentialStatus: "active" | "reauth_required";
  credentialRefreshBlockedUntil?: string | null | false;
  refreshDiagnosis: UpstreamGrant["refreshDiagnosis"];
  credentialProvenance: "clawrouter_oauth" | "imported" | null;
  hasCredential: boolean;
  credentialFields: string[];
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
}

export interface OwnerResponse {
  grant: UpstreamGrant;
}

export interface MaterializeRequest {
  key: string;
  grant: UpstreamGrant;
  legacy?: UpstreamGrant | null;
  providerId: string;
  refresh?: RefreshConfig | null;
  force: boolean;
  expectedGeneration?: number | null;
}

export interface PutRequest {
  // Only the privileged admin mutation supplies this owner intent. Grant
  // metadata, legacy imports, OAuth completion and pool submissions do not.
  nativeMediaIntent?: NativeMediaBinding | null;
  minimaxAnthropicIntent?: MiniMaxAnthropicBinding | null;
  key: string;
  grant: UpstreamGrant;
  preserveUnspecifiedSecrets: boolean;
  // Contribution imports also replace secrets; only the explicit administrator
  // operation may discard corrupt legacy metadata.
  intent?: "replace";
  provenance?: "clawrouter_oauth";
}

export function credentialProjection(record: CredentialRecord): CredentialProjection {
  return {
    minimaxAnthropicBinding: miniMaxOwnerBinding(record),
    nativeMediaBinding: record.providerId === "minimax" && miniMaxApiKeySecret(record) ? readNativeMediaBinding(record.nativeMediaBinding) : null,
    credentialStore: "durable_object",
    credentialGeneration: record.generation,
    credentialLineage: record.lineage,
    credentialStatus: record.status,
    credentialRefreshBlockedUntil: record.refreshAttempt ? null : record.nextRefreshAttemptAt ?? false,
    refreshDiagnosis: record.refreshDiagnosis ?? null,
    credentialProvenance: record.credentialProvenance ?? (record.refreshToken ? "imported" : null),
    hasCredential: !!record.credential || Object.keys(record.credentials ?? {}).length > 0,
    credentialFields: Object.keys(record.credentials ?? {}).sort(),
    hasAccessToken: !!record.accessToken,
    hasRefreshToken: !!record.refreshToken,
    tokenType: record.tokenType,
    expiresAt: record.expiresAt,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt ?? null,
    lastManualAuthorizationAt: record.lastManualAuthorizationAt ?? null,
    scopes: record.scopes,
    accountId: record.accountId,
    subscription: record.subscription,
    refresh: record.refresh,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function hasFreshPrimaryCredentials(previous: CredentialRecord, replacement: CredentialRecord): boolean {
  const oldValues = new Set([previous.credential, previous.accessToken, ...Object.values(previous.credentials ?? {})]);
  return [replacement.credential, replacement.accessToken, ...Object.values(replacement.credentials ?? {})]
    .some(value => typeof value === "string" && !oldValues.has(value));
}

export function materializedGrant(metadata: UpstreamGrant, record: CredentialRecord): UpstreamGrant {
  return {
    ...metadata,
    minimaxAnthropicBinding: miniMaxOwnerBinding(record),
    nativeMediaBinding: record.providerId === "minimax" && miniMaxApiKeySecret(record) ? readNativeMediaBinding(record.nativeMediaBinding) : null,
    credential: record.credential,
    credentials: record.credentials,
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    tokenType: record.tokenType,
    expiresAt: record.expiresAt,
    refreshTokenExpiresAt: record.refreshTokenExpiresAt ?? null,
    lastManualAuthorizationAt: record.lastManualAuthorizationAt ?? null,
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
