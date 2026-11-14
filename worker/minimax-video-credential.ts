import { isMiniMaxVideoModel, readMiniMaxVideoBinding } from "../shared/minimax-video-binding.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import { miniMaxApiKeySecret } from "./native-media-credential.ts";
import type { GrantRequirement } from "./provider-auth.ts";
import type { UpstreamGrant } from "./types.ts";
import { HttpError } from "./utils.ts";

export function miniMaxVideoDenied(): never {
  throw new HttpError(403, "minimax_video_authorization_required", "MiniMax video requires original regional video authority");
}

export function miniMaxVideoOwnerBinding(record: CredentialRecord) {
  return record.providerId === "minimax" && !record.revokedAt && miniMaxApiKeySecret(record)
    ? readMiniMaxVideoBinding(record.minimaxVideoBinding) : null;
}

export function mutateMiniMaxVideoBinding(record: CredentialRecord, previous: CredentialRecord | undefined,
  intent: unknown, preserve: boolean): void {
  const old = previous ? miniMaxVideoOwnerBinding(previous) : null;
  const same = preserve && previous && previous.grantKey === record.grantKey && previous.lineage === record.lineage
    && previous.providerId === record.providerId && previous.kind === record.kind && previous.accountId === record.accountId
    && previous.expiresAt === record.expiresAt && miniMaxApiKeySecret(previous) === miniMaxApiKeySecret(record);
  let binding = same ? old : null;
  if (intent !== undefined) {
    binding = intent === null ? null : readMiniMaxVideoBinding(intent);
    if (intent !== null && (!binding || record.providerId !== "minimax" || !miniMaxApiKeySecret(record))) miniMaxVideoDenied();
  }
  if (record.providerId !== "minimax" || !miniMaxApiKeySecret(record)) binding = null;
  record.minimaxVideoBinding = binding;
  if (previous && JSON.stringify(old) !== JSON.stringify(binding)) record.lineage = crypto.randomUUID();
}

export function miniMaxVideoProjection(grant: UpstreamGrant | null | undefined): boolean {
  return !!grant && grant.provider === "minimax" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && Number(grant.credentialGeneration) > 0 && !!grant.credentialLineage
    && (grant.expiresAt == null || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now())
    && !!grant.hasCredential && !grant.hasAccessToken && !grant.hasRefreshToken && !grant.subscription
    && Array.isArray(grant.credentialFields) && grant.credentialFields.length === 0
    && !!readMiniMaxVideoBinding(grant.minimaxVideoBinding);
}

export function miniMaxVideoRequirement({ provider, endpoint, model, mode }: GrantRequirement): boolean {
  const scheme = provider.auth.schemes.find(row => row.type !== "oauth");
  return provider.id === "minimax" && ["https://api.minimax.io", "https://api.minimaxi.com"].includes(provider.base_urls.default)
    && mode === "http" && isMiniMaxVideoModel(model)
    && provider.models.filter(card => card.upstream === model).length === 1
    && endpoint.lifecycle?.protocol === "minimax.video" && !endpoint.lifecycle.cancel && !endpoint.lifecycle.result
    && provider.capabilities.some(row => row.id === "media.predict" && row.endpoint === endpoint.id)
    && endpoint.request_format === "minimax.video_create" && endpoint.response_format === "minimax.video"
    && endpoint.method === "POST" && endpoint.path === "/v1/video_generation" && endpoint.upstreamPath === undefined
    && !endpoint.auth && !endpoint.streaming && !endpoint.websocket && !endpoint.responsesLifecycle
    && !endpoint.modelPassthrough && !endpoint.inputProfile && !endpoint.requestPricing
    && endpoint.path_params.length === 0 && Object.keys(endpoint.query).length === 0
    && Object.keys(provider.adapter.injectQuery).length === 0
    && scheme?.type === "bearer" && scheme.header.toLowerCase() === "authorization"
    && scheme.format === "Bearer ${secret}" && scheme.secretKind === "api_key";
}

export function miniMaxVideoIdentity(grant: UpstreamGrant): string {
  if (!miniMaxVideoProjection(grant)) miniMaxVideoDenied();
  return JSON.stringify([grant.provider, grant.kind, grant.accountId ?? null, grant.credentialGeneration,
    grant.credentialLineage, grant.minimaxVideoBinding, grant.expiresAt ?? null]);
}
