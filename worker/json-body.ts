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
    async push(text: string) {
      for (let offset = 0; offset < text.length; offset += 4096) consume.push(text.slice(offset, offset + 4096));
    },
    async end(): Promise<unknown> { consume.end(); return root; },
  };
}
