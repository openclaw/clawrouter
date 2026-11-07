import { minimaxMusicBinding, minimaxSpeechBinding, readNativeMediaBinding, type NativeMediaBinding } from "../shared/native-media-binding.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import type { GrantRequirement } from "./provider-auth.ts";
import type { CompiledProvider, Env, UpstreamGrant } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

// This product qualifies one actual API-key slot. Generic credential fallback
// (accessToken or the first bundle value) cannot supply native media authority.
export function miniMaxApiKeySecret(value: Pick<UpstreamGrant, "kind" | "credential" | "credentials" | "accessToken" | "refreshToken" | "subscription">): string | null {
  return value.kind === "api_key" && typeof value.credential === "string" && value.credential.length > 0 && value.credential.length <= 8192 && !/[^\x21-\x7e]/.test(value.credential)
    && !value.accessToken && !value.refreshToken && !value.subscription && !Object.keys(value.credentials ?? {}).length
    ? value.credential : null;
}

export function mutateNativeMediaBinding(record: CredentialRecord, previous: CredentialRecord | undefined, intent: unknown, preserve: boolean): void {
  const old = readNativeMediaBinding(previous?.nativeMediaBinding);
  const same = preserve && previous && previous.providerId === record.providerId && previous.kind === record.kind
    && previous.accountId === record.accountId && miniMaxApiKeySecret(previous) === miniMaxApiKeySecret(record)
    && (old?.operation !== "minimax.music" || !previous.revokedAt && previous.grantKey === record.grantKey && previous.lineage === record.lineage);
  let binding = same ? old : null;
  if (intent !== undefined) {
    binding = intent === null ? null : readNativeMediaBinding(intent);
    if (intent !== null && (!binding || record.providerId !== "minimax" || !miniMaxApiKeySecret(record)))
      throw new HttpError(400, "invalid_native_media_authorization", "Global MiniMax media requires explicit operation authorization for the original scalar API key");
    if (binding?.version === "clawrouter.native-media.v2" && (typeof record.accountId !== "string"
      || !record.accountId.length || record.accountId.length > 512 || record.accountId.trim() !== record.accountId))
      throw new HttpError(400, "invalid_native_media_authorization", "Music cover requires the original bounded account identity");
  }
  if (record.providerId !== "minimax" || !miniMaxApiKeySecret(record)) binding = null;
  record.nativeMediaBinding = binding;
  if (previous && JSON.stringify(old) !== JSON.stringify(binding)) record.lineage = crypto.randomUUID();
}

export function miniMaxMediaProjection(grant: UpstreamGrant, operation: NativeMediaBinding["operation"] = "minimax.speech"): boolean {
  const binding = readNativeMediaBinding(grant.nativeMediaBinding);
  return grant.provider === "minimax" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && !!grant.hasCredential && !grant.hasAccessToken && !grant.hasRefreshToken && !grant.subscription
    && Array.isArray(grant.credentialFields) && grant.credentialFields.length === 0
    && binding?.version === "clawrouter.native-media.v1" && binding.operation === operation;
}

// Cover is a separate inactive profile, never V1 text, free, speech or env authority.
export function miniMaxMusicCoverProjection(grant: UpstreamGrant): boolean {
  const binding = readNativeMediaBinding(grant.nativeMediaBinding);
  return grant.provider === "minimax" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active" && !!grant.hasCredential
    && !grant.hasAccessToken && !grant.hasRefreshToken && !grant.subscription
    && Array.isArray(grant.credentialFields) && grant.credentialFields.length === 0
    && typeof grant.accountId === "string" && grant.accountId.length > 0 && grant.accountId.length <= 512
    && grant.accountId.trim() === grant.accountId && binding?.version === "clawrouter.native-media.v2"
    && Number.isSafeInteger(grant.credentialGeneration) && grant.credentialGeneration! > 0
    && typeof grant.credentialLineage === "string" && grant.credentialLineage.length > 0 && grant.credentialLineage.length <= 128
    && grant.credentialRefreshBlockedUntil !== null
    && (!grant.expiresAt || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now());
}

