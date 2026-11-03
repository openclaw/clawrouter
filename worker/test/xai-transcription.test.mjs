import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareXaiTranscription, observeXaiTranscription, readXaiTranscription } from "../xai-transcription.ts";
const f = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/transcription.json", import.meta.url)));
const file = () => new File([Uint8Array.from(f.audioBytes)], f.request.filename, { type: f.request.mime });
const upload = () => ({ file: file(), fields: { ...f.request.fields } });
const read = response => readXaiTranscription(response, new AbortController().signal);

test("native multipart preserves file bytes, regional language, and field ordering without a fabricated model", async () => {
  const prepared = prepareXaiTranscription(upload());
  assert.equal(prepared.path, "/v1/stt"); assert.deepEqual([...prepared.body.keys()], ["language", "file"]);
  assert.equal(prepared.body.get("language"), "pt-BR"); assert.equal(prepared.body.has("model"), false);
  assert.equal(prepared.headers.has("content-type"), false); assert.equal(prepared.headers.has("authorization"), false);
  assert.deepEqual([...new Uint8Array(await prepared.body.get("file").arrayBuffer())], f.audioBytes);
  const serialized = await new Request("https://example.com/v1/stt", { method: "POST", body: prepared.body }).text();
  assert.deepEqual([...serialized.matchAll(/Content-Disposition: form-data; name="([^"]+)"/g)].map(m => m[1]), f.request.fieldOrder);
  assert.deepEqual([...prepareXaiTranscription({ file: file(), fields: {} }).body.keys()], ["file"]);
});

test("native form denies hidden models, prompts, remote URLs, raw audio and mismatched or path-bearing filenames", () => {
  for (const fields of [{ model: "grok-4.3" }, { prompt: "ignored hint" }, { url: "https://example.com/input.wav" }, { audio_format: "pcm" }, { format: "true" }, { language: "" }, { language: "en\n" }]) {
    assert.throws(() => prepareXaiTranscription({ file: file(), fields }));
  }
  for (const source of [
    new File([], "empty.wav", { type: "audio/wav" }), new File(["x"], "../input.wav", { type: "audio/wav" }),
    new File(["x"], "input.wav", { type: "audio/mp3" }), new File(["x"], "input.pcm", { type: "audio/pcm" }),
    new File([new Uint8Array(25_000_001)], "large.wav", { type: "audio/wav" }),
  ]) assert.throws(() => prepareXaiTranscription({ file: source, fields: {} }));
  for (const [extension, type] of [["opus", "audio/opus"], ["mkv", "video/x-matroska"], ["aac", "audio/aac"], ["mov", "video/quicktime"], ["avi", "video/x-msvideo"]]) {
    assert.equal(prepareXaiTranscription({ file: new File(["synthetic"], `input.${extension}`, { type }), fields: {} }).body.has("file"), true);
  }
});

test("complete text and silence preserve native duration without equating it to a charge", async () => {
  const result = await read(Response.json(f.result));
  assert.equal(result.text, "Synthetic transcript."); assert.equal(result.nativeDurationSeconds, 0.62);
  assert.equal(result.observedModel, null); assert.equal(result.upstreamCostMicros, null);
  assert.deepEqual(result.body.words, f.result.words);
  assert.equal((await read(Response.json(f.silence))).text, "");
  const legacy = observeXaiTranscription({ text: "synthetic" }, true);
  assert.equal(legacy.nativeDurationSeconds, null); assert.equal(legacy.upstreamCostMicros, null);
  assert.equal(observeXaiTranscription({ ...f.result, model: "grok-voice-transcribe-2.0" }, true).observedModel, "grok-voice-transcribe-2.0");
});

test("incomplete, drifted and malformed results cannot close transcription accounting", () => {
  assert.throws(() => observeXaiTranscription(f.result, false));
  for (const value of [
    {}, { text: null }, { ...f.result, text: "\ud800" }, { ...f.result, error: {} },
    { ...f.result, model: "unknown-model" }, { ...f.result, channels: [] }, { ...f.result, finish_reason: "length" },
    { ...f.result, duration: -1 }, { ...f.result, duration: "0.62" }, { ...f.result, duration: Infinity },
    { ...f.result, words: [{ text: "synthetic", start: 1, end: 0 }] }, { ...f.result, words: [{ text: "synthetic", start: 0, end: 1, speaker: 1 }] },
    { ...f.result, text: "x".repeat(256 * 1024 + 1) },
  ]) assert.throws(() => observeXaiTranscription(value, true));
});

test("HTTP status, MIME, complete UTF-8 and response limits qualify the actual response", async () => {
  for (const response of [
    Response.json(f.result, { status: 202 }), new Response(null, { status: 302 }), new Response(null, { status: 401 }),
    new Response(JSON.stringify(f.result)), Response.json(f.result, { headers: { "content-range": "bytes 0-3/10" } }),
    Response.json(f.result, { headers: { "content-length": "1" } }), Response.json(f.result, { headers: { "content-length": "1048577" } }),
    new Response(Uint8Array.of(255), { headers: { "content-type": "application/json" } }),
  ]) await assert.rejects(read(response));
});

test("caller cancellation interrupts a stalled body without POST replay or a free-cost inference", async () => {
  const controller = new AbortController(); let canceled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"text":')); }, cancel() { canceled = true; } });
  const pending = readXaiTranscription(new Response(body, { headers: { "content-type": "application/json" } }), controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
});
