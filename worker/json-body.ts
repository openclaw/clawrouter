import type { Token } from "stream-json/core/parser.js";
import { createJsonTokenizer } from "./json-tokens.ts";

// Large JSON media must not create an additional whole-document string and
// UTF-8 buffer for every pricing/dispatch/retention owner. Inputs are the plain
// JSON values constructed from ingress (not arbitrary objects with toJSON).
const stringChunk = 4096;
const encoder = new TextEncoder();

function* quoted(value: string): Generator<string> {
  yield '"';
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + stringChunk);
    // JSON.stringify escapes a lone surrogate. Keep a real pair together so
    // chunk boundaries cannot change the JSON value or its encoded byte count.
    const last = value.charCodeAt(end - 1), next = value.charCodeAt(end);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
    offset = end;
  }
  yield '"';
}

function* jsonChunks(value: unknown): Generator<string> {
  if (typeof value === "string") { yield* quoted(value); return; }
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index) yield ",";
      yield* jsonChunks(value[index] ?? null);
    }
    yield "]";
  } else if (value !== null && typeof value === "object") {
    yield "{";
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (!first) yield ",";
      first = false;
      yield* quoted(key); yield ":"; yield* jsonChunks(item);
    }
    yield "}";
  } else {
    // Reject non-JSON programmer values rather than silently alter a request.
    if (value !== null && typeof value !== "number" && typeof value !== "boolean") throw new TypeError("expected a JSON value");
    yield JSON.stringify(value);
  }
}

// A quoted chunk is at most 6 × stringChunk + 2 UTF-16 units (\u0000 escapes),
// and each unit encodes to at most 3 bytes.
const scratch = new Uint8Array(3 * (6 * stringChunk + 2));

// Same chunks as quoted(), measured into a reused buffer instead of encoded.
function quotedBytes(value: string): number {
  if (value.length <= stringChunk) return encoder.encodeInto(JSON.stringify(value), scratch).written;
  let bytes = 2;
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + stringChunk);
    const last = value.charCodeAt(end - 1), next = value.charCodeAt(end);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    bytes += encoder.encodeInto(JSON.stringify(value.slice(offset, end)), scratch).written - 2;
    offset = end;
  }
  return bytes;
}

// Counts exactly what jsonBodyStream emits, without serializing: pricing and
// dispatch size every Claude body, and the chunked serializer cost ~70% of a
// request's CPU just to be measured.
export function jsonBodyBytes(value: unknown): number {
  if (typeof value === "string") return quotedBytes(value);
  if (Array.isArray(value)) {
    let bytes = 1 + Math.max(0, value.length - 1) + 1;
    for (let index = 0; index < value.length; index++) bytes += jsonBodyBytes(value[index] ?? null);
    return bytes;
  }
  if (value !== null && typeof value === "object") {
    let bytes = 2, members = 0;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      bytes += quotedBytes(key) + 1 + jsonBodyBytes(item);
      members++;
    }
    return bytes + Math.max(0, members - 1);
  }
  if (value !== null && typeof value !== "number" && typeof value !== "boolean") throw new TypeError("expected a JSON value");
  return JSON.stringify(value).length;
}

// UTF-8 length without materializing the encoded copy; slices keep surrogate
// pairs together so a split cannot count as two replacement characters.
export function utf8Length(text: string): number {
  if (text.length <= stringChunk) return encoder.encodeInto(text, scratch).written;
  let bytes = 0;
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + stringChunk);
    const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    bytes += encoder.encodeInto(text.slice(offset, end), scratch).written;
    offset = end;
  }
  return bytes;
}

export function jsonBodyStream(value: unknown): ReadableStream<Uint8Array> {
  const chunks = jsonChunks(value);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      // Coalesce tiny structural pieces without retaining a document-sized
      // serialization; one pull emits at most ~48 KiB of encoded string data.
      let text = "";
      while (text.length < 8192) {
        const next = chunks.next();
        if (next.done) { if (text) controller.enqueue(encoder.encode(text)); controller.close(); return; }
        text += next.value;
      }
      controller.enqueue(encoder.encode(text));
    },
    cancel() { chunks.return(undefined); },
  }, { highWaterMark: 0 });
}

// Base64 images and data URLs dominate large bodies. JSON.stringify of the whole
// value would add a document-sized string plus its encoded bytes, and the
// chunked serializer above costs 4–20× native CPU. Instead stringify a skeleton
// with each media string swapped for a per-call marker, then splice the strings
// back in as raw chunks: native CPU, and no copy beyond the parsed value.
// Below 1 MiB of such strings a whole-document copy is cheaper than streaming.
const mediaChars = 64 * 1024, mediaChunk = 64 * 1024, mediaMinimum = 1024 * 1024;
// Characters JSON.stringify emits verbatim as one UTF-8 byte each.
const unplain = /[^\x20\x21\x23-\x5b\x5d-\x7e]/;

export interface MediaJsonBody { bytes: number; stream(): ReadableStream<Uint8Array> }

