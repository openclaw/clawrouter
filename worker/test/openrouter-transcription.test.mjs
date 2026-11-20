import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { openRouterTranscriptionModels, openRouterTranscriptionFormats, prepareOpenRouterTranscription,
  observeOpenRouterTranscription, readOpenRouterTranscription } from "../openrouter-transcription.ts";
const f = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/transcription.json", import.meta.url)));
const signal = () => new AbortController().signal;
const prepare = body => prepareOpenRouterTranscription(f.request.model, body);
const observe = body => observeOpenRouterTranscription(body, f.request.model);
const read = (response, abort = signal()) => readOpenRouterTranscription(response, f.request.model, abort);

test("frozen model uses native JSON with exact base64 bytes and seven input formats", () => {
  assert.deepEqual(openRouterTranscriptionModels, ["openai/whisper-large-v3-turbo"]);
  assert.deepEqual(openRouterTranscriptionFormats, ["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"]);
  for (const format of openRouterTranscriptionFormats) {
    const body = { ...f.request, input_audio: { ...f.request.input_audio, format } }, result = prepare(body);
    assert.equal(result.path, "/api/v1/audio/transcriptions"); assert.equal(result.headers.get("content-type"), "application/json");
    assert.equal(result.headers.has("authorization"), false); assert.deepEqual(result.body, body);
    assert.equal(result.audioBytes, Buffer.from(body.input_audio.data, "base64").length);
    body.input_audio.data = "changed"; assert.equal(result.body.input_audio.data, f.request.input_audio.data);
  }
});

test("no unrelated model, URL, multipart, provider preference or silently ignored prompt enters this frozen route", () => {
  for (const body of [{ ...f.request, model: "whisper-large-v3-turbo" }, { ...f.request, prompt: "ignored upstream" },
    { ...f.request, language: "en-US" }, { ...f.request, temperature: 1.1 }, { ...f.request, temperature: NaN },
    { ...f.request, response_format: "verbose_json" }, { ...f.request, provider: { only: ["groq"] } },
    { ...f.request, input_audio: { url: "https://example.com/audio.wav", format: "wav" } },
    { ...f.request, input_audio: { data: "data:audio/wav;base64,AA==", format: "wav" } },
    { ...f.request, input_audio: { data: "AB==", format: "wav" } },
    { ...f.request, input_audio: { data: "AA", format: "wav" } },
    { ...f.request, input_audio: { data: "", format: "wav" } },
    { ...f.request, input_audio: { data: "AA==", format: "pcm16" } }]) assert.throws(() => prepare(body));
  assert.throws(() => prepareOpenRouterTranscription("openai/whisper-1", { ...f.request, model: "openai/whisper-1" }));
  assert.throws(() => prepare(new FormData()));
  assert.throws(() => prepare({ ...f.request, input_audio: { data: "A".repeat(Math.ceil(16 * 1024 * 1024 / 3) * 4 + 4), format: "wav" } }));
});

test("silent audio is a valid empty transcript; seconds, tokens and actual native cost remain independent", () => {
  const result = observe(f.result);
  assert.equal(result.text, "A paper boat crosses the pond."); assert.equal(result.audioSeconds, 3.5);
  assert.equal(result.nativeCost, 0.00001); assert.equal(result.inputTokens, 42); assert.equal(result.outputTokens, 8); assert.equal(result.totalTokens, 50);
  const silent = observe(f.silent); assert.equal(silent.text, ""); assert.equal(silent.audioSeconds, 3.5); assert.equal(silent.nativeCost, null);
  const missing = observe(f.unmetered); assert.equal(missing.audioSeconds, null); assert.equal(missing.totalTokens, null);
  for (const value of [result, silent, missing, observe({ text: "", usage: { cost: 0, seconds: 0 } })]) assert.equal(value.upstreamCostMicros, null);
  assert.equal(observe({ text: "", usage: { input_tokens: 4, output_tokens: 2 } }).totalTokens, null);
});

test("malformed, partial and mismatched-model envelopes cannot become transcript success", () => {
  for (const body of [{}, [], null, { text: 12 }, { text: "ok", error: "failed" }, { text: "ok", finish_reason: "length" },
    { text: "ok", model: "openai/whisper-1" }, { text: "\ud800" }, { text: "x".repeat(262145) },
    { text: "ok", usage: { seconds: -1 } }, { text: "ok", usage: { cost: Infinity } },
    { text: "ok", usage: { input_tokens: 1.5 } }, { text: "ok", usage: [] }]) assert.throws(() => observe(body));
});

test("complete bounded native response preserves opaque generation ID and rejects bad HTTP, lengths and UTF-8", async () => {
  const result = await read(Response.json(f.result, { headers: { "x-generation-id": f.generationId } }));
  assert.equal(result.generationId, f.generationId);
  for (const response of [Response.json(f.result, { status: 202 }), Response.json(f.result, { status: 401 }),
    Response.json(f.result, { headers: { "content-length": "1" } }), Response.json(f.result, { headers: { "content-range": "bytes 0-1/100" } }),
    Response.json(f.result, { headers: { "x-generation-id": "foreign/path" } }),
    new Response(Uint8Array.of(0xff), { headers: { "content-type": "application/json" } }),
    new Response(" ".repeat(1024 * 1024 + 1), { headers: { "content-type": "application/json" } })]) await assert.rejects(() => read(response));
  const redirected = Response.json(f.result); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(() => read(redirected));
});

test("abort cancels stalled native audio response without a replacement transcription or inferred refund", async () => {
  let canceled = false;
  const controller = new AbortController(), response = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
  const pending = read(response, controller.signal); controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
});