export function miniMaxMusicCoverIdentity(grant: UpstreamGrant): string {
  if (!miniMaxMusicCoverProjection(grant)) throw new HttpError(403, "minimax_music_cover_authority_required", "The original Music cover owner is unavailable");
  return JSON.stringify([grant.provider, grant.kind, grant.accountId, grant.credentialGeneration, grant.credentialLineage,
    grant.expiresAt ?? null, readNativeMediaBinding(grant.nativeMediaBinding)]);
}

export function miniMaxMusicRequirement({ provider, endpoint, model, mode }: GrantRequirement): boolean {
  const models = provider.models.filter(row => row.id === model || row.upstream === model);
  const scheme = provider.auth.schemes.find(row => row.type !== "oauth");
  return provider.id === "minimax" && provider.base_urls.default === "https://api.minimax.io" && mode === "http"
    && models.length === 1 && ["music-2.6", "music-2.6-free"].includes(models[0].upstream)
    && models[0].capabilities.includes("music.generate")
    && provider.capabilities.some(row => row.id === "music.generate" && row.endpoint === endpoint.id)
    && endpoint.request_format === "minimax.music" && endpoint.response_format === "minimax.music"
    && endpoint.method === "POST" && endpoint.path === "/v1/music_generation" && endpoint.upstreamPath === undefined
    && !endpoint.auth && (endpoint.streaming == null || endpoint.streaming === "sse") && !endpoint.websocket
    && !endpoint.lifecycle && !endpoint.responsesLifecycle && !endpoint.modelPassthrough && !endpoint.inputProfile && !endpoint.requestPricing
    && !endpoint.path_params.length && !Object.keys(endpoint.query).length && !Object.keys(provider.adapter.injectQuery).length
    && scheme?.type === "bearer" && scheme.header.toLowerCase() === "authorization"
    && scheme.format === "Bearer ${secret}" && scheme.secretKind === "api_key";
}

export function miniMaxEnvironmentBinding(provider: CompiledProvider, env: Env, operation: NativeMediaBinding["operation"] = "minimax.speech"): { binding: string; secret: string; fingerprint: string } | null {
  const raw = env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING;
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const expected = { ...(operation === "minimax.music" ? minimaxMusicBinding : minimaxSpeechBinding), credentialSource: "MINIMAX_API_KEY" };
  if (Object.keys(row).length !== Object.keys(expected).length + 1
    || !Object.entries(expected).every(([key, item]) => row[key] === item)
    || typeof row.credentialSha256 !== "string" || row.credentialSha256.length !== 64 || !/^[a-f0-9]+$/.test(row.credentialSha256)) return null;
  // Match the actual configured selector's first available API-key source, not
  // merely another environment value that happens to contain the same bytes.
  const source = provider.config_keys.filter(key => /_(?:API_KEY|API_TOKEN)$/.test(key))
    .find(key => typeof env[key] === "string" && env[key]);
  const secret = env.MINIMAX_API_KEY;
  if (source !== "MINIMAX_API_KEY" || typeof secret !== "string" || !secret.length || secret.length > 8192 || /[^\x21-\x7e]/.test(secret)) return null;
  return { binding: JSON.stringify({ ...expected, credentialSha256: row.credentialSha256 }), secret, fingerprint: row.credentialSha256 };
}


// Both public eligibility and dispatch use the same actual fingerprint check.
// The second read closes rotation during the asynchronous digest operation.
export async function qualifyMiniMaxEnvironmentBinding(provider: CompiledProvider, env: Env, operation: NativeMediaBinding["operation"] = "minimax.speech") {
  const selected = miniMaxEnvironmentBinding(provider, env, operation);
  if (!selected || await sha256Hex(selected.secret) !== selected.fingerprint) return null;
  const current = miniMaxEnvironmentBinding(provider, env, operation);
  return current && current.secret === selected.secret && current.binding === selected.binding ? current : null;
}
