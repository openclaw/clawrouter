import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { crc32 } from "node:zlib";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareNativeGoogleImage } = await import("../native-google-images.ts");
const { observeGoogleImage } = await import("../google-images.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/images.json", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"))]).providers[0];
// Candidate endpoint/model selection for the leaf contract. Shared dispatch and
// catalog activation have separate source owners and need actual Worker proof.
const endpoint = { ...provider.endpoints.find(value => value.id === "generate_content"), modelPassthrough: undefined,
  request_format: "google.image_generate", response_format: "google.image" };
const jsonLimit = 8 * 1024 * 1024, outputLimit = 4 * 1024 * 1024;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=";
// Offline 2x2 blue images, encoded by ffmpeg (JPEG) and ImageMagick (PNG/WebP); no provider output or credentials.
const jpeg = "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAHAQEBAAAAAAAAAAAAAAAAAAAFBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AI4Av4p//9k=", webp = "UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoCAAIAAgA0JaACdLoAA5gA/vmTb/+QH/+QH/+QH/8gP+IXeyAwAA==";
const selection = (upstream = wire.request.model, body = structuredClone(wire.request.body)) => ({ provider, endpoint,
  model: { id: "google/" + upstream, upstream, capabilities: ["image.generate"] }, capability: "image.generate", body, pathParams: { model: upstream }, method: "POST" });
const native = () => prepareNativeGoogleImage(selection());
const payload = (mimeType = "image/png", data = png) => ({ ...structuredClone(wire.response),
  candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ inlineData: { mimeType, data } }] } }] });
