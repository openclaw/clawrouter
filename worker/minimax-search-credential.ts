import { readMiniMaxSearchBinding } from "../shared/minimax-search-binding.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import { miniMaxApiKeySecret } from "./native-media-credential.ts";
import type { GrantRequirement } from "./provider-auth.ts";
import type { UpstreamGrant } from "./types.ts";
import { HttpError } from "./utils.ts";

export function miniMaxSearchDenied(): never {
  throw new HttpError(403, "minimax_search_authorization_required", "MiniMax search requires original TokenPlan search authority");
}

export function miniMaxSearchOwnerBinding(record: CredentialRecord) {
  return record.providerId === "minimax" && !record.revokedAt && miniMaxApiKeySecret(record)
    ? readMiniMaxSearchBinding(record.minimaxSearchBinding) : null;
}

export function mutateMiniMaxSearchBinding(record: CredentialRecord, previous: CredentialRecord | undefined,
  intent: unknown, preserve: boolean): void {
  const old = previous ? miniMaxSearchOwnerBinding(previous) : null;
  const same = preserve && previous && previous.grantKey === record.grantKey && previous.lineage === record.lineage
    && previous.providerId === record.providerId && previous.kind === record.kind && previous.accountId === record.accountId
    && previous.expiresAt === record.expiresAt && miniMaxApiKeySecret(previous) === miniMaxApiKeySecret(record);
  let binding = same ? old : null;
  if (intent !== undefined) {
    binding = intent === null ? null : readMiniMaxSearchBinding(intent);
    if (intent !== null && (!binding || record.providerId !== "minimax" || !miniMaxApiKeySecret(record))) miniMaxSearchDenied();
  }
  if (record.providerId !== "minimax" || !miniMaxApiKeySecret(record)) binding = null;
  record.minimaxSearchBinding = binding;
  if (previous && JSON.stringify(old) !== JSON.stringify(binding)) record.lineage = crypto.randomUUID();
}

export function miniMaxSearchProjection(grant: UpstreamGrant | null | undefined): boolean {
  return !!grant && grant.provider === "minimax" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && !!grant.credentialLineage
    && (grant.expiresAt == null || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now())
    && !!grant.hasCredential && !grant.hasAccessToken && !grant.hasRefreshToken && !grant.subscription
    && Array.isArray(grant.credentialFields) && grant.credentialFields.length === 0
    && !!readMiniMaxSearchBinding(grant.minimaxSearchBinding);
}

export function miniMaxSearchRequirement({ provider, endpoint, model, mode }: GrantRequirement): boolean {
  const scheme = provider.auth.schemes.find(row => row.type !== "oauth");
  return provider.id === "minimax" && ["https://api.minimax.io", "https://api.minimaxi.com"].includes(provider.base_urls.default)
    && mode === "http" && model == null
    && provider.capabilities.some(row => row.id === "search.web" && row.endpoint === endpoint.id)
    && endpoint.request_format === "minimax.search" && endpoint.response_format === "minimax.search"
    && endpoint.method === "POST" && endpoint.path === "/v1/coding_plan/search" && endpoint.upstreamPath === undefined
    && !endpoint.auth && !endpoint.streaming && !endpoint.websocket && !endpoint.lifecycle && !endpoint.responsesLifecycle
    && !endpoint.modelPassthrough && !endpoint.inputProfile && !endpoint.requestPricing
    && endpoint.path_params.length === 0 && Object.keys(endpoint.query).length === 0
    && Object.keys(provider.adapter.injectQuery).length === 0
    && scheme?.type === "bearer" && scheme.header.toLowerCase() === "authorization"
    && scheme.format === "Bearer ${secret}" && scheme.secretKind === "api_key";
}

export function miniMaxSearchIdentity(grant: UpstreamGrant): string {
  if (!miniMaxSearchProjection(grant)) miniMaxSearchDenied();
  return JSON.stringify([grant.provider, grant.kind, grant.accountId ?? null, grant.credentialGeneration,
    grant.credentialLineage, grant.minimaxSearchBinding, grant.expiresAt ?? null]);
}
