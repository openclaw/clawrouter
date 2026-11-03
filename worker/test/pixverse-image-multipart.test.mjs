import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import test from "node:test";
import { parsePixVerseImageMultipart as parse } from "../pixverse-image-multipart.ts";

// Generated offline from a 2x2 RGBA test pattern with ffmpeg (PNG/JPEG) and
// ImageMagick (WebP). Each complete file decoded to 16 RGBA bytes with ffmpeg.
// No provider call or runtime pixel-decoding claim.
const fixtures = {
  "png": {
    "base64": "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAGUlEQVR4nGP8z8Dwn/E/QyMLI8N/IGSsBwA6swYEbMHgjAAAAABJRU5ErkJggg==",
    "bytes": 103,
    "sha256": "1069874ff9f2bcbe23c8a8c762e20670861ad6a291e205bdd2f3afeb4022f305",
    "decodedRgbaBytes": 16
  },
  "jpeg": {
    "base64": "/9j//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAGcAAQEAAAAAAAAAAAAAAAAAAAMHAQEBAQAAAAAAAAAAAAAAAAACBAcQAAICAgIDAQAAAAAAAAAAAAIBAwUGBAARdrQ3BxEAAgICAgEFAQEAAAAAAAAAAwIBBAUGAAcRtXaycyI3NP/AABEIAAIAAgMBEgACEgADEgD/2gAMAwEAAhEDEQA/AKFgFVVz4JiksujpyySUNOckh68RmZlowsiIiBsiJvttvtvj/nfz/EfHqX0IOZD2eYtLsrdqtUj1gA2bPBAALSIIRDyVhUGMaTCIiLEKiLEQsR4iOHtj+p757q2H1Szxrr+ByCxcuYnG27VmIsWbNinXMewYv7IYxSDZyEI8yzu8yzNMzM+eWUf8Vb6BfCOf/9k=",
    "bytes": 371,
    "sha256": "8c67476170e955d14dd2973542b689e04e2d4f9d33e39476da43ff5900239b0c",
    "decodedRgbaBytes": 16
  },
  "webp": {
    "base64": "UklGRmgAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAA/4D//wBWUDggPAAAAPABAJ0BKgIAAgABQCYlkAJ0ugADCPePcAD+68fy0Z8T/GL/+rQ3mHY2QAs0MmFD/FtI6FMh+1MEkZOQAA==",
    "bytes": 112,
    "sha256": "aa685e59d4f66bb7b3fdee70d31aa4a2367656dc7c41110de66cc4845851faba",
    "decodedRgbaBytes": 16
  },
  "webpLossless": {
    "base64": "UklGRjQAAABXRUJQVlA4TCcAAAAvAUAAEB8w/wKCIv9HExAU+T+agKDouuWCd0KCmrYNWPwmHRH9jwMA",
    "bytes": 60,
    "sha256": "2ed91dd0b66862a74bdeefd421aded17f22f16859bec3de590c6d6783ec4029a",
    "decodedRgbaBytes": 16
  }
};
const images = Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, Buffer.from(fixture.base64, "base64")]));
const boundary = "pixverse-test-boundary";
const contentType = "multipart/form-data; boundary=" + boundary;
const defaults = { model: "v6", prompt: "A lighthouse", duration: "5", quality: "720p" };
function field(name, value, extra = "") {
  return { headers: 'Content-Disposition: form-data; name="' + name + '"' + extra, bytes: Buffer.isBuffer(value) ? value : Buffer.from(value) };
}
function image(bytes = images.png, type = "image/png", filename = "fixture.png") {
  return { headers: 'Content-Disposition: form-data; name="image"; filename="' + filename + '"\r\nContent-Type: ' + type, bytes };
}
function body(parts = [...Object.entries(defaults).map(([key, value]) => field(key, value)), image()], name = boundary, suffix = "\r\n") {
  return Buffer.concat([...parts.flatMap(part => [Buffer.from("--" + name + "\r\n" + part.headers + "\r\n\r\n"), part.bytes, Buffer.from("\r\n")]),
    Buffer.from("--" + name + "--" + suffix)]);
}
function request(overrides = {}, file = image()) {
  return body([...Object.entries({ ...defaults, ...overrides }).map(([key, value]) => field(key, value)), file]);
}
function denied(raw, type = contentType) {
  assert.throws(() => parse(raw, type), { message: "invalid_pixverse_image_multipart" });
}
function pngChunk(name, bytes) {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); result.write(name, 4, 4, "ascii"); bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}
function insertPng(bytes) { return Buffer.concat([images.png.subarray(0, -12), bytes, images.png.subarray(-12)]); }
function changePngHeader(mutator) {
  const header = Buffer.from(images.png.subarray(16, 29)); mutator(header);
  return Buffer.concat([images.png.subarray(0, 8), pngChunk("IHDR", header), images.png.subarray(33)]);
}
function copyChange(bytes, offset, value) { const result = Buffer.from(bytes); result[offset] = value; return result; }

