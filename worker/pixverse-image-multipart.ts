import { preparePixVerseImagePlan } from "./managed-pixverse.ts";

type ImageType = "image/png" | "image/jpeg" | "image/webp";
const fileLimit = 8 * 1024 * 1024, rawLimit = fileLimit + 32 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const limits: Readonly<Record<string, number>> = {
  model: 16, prompt: 2048, duration: 16, quality: 8, seed: 16, negative_prompt: 2048,
  camera_movement: 128, template_id: 16, generate_audio_switch: 5, motion_mode: 64,
};
const crlf = encoder.encode("\r\n"), close = encoder.encode("--"), headerEnd = encoder.encode("\r\n\r\n");

// Pure framing and image-container qualification, not pixel decompression.
// The caller owns authentication, raw-byte capacity and the returned view's life.
export function parsePixVerseImageMultipart(raw: Uint8Array<ArrayBuffer>, contentType: string): {
  plan: Readonly<Record<string, unknown>>;
  file: { bytes: Uint8Array<ArrayBuffer>; type: ImageType };
} {
  if (!(raw instanceof Uint8Array) || !raw.length || raw.length > rawLimit) invalid();
  const match = /^multipart\/form-data;\s*boundary=(?:"([0-9A-Za-z'()+_,.\/:=? -]{1,70})"|([0-9A-Za-z'()+_,.\/:=?-]{1,70}))$/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.endsWith(" ")) invalid();
  const marker = encoder.encode("--" + boundary), separator = encoder.encode("\r\n--" + boundary);
  if (!at(raw, marker, 0)) invalid();
  const fields: Record<string, unknown> = Object.create(null);
  let file: { bytes: Uint8Array<ArrayBuffer>; type: ImageType } | undefined;
  let cursor = marker.length, parts = 0, scalars = 0;
  for (;;) {
    if (at(raw, close, cursor)) {
      cursor += 2;
      if (at(raw, crlf, cursor)) cursor += 2;
      if (cursor !== raw.length) invalid();
      break;
    }
    if (!at(raw, crlf, cursor) || ++parts > 11) invalid();
    cursor += 2;
    const end = find(raw, headerEnd, cursor, Math.min(raw.length, cursor + 2048 + headerEnd.length));
    if (end < 0) invalid();
    const headerBytes = raw.subarray(cursor, end);
    if (headerBytes.some(byte => byte > 126 || byte < 32 && ![9, 10, 13].includes(byte))) invalid();
    const headers = new Map<string, string>();
    for (const line of decoder.decode(headerBytes).split("\r\n")) {
      const header = /^(Content-Disposition|Content-Type):[ \t]*([^\r\n]+)$/i.exec(line);
      if (!header || headers.has(header[1].toLowerCase())) invalid();
      headers.set(header[1].toLowerCase(), header[2]);
    }
    const disposition = /^form-data;[ \t]*name="([a-z_]+)"(?:;[ \t]*filename="([^"\r\n]*)")?$/.exec(headers.get("content-disposition") ?? "");
    if (!disposition) invalid();
    const [, name, filename] = disposition;
    cursor = end + headerEnd.length;
    const next = findBoundary(raw, separator, cursor);
    if (next < 0) invalid();
    const bytes = raw.subarray(cursor, next);
    if (name === "image") {
      if (file || filename === undefined || !/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,126}$/.test(filename) || filename.includes("..")
        || !bytes.length || bytes.length > fileLimit) invalid();
      const type = headers.get("content-type")?.toLowerCase();
      if (type !== "image/png" && type !== "image/jpeg" && type !== "image/webp") invalid();
      qualifyImage(bytes, type);
      file = { bytes, type };
    } else {
      if (filename !== undefined || headers.has("content-type") || !Object.hasOwn(limits, name)
        || Object.hasOwn(fields, name) || ++scalars > 10 || bytes.length > limits[name]) invalid();
      let value: string;
      try { value = decoder.decode(bytes); } catch { invalid(); }
      if (["duration", "seed", "template_id"].includes(name)) {
        if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) invalid();
        fields[name] = Number(value);
      } else if (name === "generate_audio_switch") {
        if (value !== "true" && value !== "false") invalid();
        fields[name] = value === "true";
      } else fields[name] = value;
    }
    cursor = next + separator.length;
  }
  if (!file) invalid();
  try { return { plan: Object.freeze(preparePixVerseImagePlan(fields)), file }; }
  catch { invalid(); }
}

