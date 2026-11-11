import type { AuthorizedIdentity, CompiledEndpoint, CompiledModel, ContentRecord, Env, ProxyRequestBody } from "./types";
import { maxJsonBodyBytes, randomId } from "./utils.ts";
import { accountingArchive, privateAccountingArchive, accountingIdentity, admitAccountingJson, jsonBodyTransport } from "./json-body.ts";
import { checkOwnedHttpSinkOwner, ownedHttpSinkOwner, checkOwnedHttpArchivePreparation, prepareOwnedHttpArchive, ownedHttpArchivePut, ownedHttpArchivePipe, ownedHttpArchiveAbort,
  ownedHttpArchiveCancel, type OwnedHttpSinkOwner, type OwnedHttpRequest } from "./http-identity-owner.ts";

const retentionPeriodMs = 30 * 86_400_000;

interface RetainedSelection {
  provider: { id: string };
  endpoint: Pick<CompiledEndpoint, "request_format">;
  model: CompiledModel | null;
  capability: string;
  body: ProxyRequestBody;
}

export function retentionRequired(auth: AuthorizedIdentity, capability: string): boolean {
  return auth.policy.retainRequestContent !== false && !auth.contentRetentionDisabled && (capability.startsWith("llm.") || capability === "audio.speech" || capability === "image.generation");
}

export function contentRetentionDefault(env: Env): boolean {
  const value = env.CLAWROUTER_CONTENT_RETENTION_DEFAULT;
  if (typeof value !== "string" || !value.trim()) return true;
  return !["0", "false", "off"].includes(value.trim().toLowerCase());
}

export async function retainRequestContent(env: Env, auth: AuthorizedIdentity, selection: RetainedSelection, requestId: string): Promise<string | null> {
  const retention = prepareContentRetention(env, auth, selection, requestId);
  if (!retention) return null;
  await retention.write();
  return retention.contentRef;
}

export interface PreparedContentRetention {
  readonly contentRef: string;
  /** Above the parser bound the archive streams the body; keep that write sequential. */
  readonly large: boolean;
  write(): Promise<void>;
  /** Only a never-started ordinary archive may be dropped without a write receipt. */
  discardUnused?(): void;
}

// Fusion supplies a private prospective body view before allocating placeholders.
// The fixed-length ref has exactly the representation produced by randomId().
export function admitProspectiveContentRetention(auth: AuthorizedIdentity, selection: Omit<RetainedSelection, "body">,
  requestId: string, body: unknown): void {
  if (!retentionRequired(auth, selection.capability)) return;
  for (const value of [requestId, auth.policy.tenantId, auth.policyId, auth.credentialId, auth.principalId,
    selection.provider.id, selection.capability, selection.model?.id]) accountingIdentity(value);
  admitAccountingJson({ version: "clawrouter.retained-request.v1", contentRef: "content_00000000000000000000000000000000",
    requestId, occurredAtMs: Number.MAX_SAFE_INTEGER, expiresAtMs: Number.MAX_SAFE_INTEGER,
    tenantId: auth.policy.tenantId ?? "default", policyId: auth.policyId, credentialId: auth.credentialId,
    principalId: auth.principalId, provider: selection.provider.id, capability: selection.capability,
    model: selection.model?.id ?? null, body }, "archive");
}