test("qualified offline fixtures retain exact bytes as views into a nonzero-offset envelope", () => {
  for (const [name, bytes] of Object.entries(images)) {
    assert.equal(bytes.length, fixtures[name].bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixtures[name].sha256);
    const type = name.startsWith("webp") ? "image/webp" : "image/" + name;
    const encoded = request({}, image(bytes, type));
    const carrier = Buffer.concat([Buffer.alloc(17, 3), encoded, Buffer.alloc(19, 4)]);
    const raw = new Uint8Array(carrier.buffer, carrier.byteOffset + 17, encoded.length);
    const before = createHash("sha256").update(carrier).digest("hex");
    const result = parse(raw, contentType);
    assert.deepEqual(result.plan, { model: "v6", prompt: "A lighthouse", duration: 5, quality: "720p" });
    assert.equal(Object.isFrozen(result.plan), true);
    assert.deepEqual(Object.keys(result), ["plan", "file"]);
    assert.deepEqual(Object.keys(result.file), ["bytes", "type"]);
    assert.equal(result.file.type, type);
    assert.equal(result.file.bytes.buffer, raw.buffer);
    assert.equal(result.file.bytes.byteOffset, raw.byteOffset + encoded.indexOf(bytes));
    assert.deepEqual(Buffer.from(result.file.bytes), bytes);
    assert.equal(createHash("sha256").update(carrier).digest("hex"), before);
  }
});

test("all ten native scalar fields normalize once without an upload ID or authority", () => {
  const values = { ...defaults, model: "c1", prompt: "光の塔", seed: "0", negative_prompt: "",
    camera_movement: "zoom_in", template_id: "9007199254740991", generate_audio_switch: "false", motion_mode: "normal" };
  const result = parse(body([image(), ...Object.entries(values).map(([key, value]) => field(key, value))]), contentType);
  assert.deepEqual(result.plan, { ...values, duration: 5, seed: 0, template_id: Number.MAX_SAFE_INTEGER, generate_audio_switch: false });
  assert.equal(Object.hasOwn(result.plan, "img_id"), false);
  assert.equal(parse(request({ generate_audio_switch: "true" }), contentType).plan.generate_audio_switch, true);
});

test("file limit is inclusive with a well-formed ancillary PNG chunk; envelope and overflow fail closed", () => {
  const padding = pngChunk("ruSt", Buffer.alloc(8 * 1024 * 1024 - images.png.length - 12));
  const large = insertPng(padding);
  assert.equal(large.length, 8 * 1024 * 1024);
  const raw = request({}, image(large));
  assert.equal(parse(raw, contentType).file.bytes.length, large.length);
  denied(request({}, image(insertPng(pngChunk("ruSt", Buffer.alloc(padding.length - 11))))));
  denied(Buffer.alloc(8 * 1024 * 1024 + 32 * 1024 + 1));
});

test("the 2 KiB header cap applies independently to every part", () => {
  const base = field("prompt", "A lighthouse");
  const padded = { ...base, headers: base.headers.replace(": ", ":" + " ".repeat(2048 - base.headers.length + 1)) };
  assert.equal(Buffer.byteLength(padded.headers), 2048);
  const parts = [field("model", "v6"), padded, field("duration", "5"), field("quality", "720p"), image()];
  assert.equal(parse(body(parts), contentType).plan.prompt, "A lighthouse");
  denied(body(parts.map(part => part === padded ? { ...part, headers: part.headers + " " } : part)));
  denied(body([{ ...image(), headers: "X".repeat(2049) }]));
});

