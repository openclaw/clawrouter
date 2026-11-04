import { BodyLease } from "./body-budget.ts";
import { HttpOperation } from "./http-operation.ts";
import { qualifyImageContainer } from "./pixverse-image-multipart.ts";
import { assertPublishedInputLive, assertPublishedVerifier, publishedInputKey, publishedInputUnavailable, samePublishedInput,
  validatePublishedObject, type PublishedInputBinding, type PublishedInputObject, type PublishedInputReceipt } from "./published-input-receipt.ts";
import type { Env } from "./types.ts";
import { HttpError, safeEqual, sha256Hex } from "./utils.ts";

const windowBytes = 16 * 1024;
const maxReads = 8192;
const pathPrefix = "/v1/input-assets/";
export interface PublishedInputAccess {
  readonly binding: PublishedInputBinding;
  readonly operation: HttpOperation;
  // Internal verified issuer + current explicit permission + original owner.
  // A caller field, URL, MIME label or pure codec cannot supply this closure.
  authorize(): Promise<void>;
  assertLive(): void;
}

export async function publishedInputCall<T>(env: Env, scope: string, input: unknown, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const response = await env.ACCESS_CONTROL.get(env.ACCESS_CONTROL.idFromName(scope)).fetch(
    "https://clawrouter.internal/responses-background", { method: "POST", body: JSON.stringify(input),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); publishedInputUnavailable(); }
  const value = await response.json<T>();
  signal.throwIfAborted(); return value;
}

export function publishedInputUrl(binding: PublishedInputBinding, verifier: string): string {
  assertPublishedInputLive(binding);
  if (!validVerifier(verifier)) publishedInputUnavailable();
  return `${binding.publicOrigin}${pathPrefix}${binding.scope.slice("http-continuations:".length)}/${binding.id}/${verifier}`;
}
export function parsePublishedInputUrl(value: string, origin: string): { scope: string; id: string; verifier: string } {
  if (typeof value !== "string" || value.length > 1024 || typeof origin !== "string") publishedInputUnavailable();
  let url: URL;
  try { url = new URL(value); } catch { publishedInputUnavailable(); }
  if (url.protocol !== "https:" || url.origin !== origin || url.href !== value || url.search || url.hash || url.username || url.password
    || !url.pathname.startsWith(pathPrefix)) publishedInputUnavailable();
  const parts = url.pathname.slice(pathPrefix.length).split("/");
  if (parts.length !== 3 || parts[0].length !== 64 || !/^[a-f0-9]+$/.test(parts[0])
    || parts[1].length !== 38 || !/^asset_[a-f0-9]{32}$/.test(parts[1]) || !validVerifier(parts[2])) publishedInputUnavailable();
  return { scope: `http-continuations:${parts[0]}`, id: parts[1], verifier: parts[2] };
}
function validVerifier(value: unknown): value is string { return typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value); }

export async function resolvePublishedInputUrl(env: Env, url: string, signal: AbortSignal): Promise<PublishedInputReceipt> {
  if (!env.CLAWROUTER_PUBLIC_ORIGIN) publishedInputUnavailable();
  const locator = parsePublishedInputUrl(url, env.CLAWROUTER_PUBLIC_ORIGIN);
  const verifierDigest = await sha256Hex(locator.verifier);
  const receipt = await publishedInputCall<PublishedInputReceipt>(env, locator.scope,
    { action: "asset_get", id: locator.id, verifierDigest }, signal);
  assertPublishedVerifier(receipt, verifierDigest);
  if (receipt.binding.scope !== locator.scope || receipt.binding.id !== locator.id || receipt.binding.publicOrigin !== env.CLAWROUTER_PUBLIC_ORIGIN
    || !["published", "forwarding_unknown"].includes(receipt.state) || !receipt.object) publishedInputUnavailable();
  validatePublishedObject(receipt.object, receipt.binding);
  return receipt;
}

