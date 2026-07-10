import type { AuthorizedIdentity, CompiledModel, ContentRecord, Env } from "./types";
import { randomId } from "./utils.ts";

interface RetainedSelection {
  provider: { id: string };
  model: CompiledModel | null;
  capability: string;
  body: Record<string, unknown>;
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
    body: selection.body,
  };
  await env.CONTENT_ARCHIVE.put(contentKey(record.tenantId, contentRef), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { expiresAt: String(record.expiresAtMs) },
  });
  return contentRef;
}

export function contentKey(tenant: string, ref: string): string {
  return `v1/${encodeURIComponent(tenant)}/${encodeURIComponent(ref)}.json`;
}