test("boundary grammar and the 70-byte limit are strict", () => {
  const parts = [...Object.entries(defaults).map(([key, value]) => field(key, value)), image()];
  const name = "a".repeat(70);
  assert.equal(parse(body(parts, name, ""), 'multipart/form-data; boundary="' + name + '"').file.type, "image/png");
  for (const type of ["multipart/form-data", contentType + "; charset=utf-8", contentType + "; boundary=other",
    'multipart/form-data; boundary="bad "', "multipart/form-data; boundary=☃", "multipart/form-data; boundary=" + "a".repeat(71),
    "multipart/form-data; boundary=a\r\nb", "text/plain; boundary=" + boundary]) denied(body(), type);
});

test("closing delimiter, EOF and CRLF framing are required", () => {
  const raw = body();
  for (const broken of [raw.subarray(0, -5), Buffer.concat([raw, Buffer.from("epilogue")]),
    Buffer.concat([Buffer.from("preamble\r\n"), raw]), Buffer.from("--" + boundary + "\r\nContent-Disposition: x"),
    Buffer.from(raw.toString("latin1").replaceAll("\r\n", "\n"), "latin1"), Buffer.from("--" + boundary + "--\r\n")]) denied(broken);
});

test("boundary-like bytes within an image do not truncate the file", () => {
  const png = insertPng(pngChunk("ruSt", Buffer.from("\r\n--" + boundary + "X\r\n--" + boundary.slice(0, -1))));
  assert.deepEqual(Buffer.from(parse(request({}, image(png)), contentType).file.bytes), png);
  const delimited = insertPng(pngChunk("ruSt", Buffer.from("\r\n--" + boundary + "\r\n")));
  denied(request({}, image(delimited)));
});

test("duplicates, unknown fields and excess parts cannot mint input authority", () => {
  const parts = [...Object.entries(defaults).map(([key, value]) => field(key, value)), image()];
  for (const extra of [image(), field("prompt", "again"), field("image_url", "https://images.example/test.png"),
    field("img_id", "123"), field("input_id", "123"), field("upstreamRetention", "true"),
    field("headers", "{}"), field("__proto__", "{}"), field("aspect_ratio", "1:1")]) denied(body([...parts, extra]));
  denied(body([...parts, ...Array.from({ length: 7 }, () => field("seed", "0"))]));
  denied(body(parts.filter(part => part !== parts.at(-1))));
});

test("ambiguous disposition, duplicate headers and unsupported encodings are denied", () => {
  for (const headers of [
    image().headers + "\r\ncontent-type: image/png",
    image().headers + "\r\nContent-Transfer-Encoding: base64",
    image().headers + "\r\nX-Test: value",
    image().headers.replace('name="image"', 'name="image"; name="prompt"'),
    image().headers.replace('filename="fixture.png"', "filename*=UTF-8''fixture.png"),
    image().headers.replace('filename="fixture.png"', 'filename="../fixture.png"'),
    image().headers.replace('; filename="fixture.png"', ""),
    image().headers.replace("\r\nContent-Type:", "\r\n Content-Type:"),
    image().headers.replace("form-data", "attachment"),
  ]) denied(request({}, { ...image(), headers }));
  denied(body([field("model", "v6", '; filename="model.txt"'), field("prompt", "ok"), field("duration", "5"), field("quality", "720p"), image()]));
  denied(body([field("model", "v6", "\r\nContent-Type: text/plain"), field("prompt", "ok"), field("duration", "5"), field("quality", "720p"), image()]));
});