// Publication borrows one exact bounded decoded allocation from authenticated
// intake. That caller keeps its ingress lease through this method's settlement.
// No object body, base64 graph, verifier or media bytes enter the durable row.
export async function publishInputBytes(env: Env, access: PublishedInputAccess, bytes: Uint8Array<ArrayBuffer>): Promise<PublishedInputReceipt> {
  const { binding, operation } = access, signal = operation.signal;
  assertPublishedInputLive(binding);
  if (!(bytes instanceof Uint8Array) || bytes.byteOffset !== 0 || bytes.byteLength !== binding.size || bytes.buffer.byteLength !== binding.size) publishedInputUnavailable();
  qualifyImageContainer(bytes, binding.mime);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  if (!safeEqual(hex(hash), binding.digest)) publishedInputUnavailable();
  await access.authorize();
  const ack = await publishedInputCall<{ acknowledged: true; receipt: PublishedInputReceipt }>(env, binding.scope,
    { action: "asset_claim_publish", binding }, signal);
  if (ack.acknowledged !== true || ack.receipt.state !== "publication_unknown" || !samePublishedInput(ack.receipt.binding, binding)) publishedInputUnavailable();
  signal.throwIfAborted(); access.assertLive(); assertPublishedInputLive(binding);
  let source: Uint8Array<ArrayBuffer> | undefined = bytes, offset = 0;
  const stream = new ReadableStream<Uint8Array>({ type: "bytes", pull(controller) {
    if (!source) { controller.close(); return; }
    const end = Math.min(source.length, offset + windowBytes), output = source.slice(offset, end); offset = end;
    controller.enqueue(output);
    if (offset === source.length) { source = undefined; controller.close(); }
  }, cancel() { source = undefined; } }, { highWaterMark: 0 });
  const abort = new AbortController(), cancel = () => abort.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const fixed = new FixedLengthStream(binding.size);
  const pipe = stream.pipeTo(fixed.writable, { signal: abort.signal });
  void pipe.catch(() => undefined);
  let pending: Promise<R2Object | null> | undefined;
  try {
    // Conditional creation, never overwrite. R2's version identifies this exact
    // upload; a later GET additionally compares version, ETag and SHA256.
    pending = env.CONTENT_ARCHIVE.put(publishedInputKey(binding), fixed.readable, {
      onlyIf: new Headers({ "if-none-match": "*" }), sha256: hash,
      httpMetadata: { contentType: binding.mime, cacheControl: "private, no-store" },
      customMetadata: { expiresAt: String(binding.expiresAt), digest: binding.digest },
    });
    const result = await operation.wait(pending, "publication");
    await pipe;
    if (!result) publishedInputUnavailable();
    const object = archiveObject(result, binding);
    await access.authorize(); signal.throwIfAborted(); access.assertLive();
    const bound = await publishedInputCall<{ acknowledged: true; receipt: PublishedInputReceipt }>(env, binding.scope,
      { action: "asset_bind_publish", binding, object }, signal);
    if (bound.acknowledged !== true || bound.receipt.state !== "published" || !samePublishedInput(bound.receipt.binding, binding)) publishedInputUnavailable();
    return bound.receipt;
  } finally {
    abort.abort();
    if (!fixed.readable.locked) await fixed.readable.cancel().catch(() => undefined);
    await pipe.catch(() => undefined);
    // Cancellation is not retirement while the archive consumer still owns a
    // read. Wait for its actual settlement before releasing our byte reference.
    await pending?.catch(() => undefined);
    source = undefined; signal.removeEventListener("abort", cancel);
  }
}

function archiveObject(object: R2Object, binding: PublishedInputBinding): PublishedInputObject {
  const value: PublishedInputObject = { key: object.key, version: object.version, etag: object.etag,
    digest: hex(object.checksums.sha256), mime: object.httpMetadata?.contentType as PublishedInputBinding["mime"], size: object.size };
  validatePublishedObject(value, binding);
  if (object.customMetadata?.expiresAt !== String(binding.expiresAt) || object.customMetadata.digest !== binding.digest) publishedInputUnavailable();
  return value;
}
function hex(value: ArrayBuffer | undefined): string {
  if (!(value instanceof ArrayBuffer) || value.byteLength !== 32) publishedInputUnavailable();
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("");
}