// The borrowed music controller invokes this only for its qualified inline
// profile. Router logging policy remains distinct from upstream asset consent.
// The archive owns its graph until BOTH the put and its bounded transport end.
export function prepareInlineMusicRetention(env: Env, auth: AuthorizedIdentity, selection: RetainedSelection,
  requestId: string, signal: AbortSignal): (PreparedContentRetention & { discard(): void }) | null {
  if (auth.policy.retainRequestContent === false || auth.contentRetentionDisabled) return null;
  const contentRef = randomId("content"), occurredAtMs = Date.now();
  let record: ContentRecord | undefined = {
    version: "clawrouter.retained-request.v1", contentRef, requestId, occurredAtMs,
    expiresAtMs: occurredAtMs + retentionPeriodMs, tenantId: auth.policy.tenantId ?? "default",
    policyId: auth.policyId, credentialId: auth.credentialId, principalId: auth.principalId,
    provider: selection.provider.id, capability: selection.capability, model: selection.model?.id ?? null,
    body: selection.body,
  };
  let used = false;
  return { contentRef, large: true, discard() { record = undefined; }, async write() {
    if (used || !record) throw new TypeError("borrowed retention is single-use");
    used = true;
    const key = contentKey(record.tenantId, contentRef), expiresAt = String(record.expiresAtMs);
    const serializer = jsonBodyTransport(record, 12 * 1024 * 1024 + 64 * 1024);
    record = undefined;
    const abort = new AbortController(), cancel = () => abort.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const fixed = new FixedLengthStream(serializer.bytes);
    const pipe = serializer.stream().pipeTo(fixed.writable, { signal: abort.signal });
    void pipe.catch(() => undefined);
    try {
      signal.throwIfAborted();
      await env.CONTENT_ARCHIVE.put(key, fixed.readable, {
        httpMetadata: { contentType: "application/json" }, customMetadata: { expiresAt },
      });
      await pipe;
      signal.throwIfAborted();
    } finally {
      abort.abort();
      // R2 may refuse before acquiring the readable. Abort alone can still
      // wait on its backpressured write; cancel only our unclaimed stream.
      if (!fixed.readable.locked) await fixed.readable.cancel().catch(() => undefined);
      await pipe.catch(() => undefined);
      serializer.discard(); record = undefined;
      signal.removeEventListener("abort", cancel);
    }
  } };
}

// Allocates the content ref synchronously so usage events can reference it;
// the R2 write itself can run after the request is dispatched.
export function prepareContentRetention(env: Env, auth: AuthorizedIdentity, selection: RetainedSelection, requestId: string, ownedHttp?: OwnedHttpSinkOwner): PreparedContentRetention | null {
  return createContentRetention(env, auth, selection, requestId, ownedHttp);
}
export function prepareOwnedHttpContentRetention(cap: OwnedHttpRequest, env: Env, auth: AuthorizedIdentity,
  selection: RetainedSelection, requestId: string): PreparedContentRetention | null {
  const sink = ownedHttpSinkOwner(cap);
  checkOwnedHttpArchivePreparation(cap, sink, env, auth, selection as import("./proxy-selection.ts").ProxySelection, requestId);
  return createContentRetention(env, auth, selection, requestId, sink, cap);
}
function createContentRetention(env: Env, auth: AuthorizedIdentity, selection: RetainedSelection, requestId: string,
  ownedHttp?: OwnedHttpSinkOwner, privateRequest?: OwnedHttpRequest): PreparedContentRetention | null {
  if (ownedHttp !== undefined) checkOwnedHttpSinkOwner(ownedHttp);
  if (!retentionRequired(auth, selection.capability)) return null;
  const privateBucket = ownedHttp === undefined ? undefined
    : prepareOwnedHttpArchive(privateRequest!, ownedHttp, env, auth, selection as import("./proxy-selection.ts").ProxySelection, requestId);
  for (const value of [requestId, auth.policy.tenantId, auth.policyId, auth.credentialId, auth.principalId,
    selection.provider.id, selection.capability, selection.model?.id]) accountingIdentity(value);
  const contentRef = randomId("content"), occurredAtMs = Date.now();
  const tenant = auth.policy.tenantId ?? "default";
  const expiresAt = String(occurredAtMs + retentionPeriodMs);
  const record: ContentRecord = {
    version: "clawrouter.retained-request.v1", contentRef, requestId, occurredAtMs,
    expiresAtMs: occurredAtMs + retentionPeriodMs, tenantId: tenant, policyId: auth.policyId,
    credentialId: auth.credentialId, principalId: auth.principalId, provider: selection.provider.id,
    capability: selection.capability, model: selection.model?.id ?? null, body: selection.body,
  };
  const gateway = selection.endpoint.request_format === "cloudflare_ai_gateway.universal" && Array.isArray(selection.body) ? selection.body : undefined;
  // Admission traverses the privacy-filtered view BEFORE the first map/copy.
  const archive = ownedHttp === undefined ? accountingArchive(record, gateway) : privateAccountingArchive(record, gateway);
  return ownedContentRetention(ownedHttp === undefined ? env.CONTENT_ARCHIVE : privateBucket, contentKey(tenant, contentRef), expiresAt, contentRef, archive, ownedHttp);
}

