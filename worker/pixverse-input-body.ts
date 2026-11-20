import { BodyLease } from "./body-budget.ts";
import { HttpOperation } from "./http-operation.ts";
import { createJsonTokenizer } from "./json-tokens.ts";
import { HttpError } from "./utils.ts";

// Private to the composed PixVerse profile. These are storage/capacity bounds,
// never a vendor asset lifetime, price bound or generic body override.
export const pixVerseInputLimits = Object.freeze({
  image: 8 * 1024 * 1024, ingress: 8 * 1024 * 1024 + 32 * 1024,
  metadata: 16 * 1024, response: 1024 * 1024, chunk: 16 * 1024,
  publicLease: 20 * 1024 * 1024, ownerLease: 28 * 1024 * 1024,
});
const encoder = new TextEncoder();
function invalid(): never { throw new HttpError(400, "invalid_pixverse_input", "composed image input does not satisfy the bounded profile"); }
export function pixVerseInputLease(side: "public" | "owner"): BodyLease {
  const lease = new BodyLease();
  if (!lease.grow(side === "public" ? pixVerseInputLimits.publicLease : pixVerseInputLimits.ownerLease))
    throw new HttpError(503, "server_overloaded", "composed image capacity is busy");
  return lease;
}

// A fixed destination and one reused BYOB window: no geometric growth, final
// slice, chunk list or whole-stream formData/text/arrayBuffer fallback.
export async function readPixVerseBytes(body: ReadableStream<Uint8Array> | null, maximum: number, operation: HttpOperation): Promise<Uint8Array<ArrayBuffer>> {
  operation.signal.throwIfAborted();
  if (!body || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > pixVerseInputLimits.ingress) invalid();
  let reader: ReadableStreamBYOBReader;
  try { reader = body.getReader({ mode: "byob" }); }
  catch { void body.cancel().catch(() => undefined); invalid(); }
  const raw = new Uint8Array(maximum);
  let window = new Uint8Array(pixVerseInputLimits.chunk), used = 0, complete = false;
  try {
    for (;;) {
      const next = await operation.wait(reader.read(window)); operation.signal.throwIfAborted();
      if (next.value) {
        if (next.value.byteLength > pixVerseInputLimits.chunk || next.value.byteLength > maximum - used) invalid();
        raw.set(next.value, used); used += next.value.byteLength;
        // BYOB transfers the old window; retain its returned backing store.
        window = new Uint8Array(next.value.buffer);
      }
      if (next.done) { complete = true; return raw.subarray(0, used); }
    }
  } finally {
    if (!complete) void reader.cancel(operation.signal.reason).catch(() => undefined);
    reader.releaseLock();
  }
}

export interface PixVerseByteStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly length: number;
  readonly done: Promise<void>;
  readonly complete: boolean;
  cancel(reason?: unknown): void;
}
// Byte streams must not enqueue a borrowed image view: byte controllers detach
// that backing store. Copy only into the consumer's BYOB window or one 16 KiB
// output chunk. HWM zero prevents producer read-ahead and a retained chunk list.
export function pixVerseByteStream(parts: readonly Uint8Array[]): PixVerseByteStream {
  if (parts.length > 4 || parts.some(part => !(part instanceof Uint8Array))
    || parts.reduce((total, part) => total + part.byteLength, 0) > pixVerseInputLimits.ingress) invalid();
  let buffers = [...parts], index = 0, offset = 0, finished = false, complete = false;
  const length = buffers.reduce((total, part) => total + part.byteLength, 0);
  let controller: ReadableByteStreamController;
  let resolve!: () => void;
  const done = new Promise<void>(complete => { resolve = complete; });
  const finish = () => { if (!finished) { finished = true; buffers = []; resolve(); } };
  const body = new ReadableStream<Uint8Array>({ type: "bytes",
    start(value) {
      if (!("byobRequest" in value)) invalid();
      controller = value;
    },
    pull(value) {
      if (!("byobRequest" in value)) invalid();
      const requested = value.byobRequest?.view;
      const chunk = requested ? new Uint8Array(requested.buffer, requested.byteOffset, Math.min(requested.byteLength, pixVerseInputLimits.chunk))
        : new Uint8Array(pixVerseInputLimits.chunk);
      let used = 0;
      while (used < chunk.length && index < buffers.length) {
        const part = buffers[index], size = Math.min(chunk.length - used, part.length - offset);
        chunk.set(part.subarray(offset, offset + size), used); used += size; offset += size;
        if (offset === part.length) { index++; offset = 0; }
      }
      if (used) {
        if (requested) value.byobRequest!.respond(used);
        else value.enqueue(chunk.subarray(0, used));
      }
      if (!used && index === buffers.length) {
        complete = true; value.close();
        if (!used && requested) value.byobRequest?.respond(0);
        finish();
      }
    },
    cancel() { finish(); },
  }, { highWaterMark: 0 });
  return { body, length, done, get complete() { return complete; }, cancel(reason) { if (!finished) { controller.error(reason); finish(); } } };
}

