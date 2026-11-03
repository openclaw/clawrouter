import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { xaiSpeechFormats, xaiSpeechFallbackVoices, prepareXaiSpeech, readXaiSpeech, prepareXaiSpeechVoices, readXaiSpeechVoices } from "../xai-speech.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/speech.json", import.meta.url)));
const signal = () => new AbortController().signal;

test("native unary TTS preserves speech fields and never invents a model or credential", () => {
  assert.deepEqual(xaiSpeechFallbackVoices, ["ara", "eve", "leo", "rex", "sal"]);
  const request = prepareXaiSpeech(wire.request);
  assert.equal(request.path, "/v1/tts"); assert.deepEqual(request.body, wire.request);
  assert.equal(request.body.model, undefined); assert.equal(request.headers.has("authorization"), false);
  assert.equal(prepareXaiSpeech({ ...wire.request, language: "pt-BR", voice_id: "EVE" }).body.language, "pt-BR");
  for (const body of [
    { ...wire.request, model: "tts-1" }, { ...wire.request, input: "synthetic" },
    { ...wire.request, text: "x".repeat(60001) }, { ...wire.request, text: String.fromCharCode(0xd800) },
    { ...wire.request, language: "en?secret=synthetic" }, { ...wire.request, speed: 1.6 },
    { ...wire.request, with_timestamps: true }, { ...wire.request, output_format: { codec: "opus" } },
    { ...wire.request, output_format: { codec: "pcm", sample_rate: 8000 } },
  ]) assert.throws(() => prepareXaiSpeech(body));
});

test("each frozen codec requires its native MIME and complete byte identity", async () => {
  for (const [codec, mime] of Object.entries(xaiSpeechFormats)) {
    const request = prepareXaiSpeech({ ...wire.request, output_format: { codec } });
    const result = await readXaiSpeech(new Response(Uint8Array.from(wire.audioBytes), { headers: { "content-type": mime } }), request, signal());
    assert.deepEqual([...result.audio], wire.audioBytes); assert.equal(result.codec, codec); assert.equal(result.mimeType, mime);
    assert.equal(result.sampleRate, 24000); assert.equal(result.sampleRateBasis, "service_default"); assert.equal(result.upstreamCostMicros, null);
    await assert.rejects(readXaiSpeech(Response.json({ error: "synthetic" }), request, signal()));
  }
  const pcm = prepareXaiSpeech({ ...wire.request, output_format: { codec: "pcm" } });
  await assert.rejects(readXaiSpeech(new Response(Uint8Array.of(1), { headers: { "content-type": "audio/pcm" } }), pcm, signal()), /audio/);
});

test("partial, empty, oversized and failed speech responses cannot complete a paid synthesis", async () => {
  const request = prepareXaiSpeech(wire.request);
  for (const response of [
    new Response("", { headers: { "content-type": "audio/mpeg" } }),
    new Response(Uint8Array.from(wire.audioBytes), { status: 202, headers: { "content-type": "audio/mpeg" } }),
    new Response(null, { status: 302 }),
    new Response(Uint8Array.from(wire.audioBytes), { headers: { "content-type": "audio/mpeg", "content-length": "3" } }),
    new Response(Uint8Array.from(wire.audioBytes), { headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-3/8" } }),
    new Response(Uint8Array.from(wire.audioBytes), { headers: { "content-type": "audio/mpeg", "content-length": String(16 * 1024 * 1024 + 1) } }),
  ]) await assert.rejects(readXaiSpeech(response, request, signal()));
});

test("voice discovery preserves bounded native identities without equating fallback labels to availability", async () => {
  const request = prepareXaiSpeechVoices();
  assert.equal(request.method, "GET"); assert.equal(request.path, "/v1/tts/voices"); assert.equal(request.headers.has("authorization"), false);
  const result = await readXaiSpeechVoices(Response.json(wire.voices), signal());
  assert.deepEqual(result.voices.map(v => v.id), ["eve", "ara"]); assert.equal(result.voices[0].locale, "en");
  assert.equal((await readXaiSpeechVoices(Response.json({ voices: [] }), signal())).voices.length, 0);
  for (const body of [
    { voices: [{ voice_id: "eve" }, { voice_id: "EVE" }] }, { voices: [{ name: "missing id" }] },
    { voices: [{ voice_id: "eve", name: 123 }] }, { voices: [], error: {} }, { voices: Array(513).fill({ voice_id: "eve" }) },
  ]) await assert.rejects(readXaiSpeechVoices(Response.json(body), signal()));
  await assert.rejects(readXaiSpeechVoices(new Response(Uint8Array.of(255), { headers: { "content-type": "application/json" } }), signal()));
});

test("caller cancellation interrupts a stalled binary body without POST replay or fake usage", async () => {
  const request = prepareXaiSpeech(wire.request), controller = new AbortController(); let canceled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(0, 1)); }, cancel() { canceled = true; } });
  const pending = readXaiSpeech(new Response(stream, { headers: { "content-type": "audio/mpeg" } }), request, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
});