// Portable byte/container syntax only, not pixels, auth, receipts or regions.
// Keep the same file/MIME preconditions as the multipart caller; retain no bytes.
export function qualifyImageContainer(bytes: Uint8Array, type: ImageType): void {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > fileLimit
    || type !== "image/png" && type !== "image/jpeg" && type !== "image/webp") invalid();
  qualifyImage(bytes, type);
}

function qualifyImage(bytes: Uint8Array, type: ImageType): void {
  if (type === "image/png") png(bytes);
  else if (type === "image/jpeg") jpeg(bytes);
  else webp(bytes);
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc(bytes: Uint8Array, start: number, end: number): number {
  let value = 0xffffffff;
  for (let index = start; index < end; index++) value = crcTable[(value ^ bytes[index]) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
function png(bytes: Uint8Array): void {
  if (!at(bytes, Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), 0)) invalid();
  let offset = 8, color = -1, depth = 0, palette = false, idat = false, ended = false, compressed = 0;
  const zlib: number[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const size = uint(bytes, offset, 4), name = fourcc(bytes, offset + 4), end = offset + 12 + size;
    if (size > 0x7fffffff || end > bytes.length || !/^[A-Za-z]{4}$/.test(name)
      || name[2] !== name[2].toUpperCase() || crc(bytes, offset + 4, end - 4) !== uint(bytes, end - 4, 4)) invalid();
    const start = offset + 8;
    if (offset === 8) {
      if (name !== "IHDR" || size !== 13 || !uint(bytes, start, 4) || uint(bytes, start, 4) > 0x7fffffff
        || !uint(bytes, start + 4, 4) || uint(bytes, start + 4, 4) > 0x7fffffff
        || bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || bytes[start + 12] > 1) invalid();
      depth = bytes[start + 8]; color = bytes[start + 9];
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth)) invalid();
    } else if (name === "IHDR" || ["acTL", "fcTL", "fdAT"].includes(name)) invalid();
    else if (name === "PLTE") {
      if (palette || idat || !size || size % 3 || size > 768 || color === 0 || color === 4 || color === 3 && size / 3 > 2 ** depth) invalid();
      palette = true;
    } else if (name === "IDAT") {
      if (ended || color === 3 && !palette) invalid();
      idat = true; compressed += size;
      for (let i = 0; i < size && zlib.length < 2; i++) zlib.push(bytes[start + i]);
    } else if (name === "IEND") {
      if (size || !idat || compressed < 6 || end !== bytes.length || zlib[0] % 16 !== 8
        || zlib[0] >>> 4 > 7 || (zlib[0] * 256 + zlib[1]) % 31 || zlib[1] & 32) invalid();
      return;
    } else {
      if (name[0] === name[0].toUpperCase()) invalid();
      if (idat) ended = true;
    }
    offset = end;
  }
  invalid();
}