const response = (body = payload(), headers = {}, status = 200) => Response.json(body, { status, headers });
async function read(upstream, signal = new AbortController().signal) {
  const prepared = native(), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("Google image wrapper binds both frozen models to the exact unary origin and native JSON", () => {
  for (const model of ["gemini-3.1-flash-image", "gemini-3-pro-image"]) {
    const selected = selection(model), before = structuredClone(selected), prepared = prepareNativeGoogleImage(selected);
    assert.deepEqual(selected, before); assert.equal(prepared.origin, "https://generativelanguage.googleapis.com");
    assert.equal(prepared.path, `/v1beta/models/${model}:generateContent`);
    assert.equal(prepared.query, undefined); assert.equal(prepared.tariff, undefined); assert.equal(prepared.body, undefined);
    assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
    for (const url of [prepared.origin + prepared.path + "?alt=sse", prepared.origin + prepared.path + "?key=synthetic",
      "https://other.example" + prepared.path, prepared.origin + "/v1beta/models/other:generateContent"])
      assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  }
  assert.equal(prepareNativeGoogleImage({ ...selection(), endpoint: { ...endpoint, request_format: "google.generate_content" } }), undefined);
});

test("Google image leaf rejects mismatched selectors, aliases, generic routes, queries and tariffs", () => {
  for (const model of ["gemini-3-pro-image-preview", "gemini-nano-banana-2.1", "google/gemini-3-pro-image"])
    assert.throws(() => prepareNativeGoogleImage(selection(model)));
  for (const change of [{ provider: { ...provider, id: "google" } }, { model: null }, { method: "GET" }, { capability: "llm.generate" },
    { pathParams: { model: "gemini-3-pro-image" } }, { pathParams: { ...selection().pathParams, key: "synthetic" } }, { nativeQuery: {} }])
    assert.throws(() => prepareNativeGoogleImage({ ...selection(), ...change }));
  for (const change of [{ method: "GET" }, { path: "/v1beta/models/${model}:streamGenerateContent" }, { upstreamPath: endpoint.path },
    { path_params: [] }, { path_params: ["model", "extra"] }, { response_format: "google.generate_content" }, { query: { alt: "sse" } },
    { modelPassthrough: {} }, { streaming: true }, { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { requestPricing: {} }])
    assert.throws(() => prepareNativeGoogleImage({ ...selection(), endpoint: { ...endpoint, ...change } }));
});

test("Google image inputs require explicit matching canonical inline images without asset authority", () => {
  const body = data => ({ ...structuredClone(wire.request.body), contents: [{ role: "user", parts: [{ text: "Edit synthetic image." }, data] }] });
  for (const [mimeType, data] of [["image/png", png], ["image/jpeg", jpeg], ["image/webp", webp]]) {
    const selected = selection(undefined, body({ inlineData: { mimeType, data } })), before = structuredClone(selected.body);
    assert.ok(prepareNativeGoogleImage(selected)); assert.deepEqual(selected.body, before);
  }
  for (const part of [{ inlineData: { data: png } }, { inlineData: { mimeType: ["image/png"], data: png } },
    { inlineData: { mimeType: "image/jpeg", data: png } }, { inlineData: { mimeType: "image/heic", data: png } },
    { inlineData: { mimeType: "image/png", data: png.replace(/=+$/, "") } },
    { fileData: { fileUri: "https://assets.example/private" } }, { fileData: { fileUri: "files/synthetic" } }])
    assert.throws(() => prepareNativeGoogleImage(selection(undefined, body(part))));
  for (const imageConfig of [{ imageSize: ["1K"] }, { aspectRatio: ["1:1"] }])
    assert.throws(() => prepareNativeGoogleImage(selection(undefined, { ...wire.request.body, generationConfig: { ...wire.request.body.generationConfig, imageConfig } })));
  const big = body({ inlineData: { mimeType: "image/png", data: "A".repeat(jsonLimit) } });
  assert.throws(() => prepareNativeGoogleImage(selection(undefined, big)));
});

test("Google image capacity is charged 64 MiB before dispatch alongside the existing request lease", () => {
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(jsonLimit), true);
  const output = native().acquire(); assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
  output.release(); input.release(); assert.equal(bodyBudgetCharged(), baseline);
  const other = new BodyLease(); assert.equal(other.grow(20 * 1024 * 1024), true);
  try { assert.throws(() => native().acquire(), /capacity is busy/); } finally { other.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("Google image output preserves canonical image bytes and native modality usage without token or cost inference", async () => {
  for (const [mime, bytes] of [["image/png", png], ["image/jpeg", jpeg], ["image/webp", webp]]) {
    const original = payload(mime, bytes), result = await read(response(original, { "x-private-upstream": "synthetic" }));
    const delivered = await result.response.json();
    assert.deepEqual(delivered, original); assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
    assert.deepEqual(delivered.usageMetadata, wire.response.usageMetadata);
    assert.deepEqual(Buffer.from(delivered.candidates[0].content.parts[0].inlineData.data, "base64"), Buffer.from(bytes, "base64"));
    assert.equal(result.usage.requestCostReceipt, undefined); assert.equal(result.response.headers.get("x-private-upstream"), null);
  }
});

test("Google image compatibility PNG default never qualifies missing MIME for the wrapper", async () => {
  const absent = payload(); delete absent.candidates[0].content.parts[0].inlineData.mimeType;
  assert.equal(observeGoogleImage(absent, true).images[0].mimeType, "image/png");
  await assert.rejects(read(response(absent)), /invalid_native_google_image_response/);
  for (const mimeType of [null, ["image/png"], "", "image/avif", "image/png; charset=utf-8", "image/jpeg"])
    await assert.rejects(read(response(payload(mimeType))), /invalid_native_google_image_response/);
});

test("Google image output rejects mismatched containers, noncanonical base64 and ambiguous MIME aliases", async () => {
  for (const body of [payload("image/png", "AQ=="), payload("image/png", png.replace(/=+$/, "")),
    payload("image/jpeg", Buffer.from(Buffer.from(jpeg, "base64").subarray(0, -2)).toString("base64")), payload("image/webp", png)])
    await assert.rejects(read(response(body)));
  const badWebp = Buffer.from(webp, "base64"); badWebp[4] ^= 1; await assert.rejects(read(response(payload("image/webp", badWebp.toString("base64")))));
  const ambiguous = payload(); ambiguous.candidates[0].content.parts[0].inlineData.mime_type = "image/png"; await assert.rejects(read(response(ambiguous)));
  const snake = payload(); const part = snake.candidates[0].content.parts[0]; part.inline_data = { mime_type: "image/png", data: png }; delete part.inlineData;
  assert.deepEqual(await (await read(response(snake))).response.json(), snake);
});

test("Google thought images are removed before the frozen client can consume them; native usage is retained", async () => {
  const body = payload(); body.candidates[0].content.parts.unshift({ thought: true, inlineData: { data: "synthetic-private-thought" } });
  const result = await read(response(body)), delivered = await result.response.json();
  assert.equal(body.candidates[0].content.parts.length, 2); assert.deepEqual(delivered, payload());
  assert.equal(JSON.stringify(delivered).includes("synthetic-private-thought"), false);
  assert.deepEqual(delivered.usageMetadata, body.usageMetadata);
});

test("Google image batches reject blocked, incomplete or invalid siblings and never return a valid prefix", async () => {
  for (const reason of [undefined, "MAX_TOKENS", "IMAGE_SAFETY", "OTHER"]) {
    const body = payload(); body.candidates.push({ ...body.candidates[0], finishReason: reason }); await assert.rejects(read(response(body)));
  }
  for (const extra of [{ inlineData: { mimeType: "image/png", data: "AQ==" } }, { text: "file", fileData: { fileUri: "https://assets.example/image.png" } }]) {
    const body = payload(); body.candidates[0].content.parts.push(extra); await assert.rejects(read(response(body)));
  }
  for (const body of [{ ...payload(), error: { message: "synthetic" } }, { ...payload(), promptFeedback: { blockReason: "SAFETY" } },
    { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "No image" }] } }] }]) await assert.rejects(read(response(body)));
  const many = payload(); many.candidates[0].content.parts = Array.from({ length: 5 }, () => ({ inlineData: { mimeType: "image/png", data: png } }));
  await assert.rejects(read(response(many)));
});

