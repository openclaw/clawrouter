import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { googleImageModels, googleImageLimits, prepareGoogleImage, observeGoogleImage, readGoogleImage } from "../google-images.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/images.json", import.meta.url), "utf8"));
const prepare = body => prepareGoogleImage(wire.request.model, body);
const clone = () => structuredClone(wire.response);
const part = value => value.candidates[0].content.parts[1];

test("Google image preparation preserves exactly the frozen native model and geometry surface", () => {
  assert.equal(googleImageModels.length, 2);
  for (const model of googleImageModels) {
    const request = prepareGoogleImage(model, wire.request.body);
    assert.equal(request.body, wire.request.body);
    assert.equal(request.path, `/v1beta/models/${model}:generateContent`);
    assert.equal(request.headers.get("x-goog-api-key"), null);
  }
  for (const model of ["google/gemini-3-pro-image", "gemini-3-pro-image-preview", "gemini-nano-banana-2.1"]) assert.throws(() => prepareGoogleImage(model, wire.request.body));
  for (const change of [{ candidateCount: 4 }, { responseModalities: ["AUDIO"] }, { imageConfig: { imageSize: "512px" } }, { imageConfig: { aspectRatio: "1:8" } }]) {
    assert.throws(() => prepare({ ...wire.request.body, generationConfig: { ...wire.request.body.generationConfig, ...change } }));
  }
  for (const change of [{ tools: [{ googleSearch: {} }] }, { cachedContent: "cachedContents/synthetic" }, { safetySettings: [] }]) assert.throws(() => prepare({ ...wire.request.body, ...change }));
});

test("Google editing preserves up to five bounded inline images without raw file references", () => {
  const image = part(wire.response), prompt = { text: "Edit synthetic images." };
  const body = { ...wire.request.body, contents: [{ role: "user", parts: [image, image, image, image, image, prompt] }] };
  assert.equal(prepare(body).body, body);
  assert.throws(() => prepare({ ...body, contents: [{ role: "user", parts: [...body.contents[0].parts, image] }] }));
  for (const invalid of [{ fileData: { fileUri: "https://example.com/private" } }, { inlineData: { mimeType: "audio/mpeg", data: "AQ==" } }, { text: "", inlineData: image.inlineData }]) {
    assert.throws(() => prepare({ ...body, contents: [{ role: "user", parts: [invalid, prompt] }] }));
  }
});

test("Google image delivery validates all output assets and keeps native modality usage separate", () => {
  const response = clone(); response.candidates[0].content.parts.unshift({ thought: true, inlineData: { mimeType: "image/png", data: "synthetic-private-thought" } });
  const result = observeGoogleImage(response, true);
  assert.equal(result.body, response);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mimeType, "image/png");
  assert.equal(result.images[0].decodedBytes, Buffer.from(part(wire.response).inlineData.data, "base64").length);
  assert.equal(result.body.usageMetadata.thoughtsTokenCount, 128);
  assert.equal(result.inputTokens, undefined); assert.equal(result.costMicros, undefined);
  const alias = clone(); const inline = part(alias).inlineData; delete part(alias).inlineData;
  part(alias).inline_data = { mime_type: inline.mimeType, data: inline.data.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
  assert.deepEqual(observeGoogleImage(alias, true).images, observeGoogleImage(wire.response, true).images);
});

test("Google blocked or partial siblings cannot publish a valid image prefix", () => {
  assert.throws(() => observeGoogleImage(wire.response, false));
  for (const reason of [undefined, "MAX_TOKENS", "IMAGE_SAFETY", "OTHER"]) {
    const response = clone(); response.candidates.push({ ...response.candidates[0], finishReason: reason });
    assert.throws(() => observeGoogleImage(response, true));
  }
  for (const response of [{ ...clone(), error: {} }, { ...clone(), promptFeedback: { blockReason: "SAFETY" } }, { candidates: [] }, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "No image generated." }] } }] }]) assert.throws(() => observeGoogleImage(response, true));
  const many = clone(); many.candidates[0].content.parts = Array.from({ length: 5 }, () => part(wire.response)); assert.throws(() => observeGoogleImage(many, true));
});

test("Google image aliases and base64 reject ambiguous or noncanonical content atomically", () => {
  for (const data of ["", "a", "Zh==", "YQ=", "YQ===", "data:image/png;base64,YQ==", "Y Q=="]) {
    const response = clone(); response.candidates[0].content.parts.push({ inlineData: { data, mimeType: "image/png" } });
    assert.throws(() => observeGoogleImage(response, true));
  }
  const ambiguous = clone(); part(ambiguous).inline_data = part(ambiguous).inlineData; assert.throws(() => observeGoogleImage(ambiguous, true));
  const mime = clone(); part(mime).inlineData.mime_type = "image/jpeg"; assert.throws(() => observeGoogleImage(mime, true));
  const remote = clone(); remote.candidates[0].content.parts.push({ fileData: { fileUri: "https://media.example/output.png" } }); assert.throws(() => observeGoogleImage(remote, true));
});

test("Google image HTTP delivery requires bounded complete UTF-8 EOF and cancels on caller abort", async () => {
  assert.equal((await readGoogleImage(Response.json(wire.response), new AbortController().signal)).images.length, 1);
  const invalid = [Response.json(wire.response, { status: 202 }), new Response('{"candidates":', { headers: { "content-type": "application/json" } }), new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }), new Response(" ", { headers: { "content-type": "application/json", "content-length": String(googleImageLimits.responseBytes + 1) } })];
  for (const response of invalid) await assert.rejects(() => readGoogleImage(response, new AbortController().signal));
  let canceled = false, readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const controller = new AbortController();
  const stream = new ReadableStream({ pull() { readStarted(); return new Promise(() => {}); }, cancel() { canceled = true; } });
  const reading = readGoogleImage(new Response(stream, { headers: { "content-type": "application/json" } }), controller.signal);
  await started; controller.abort(); await assert.rejects(reading); assert.equal(canceled, true);
});
