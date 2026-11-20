import { BodyLease } from "./body-budget.ts";
import { createJsonBodyParser, JsonBodyStructureLimit } from "./json-body.ts";
import type { HttpOperation } from "./http-operation.ts";
import { HttpError, maxJsonBodyBytes, maxMediaJsonBodyBytes } from "./utils.ts";

const MiB = 1024 * 1024;
export const inlineMusicJsonBytes = 12 * MiB;
const windowBytes = 16 * 1024, maximumReads = 262144;

// Freeze one parsed graph in place before borrowing; this is ownership/size
// preparation, not the source codec's model, media or request validation.
export function freezeInlineMusicInput(value: unknown): void {
  let nodes = 0, units = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 32 || depth > 8) invalid();
    if (typeof item === "string") { units += item.length; if (units > inlineMusicJsonBytes) invalid(); return; }
    if (item === null || typeof item !== "object") return;
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    for (const key of Object.keys(item)) {
      units += key.length;
      if (units > inlineMusicJsonBytes) invalid();
      const property = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in property)) invalid();
      visit(property.value, depth + 1);
    }
    Object.freeze(item);
  };
  visit(value, 0);
}

// Internal qualified-profile intake only. The common controller authenticates
// before calling and owns this existing operation through response delivery.
// The returned lease continues covering the graph and validation scratch.
export async function readInlineMusicJson(request: Request, operation: HttpOperation, sharedChat = false): Promise<{
  value: unknown; lease: BodyLease; bytes: number;
}> {
  // Native Chat and music share a physical route. Resolve their registered
  // model after parsing; ordinary Chat keeps its existing 32 MB envelope and
  // incremental charge. Only the selected music profile grows to 64 MiB before
  // byte/container validation. No body-shape guess selects a capability.
  const maximumBytes = sharedChat ? maxMediaJsonBodyBytes : inlineMusicJsonBytes;
  const reject = (): never => { void request.body?.cancel().catch(() => undefined); invalid(); };
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(request.headers.get("content-type")?.trim() ?? "")
    || ![null, "identity"].includes(request.headers.get("content-encoding"))) reject();
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) reject();
  if (length !== null && Number(length) > maximumBytes) {
    void request.body?.cancel().catch(() => undefined);
    throw new HttpError(413, "request_too_large", "JSON input exceeds its route envelope");
  }
  const body = request.body;
  if (!body) return reject();
  const lease = new BodyLease();
  if (!lease.grow(sharedChat ? Number(length ?? 0) : 32 * MiB)) {
    void body.cancel().catch(() => undefined);
    throw new HttpError(503, "server_overloaded", "inline music input capacity is busy", { "retry-after": "1" });
  }
  let reader: ReadableStreamBYOBReader | undefined, parser: ReturnType<typeof createJsonBodyParser> | undefined;
  let window: Uint8Array<ArrayBuffer> | undefined, cancellation: Promise<void> | undefined;
  let transferred = false, firstText = true, size = 0, reads = 0;
  const cancel = () => { cancellation ??= reader?.cancel(operation.signal.reason).catch(() => undefined); };
  try {
    operation.signal.throwIfAborted();
    // No default-reader fallback: an arbitrary backing allocation would defeat
    // the fixed-window lifetime bound before its view could be inspected.
    reader = body.getReader({ mode: "byob" });
    parser = createJsonBodyParser(!sharedChat);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    window = new Uint8Array(windowBytes);
    operation.signal.addEventListener("abort", cancel, { once: true });
    for (;;) {
      operation.signal.throwIfAborted();
      if (++reads > maximumReads) invalid();
      const part: ReadableStreamReadResult<Uint8Array<ArrayBuffer>> = await reader.read(window);
      operation.signal.throwIfAborted();
      if (part.value) {
        if (!(part.value.buffer instanceof ArrayBuffer) || part.value.buffer.byteLength > windowBytes
          || part.value.byteLength > windowBytes) invalid();
        if (part.value.byteLength > maximumBytes - size)
          throw new HttpError(413, "request_too_large", "JSON input exceeds its route envelope");
        size += part.value.byteLength;
        if (sharedChat && !lease.grow(size))
          throw new HttpError(503, "server_overloaded", "JSON input capacity is busy", { "retry-after": "1" });
        if (sharedChat && size > maxJsonBodyBytes) parser.enforceStructureLimits();
        for (let offset = 0; offset < part.value.byteLength; offset += 4096) {
          const text = decoder.decode(part.value.subarray(offset, offset + 4096), { stream: true });
          if (firstText && text.length) { if (text.charCodeAt(0) === 0xfeff) invalid(); firstText = false; }
          parser.push(text);
        }
        window = new Uint8Array(part.value.buffer);
      }
      if (part.done) break;
    }
    if (!size || length !== null && size !== Number(length)) invalid();
    parser.push(decoder.decode());
    const value = parser.take();
    parser = undefined; window = undefined;
    reader.releaseLock(); reader = undefined;
    transferred = true;
    return { value, lease, bytes: size };
  } catch (error) {
    cancel();
    if (error instanceof HttpError || operation.signal.aborted) throw error;
    if (error instanceof JsonBodyStructureLimit) throw new HttpError(413, "request_too_large", "inline music JSON exceeds structural bounds");
    return invalid();
  } finally {
    operation.signal.removeEventListener("abort", cancel);
    if (reader) { cancel(); await cancellation; reader.releaseLock(); }
    else if (!transferred) await body.cancel().catch(() => undefined);
    parser?.discard(); parser = undefined; window = undefined;
    if (!transferred) lease.release();
  }
}

function invalid(): never { throw new HttpError(400, "invalid_inline_music_input", "inline music requires bounded complete UTF-8 JSON"); }
