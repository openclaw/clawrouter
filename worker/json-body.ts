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

export function jsonBodyBytes(value: unknown): number {
  let bytes = 0;
  for (const chunk of jsonChunks(value)) bytes += encoder.encode(chunk).byteLength;
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
