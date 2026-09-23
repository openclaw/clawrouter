import type { AuthorizedIdentity, CompiledEndpoint, CompiledModel, ContentRecord, Env, ProxyRequestBody } from "./types";
import { randomId } from "./utils.ts";

interface RetainedSelection {
  provider: { id: string };
  endpoint: Pick<CompiledEndpoint, "request_format">;
  model: CompiledModel | null;
  capability: string;
  body: ProxyRequestBody;
}

export function retentionRequired(auth: AuthorizedIdentity, capability: string): boolean {
  return auth.policy.retainRequestContent !== false && !auth.contentRetentionDisabled && capability.startsWith("llm.");
}

export function contentRetentionDefault(env: Env): boolean {
  const value = env.CLAWROUTER_CONTENT_RETENTION_DEFAULT;
  if (typeof value !== "string" || !value.trim()) return true;
  return !["0", "false", "off"].includes(value.trim().toLowerCase());
}

export async function retainRequestContent(env: Env, auth: AuthorizedIdentity, selection: RetainedSelection, requestId: string): Promise<string | null> {
  if (!retentionRequired(auth, selection.capability)) return null;
  const contentRef = randomId("content");
  const occurredAtMs = Date.now();
  const record: ContentRecord = {
    version: "clawrouter.retained-request.v1",
    contentRef,
    requestId,
    occurredAtMs,
    expiresAtMs: occurredAtMs + 30 * 86_400_000,
    tenantId: auth.policy.tenantId ?? "default",
    policyId: auth.policyId,
    credentialId: auth.credentialId,
    principalId: auth.principalId,
    provider: selection.provider.id,
    capability: selection.capability,
    model: selection.model?.id ?? null,
    // Universal gateway entries carry transport credentials inside the JSON
    // body. Archive query content, never their authorization or header fields.
    body: selection.endpoint.request_format === "cloudflare_ai_gateway.universal" && Array.isArray(selection.body)
      ? selection.body.map(({ headers: _headers, authorization: _authorization, ...entry }) => entry)
      : selection.body,
  };
  await env.CONTENT_ARCHIVE.put(contentKey(record.tenantId, contentRef), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { expiresAt: String(record.expiresAtMs) },
  });
  return contentRef;
}

export async function readRetainedContent(env: Env, tenant: string, ref: string): Promise<Record<string, unknown> | null> {
  const object = await env.CONTENT_ARCHIVE.get(contentKey(tenant, ref));
  if (!object) return null;
  const text = await object.text();
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // Physical deletion can lag expiry. Check the archive identity and current time
  // after reading the body so expired content cannot escape during a slow read.
  if (record.version !== "clawrouter.retained-request.v1" || record.tenantId !== tenant || record.contentRef !== ref
    || typeof record.expiresAtMs !== "number" || !Number.isFinite(record.expiresAtMs) || record.expiresAtMs <= Date.now()) return null;
  return record;
}

export function contentKey(tenant: string, ref: string): string {
  return `v1/${encodeURIComponent(tenant)}/${encodeURIComponent(ref)}.json`;
}
