import { qualifyImageContainer } from "./pixverse-image-multipart.ts";

export interface MiniMaxFirstFrame {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

const maxBytes = 8 * 1024 * 1024;
const prefixes = [
  ["data:image/png;base64,", "image/png"],
  ["data:image/jpeg;base64,", "image/jpeg"],
  ["data:image/webp;base64,", "image/webp"],
] as const;

// Pure structural qualification. The caller owns the returned allocation and
// its lifetime; this supplies no grant, receipt, pixel decoding or URL authority.
export function qualifyMiniMaxFirstFrame(value: unknown): MiniMaxFirstFrame {
  if (typeof value !== "string") invalid();
  const prefix = prefixes.find(([text]) => value.startsWith(text));
  if (!prefix) invalid();
  const [header, mimeType] = prefix, start = header.length, length = value.length - start;
  if (!length || length % 4 || length > Math.ceil(maxBytes / 3) * 4) invalid();
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const end = value.length - padding, size = length / 4 * 3 - padding;
  if (!size || size > maxBytes) invalid();
  // Read the original string in place. No regex capture, normalization,
  // full-size decoded string, re-encoding or substring of the payload.
  for (let i = start; i < end; i++) if (sextet(value.charCodeAt(i)) < 0) invalid();
  const tail = sextet(value.charCodeAt(end - 1));
  if (padding === 2 && (tail & 15) || padding === 1 && (tail & 3)) invalid();
  const bytes = new Uint8Array(size);
  for (let i = start, output = 0; i < value.length; i += 4) {
    const a = sextet(value.charCodeAt(i)), b = sextet(value.charCodeAt(i + 1));
    const c = i + 2 < end ? sextet(value.charCodeAt(i + 2)) : 0;
    const d = i + 3 < end ? sextet(value.charCodeAt(i + 3)) : 0;
    bytes[output++] = a << 2 | b >>> 4;
    if (output < size) bytes[output++] = b << 4 | c >>> 2;
    if (output < size) bytes[output++] = c << 6 | d;
  }
  return qualifyMiniMaxFirstFrameBytes(bytes, mimeType);
}

// The caller retains the original buffer; validation neither copies nor decodes.
export function qualifyMiniMaxFirstFrameBytes(bytes: Uint8Array<ArrayBuffer>, mimeType: MiniMaxFirstFrame["mimeType"]): MiniMaxFirstFrame {
  if (!bytes.length || bytes.length > maxBytes || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) invalid();
  try { qualifyImageContainer(bytes, mimeType); } catch { invalid(); }
  const [width, height] = dimensions(bytes, mimeType);
  if (Math.min(width, height) <= 300 || width * 5 < height * 2 || width * 2 > height * 5) invalid();
  return { bytes, mimeType, width, height };
}

function sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}

// Container qualification has already checked bounds, unique frames, complete
// termination and (for extended WebP) agreement with the coded image dimensions.
function dimensions(bytes: Uint8Array, mimeType: MiniMaxFirstFrame["mimeType"]): readonly [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === "image/png") return [view.getUint32(16), view.getUint32(20)];
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) invalid();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++], length = view.getUint16(offset);
      if (marker === 192 || marker === 193 || marker === 194) return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      offset += length;
    }
  } else {
    let offset = 12;
    while (offset < bytes.length) {
      const size = view.getUint32(offset + 4, true), start = offset + 8;
      const tag = view.getUint32(offset);
      if (tag === 0x56503858) return [uint24(bytes, start + 4) + 1, uint24(bytes, start + 7) + 1]; // VP8X
      if (tag === 0x56503820) return [view.getUint16(start + 6, true), view.getUint16(start + 8, true)]; // VP8
      if (tag === 0x5650384c) {
        const bits = view.getUint32(start + 1, true);
        return [(bits & 16383) + 1, (bits >>> 14 & 16383) + 1]; // VP8L
      }
      offset = start + size + (size & 1);
    }
  }
  invalid();
}
function uint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
}
function invalid(): never { throw new Error("invalid_minimax_first_frame"); }