export function pixVerseMultipart(file: Readonly<{ bytes: Uint8Array; type: string }>): { stream: PixVerseByteStream; contentType: string } {
  if (!file.bytes.length || file.bytes.length > pixVerseInputLimits.image || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) invalid();
  const boundary = `clawrouter-${crypto.randomUUID()}`;
  const prefix = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="input-image"\r\nContent-Type: ${file.type}\r\n\r\n`);
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  if (prefix.length + suffix.length > 1024) invalid();
  return { stream: pixVerseByteStream([prefix, file.bytes, suffix]), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Reject object/string amplification BEFORE the codec's JSON.parse. The
// tokenizer emits bounded feeds; values are counted without accumulating them.
export function assertPixVerseResponseStructure(bytes: Uint8Array): void {
  if (!bytes.length || bytes.length > pixVerseInputLimits.response) invalid();
  const stack: Array<{ kind: "object" | "array"; count: number }> = [];
  let nodes = 0, properties = 0, stringUnits = 0, scalarUnits = 0, key = false, string = false;
  const node = () => {
    if (++nodes > 4096) invalid();
    const parent = stack.at(-1);
    if (parent?.kind === "array" && ++parent.count > 1024) invalid();
  };
  const tokenizer = createJsonTokenizer(token => {
    switch (token.name) {
      case "startObject": case "startArray":
        node(); if (stack.length >= 32) invalid(); stack.push({ kind: token.name === "startObject" ? "object" : "array", count: 0 }); break;
      case "endObject": case "endArray": stack.pop(); break;
      case "startKey": key = true; string = true; scalarUnits = 0; break;
      case "startString": key = false; string = true; scalarUnits = 0; node(); break;
      case "startNumber": key = false; string = false; scalarUnits = 0; node(); break;
      case "stringChunk": case "numberChunk":
        scalarUnits += token.value.length;
        if (scalarUnits > 65536) invalid();
        if (string && (stringUnits += token.value.length) > 262144) invalid();
        break;
      case "endKey":
        if (!key || !stack.length || stack.at(-1)!.kind !== "object" || ++stack.at(-1)!.count > 128 || ++properties > 4096) invalid();
        key = false; string = false; break;
      case "endString": case "endNumber": string = false; break;
      case "nullValue": case "trueValue": case "falseValue": node(); break;
    }
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let offset = 0; offset < bytes.length; offset += 1024) tokenizer.push(decoder.decode(bytes.subarray(offset, offset + 1024), { stream: true }));
  tokenizer.push(decoder.decode()); tokenizer.end();
}

export async function readPixVerseResponseBytes(response: Response, operation: HttpOperation): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get("content-length"), mime = response.headers.get("content-type");
  if (response.status !== 200 || response.redirected || response.headers.has("content-range")
    || !mime || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
    || ![null, "identity"].includes(response.headers.get("content-encoding"))
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > pixVerseInputLimits.response)) {
    void response.body?.cancel().catch(() => undefined); invalid();
  }
  const raw = await readPixVerseBytes(response.body, pixVerseInputLimits.response, operation);
  if (length !== null && raw.length !== Number(length)) invalid();
  assertPixVerseResponseStructure(raw); return raw;
}

// Feed only bounded complete bytes to the existing codec. A synthetic Response
// over raw Uint8Array could hand its reader a single 1 MiB chunk; this view keeps
// the same 16 KiB stream bound and propagates cancellation without another lease.
export async function inspectPixVerseBytes<T>(raw: Uint8Array, operation: HttpOperation, inspect: (response: Response) => Promise<T>): Promise<T> {
  const stream = pixVerseByteStream([raw]);
  const canceled = () => stream.cancel(operation.signal.reason);
  operation.signal.addEventListener("abort", canceled, { once: true });
  try {
    operation.signal.throwIfAborted();
    const result = await inspect(new Response(stream.body, { headers: { "content-type": "application/json", "content-length": String(raw.length) } }));
    operation.signal.throwIfAborted();
    if (!stream.complete) invalid();
    return result;
  } finally { operation.signal.removeEventListener("abort", canceled); stream.cancel("codec complete"); }
}
