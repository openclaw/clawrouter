import { prepareVertexAnthropicRequest, vertexAnthropicUrl } from "./provider-vertex.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import type { UpstreamGrant } from "./types.ts";
import { HttpError } from "./utils.ts";

export interface VertexAnthropicBinding {
  version: "clawrouter.vertex-anthropic.v1";
  source: "access_token";
  project: string;
  location: string;
}

export function vertexAnthropicUnavailable(): never {
  throw new HttpError(403, "vertex_authorization_required", "Vertex Messages requires its original credential and resource authorization");
}

export function readVertexAnthropicBinding(value: unknown): VertexAnthropicBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 4 || Object.keys(v).some(key => !["version", "source", "project", "location"].includes(key))
    || v.version !== "clawrouter.vertex-anthropic.v1" || v.source !== "access_token"
    || typeof v.project !== "string" || typeof v.location !== "string") return null;
  try { vertexAnthropicUrl({ project: v.project, location: v.location }, "binding-validation", false); }
  catch { return null; }
  return { version: v.version, source: v.source, project: v.project, location: v.location };
}

export function normalizeVertexAnthropicBinding(value: unknown): VertexAnthropicBinding {
  const binding = readVertexAnthropicBinding(value);
  if (!binding) throw new HttpError(400, "invalid_vertex_authorization", "Vertex resource authorization is invalid");
  return binding;
}

type Source = Pick<CredentialRecord, "vertexAnthropicBinding" | "providerId" | "kind" | "credential" | "credentials" |
  "accessToken" | "refreshToken" | "tokenType" | "expiresAt" | "refresh" | "subscription">;

// Presence of a token, generic OAuth kind or expiry never attests its resource
// or grants refresh capability. Only explicit owner intent creates this binding.
export function vertexOwnerBinding(record: Source): VertexAnthropicBinding | null {
  const binding = readVertexAnthropicBinding(record.vertexAnthropicBinding);
  const expiry = Math.floor(Date.parse(record.expiresAt ?? "") / 1000);
  if (!binding || record.providerId !== "anthropic-vertex" || record.kind !== "oauth" || record.tokenType !== "Bearer"
    || record.credential || Object.keys(record.credentials ?? {}).length || record.refreshToken || record.refresh || record.subscription
    || !Number.isSafeInteger(expiry) || expiry <= 60 || !record.accessToken) return null;
  try {
    // Reuse the codec's exact token grammar without making expired metadata
    // disappear. Admission and the final dispatch check enforce current expiry.
    const request = prepareVertexAnthropicRequest({ messages: [], max_tokens: 1 }, binding, "binding-validation",
      { accessToken: record.accessToken, expiresAt: expiry }, 0);
    void request.body?.cancel().catch(() => undefined);
  } catch { return null; }
  return binding;
}

export function mutateVertexAnthropicBinding(record: CredentialRecord, previous: CredentialRecord | undefined,
  intent: VertexAnthropicBinding | null | undefined, preserve: boolean): void {
  const old = previous ? vertexOwnerBinding(previous) : null;
  const same = preserve && previous && record.lineage === previous.lineage && record.providerId === previous.providerId
    && record.kind === previous.kind && record.accountId === previous.accountId && record.accessToken === previous.accessToken
    && record.expiresAt === previous.expiresAt && record.tokenType === previous.tokenType;
  record.vertexAnthropicBinding = intent === undefined ? same ? old : null : intent === null ? null : normalizeVertexAnthropicBinding(intent);
  if (record.vertexAnthropicBinding && !vertexOwnerBinding(record))
    throw new HttpError(400, "invalid_vertex_authorization", "Vertex requires one preprovisioned Bearer access token with explicit expiry and no refresh override");
  if (JSON.stringify(old) !== JSON.stringify(record.vertexAnthropicBinding)) record.lineage = crypto.randomUUID();
}

export function vertexAnthropicProjection(grant: UpstreamGrant | null): VertexAnthropicBinding | null {
  const binding = readVertexAnthropicBinding(grant?.vertexAnthropicBinding);
  if (!binding || !grant || grant.provider !== "anthropic-vertex" || grant.kind !== "oauth" || grant.tokenType !== "Bearer"
    || grant.credentialStore !== "durable_object" || grant.enabled !== true || grant.revokedAt || grant.credentialStatus !== "active"
    || !grant.credentialLineage || !Number.isSafeInteger(grant.credentialGeneration) || grant.credentialGeneration! < 1
    || grant.credentialRefreshBlockedUntil === null || grant.hasCredential || grant.credentialFields?.length || !grant.hasAccessToken
    || grant.hasRefreshToken || grant.refresh || grant.subscription || !Number.isSafeInteger(Math.floor(Date.parse(grant.expiresAt ?? "") / 1000))) return null;
  return binding;
}
