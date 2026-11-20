import { readMiniMaxImageBinding } from "../shared/minimax-image-binding.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import { miniMaxApiKeySecret } from "./native-media-credential.ts";
import type { GrantRequirement } from "./provider-auth.ts";
import type { UpstreamGrant } from "./types.ts";
import { HttpError } from "./utils.ts";

export function miniMaxImageOwnerBinding(record: CredentialRecord) {
  return record.providerId === "minimax" && !record.revokedAt && miniMaxApiKeySecret(record)
    ? readMiniMaxImageBinding(record.minimaxImageBinding) : null;
}

export function mutateMiniMaxImageBinding(record: CredentialRecord, previous: CredentialRecord | undefined, intent: unknown, preserve: boolean): void {
  const old = previous ? miniMaxImageOwnerBinding(previous) : null;
  const same = preserve && previous && previous.grantKey === record.grantKey && previous.lineage === record.lineage
    && previous.providerId === record.providerId && previous.kind === record.kind && previous.accountId === record.accountId
    && miniMaxApiKeySecret(previous) === miniMaxApiKeySecret(record);
  let binding = same ? old : null;
  if (intent !== undefined) {
    binding = intent === null ? null : readMiniMaxImageBinding(intent);
    if (intent !== null && (!binding || record.providerId !== "minimax" || !miniMaxApiKeySecret(record)))
      throw new HttpError(400, "invalid_minimax_image_authorization", "MiniMax images require explicit global authorization for the original scalar API key");
  }
  if (record.providerId !== "minimax" || !miniMaxApiKeySecret(record)) binding = null;
  record.minimaxImageBinding = binding;
  if (previous && JSON.stringify(old) !== JSON.stringify(binding)) record.lineage = crypto.randomUUID();
}

export function miniMaxImageProjection(grant: UpstreamGrant | null | undefined): boolean {
  return !!grant && grant.provider === "minimax" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && !!grant.credentialLineage
    && (grant.expiresAt == null || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now())
    && !!grant.hasCredential && !grant.hasAccessToken && !grant.hasRefreshToken && !grant.subscription
    && Array.isArray(grant.credentialFields) && grant.credentialFields.length === 0
    && !!readMiniMaxImageBinding(grant.minimaxImageBinding);
}

export function miniMaxImageRequirement({ provider, endpoint, model, mode }: GrantRequirement): boolean {
  const rows = provider.models.filter(row => row.id === model || row.upstream === model);
  const scheme = provider.auth.schemes.find(row => row.type !== "oauth");
  return provider.id === "minimax" && provider.base_urls.default === "https://api.minimax.io" && mode === "http"
    && rows.length === 1 && rows[0].upstream === "image-01" && rows[0].capabilities.includes("image.generate")
    && provider.capabilities.some(row => row.id === "image.generate" && row.endpoint === endpoint.id)
    && endpoint.request_format === "minimax.images" && endpoint.response_format === "minimax.images"
    && endpoint.method === "POST" && endpoint.path === "/v1/image_generation" && endpoint.upstreamPath === undefined
    && !endpoint.auth && !endpoint.streaming && !endpoint.websocket && !endpoint.lifecycle && !endpoint.responsesLifecycle
    && !endpoint.modelPassthrough && !endpoint.inputProfile && !endpoint.requestPricing
    && endpoint.path_params.length === 0 && Object.keys(endpoint.query).length === 0
    && Object.keys(provider.adapter.injectQuery).length === 0
    && scheme?.type === "bearer" && scheme.header.toLowerCase() === "authorization"
    && scheme.format === "Bearer ${secret}" && scheme.secretKind === "api_key";
}

export function miniMaxImageIdentity(grant: UpstreamGrant): string {
  if (!miniMaxImageProjection(grant)) miniMaxImageDenied();
  return JSON.stringify([grant.provider, grant.kind, grant.accountId ?? null, grant.credentialGeneration,
    grant.credentialLineage, grant.minimaxImageBinding, grant.expiresAt ?? null]);
}
export function miniMaxImageDenied(): never {
  throw new HttpError(403, "minimax_image_authorization_required", "MiniMax images require unchanged original global image authorization");
}
