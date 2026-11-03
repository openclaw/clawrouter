import { minimaxSpeechBinding, readNativeMediaBinding } from "../shared/native-media-binding.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
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
    && previous.accountId === record.accountId && miniMaxApiKeySecret(previous) === miniMaxApiKeySecret(record);
  let binding = same ? old : null;
  if (intent !== undefined) {
    binding = intent === null ? null : readNativeMediaBinding(intent);
    if (intent !== null && (!binding || record.providerId !== "minimax" || !miniMaxApiKeySecret(record)))
      throw new HttpError(400, "invalid_native_media_authorization", "Global MiniMax speech requires the original scalar native API key");
  }
  if (record.providerId !== "minimax" || !miniMaxApiKeySecret(record)) binding = null;
  record.nativeMediaBinding = binding;
  if (previous && JSON.stringify(old) !== JSON.stringify(binding)) record.lineage = crypto.randomUUID();
}

export function miniMaxMediaProjection(grant: UpstreamGrant): boolean {
  return grant.provider === "minimax" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && !!grant.hasCredential && !grant.hasAccessToken && !grant.hasRefreshToken && !grant.subscription
    && Array.isArray(grant.credentialFields) && grant.credentialFields.length === 0
    && !!readNativeMediaBinding(grant.nativeMediaBinding);
}

export function miniMaxEnvironmentBinding(provider: CompiledProvider, env: Env): { binding: string; secret: string; fingerprint: string } | null {
  const raw = env.CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING;
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const expected = { ...minimaxSpeechBinding, credentialSource: "MINIMAX_API_KEY" };
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
export async function qualifyMiniMaxEnvironmentBinding(provider: CompiledProvider, env: Env) {
  const selected = miniMaxEnvironmentBinding(provider, env);
  if (!selected || await sha256Hex(selected.secret) !== selected.fingerprint) return null;
  const current = miniMaxEnvironmentBinding(provider, env);
  return current && current.secret === selected.secret && current.binding === selected.binding ? current : null;
}