// Null when large strings total under 1 MiB; JSON.stringify is cheaper then.
export function mediaJsonBody(value: unknown): MediaJsonBody | null {
  const slots: Array<{ owner: Record<string, unknown> | unknown[]; key: string | number; value: string }> = [];
  // Iterative: an 8 MiB JSON.parse body can nest far deeper than the call stack.
  const pending: unknown[] = [value];
  let total = 0;
  while (pending.length) {
    const owner = pending.pop();
    if (!owner || typeof owner !== "object") continue;
    const keys: Array<string | number> = Array.isArray(owner) ? Array.from(owner.keys()) : Object.keys(owner);
    for (const key of keys) {
      const item = (owner as Record<string | number, unknown>)[key];
      if (typeof item === "string") { if (item.length >= mediaChars) { slots.push({ owner: owner as Record<string, unknown>, key, value: item }); total += item.length; } }
      else if (item && typeof item === "object") pending.push(item);
    }
  }
  if (total < mediaMinimum) return null;
  const marker = `\u0000clawrouter-media-${crypto.randomUUID()}-`;
  let skeleton: string;
  try {
    slots.forEach((slot, index) => { (slot.owner as Record<string | number, unknown>)[slot.key] = marker + index; });
    skeleton = JSON.stringify(value);
  } finally {
    for (const slot of slots) (slot.owner as Record<string | number, unknown>)[slot.key] = slot.value;
  }
  // The marker's control character is always escaped, and its UUID is fresh,
  // so caller text cannot produce this serialized form.
  const needle = `"${JSON.stringify(marker).slice(1, -1)}`;
  const pieces: Array<Uint8Array | string> = [];
  let bytes = 0, offset = 0;
  for (let at = skeleton.indexOf(needle); at >= 0; at = skeleton.indexOf(needle, offset)) {
    const end = skeleton.indexOf('"', at + needle.length);
    const piece = encoder.encode(skeleton.slice(offset, at)), media = slots[Number(skeleton.slice(at + needle.length, end))].value;
    pieces.push(piece, media);
    bytes += piece.byteLength + (unplain.test(media) ? quotedBytes(media) : media.length + 2);
    offset = end + 1;
  }
  const tail = encoder.encode(skeleton.slice(offset));
  pieces.push(tail);
  bytes += tail.byteLength;
  return {
    bytes,
    stream() {
      let index = 0, chunks: Iterator<string> | null = null;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          while (index < pieces.length) {
            const piece = pieces[index];
            if (typeof piece !== "string") { index++; if (piece.byteLength) { controller.enqueue(piece); return; } continue; }
            chunks ??= unplain.test(piece) ? quoted(piece) : plainChunks(piece);
            const next = chunks.next();
            if (!next.done) { controller.enqueue(encoder.encode(next.value)); return; }
            chunks = null; index++;
          }
          controller.close();
        },
        cancel() { index = pieces.length; },
      }, { highWaterMark: 0 });
    },
  };
}

function* plainChunks(value: string): Generator<string> {
  yield '"';
  for (let offset = 0; offset < value.length; offset += mediaChunk) yield value.slice(offset, offset + mediaChunk);
  yield '"';
}

export class JsonBodyStructureLimit extends Error {}

// The larger envelope is for media, not unbounded object expansion. A byte cap
// alone lets millions of tiny arrays/objects exhaust the 128 MB isolate. Parse
// in bounded feeds directly into the value instead of retaining a second full
// decoded document for JSON.parse. Limits apply only to bodies above 8 MiB.
export function createJsonBodyParser() {
  const stack: Array<{ value: Record<string, unknown> | unknown[]; key?: string }> = [];
  let root: unknown, scalar = "", key = false, nodes = 0;
  function attach(value: unknown) {
    if (++nodes > 65_536) throw new JsonBodyStructureLimit();
    const frame = stack.at(-1);
    if (!frame) root = value;
    else if (Array.isArray(frame.value)) frame.value.push(value);
    // Define an own property, as JSON.parse does, including __proto__. Repeated
    // keys replace the previous value instead of altering object prototypes.
    else Object.defineProperty(frame.value, frame.key!, { value, writable: true, enumerable: true, configurable: true });
  }
  function accept(token: Token) {
    switch (token.name) {
      case "startObject": case "startArray": {
        if (stack.length >= 128) throw new JsonBodyStructureLimit();
        const value = token.name === "startArray" ? [] : {};
        attach(value); stack.push({ value }); break;
      }
      case "endObject": case "endArray": stack.pop(); break;
      case "startKey": key = true; scalar = ""; break;
      case "startString": case "startNumber": key = false; scalar = ""; break;
      case "stringChunk": case "numberChunk":
        scalar += token.value;
        if ((key || token.name === "numberChunk") && scalar.length > 4096) throw new JsonBodyStructureLimit();
        break;
      case "endKey": stack.at(-1)!.key = scalar; scalar = ""; break;
      case "endString": attach(scalar); scalar = ""; break;
      case "endNumber": attach(Number(scalar)); scalar = ""; break;
      case "nullValue": case "trueValue": case "falseValue": attach(token.value); break;
    }
  }
  const consume = createJsonTokenizer(accept);
  return {
    push(text: string): void {
      for (let offset = 0; offset < text.length; offset += 4096) consume.push(text.slice(offset, offset + 4096));
    },
    end(): unknown { consume.end(); return root; },
  };
}

// The same structural bounds for a message that already arrived whole, such as
// an expanded WebSocket create. Feeds are re-decoded copies, never slices: a
// retained 13+ character value sliced from the message would pin all of it.
export function parseBoundedJson(text: string): unknown {
  const parser = createJsonBodyParser(), decoder = new TextDecoder();
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + stringChunk);
    const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    parser.push(decoder.decode(encoder.encode(text.slice(offset, end))));
    offset = end;
  }
  return parser.end();
}