function jpeg(bytes: Uint8Array): void {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) invalid();
  let offset = 2, frame = false, scanned = false, entropy = false, tables = false, quant = false;
  const components = new Set<number>();
  while (offset < bytes.length) {
    if (entropy) {
      const start = offset;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 255) continue;
        while (bytes[offset] === 255) offset++;
        if (offset >= bytes.length) invalid();
        const marker = bytes[offset];
        if (marker === 0 || marker >= 208 && marker <= 215) { offset++; continue; }
        offset--; break;
      }
      if (offset === start) invalid();
      entropy = false;
    }
    if (bytes[offset++] !== 255) invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217) { if (!frame || !scanned || offset !== bytes.length) invalid(); return; }
    if (marker === undefined || marker === 0 || marker === 216 || marker === 1 || marker >= 208 && marker <= 215
      || offset + 2 > bytes.length) invalid();
    const length = uint(bytes, offset, 2), end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    if ([192, 193, 194].includes(marker)) {
      if (frame || length < 11 || bytes[offset + 2] !== 8 || !uint(bytes, offset + 3, 2) || !uint(bytes, offset + 5, 2)) invalid();
      const count = bytes[offset + 7];
      if (![1, 3, 4].includes(count) || length !== 8 + count * 3) invalid();
      for (let i = 0; i < count; i++) {
        const at = offset + 8 + i * 3, id = bytes[at], sampling = bytes[at + 1];
        if (components.has(id) || !(sampling & 15) || (sampling & 15) > 4 || !(sampling >>> 4) || sampling >>> 4 > 4 || bytes[at + 2] > 3) invalid();
        components.add(id);
      }
      frame = true;
    } else if (marker === 218) {
      const count = bytes[offset + 2];
      if (!frame || !tables || !quant || count < 1 || count > components.size || length !== 6 + count * 2) invalid();
      const seen = new Set<number>();
      for (let i = 0; i < count; i++) {
        const id = bytes[offset + 3 + i * 2], table = bytes[offset + 4 + i * 2];
        if (!components.has(id) || seen.has(id) || (table & 15) > 3 || table >>> 4 > 3) invalid();
        seen.add(id);
      }
      if (bytes[end - 3] > 63 || bytes[end - 2] > 63 || bytes[end - 3] > bytes[end - 2]
        || (bytes[end - 1] & 15) > 13 || bytes[end - 1] >>> 4 > 13) invalid();
      scanned = true; entropy = true;
    } else if (marker === 219) {
      let cursor = offset + 2;
      while (cursor < end) {
        const table = bytes[cursor++], width = (table >>> 4) + 1;
        if (width > 2 || (table & 15) > 3 || cursor + 64 * width > end) invalid();
        for (let i = 0; i < 64; i++) if (!uint(bytes, cursor + i * width, width)) invalid();
        cursor += 64 * width;
      }
      if (cursor !== end || length === 2) invalid();
      quant = true;
    } else if (marker === 196) {
      let cursor = offset + 2;
      while (cursor < end) {
        if (cursor + 17 > end) invalid();
        const table = bytes[cursor++]; if (table >>> 4 > 1 || (table & 15) > 3) invalid();
        let count = 0, left = 1;
        for (let i = 0; i < 16; i++) { const n = bytes[cursor++]; count += n; left = left * 2 - n; if (left < 0) invalid(); }
        if (!count || count > 256 || cursor + count > end) invalid();
        cursor += count;
      }
      if (cursor !== end || length === 2) invalid();
      tables = true;
    } else if (marker === 221) { if (length !== 4) invalid(); }
    else if (!(marker >= 224 && marker <= 239) && marker !== 254) invalid();
    offset = end;
  }
  invalid();
}

