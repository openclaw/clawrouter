import { prepareVertexAnthropicRequest, vertexAnthropicUrl, importVertexServiceAccountKey, createVertexAssertion } from "./provider-vertex.ts";
import type { CredentialRecord } from "./grant-credential-record.ts";
import type { UpstreamGrant } from "./types.ts";
import { HttpError } from "./utils.ts";

interface VertexResource {
  version: "clawrouter.vertex-anthropic.v1";
  project: string;
  location: string;
}

export type VertexAnthropicBinding = VertexResource & ({ source: "access_token" } | { source: "service_account"; clientEmail: string; keyId?: string });

export function vertexAnthropicUnavailable(): never {
  throw new HttpError(403, "vertex_authorization_required", "Vertex Messages requires its original credential and resource authorization");
}

export function readVertexAnthropicBinding(value: unknown): VertexAnthropicBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const fields = v.source === "service_account" ? ["version", "source", "project", "location", "clientEmail", "keyId"] : ["version", "source", "project", "location"];
  if (Object.keys(v).some(key => !fields.includes(key))
    || v.version !== "clawrouter.vertex-anthropic.v1" || !["access_token", "service_account"].includes(v.source as string)
    || typeof v.project !== "string" || typeof v.location !== "string") return null;
  try { vertexAnthropicUrl({ project: v.project, location: v.location }, "binding-validation", false); }
  catch { return null; }
  const resource: VertexResource = { version: v.version, project: v.project, location: v.location };
  if (v.source === "access_token") return { ...resource, source: v.source };
  if (typeof v.clientEmail !== "string" || v.clientEmail.length > 254 || !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/.test(v.clientEmail)
    || v.keyId !== undefined && (typeof v.keyId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.keyId))) return null;
  return { ...resource, source: "service_account", clientEmail: v.clientEmail, ...(v.keyId === undefined ? {} : { keyId: v.keyId as string }) };
}

export function normalizeVertexAnthropicBinding(value: unknown): VertexAnthropicBinding {
  const binding = readVertexAnthropicBinding(value);
  if (!binding) throw new HttpError(400, "invalid_vertex_authorization", "Vertex resource authorization is invalid");
  return binding;
}

type Source = Pick<CredentialRecord, "vertexAnthropicBinding" | "providerId" | "kind" | "credential" | "credentials" |
  "vertexPrivateKey" | "accessToken" | "refreshToken" | "tokenType" | "expiresAt" | "refresh" | "subscription">;

// Presence of a token, generic OAuth kind or expiry never attests its resource
// or grants refresh capability. Only explicit owner intent creates this binding.
export function vertexOwnerBinding(record: Source): VertexAnthropicBinding | null {
  const binding = readVertexAnthropicBinding(record.vertexAnthropicBinding);
  const expiry = Math.floor(Date.parse(record.expiresAt ?? "") / 1000);
  if (!binding || record.providerId !== "anthropic-vertex" || record.kind !== "oauth" || record.tokenType !== "Bearer"
    || record.credential || Object.keys(record.credentials ?? {}).length || record.refreshToken || record.refresh || record.subscription
    ) return null;
  if (binding.source === "service_account" && !record.vertexPrivateKey) return null;
  if (binding.source === "service_account" && !record.accessToken && !record.expiresAt) return binding;
  if (!Number.isSafeInteger(expiry) || expiry <= 60 || !record.accessToken) return null;
  try {
    // Reuse the codec's exact token grammar without making expired metadata
    // disappear. Admission and the final dispatch check enforce current expiry.
    const request = prepareVertexAnthropicRequest({ messages: [], max_tokens: 1 }, binding, "binding-validation",
      { accessToken: record.accessToken, expiresAt: expiry }, 0);
    void request.body?.cancel().catch(() => undefined);
  } catch { return null; }
  return binding;
}

export async function mutateVertexAnthropicBinding(record: CredentialRecord, previous: CredentialRecord | undefined,
  intent: VertexAnthropicBinding | null | undefined, preserve: boolean, privateKey?: string): Promise<void> {
  const old = previous ? vertexOwnerBinding(previous) : null;
  const same = preserve && previous && record.lineage === previous.lineage && record.providerId === previous.providerId
    && record.kind === previous.kind && record.accountId === previous.accountId && record.accessToken === previous.accessToken
    && record.expiresAt === previous.expiresAt && record.tokenType === previous.tokenType;
  record.vertexAnthropicBinding = intent === undefined ? same ? old : null : intent === null ? null : normalizeVertexAnthropicBinding(intent);
  const binding = record.vertexAnthropicBinding;
  record.vertexPrivateKey = binding?.source === "service_account" ? privateKey ?? (same ? previous?.vertexPrivateKey : undefined) : undefined;
  if (privateKey !== undefined && binding?.source !== "service_account") throw new HttpError(400, "invalid_vertex_authorization", "A signing key requires explicit service-account authorization");
  if (binding?.source === "service_account") {
    // Access tokens belong to the signing identity/resource that minted them.
    // A new signing authority must exchange; never inherit or accept a caller's
    // unrelated token beside its new key.
    if (!same || JSON.stringify(old) !== JSON.stringify(binding) || record.vertexPrivateKey !== previous?.vertexPrivateKey) {
      record.accessToken = undefined; record.expiresAt = null;
    }
    try { await createVertexAssertion(binding.clientEmail, await importVertexServiceAccountKey(record.vertexPrivateKey!), 0, binding.keyId); }
    catch { throw new HttpError(400, "invalid_vertex_authorization", "Vertex service-account signing authority is invalid"); }
  }
  if (record.vertexAnthropicBinding && !vertexOwnerBinding(record))
    throw new HttpError(400, "invalid_vertex_authorization", "Vertex requires its explicit Bearer credential source and no refresh override");
  if (JSON.stringify(old) !== JSON.stringify(record.vertexAnthropicBinding) || record.vertexPrivateKey !== previous?.vertexPrivateKey) record.lineage = crypto.randomUUID();
  // Only a different signing key may retire an uncertain exchange fence.
  if (record.vertexPrivateKey && record.vertexPrivateKey !== previous?.vertexPrivateKey) {
    record.status = "active"; record.refreshAttempt = null; record.refreshDiagnosis = null; record.nextRefreshAttemptAt = null;
  }
}

function projectedVertexBinding(grant: UpstreamGrant | null): VertexAnthropicBinding | null {
  const binding = readVertexAnthropicBinding(grant?.vertexAnthropicBinding);
  if (!binding || !grant || grant.provider !== "anthropic-vertex" || grant.kind !== "oauth" || grant.tokenType !== "Bearer"
    || grant.credentialStore !== "durable_object"
    || !grant.credentialLineage || !Number.isSafeInteger(grant.credentialGeneration) || grant.credentialGeneration! < 1
    || grant.hasCredential || grant.credentialFields?.length || binding.source === "access_token" && !grant.hasAccessToken
    || grant.hasRefreshToken || grant.refresh || grant.subscription || (binding.source === "access_token" || grant.hasAccessToken) && !Number.isSafeInteger(Math.floor(Date.parse(grant.expiresAt ?? "") / 1000))) return null;
  return binding;
}

// Credential presence is distinct from current routing eligibility. A fenced
// key-only owner still occupies its original pool and permits admin mutation.
export function vertexSigningCredentialPresent(grant: UpstreamGrant): boolean {
  return projectedVertexBinding(grant)?.source === "service_account";
}
export function vertexAnthropicProjection(grant: UpstreamGrant | null): VertexAnthropicBinding | null {
  return grant?.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && grant.credentialRefreshBlockedUntil !== null ? projectedVertexBinding(grant) : null;
}