test("UTF-8 is fatal and scalar byte limits apply before native normalization", () => {
  for (const bytes of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf0, 0x9f]), Buffer.from([0xff])]) denied(request({ prompt: bytes }));
  assert.equal(parse(request({ prompt: "é".repeat(1024) }), contentType).plan.prompt.length, 1024);
  denied(request({ prompt: "é".repeat(1025) }));
  denied(request({ model: "\ufeffv6" }));
  assert.equal(parse(request({ prompt: "\ufefftext" }), contentType).plan.prompt, "\ufefftext");
});

test("ambiguous numbers, booleans and unsupported native options are rejected", () => {
  for (const value of ["05", "+5", "-0", "5.0", "5e0", " 5", "5 ", "", "0x5", "NaN", "Infinity"]) denied(request({ duration: value }));
  for (const values of [{ duration: "0" }, { duration: "16" }, { seed: "2147483648" }, { seed: "-1" },
    { template_id: "9007199254740992" }, { model: "v5" }, { quality: "4k" }, { prompt: "  " },
    { motion_mode: "" }, { camera_movement: "" }, { generate_audio_switch: "1" }, { generate_audio_switch: "TRUE" }]) denied(request(values));
  assert.equal(parse(request({ duration: "15", seed: "2147483647" }), contentType).plan.seed, 2147483647);
});

test("MIME must match qualified bytes, with no URL, SVG or empty-image fallback", () => {
  for (const [bytes, type] of [[images.png, "image/jpeg"], [images.jpeg, "image/webp"], [images.webp, "image/png"],
    [images.png, "image/png; charset=utf-8"], [images.png, "application/octet-stream"],
    [Buffer.from("<svg/>"), "image/svg+xml"], [Buffer.from("https://images.example/test.png"), "image/png"],
    [Buffer.alloc(0), "image/png"]]) denied(request({}, image(bytes, type)));
});

test("PNG requires checksummed chunks, valid IHDR and a final IEND", () => {
  for (const bytes of [copyChange(images.png, 20, 99), images.png.subarray(0, -1), Buffer.concat([images.png, Buffer.of(0)]),
    changePngHeader(header => header.writeUInt32BE(0, 0)), changePngHeader(header => { header[8] = 3; }),
    insertPng(pngChunk("IHDR", images.png.subarray(16, 29))), insertPng(pngChunk("ABCD", Buffer.alloc(0))),
    insertPng(pngChunk("acTL", Buffer.alloc(8))), insertPng(Buffer.alloc(11))]) denied(request({}, image(bytes)));
});

test("JPEG requires frame/tables/scan framing and exact EOI, not a magic-only prefix", () => {
  const sos = images.jpeg.indexOf(Buffer.from([255, 218]));
  const sof = images.jpeg.indexOf(Buffer.from([255, 192]));
  const dht = images.jpeg.indexOf(Buffer.from([255, 196]));
  for (const bytes of [images.jpeg.subarray(0, -1), Buffer.concat([images.jpeg, Buffer.of(0)]), Buffer.from([255, 216, 255, 217]),
    copyChange(images.jpeg, sof + 4, 16), copyChange(images.jpeg, sos + 3, 1),
    copyChange(images.jpeg, dht + 1, 254), Buffer.concat([images.jpeg.subarray(0, sos), Buffer.from([255, 216, 255, 217])])]) {
    denied(request({}, image(bytes, "image/jpeg")));
  }
});

test("WebP requires exact RIFF/chunk sizes, supported still-image flags and matching canvas", () => {
  const vp8 = images.webp.indexOf(Buffer.from("VP8 "));
  for (const bytes of [images.webp.subarray(0, -1), Buffer.concat([images.webp, Buffer.of(0)]),
    copyChange(images.webp, 4, 0), copyChange(images.webp, 20, 18),
    copyChange(images.webp, 24, 2), copyChange(images.webp, vp8 + 11, 0),
    copyChange(images.webpLossless, 20, 0), copyChange(images.webpLossless, 24, 0xe0)]) denied(request({}, image(bytes, "image/webp")));
});

test("errors stay generic and never include uploaded text, paths or image content", () => {
  const secret = "private-request-content";
  assert.throws(() => parse(request({ [secret]: secret }), contentType), error =>
    error.message === "invalid_pixverse_image_multipart" && !error.message.includes(secret));
});
