import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { googleUnderstandingModel, prepareGoogleUnderstanding, observeGoogleUnderstanding, readGoogleUnderstanding } from "../google-media-understanding.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/media-understanding.json", import.meta.url), "utf8"));
const prepare = (mode, body = wire[mode]) => prepareGoogleUnderstanding(googleUnderstandingModel, mode, body);

test("Google understanding preserves native snake-case audio/video bytes and the frozen default model", () => {
  for (const mode of ["audio", "video"]) {
    const request = prepare(mode);
    assert.equal(request.path, wire.path); assert.equal(request.body, wire[mode]); assert.equal(request.mode, mode);
    assert.equal(request.decodedBytes, 4); assert.equal(request.headers.get("x-goog-api-key"), null);
    assert.deepEqual(Buffer.from(request.body.contents[0].parts[1].inline_data.data, "base64"), Buffer.from([0, 1, 2, 3]));
  }
  assert.throws(() => prepareGoogleUnderstanding("gemini-3.8-flash", "audio", wire.audio));
  assert.throws(() => prepareGoogleUnderstanding(googleUnderstandingModel, "image", wire.audio));
});

test("Google understanding rejects modality changes, foreign files and implicit tool/generation upgrades", () => {
  assert.throws(() => prepare("audio", wire.video)); assert.throws(() => prepare("video", wire.audio));
  for (const change of [{ tools: [{ google_search: {} }] }, { generationConfig: { responseModalities: ["AUDIO"] } }, { cachedContent: "cachedContents/foreign" }]) assert.throws(() => prepare("audio", { ...wire.audio, ...change }));
  for (const part of [{ file_data: { file_uri: "files/foreign", mime_type: "audio/wav" } }, { inline_data: { mime_type: "audio/wav", data: "https://media.example/audio.wav" } }, { inlineData: { mimeType: "audio/wav", data: "AAECAw==" } }]) {
    const body = structuredClone(wire.audio); body.contents[0].parts[1] = part; assert.throws(() => prepare("audio", body));
  }
});

test("Google inline media requires bounded canonical standard base64 without decoding full files", () => {
  for (const data of ["", "a", "Zh==", "YQ=", "AAECAw", "Y Q==", "data:audio/wav;base64,YQ=="]) {
    const body = structuredClone(wire.audio); body.contents[0].parts[1].inline_data.data = data; assert.throws(() => prepare("audio", body));
  }
  const body = structuredClone(wire.audio); body.contents[0].parts[0].text = " "; assert.throws(() => prepare("audio", body));
});

test("Google final text preserves native usage and excludes thought text without partial delivery", () => {
  const body = structuredClone(wire.response); body.candidates[0].content.parts.unshift({ thought: true, text: "Synthetic private reasoning." });
  const result = observeGoogleUnderstanding(body, true);
  assert.equal(result.body, body); assert.equal(result.text, "Synthetic description.\nSecond line.");
  assert.equal(result.durationSeconds, undefined); assert.equal(result.costMicros, undefined);
  assert.deepEqual(result.body.usageMetadata, wire.response.usageMetadata);
  assert.throws(() => observeGoogleUnderstanding(body, false));
  for (const reason of [undefined, "MAX_TOKENS", "SAFETY", "CONTINUATION"]) { const value = structuredClone(body); value.candidates[0].finishReason = reason; assert.throws(() => observeGoogleUnderstanding(value, true)); }
  for (const value of [{ ...body, error: {} }, { ...body, promptFeedback: { blockReason: "SAFETY" } }, { candidates: [] }]) assert.throws(() => observeGoogleUnderstanding(value, true));
  const mixed = structuredClone(body); mixed.candidates[0].content.parts.push({ inlineData: { mimeType: "audio/wav", data: "AAECAw==" } }); assert.throws(() => observeGoogleUnderstanding(mixed, true));
});

test("Google understanding HTTP delivery enforces EOF and deadline/caller cancellation", async () => {
  assert.equal((await readGoogleUnderstanding(Response.json(wire.response), new AbortController().signal)).text, "Synthetic description.\nSecond line.");
  for (const response of [Response.json(wire.response, { status: 202 }), new Response('{"candidates":', { headers: { "content-type": "application/json" } }), new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }), new Response(" ", { headers: { "content-type": "application/json", "content-length": "1048577" } })]) await assert.rejects(() => readGoogleUnderstanding(response, new AbortController().signal));
  let canceled = false, started; const waiting = new Promise(resolve => { started = resolve; }), controller = new AbortController();
  const stream = new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { canceled = true; } });
  const read = readGoogleUnderstanding(new Response(stream, { headers: { "content-type": "application/json" } }), controller.signal);
  await waiting; controller.abort(); await assert.rejects(read); assert.equal(canceled, true);
});
