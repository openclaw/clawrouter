// Claude bills an image as ceil(width / 28) * ceil(height / 28) visual tokens.
// It only downsizes before patching, and the API rejects any side above 8000 px,
// so the encoded header dimensions bound billed image input on every model tier.
// https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size
const PATCH_PX = 28;
const MAX_EDGE_PX = 8_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SOURCE_KEYS = new Set(["type", "media_type", "data"]);
// Documented image block keys; none of them can enlarge the billed image.
const BLOCK_KEYS = new Set(["type", "source", "cache_control", "transformations"]);
const OVERSIZED_IMAGE = new Set(["downsize", "error"]);

export interface InlineImageBound { encodedBytes: number; tokens: number }

// A content block Claude bills as an image. The caller decides position: only a
// direct block of user content or of a user tool_result's content qualifies.
export function claudeImageBlockBound(block: Record<string, unknown>): InlineImageBound | null {
  if (block.type !== "image" || Object.keys(block).some(key => !BLOCK_KEYS.has(key))) return null;
  const { transformations } = block;
  if (transformations !== undefined) {
    if (!transformations || typeof transformations !== "object" || Array.isArray(transformations)) return null;
    const entries = Object.entries(transformations);
    if (entries.some(([key, value]) => key !== "oversized_image" || typeof value !== "string" || !OVERSIZED_IMAGE.has(value))) return null;
  }
  return claudeImageBound(block.source);
}

// Null means no qualified ceiling: URL/file sources, malformed or unrecognized
// data, a header that disagrees with media_type, or out-of-range dimensions.
export function claudeImageBound(source: unknown): InlineImageBound | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const { type, media_type: mediaType, data } = source as Record<string, unknown>;
  if (type !== "base64" || typeof mediaType !== "string" || typeof data !== "string" || Object.keys(source).some(key => !SOURCE_KEYS.has(key))) return null;
  if (!data.length || data.length % 4 !== 0 || !BASE64.test(data)) return null;
  const size = imageSize(base64Reader(data), mediaType);
  if (!size) return null;
  const [width, height] = size;
  if (width < 1 || height < 1 || width > MAX_EDGE_PX || height > MAX_EDGE_PX) return null;
  return { encodedBytes: data.length, tokens: Math.ceil(width / PATCH_PX) * Math.ceil(height / PATCH_PX) };
}

type ByteAt = (offset: number) => number;

// Decode only the addressed bytes; headers are tiny but a JPEG can place its
// frame header after large metadata segments. Out-of-range reads return -1.
function base64Reader(data: string): ByteAt {
  const length = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  return (offset) => {
    if (offset < 0 || offset >= length) return -1;
    const group = Math.floor(offset / 3) * 4;
    let bits = 0;
    for (let index = 0; index < 4; index++) bits = bits << 6 | sextet(data.charCodeAt(group + index));
    return bits >> (16 - offset % 3 * 8) & 0xff;
  };
}

function sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : code === 47 ? 63 : 0; // "=" padding contributes zero bits
}

function imageSize(at: ByteAt, mediaType: string): [number, number] | null {
  if (mediaType === "image/png") return pngSize(at);
  if (mediaType === "image/jpeg") return jpegSize(at);
  if (mediaType === "image/gif") return gifSize(at);
  if (mediaType === "image/webp") return webpSize(at);
  return null;
}

