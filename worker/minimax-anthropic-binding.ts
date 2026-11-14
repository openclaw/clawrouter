import { resolveMiniMaxResource, type MiniMaxApiCredential, type MiniMaxOAuthCredential, type MiniMaxRegion } from "./provider-minimax-oauth.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import type { UpstreamGrant } from "./types.ts";
import { HttpError } from "./utils.ts";

export interface MiniMaxAnthropicBinding {
  version: "clawrouter.minimax-anthropic.v1";
  kind: "api_key" | "oauth";
  region: MiniMaxRegion;
  issuer: string;
  tokenEndpoint: string;
  resource: string;
}

export function miniMaxAnthropicUnavailable(): never {
  throw new HttpError(403, "minimax_anthropic_authorization_required", "MiniMax Messages requires original regional credential authorization");
}

// This is explicit preprovisioned issuer history, never inferred from a key,
// Bearer header, provider label, generic refresh config or speech permission.
export function readMiniMaxAnthropicBinding(value: unknown): MiniMaxAnthropicBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 6 || Object.keys(v).some(key => !["version", "kind", "region", "issuer", "tokenEndpoint", "resource"].includes(key))
    || v.version !== "clawrouter.minimax-anthropic.v1" || v.kind !== "api_key" && v.kind !== "oauth"
    || v.region !== "global" && v.region !== "cn" || typeof v.resource !== "string") return null;
  const issuer = v.region === "global" ? "https://account.minimax.io" : "https://account.minimaxi.com";
  if (v.issuer !== issuer || v.tokenEndpoint !== `${issuer}/oauth2/token`) return null;
  try {
    const resource = resolveMiniMaxResource(v.region, v.resource).anthropicBaseUrl;
    // The existing API-key codec supports only the canonical regional resource.
    // OAuth may retain an explicitly admitted CN alias; never coerce one kind.
    if (v.kind === "api_key" && resource !== resolveMiniMaxResource(v.region).anthropicBaseUrl) return null;
    return { version: "clawrouter.minimax-anthropic.v1", kind: v.kind as "api_key" | "oauth", region: v.region,
      issuer, tokenEndpoint: `${issuer}/oauth2/token`, resource };
  } catch { return null; }
}

export function normalizeMiniMaxAnthropicBinding(value: unknown): MiniMaxAnthropicBinding {
  const binding = readMiniMaxAnthropicBinding(value);
  if (!binding) throw new HttpError(400, "invalid_minimax_anthropic_authorization", "MiniMax regional credential authorization is invalid");
  return binding;
}

function secret(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

type CredentialSource = Pick<CredentialRecord, "minimaxAnthropicBinding" | "providerId" | "kind" | "subscription" | "credentials" | "refresh" | "credential" | "accessToken" | "refreshToken" | "expiresAt">;

export function miniMaxOwnerBinding(record: CredentialSource): MiniMaxAnthropicBinding | null {
  const binding = readMiniMaxAnthropicBinding(record.minimaxAnthropicBinding);
  if (!binding || record.providerId !== "minimax" || record.kind !== binding.kind || record.subscription
    || Object.keys(record.credentials ?? {}).length || record.refresh) return null;
  if (binding.kind === "api_key") return secret(record.credential) && !record.accessToken && !record.refreshToken ? binding : null;
  return !record.credential && secret(record.accessToken) && secret(record.refreshToken)
    && Number.isFinite(Date.parse(record.expiresAt ?? "")) ? binding : null;
}

export function mutateMiniMaxAnthropicBinding(record: CredentialRecord, previous: CredentialRecord | undefined,
  intent: MiniMaxAnthropicBinding | null | undefined, preserve: boolean): void {
  const old = previous ? miniMaxOwnerBinding(previous) : null;
  const unchanged = preserve && previous && record.lineage === previous.lineage
    && record.providerId === previous.providerId && record.kind === previous.kind && record.accountId === previous.accountId
    && ["credential", "accessToken", "refreshToken"].every(key => record[key as keyof CredentialRecord] === previous[key as keyof CredentialRecord]);
  record.minimaxAnthropicBinding = intent === undefined ? unchanged ? old : null : intent === null ? null : normalizeMiniMaxAnthropicBinding(intent);
  if (record.minimaxAnthropicBinding && !miniMaxOwnerBinding(record))
    throw new HttpError(400, "invalid_minimax_anthropic_authorization", "MiniMax authorization requires an unambiguous matching credential source and no generic refresh override");
  if (JSON.stringify(old) !== JSON.stringify(record.minimaxAnthropicBinding)) record.lineage = crypto.randomUUID();
}

export function miniMaxAnthropicProjection(grant: UpstreamGrant | null): MiniMaxAnthropicBinding | null {
  const binding = readMiniMaxAnthropicBinding(grant?.minimaxAnthropicBinding);
  if (!binding || !grant || grant.provider !== "minimax" || grant.kind !== binding.kind || grant.credentialStore !== "durable_object"
    || grant.enabled === false || grant.revokedAt || grant.credentialRefreshBlockedUntil === null || grant.credentialStatus !== "active" || !grant.credentialLineage
    || !Number.isSafeInteger(grant.credentialGeneration) || grant.credentialGeneration! < 1
    || grant.subscription || grant.credentialFields?.length || grant.refresh) return null;
  return binding.kind === "api_key"
    ? grant.hasCredential && !grant.hasAccessToken && !grant.hasRefreshToken ? binding : null
    : !grant.hasCredential && grant.hasAccessToken && grant.hasRefreshToken && Number.isFinite(Date.parse(grant.expiresAt ?? "")) ? binding : null;
}

export function miniMaxCredential(record: CredentialSource & Pick<CredentialRecord, "grantKey" | "lineage" | "generation">): MiniMaxApiCredential | MiniMaxOAuthCredential {
  const binding = miniMaxOwnerBinding(record);
  if (!binding || !record.grantKey || !record.lineage || !Number.isSafeInteger(record.generation)) miniMaxAnthropicUnavailable();
  const ownerBinding = JSON.stringify([record.grantKey, record.lineage, record.generation]);
  return binding.kind === "api_key"
    ? { kind: "api_key", region: binding.region, ownerBinding, secret: record.credential! }
    : { kind: "oauth", region: binding.region, ownerBinding, access: record.accessToken!, refresh: record.refreshToken!,
      expiresAt: Date.parse(record.expiresAt!), tokenEndpoint: binding.tokenEndpoint, resource: resolveMiniMaxResource(binding.region, binding.resource) };
}