function webp(bytes: Uint8Array): void {
  if (bytes.length < 20 || fourcc(bytes, 0) !== "RIFF" || uint(bytes, 4, 4, true) + 8 !== bytes.length || fourcc(bytes, 8) !== "WEBP") invalid();
  let offset = 12, image = false, extended = false, alpha = false, imageAlpha = false, flags = 0, canvasWidth = 0, canvasHeight = 0;
  const seen = new Set<string>();
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid();
    const name = fourcc(bytes, offset), size = uint(bytes, offset + 4, 4, true), start = offset + 8, end = start + size;
    if (end + (size & 1) > bytes.length || size & 1 && bytes[end] !== 0 || seen.has(name)) invalid();
    seen.add(name);
    if (name === "VP8X") {
      if (offset !== 12 || size !== 10 || bytes[start] & 0xc3 || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) invalid();
      extended = true; flags = bytes[start]; canvasWidth = uint(bytes, start + 4, 3, true) + 1; canvasHeight = uint(bytes, start + 7, 3, true) + 1;
    } else if (name === "VP8 " || name === "VP8L") {
      if (image || !size) invalid();
      let width: number, height: number;
      if (name === "VP8 ") {
        const tag = uint(bytes, start, 3, true);
        if (size < 11 || tag & 1 || (tag >>> 1 & 7) > 3 || !(tag & 16) || tag >>> 5 > size - 10
          || !at(bytes, Uint8Array.of(157, 1, 42), start + 3)) invalid();
        width = uint(bytes, start + 6, 2, true); height = uint(bytes, start + 8, 2, true);
        if (!width || !height || width >>> 14 || height >>> 14) invalid();
      } else {
        if (size < 6 || bytes[start] !== 47 || bytes[start + 4] >>> 5 || alpha) invalid();
        const bits = uint(bytes, start + 1, 4, true);
        width = (bits & 16383) + 1; height = (bits >>> 14 & 16383) + 1;
        imageAlpha = !!(bits & 0x10000000);
      }
      if (extended && (width !== canvasWidth || height !== canvasHeight)) invalid();
      image = true;
    } else if (name === "ALPH") {
      if (!extended || !(flags & 16) || image || !size || bytes[start] & 0xc0 || (bytes[start] & 3) > 1 || (bytes[start] >>> 4 & 3) > 1) invalid();
      alpha = true;
    } else if (["ICCP", "EXIF", "XMP "].includes(name)) {
      const flag = name === "ICCP" ? 32 : name === "EXIF" ? 8 : 4;
      if (!extended || !(flags & flag) || !size || name === "ICCP" && image || name !== "ICCP" && !image) invalid();
    } else invalid();
    offset = end + (size & 1);
  }
  if (!image || offset !== bytes.length || extended && ((flags & 32) !== (seen.has("ICCP") ? 32 : 0)
    || (flags & 8) !== (seen.has("EXIF") ? 8 : 0) || (flags & 4) !== (seen.has("XMP ") ? 4 : 0)
    || !!(flags & 16) !== (alpha || imageAlpha))) invalid();
}

function uint(bytes: Uint8Array, offset: number, count: number, little = false): number {
  if (offset < 0 || offset + count > bytes.length) invalid();
  let value = 0;
  for (let i = 0; i < count; i++) value = value * 256 + bytes[offset + (little ? count - i - 1 : i)];
  return value;
}
function fourcc(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.length) invalid();
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}
function at(raw: Uint8Array, pattern: Uint8Array, offset: number): boolean {
  return offset >= 0 && offset + pattern.length <= raw.length && pattern.every((byte, index) => byte === raw[offset + index]);
}
function find(raw: Uint8Array, pattern: Uint8Array, start: number, end: number): number {
  for (let offset = start; offset + pattern.length <= end; offset++) if (at(raw, pattern, offset)) return offset;
  return -1;
}
// Linear-time boundary scanning, including repeated boundary-like image bytes.
function findBoundary(raw: Uint8Array, pattern: Uint8Array, start: number): number {
  const prefix = new Uint8Array(pattern.length);
  for (let i = 1, matched = 0; i < pattern.length; i++) {
    while (matched && pattern[i] !== pattern[matched]) matched = prefix[matched - 1];
    if (pattern[i] === pattern[matched]) matched++;
    prefix[i] = matched;
  }
  for (let i = start, matched = 0; i < raw.length; i++) {
    while (matched && raw[i] !== pattern[matched]) matched = prefix[matched - 1];
    if (raw[i] === pattern[matched]) matched++;
    if (matched === pattern.length) {
      if (at(raw, crlf, i + 1) || at(raw, close, i + 1)) return i + 1 - pattern.length;
      matched = prefix[matched - 1];
    }
  }
  return -1;
}
function invalid(): never { throw new Error("invalid_pixverse_image_multipart"); }