// Exactly one 13-byte IHDR, then chunks up to the first IDAT. Decoders differ on
// a repeated IHDR (some keep the last), so any second one has no bound.
function pngSize(at: ByteAt): [number, number] | null {
  if (!matches(at, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || uint(at, 8, 4, false) !== 13 || !matches(at, 12, ascii("IHDR"))) return null;
  const size = pair(uint(at, 16, 4, false), uint(at, 20, 4, false));
  for (let offset = 33; size;) {
    const length = uint(at, offset, 4, false);
    if (length == null || length > 0x7fffffff) return null;
    if (matches(at, offset + 4, ascii("IDAT"))) return size;
    if (matches(at, offset + 4, ascii("IHDR")) || matches(at, offset + 4, ascii("IEND"))) return null;
    offset += 12 + length;
  }
  return null;
}

// Segments that may precede the frame or scan and carry a length: DHT, DAC, DQT,
// DRI and COM, plus APP0-APP15 below. Frame headers are SOF0-SOF15 without these.
const JPEG_TABLES = new Set([0xc4, 0xcc, 0xdb, 0xdd, 0xfe]);
const isJpegFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

// Walk marker segments to the start of scan and require exactly one frame header.
// Real decoders skip FF00 stuffing and stray bytes while hunting for a marker, so
// any marker this walk cannot classify (0x00, reserved 0x02-0xBF, RSTn/TEM, a
// second SOI, EOI, DNL/DHP/EXP, JPGn) or any stray byte has no header bound.
// Embedded EXIF thumbnails stay inside skipped APPn segments.
function jpegSize(at: ByteAt): [number, number] | null {
  if (at(0) !== 0xff || at(1) !== 0xd8) return null;
  let offset = 2, size: [number, number] | null = null;
  while (true) {
    if (at(offset) !== 0xff) return null;
    while (at(offset + 1) === 0xff) offset++;
    const marker = at(offset + 1), length = uint(at, offset + 2, 2, false);
    if (length == null || length < 2) return null;
    if (marker === 0xda) return size;
    if (isJpegFrame(marker)) {
      const components = at(offset + 9);
      if (size || components < 1 || length !== 8 + 3 * components) return null;
      // A zero height is defined later by DNL; claudeImageBound rejects it.
      size = pair(uint(at, offset + 7, 2, false), uint(at, offset + 5, 2, false));
      if (!size) return null;
    } else if (!JPEG_TABLES.has(marker) && !(marker >= 0xe0 && marker <= 0xef)) return null;
    offset += 2 + length;
  }
}

// A first frame may extend past the logical screen; bound both.
function gifSize(at: ByteAt): [number, number] | null {
  if (!matches(at, 0, ascii("GIF87a")) && !matches(at, 0, ascii("GIF89a"))) return null;
  const width = uint(at, 6, 2, true), height = uint(at, 8, 2, true), packed = at(10);
  if (width == null || height == null || packed < 0) return null;
  let offset = 13 + (packed & 0x80 ? 3 << ((packed & 7) + 1) : 0);
  while (true) {
    const introducer = at(offset);
    if (introducer === 0x2c) {
      const [left, top, frameWidth, frameHeight] = [1, 3, 5, 7].map(delta => uint(at, offset + delta, 2, true));
      if (left == null || top == null || frameWidth == null || frameHeight == null) return null;
      return [Math.max(width, left + frameWidth), Math.max(height, top + frameHeight)];
    }
    if (introducer !== 0x21) return null;
    offset += 2;
    for (let size = at(offset); size !== 0; size = at(offset)) {
      if (size < 0) return null;
      offset += size + 1;
    }
    offset++;
  }
}

function webpSize(at: ByteAt): [number, number] | null {
  if (!matches(at, 0, ascii("RIFF")) || !matches(at, 8, ascii("WEBP"))) return null;
  if (matches(at, 12, ascii("VP8 "))) {
    if (!matches(at, 23, [0x9d, 0x01, 0x2a])) return null;
    const width = uint(at, 26, 2, true), height = uint(at, 28, 2, true);
    // Nonzero scale bits request decoder upscaling; do not bound that case.
    if (width == null || height == null || width >> 14 || height >> 14) return null;
    return [width, height];
  }
  if (matches(at, 12, ascii("VP8L"))) {
    const bits = at(20) === 0x2f ? uint(at, 21, 4, true) : null;
    return bits == null ? null : [(bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1];
  }
  if (matches(at, 12, ascii("VP8X"))) {
    const width = uint(at, 24, 3, true), height = uint(at, 27, 3, true);
    return width == null || height == null ? null : [width + 1, height + 1];
  }
  return null;
}

function uint(at: ByteAt, offset: number, size: number, little: boolean): number | null {
  let value = 0;
  for (let index = 0; index < size; index++) {
    const byte = at(offset + (little ? size - 1 - index : index));
    if (byte < 0) return null;
    value = value * 256 + byte;
  }
  return value;
}

function matches(at: ByteAt, offset: number, expected: number[]): boolean { return expected.every((byte, index) => at(offset + index) === byte); }
function pair(width: number | null, height: number | null): [number, number] | null { return width == null || height == null ? null : [width, height]; }
function ascii(value: string): number[] { return [...value].map(character => character.charCodeAt(0)); }
