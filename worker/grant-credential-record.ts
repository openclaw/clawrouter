import type { MiniMaxSearchBinding } from "../shared/minimax-search-binding.ts";
import { miniMaxSearchOwnerBinding } from "./minimax-search-credential.ts";
import type { SearchGrantMutationActor } from "./authority-contracts.ts";
import type { CopilotAccountAttempt, CopilotAccountBinding } from "./copilot-account-flow.ts";
import { miniMaxImageOwnerBinding } from "./minimax-image-credential.ts";
import type { MiniMaxImageBinding } from "../shared/minimax-image-binding.ts";
import { vertexOwnerBinding, type VertexAnthropicBinding } from "./vertex-anthropic-binding.ts";
import { miniMaxOwnerBinding, type MiniMaxAnthropicBinding } from "./minimax-anthropic-binding.ts";
import type { MiniMaxDeviceAttempt } from "./minimax-device-flow.ts";
import type { CopilotDeviceAttempt, CopilotDeviceCredential } from "./copilot-device-flow.ts";
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
  // Private owner state; deliberately absent from every materialized projection.
  minimaxDeviceAttempt?: MiniMaxDeviceAttempt;
  copilotDeviceAttempt?: CopilotDeviceAttempt;
  copilotDeviceCredential?: CopilotDeviceCredential;
  copilotAccountAttempt?: CopilotAccountAttempt;
  copilotAccountBinding?: CopilotAccountBinding;
  vertexAnthropicBinding?: VertexAnthropicBinding | null;
  vertexPrivateKey?: string;
  minimaxAnthropicBinding?: MiniMaxAnthropicBinding | null;
  nativeMediaBinding?: NativeMediaBinding | null;
  minimaxSearchBinding?: MiniMaxSearchBinding | null;
  minimaxImageBinding?: MiniMaxImageBinding | null;
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
  vertexAnthropicBinding: VertexAnthropicBinding | null;
  minimaxAnthropicBinding: MiniMaxAnthropicBinding | null;
  nativeMediaBinding: NativeMediaBinding | null;
  minimaxSearchBinding: MiniMaxSearchBinding | null;
  minimaxImageBinding: MiniMaxImageBinding | null;
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
  operation?: "minimax.images" | "minimax.music" | "minimax.search";
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
  minimaxSearchIntent?: MiniMaxSearchBinding | null;
  searchActor?: SearchGrantMutationActor;
  minimaxImageIntent?: MiniMaxImageBinding | null;
  vertexAnthropicIntent?: VertexAnthropicBinding | null;
  vertexPrivateKey?: string;
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
    minimaxSearchBinding: miniMaxSearchOwnerBinding(record),
    minimaxImageBinding: miniMaxImageOwnerBinding(record),
    vertexAnthropicBinding: vertexOwnerBinding(record),
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
  const oldValues = new Set([previous.vertexPrivateKey, previous.credential, previous.accessToken, ...Object.values(previous.credentials ?? {})]);
  return [replacement.vertexPrivateKey, replacement.credential, replacement.accessToken, ...Object.values(replacement.credentials ?? {})]
    .some(value => typeof value === "string" && !oldValues.has(value));
}

export function materializedGrant(metadata: UpstreamGrant, record: CredentialRecord): UpstreamGrant {
  return {
    ...metadata,
    minimaxSearchBinding: miniMaxSearchOwnerBinding(record),
    minimaxImageBinding: miniMaxImageOwnerBinding(record),
    vertexAnthropicBinding: vertexOwnerBinding(record),
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