// Add a valid ancillary PNG text chunk to exercise byte limits without claiming
// arbitrary padded bytes are a fully decoded image. Preserve the original IEND.
function sizedPng(size) {
  const original = Buffer.from(png, "base64"), chunk = Buffer.alloc(size - original.length);
  chunk.writeUInt32BE(chunk.length - 12); chunk.write("tEXt", 4); chunk.write("padding\0", 8);
  chunk.fill(65, 16, chunk.length - 4); chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)]).toString("base64");
}

test("Google image combined decoded bound includes every delivered image and admits the exact boundary", async () => {
  const body = payload("image/png", sizedPng(outputLimit / 4));
  body.candidates[0].content.parts = Array.from({ length: 4 }, () => structuredClone(body.candidates[0].content.parts[0]));
  const result = await read(response(body)); assert.equal((await result.response.json()).candidates[0].content.parts.length, 4);
  body.candidates[0].content.parts[3].inlineData.data = sizedPng(outputLimit / 4 + 1);
  await assert.rejects(read(response(body)));
  await assert.rejects(read(response(payload("image/png", sizedPng(outputLimit + 1)))));
});

test("Google image delivery requires bounded complete UTF-8 JSON with matching lengths and HTTP metadata", async () => {
  const text = JSON.stringify(payload()), header = { "content-type": "application/json" };
  for (const length of ["-1", "1.5", "1, 1", "invalid", String(jsonLimit + 1), String(Buffer.byteLength(text) - 1), String(Buffer.byteLength(text) + 1)])
    await assert.rejects(read(new Response(text, { headers: { ...header, "content-length": length } })));
  await assert.rejects(read(new Response(text, { headers: { ...header, "content-encoding": "identity", "content-length": "1" } })));
  for (const status of [202, 206, 302, 422, 500]) await assert.rejects(read(response(payload(), {}, status)));
  for (const headers of [{ "content-type": "text/plain" }, { "content-range": "bytes 0-1/100" }, { "content-encoding": "gzip" }])
    await assert.rejects(read(response(payload(), headers)));
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  for (const body of [new Uint8Array([0xff]), '{"candidates":', ""]) await assert.rejects(read(new Response(body, { headers: header })));
  const exact = text + " ".repeat(jsonLimit - Buffer.byteLength(text));
  assert.ok(await read(new Response(exact, { headers: { ...header, "content-length": String(jsonLimit) } })));
  await assert.rejects(read(new Response(exact + " ", { headers: header })));
});

test("Google image abort, timeout and lost response cancel reading without publishing partial media or refunds", async () => {
  const header = { "content-type": "application/json" }, prefix = JSON.stringify(payload()).slice(0, -1);
  let first = true;
  const broken = new ReadableStream({ pull(c) { if (first) { first = false; c.enqueue(new TextEncoder().encode(prefix)); } else c.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(new Response(broken, { headers: header })), { message: "invalid_native_google_image_response" });
  for (const reason of [new DOMException("synthetic", "AbortError"), new DOMException("synthetic", "TimeoutError")]) {
    const abort = new AbortController(); let canceled = false;
    const stalled = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(prefix)); }, cancel() { canceled = true; } });
    const pending = read(new Response(stalled, { headers: header }), abort.signal); abort.abort(reason);
    await assert.rejects(pending); assert.equal(canceled, true);
  }
  const already = new AbortController(); already.abort(); await assert.rejects(read(response(), already.signal));
});