// The GET's 16 MiB charge is separate from the generation's 64 MiB response
// quarantine. No whole-object text/base64 conversion or response clone occurs.
export async function publishedInputResponse(env: Env, receipt: PublishedInputReceipt, access: PublishedInputAccess): Promise<Response> {
  const { binding, operation } = access, signal = operation.signal;
  if (!samePublishedInput(receipt.binding, binding) || !receipt.object || !["published", "forwarding_unknown"].includes(receipt.state)) publishedInputUnavailable();
  validatePublishedObject(receipt.object, binding);
  const lease = new BodyLease();
  if (!lease.grow(8 * 1024 * 1024)) throw new HttpError(503, "server_overloaded", "published input delivery capacity is busy");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pendingObject: Promise<R2ObjectBody | R2Object | null> | undefined;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let part: Uint8Array | undefined, offset = 0, bytes = 0, reads = 0, ended = false;
  let cleanup: Promise<void> | undefined;
  const onAbort = () => { void finish(signal.reason ?? new Error("published input operation canceled")); };
  const finish = (reason?: unknown): Promise<void> => cleanup ??= Promise.resolve().then(async () => {
    operation.stop(reason === undefined ? "complete" : "upstream", reason);
    try {
      const late = await pendingObject?.catch(() => undefined);
      if (!reader && late && "body" in late && !late.body.locked) reader = late.body.getReader();
      if (!ended) await reader?.cancel(reason).catch(() => undefined);
      await pending?.catch(() => undefined);
    } finally {
      reader?.releaseLock(); reader = undefined; part = undefined; pendingObject = undefined;
      signal.removeEventListener("abort", onAbort); lease.release();
    }
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await access.authorize(); signal.throwIfAborted(); access.assertLive();
    pendingObject = env.CONTENT_ARCHIVE.get(receipt.object.key, { onlyIf: { etagMatches: receipt.object.etag } });
    const object = await pendingObject;
    signal.throwIfAborted();
    if (!object || !("body" in object)) publishedInputUnavailable();
    reader = object.body.getReader();
    const actual = archiveObject(object, binding);
    if (actual.version !== receipt.object.version || actual.etag !== receipt.object.etag) publishedInputUnavailable();
    await access.authorize(); signal.throwIfAborted(); access.assertLive();
    const body = new ReadableStream<Uint8Array>({ type: "bytes", async pull(controller) {
      try {
        signal.throwIfAborted(); access.assertLive(); assertPublishedInputLive(binding);
        while (!part || offset === part.byteLength) {
          part = undefined; offset = 0;
          if (++reads > maxReads) publishedInputUnavailable();
          pending = reader!.read();
          const result = await operation.wait(pending);
          pending = undefined;
          if (result.done) {
            if (bytes !== binding.size) publishedInputUnavailable();
            ended = true; await finish(); controller.close(); controller.byobRequest?.respond(0); return;
          }
          if (!(result.value instanceof Uint8Array) || result.value.buffer.byteLength > 8 * 1024 * 1024
            || bytes + result.value.byteLength > binding.size) publishedInputUnavailable();
          part = result.value; bytes += part.byteLength;
        }
        const size = Math.min(windowBytes, part.byteLength - offset), chunk = part.slice(offset, offset + size);
        offset += size;
        // Fresh output backing is detached, never the retained R2 input view.
        controller.enqueue(chunk);
      } catch (error) { await finish(error); controller.error(error); }
    }, async cancel(reason) { operation.cancel(reason); await finish(reason ?? new Error("published input delivery canceled")); } }, { highWaterMark: 0 });
    return new Response(body, { headers: { "content-type": binding.mime, "content-length": String(binding.size),
      "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
  } catch (error) { await finish(error); throw error; }
}
