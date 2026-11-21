import assert from "node:assert/strict";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import test from "node:test";
import { qualifyMiniMaxFirstFrame as qualify } from "../minimax-video-first-frame.ts";

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
const deny = value => assert.throws(() => qualify(value), { message: "invalid_minimax_first_frame" });

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

test("complete offline PNG returns explicit metadata and one exact-sized owned allocation", () => {
  const input = uri(image), output = qualify(input);
  assert.deepEqual(Object.keys(output).sort(), ["bytes", "height", "mimeType", "width"]);
  assert.equal(output.mimeType, "image/png"); assert.equal(output.width, 301); assert.equal(output.height, 301);
  assert.equal(output.bytes.constructor, Uint8Array);
  assert.equal(output.bytes.byteOffset, 0); assert.equal(output.bytes.buffer.byteLength, image.length);
  assert.deepEqual(Buffer.from(output.bytes), image);
  // The default generated PNG's grayscale raster is complete and decoder-checked.
  const compressedLength = image.readUInt32BE(33);
  assert.equal(inflateSync(image.subarray(41, 41 + compressedLength)).length, 302 * 301);
  const again = qualify(input);
  assert.notEqual(output.bytes.buffer, again.bytes.buffer);
  output.bytes.fill(0); assert.deepEqual(Buffer.from(again.bytes), image); assert.equal(input, uri(image));
  const moved = structuredClone(again.bytes, { transfer: [again.bytes.buffer] });
  assert.equal(again.bytes.byteLength, 0); assert.deepEqual(Buffer.from(moved), image);
});

test("JPEG and all three static WebP containers report exact coded dimensions", () => {
  for (const [bytes, type] of [[jpeg(), "image/jpeg"], [webp(), "image/webp"],
    [webp(480, 320, "simple"), "image/webp"], [webp(480, 320, "lossless"), "image/webp"]]) {
    const output = qualify(uri(bytes, type));
    assert.equal(output.width, 480); assert.equal(output.height, 320); assert.equal(output.mimeType, type);
    assert.deepEqual(Buffer.from(output.bytes), bytes); assert.equal(output.bytes.buffer.byteLength, bytes.length);
  }
});

test("all MIME branches enforce short-edge and inclusive aspect boundaries", () => {
  for (const [make, type] of [[png, "image/png"], [jpeg, "image/jpeg"], [webp, "image/webp"]]) {
    for (const [width, height] of [[301, 301], [302, 755], [755, 302]]) {
      const output = qualify(uri(make(width, height), type));
      assert.equal(output.width, width); assert.equal(output.height, height);
    }
    for (const [width, height] of [[300, 301], [301, 300], [302, 756], [756, 302]]) deny(uri(make(width, height), type));
  }
});

test("structural dimensions do not invent a vendor pixel maximum or decompress pixels", () => {
  const output = qualify(uri(png(0x7fffffff, 0x7fffffff)));
  assert.equal(output.width, 0x7fffffff); assert.equal(output.height, 0x7fffffff);
  // Header-only dimension change: deliberately not a matching pixel raster.
  deny(uri(png(0x80000000, 301))); // PNG container's own unsigned-31-bit dimension rule.
});

test("exact 8 MiB decoded boundary is preserved and over-limit is rejected before decoding", () => {
  const bytes = paddedPng(limit), output = qualify(uri(bytes));
  assert.equal(output.bytes.byteLength, limit); assert.equal(output.bytes.buffer.byteLength, limit);
  assert.deepEqual(Buffer.from(output.bytes), bytes);
  deny(uri(paddedPng(limit + 1)));
  deny("data:image/png;base64," + "A".repeat(Math.ceil(limit / 3) * 4 + 4));
});

test("standard base64 supports each padding count without atob or btoa", () => {
  const saved = [globalThis.atob, globalThis.btoa];
  globalThis.atob = globalThis.btoa = () => { throw new Error("whole-string base64 forbidden"); };
  try {
    for (let remainder = 0; remainder < 3; remainder++) {
      const bytes = paddedPng(1023 + remainder), input = uri(bytes), output = qualify(input);
      assert.deepEqual(Buffer.from(output.bytes), bytes);
    }
  } finally { [globalThis.atob, globalThis.btoa] = saved; }
});