function ownedContentRetention(bucket: Env["CONTENT_ARCHIVE"], key: string, expiresAt: string,
  contentRef: string, archive: ReturnType<typeof accountingArchive>, ownedHttp?: OwnedHttpSinkOwner): PreparedContentRetention {
  let writing: Promise<void> | undefined;
  let unused = false;
  return { contentRef, large: archive.bytes > maxJsonBodyBytes,
    discardUnused() { if (!writing) { unused = true; archive.discard(); } },
    write() {
    if (unused) throw new TypeError("unused content retention is closed");
    return writing ??= (async () => {
      if (archive.bytes <= 32768) {
        // The COMPLETE admitted serialization fits the same whole-backing
        // ceiling. R2 completion remains a distinct, awaited owner.
        const text = archive.text();
        if (ownedHttp !== undefined) await ownedHttpArchivePut(ownedHttp, bucket, key, text, expiresAt);
        else await bucket.put(key, text, { httpMetadata: { contentType: "application/json" }, customMetadata: { expiresAt } });
        return;
      }
      const fixed = new FixedLengthStream(archive.bytes), abort = new AbortController();
      const pipe = ownedHttp !== undefined ? ownedHttpArchivePipe(ownedHttp, archive.stream(), fixed.writable, abort.signal)
        : archive.stream().pipeTo(fixed.writable, { signal: abort.signal });
      const pipeOutcome = pipe.then(() => ({ failed: false as const }), error => ({ failed: true as const, error }));
      let hasPrimary = false, primary: unknown;
      const cleanup: unknown[] = [];
      try {
        if (ownedHttp !== undefined) await ownedHttpArchivePut(ownedHttp, bucket, key, fixed.readable, expiresAt);
        else await bucket.put(key, fixed.readable, { httpMetadata: { contentType: "application/json" }, customMetadata: { expiresAt } });
      } catch (error) { hasPrimary = true; primary = error; }
      if (hasPrimary) {
        if (ownedHttp !== undefined) { try { ownedHttpArchiveAbort(ownedHttp, abort); } catch (error) { cleanup.push(error); } }
        else abort.abort();
        if (!fixed.readable.locked) {
          try { if (ownedHttp !== undefined) await ownedHttpArchiveCancel(ownedHttp, fixed.readable); else await fixed.readable.cancel(); } catch (error) { cleanup.push(error); }
        }
      }
      const outcome = await pipeOutcome;
      if (outcome.failed) cleanup.push(outcome.error);
      archive.discard();
      if (cleanup.length) throw new AggregateError(hasPrimary ? [primary, ...cleanup] : cleanup, "content retention cleanup failed");
      if (hasPrimary) throw primary;
    })();
  } };
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
    || typeof record.expiresAtMs !== "number" || !Number.isFinite(record.expiresAtMs)
    || Math.min(record.expiresAtMs, retainedContentDeadline(object)) <= Date.now()) return null;
  return record;
}

export function retainedContentDeadline(object: Pick<R2Object, "uploaded" | "customMetadata">): number {
  const maximum = object.uploaded.getTime() + retentionPeriodMs;
  const declared = object.customMetadata?.expiresAt?.trim();
  const expiry = declared ? Number(declared) : NaN;
  return Number.isFinite(expiry) ? Math.min(expiry, maximum) : maximum;
}

export function contentKey(tenant: string, ref: string): string {
  return `v1/${encodeURIComponent(tenant)}/${encodeURIComponent(ref)}.json`;
}
