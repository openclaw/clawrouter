import { crc32, deflateSync } from "node:zlib";
const limit = 8 * 1024 * 1024;
function chunk(name, payload) {
  const bytes = Buffer.alloc(payload.length + 12);
  bytes.writeUInt32BE(payload.length); bytes.write(name, 4, 4, "ascii"); payload.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function png(width = 301, height = 301, compressed = deflateSync(Buffer.alloc(302 * 301))) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}
const image = png();
function paddedPng(size) {
  return Buffer.concat([image.subarray(0, -12), chunk("ruSt", Buffer.alloc(size - image.length - 12)), image.subarray(-12)]);
}
const uri = (bytes, mime = "image/png") => `data:${mime};base64,${bytes.toString("base64")}`;

// Existing offline 2x2 JPEG/WebP fixtures from pixverse-image-multipart.test.mjs.
// Their frame dimensions are changed below ONLY to exercise structural parsing;
// these mutated files make no pixel-decoding or playable-media claim.
const jpegFixture = Buffer.from("/9j//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAGcAAQEAAAAAAAAAAAAAAAAAAAMHAQEBAQAAAAAAAAAAAAAAAAACBAcQAAICAgIDAQAAAAAAAAAAAAIBAwUGBAARdrQ3BxEAAgICAgEFAQEAAAAAAAAAAwIBBAUGAAcRtXaycyI3NP/AABEIAAIAAgMBEgACEgADEgD/2gAMAwEAAhEDEQA/AKFgFVVz4JiksujpyySUNOckh68RmZlowsiIiBsiJvttvtvj/nfz/EfHqX0IOZD2eYtLsrdqtUj1gA2bPBAALSIIRDyVhUGMaTCIiLEKiLEQsR4iOHtj+p757q2H1Szxrr+ByCxcuYnG27VmIsWbNinXMewYv7IYxSDZyEI8yzu8yzNMzM+eWUf8Vb6BfCOf/9k=", "base64");
const webpFixture = Buffer.from("UklGRmgAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAA/4D//wBWUDggPAAAAPABAJ0BKgIAAgABQCYlkAJ0ugADCPePcAD+68fy0Z8T/GL/+rQ3mHY2QAs0MmFD/FtI6FMh+1MEkZOQAA==", "base64");
const losslessFixture = Buffer.from("UklGRjQAAABXRUJQVlA4TCcAAAAvAUAAEB8w/wKCIv9HExAU+T+agKDouuWCd0KCmrYNWPwmHRH9jwMA", "base64");
function jpeg(width = 480, height = 320) {
  const bytes = Buffer.from(jpegFixture), frame = bytes.indexOf(Buffer.from([255, 192]));
  bytes.writeUInt16BE(height, frame + 5); bytes.writeUInt16BE(width, frame + 7);
  return bytes;
}
function webp(width = 480, height = 320, mode = "extended") {
  if (mode === "lossless") {
    const bytes = Buffer.from(losslessFixture);
    bytes.writeUInt32LE((width - 1) + (height - 1) * 16384 + 0x10000000, 21);
    return bytes;
  }
  const bytes = Buffer.from(webpFixture), frame = bytes.indexOf("VP8 ");
  bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
  bytes.writeUInt16LE(width, frame + 14); bytes.writeUInt16LE(height, frame + 16);
  if (mode === "extended") return bytes;
  const simple = Buffer.concat([bytes.subarray(0, 12), bytes.subarray(frame)]);
  simple.writeUInt32LE(simple.length - 8, 4);
  return simple;
}


export function inlineImage(type = "image/png", size = 8 * 1024 * 1024) {
  if (type === "image/png") return paddedPng(size);
  if (type === "image/jpeg") {
    const original = jpeg(), parts = [original.subarray(0, 2)]; let remaining = size - original.length;
    while (remaining) {
      let bytes = Math.min(65537, remaining);
      if (remaining > bytes && remaining - bytes < 4) bytes -= 4;
      if (bytes < 4) throw Error("fixture JPEG size");
      const segment = Buffer.alloc(bytes); segment[0] = 255; segment[1] = 239; segment.writeUInt16BE(bytes - 2, 2);
      parts.push(segment); remaining -= bytes;
    }
    parts.push(original.subarray(2)); return Buffer.concat(parts);
  }
  const original = webp(), extra = Buffer.alloc(size - original.length);
  extra.write("EXIF"); extra.writeUInt32LE(extra.length - 8, 4); original[20] |= 8;
  const result = Buffer.concat([original, extra]); result.writeUInt32LE(result.length - 8, 4); return result;
}
export { uri };