test("nonzero unused bits are denied even when decoded bytes would match", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (const size of [1024, 1025]) {
    const input = uri(paddedPng(size)), padding = input.endsWith("==") ? 2 : 1;
    const at = input.length - padding - 1, digit = alphabet.indexOf(input[at]);
    assert.ok(digit >= 0);
    const malformed = input.slice(0, at) + alphabet[digit + 1] + input.slice(at + 1);
    assert.deepEqual(Buffer.from(malformed.split(",")[1], "base64"), paddedPng(size));
    deny(malformed);
  }
});

test("noncanonical MIME, padding, alphabet, whitespace and extra URI fields fail closed", () => {
  const input = uri(image);
  for (const value of [null, undefined, {}, Buffer.from(input), "", "https://example.com/image.png",
    "data:;base64,AAAA", input.replace("image/png", "IMAGE/PNG"), input.replace("image/png", "image/jpg"),
    input.replace("image/png", "image/svg+xml"), input.replace(";base64", ";charset=utf-8;base64"),
    input.replace(";base64", ";BASE64"), " " + input, input + "\n", input + "=", input + "#fragment",
    input.slice(0, -1), "data:image/png;base64,====", "data:image/png;base64,A===",
    "data:image/png;base64,AA=A", "data:image/png;base64,", "data:image/png;base64,AA-_",
    input.replace(",", ",\u0000"), input.replace(",", ",é"), input.replace(",", ",%41")]) deny(value);
});

test("valid bytes cannot be relabelled as another image MIME", () => {
  for (const [bytes, actual] of [[image, "image/png"], [jpeg(), "image/jpeg"], [webp(), "image/webp"]]) {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) if (type !== actual) deny(uri(bytes, type));
  }
});

test("truncated, trailing, corrupt and signature-only containers are rejected", () => {
  for (const [bytes, type] of [[image, "image/png"], [jpeg(), "image/jpeg"], [webp(), "image/webp"],
    [webp(480, 320, "lossless"), "image/webp"]]) {
    for (const cut of [1, 8, bytes.length - 1]) deny(uri(bytes.subarray(0, cut), type));
    deny(uri(Buffer.concat([bytes, Buffer.of(0)]), type));
    const corrupt = Buffer.from(bytes); corrupt[0] ^= 1; deny(uri(corrupt, type));
  }
  const badCrc = Buffer.from(image); badCrc[29] ^= 1; deny(uri(badCrc));
  const missingData = Buffer.concat([image.subarray(0, 33), chunk("IEND", Buffer.alloc(0))]); deny(uri(missingData));
  deny(uri(Buffer.from([255, 216, 255, 217]), "image/jpeg"));
});

test("WebP canvas disagreement, chunk-size ambiguity and animation flags are rejected", () => {
  const mismatch = webp(); mismatch[24] ^= 1; deny(uri(mismatch, "image/webp"));
  const size = webp(); size.writeUInt32LE(size.length - 9, 4); deny(uri(size, "image/webp"));
  const animated = webp(); animated[20] |= 2; deny(uri(animated, "image/webp"));
  const badChunk = webp(); badChunk.writeUInt32LE(0xffffffff, 16); deny(uri(badChunk, "image/webp"));
});

test("PNG animation and JPEG missing frame or premature end cannot establish dimensions", () => {
  const animation = Buffer.concat([image.subarray(0, 33), chunk("acTL", Buffer.alloc(8)), image.subarray(33)]);
  deny(uri(animation));
  const missingFrame = jpeg(), frame = missingFrame.indexOf(Buffer.from([255, 192]));
  missingFrame[frame + 1] = 254; deny(uri(missingFrame, "image/jpeg"));
  const prematureEnd = Buffer.concat([jpeg().subarray(0, frame), Buffer.from([255, 217])]);
  deny(uri(prematureEnd, "image/jpeg"));
});

test("sanitized errors do not retain or echo caller input or another provider's error", () => {
  for (const input of ["data:image/png;base64,PRIVATE_INPUT", uri(Buffer.from("private image bytes"))]) {
    assert.throws(() => qualify(input), error => {
      assert.equal(error.message, "invalid_minimax_first_frame"); assert.equal(error.cause, undefined);
      assert.ok(!error.stack.includes(input)); assert.ok(!error.message.includes("pixverse")); return true;
    });
  }
});
