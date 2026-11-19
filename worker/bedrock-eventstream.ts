import { createSseUsageAccumulator, usageInspectionLimit, type UsageInspection, type UsageTokens } from "./token-usage.ts";

// Complete-frame validation only. Callers own assembly, capacity and delivery.
// Payload borrows the supplied bytes; only colon metadata is exposed as strings.
export function decodeBedrockEventFrame(frame: Uint8Array): Readonly<{ headers: ReadonlyMap<string, string>; payload: Uint8Array }> {
  const { length, headerEnd } = eventPrelude(frame);
  if (frame.length !== length || crc32(frame.subarray(0, length - 4))
    !== new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(length - 4)) throw new Error("invalid event frame");
  return { headers: eventHeaders(frame.subarray(12, headerEnd)), payload: frame.subarray(headerEnd, length - 4) };
}

function eventPrelude(bytes: Uint8Array): { length: number; headerEnd: number } {
  if (bytes.length < 12) throw new Error("truncated event prelude");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = view.getUint32(0), headers = view.getUint32(4);
  if (crc32(bytes.subarray(0, 8)) !== view.getUint32(8) || length < 16 || headers > length - 16) throw new Error("invalid event prelude");
  return { length, headerEnd: 12 + headers };
}

// Observe InvokeModelWithResponseStream, never reframe or drain it. The existing
// response reader owns delivery. Unknown/oversized payloads remain unmetered.
export function createBedrockEventStreamInspector() {
  const prelude = new Uint8Array(12), decoder = new TextDecoder("utf-8", { fatal: true });
  const messages = createSseUsageAccumulator();
  let offset = 0, frame: Uint8Array | null = null, stopped = false, failed = false;
  let novaSeen = false, nova: UsageTokens | null = null;
  function invalid() { stopped = true; failed = true; frame = null; nova = null; }
  function consume(bytes: Uint8Array) {
    try {
      const { headers, payload: envelopeBytes } = decodeBedrockEventFrame(bytes);
      if (headers.get(":message-type") === "exception" || headers.get(":message-type") === "error") { failed = true; return; }
      if (headers.get(":message-type") !== "event" || headers.get(":event-type") !== "chunk") { stopped = true; nova = null; return; }
      const envelope = object(JSON.parse(decoder.decode(envelopeBytes)));
      if (typeof envelope?.bytes !== "string" || (envelope.bytes.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.bytes))) { invalid(); return; }
      const payload = Uint8Array.from(atob(envelope.bytes), char => char.charCodeAt(0));
      const value = object(JSON.parse(decoder.decode(payload)));
      if (!value) { invalid(); return; }
      // Nova emits its complete counters in metadata after messageStop.
      if (Object.hasOwn(value, "metadata")) {
        novaSeen = true;
        nova = novaUsage(object(object(value.metadata)?.usage));
      }
      // Bedrock's Anthropic Messages payloads retain their native terminals.
      if (typeof value.type === "string") messages.accept({ kind: "data", value });
    } catch { invalid(); }
  }
  return {
    push(bytes: Uint8Array) {
      let index = 0;
      while (index < bytes.length && !stopped) {
        if (!frame) {
          const count = Math.min(12 - offset, bytes.length - index);
          prelude.set(bytes.subarray(index, index + count), offset); offset += count; index += count;
          if (offset < 12) continue;
          let length: number;
          try { length = eventPrelude(prelude).length; } catch { invalid(); break; }
          // This is an inspection cap, not a wire limit. Delivery continues.
          if (length > usageInspectionLimit) { stopped = true; nova = null; break; }
          frame = new Uint8Array(length); frame.set(prelude);
        }
        const count = Math.min(frame.length - offset, bytes.length - index);
        frame.set(bytes.subarray(index, index + count), offset); offset += count; index += count;
        if (offset === frame.length) { consume(frame); frame = null; offset = 0; }
      }
    },
    result(ended = true): UsageInspection {
      if (stopped) return { tokens: null, outcome: failed ? "provider_error" : null };
      if (!ended) return { tokens: null, outcome: failed ? "provider_error" : null };
      if (offset !== 0) return { tokens: null, outcome: "provider_error" };
      const message = messages.result();
      return { tokens: novaSeen ? nova : message.tokens, outcome: failed ? "provider_error" : novaSeen ? "success" : message.outcome };
    },
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function novaUsage(usage: Record<string, unknown> | null): UsageTokens | null {
  const input = usage?.inputTokens, output = usage?.outputTokens, total = usage?.totalTokens;
  if (typeof input !== "number" || typeof output !== "number" || typeof total !== "number"
    || ![input, output, total].every(value => Number.isSafeInteger(value) && value >= 0) || input + output !== total) return null;
  return { input, output, total, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
}

function eventHeaders(bytes: Uint8Array): Map<string, string> {
  const decoder = new TextDecoder("utf-8", { fatal: true }), result = new Map<string, string>(), names = new Set<string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes[offset++];
    if (!length || offset + length + 1 > bytes.length) throw new Error("invalid event header");
    const name = decoder.decode(bytes.subarray(offset, offset + length)); offset += length;
    if (names.has(name)) throw new Error("duplicate event header");
    names.add(name);
    const type = bytes[offset++];
    let size = [0, 0, 1, 2, 4, 8, 0, 0, 8, 16][type];
    if (size === undefined) throw new Error("invalid event header type");
    if (type === 6 || type === 7) { size = view.getUint16(offset); offset += 2; }
    if (offset + size > bytes.length) throw new Error("truncated event header");
    if (name.startsWith(":")) {
      if (type !== 7) throw new Error("invalid event metadata");
      result.set(name, decoder.decode(bytes.subarray(offset, offset + size)));
    }
    offset += size;
  }
  return result;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
