import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareMiniMaxSpeech, observeMiniMaxSpeech, readMiniMaxSpeech, miniMaxSpeechModels } from "../minimax-speech.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/minimax/speech.json", import.meta.url)));
const prepare = body => prepareMiniMaxSpeech(body.model, body), request = prepare(wire.request);
const observe = body => observeMiniMaxSpeech(body, request, true);
const signal = () => new AbortController().signal;

test("eight frozen MiniMax speech identities preserve native unary JSON without credentials or product aliases", () => {
  assert.equal(miniMaxSpeechModels.length, 8);
  for (const model of miniMaxSpeechModels) {
    const body = { ...wire.request, model }, result = prepare(body);
    assert.equal(result.path, wire.path); assert.deepEqual(result.body, body);
    assert.equal(result.headers.get("content-type"), "application/json");
    assert.equal(result.headers.has("authorization"), false);
  }
  assert.throws(() => prepare({ ...wire.request, model: "speech-3.0" }));
  assert.throws(() => prepareMiniMaxSpeech("speech-2.6-hd", wire.request));
  for (const extra of [{ stream: true }, { output_format: "url" }, { GroupId: "foreign" }, { api_key: "synthetic" }, { voice_modify: {} }]) {
    assert.throws(() => prepare({ ...wire.request, ...extra }));
  }
});

test("frozen voice/audio controls reject coercion, oversized text and silent output conversion", () => {
  for (const voice of [{ speed: 0.4 }, { speed: "1" }, { vol: 0 }, { vol: Infinity }, { pitch: 1.5 }, { pitch: 13 }, { voice_id: "\n" }, { voice_id: "x".repeat(257) }]) {
    assert.throws(() => prepare({ ...wire.request, voice_setting: { ...wire.request.voice_setting, ...voice } }));
  }
  for (const text of ["", "x".repeat(10000), "😀".repeat(5000)]) assert.throws(() => prepare({ ...wire.request, text }));
  for (const audio of [{ format: "wav", sample_rate: 32000 }, { format: "mp3", sample_rate: 16000 }]) {
    assert.throws(() => prepare({ ...wire.request, audio_setting: audio }));
  }
});

test("complete hex output preserves exact bytes and native billable characters without inventing cost", () => {
  const result = observe(wire.result);
  assert.deepEqual([...result.audio], [0, 255, 128]); assert.equal(result.mimeType, "audio/mpeg");
  assert.equal(result.usageCharacters, 12); assert.equal(result.observedAudioMilliseconds, 150);
  assert.equal(result.actualCostMicros, undefined);
  assert.notEqual(result.usageCharacters, wire.result.extra_info.word_count);
  assert.notEqual(result.usageCharacters, wire.result.extra_info.usage_voice_count);
  const missing = structuredClone(wire.result); delete missing.extra_info;
  assert.equal(observe(missing).usageCharacters, null);
  for (const count of [undefined, -1, 0.5, "12", Number.MAX_SAFE_INTEGER + 1]) {
    const body = structuredClone(wire.result); body.extra_info.usage_characters = count;
    assert.equal(observe(body).usageCharacters, null);
  }
});

test("partial/error/foreign/malformed audio cannot become successful speech", () => {
  assert.throws(() => observeMiniMaxSpeech(wire.result, request, false), /incomplete/);
  for (const change of [
    b => { b.data.status = 1; }, b => { b.base_resp.status_code = 1008; }, b => { delete b.base_resp; },
    b => { b.data = null; }, b => { b.model = "speech-2.6-hd"; }, b => { b.error = {}; },
    b => { b.extra_info.audio_size = 2; }, b => { b.extra_info.audio_format = "wav"; },
    b => { b.extra_info.audio_sample_rate = 16000; },
  ]) { const body = structuredClone(wire.result); change(body); assert.throws(() => observe(body)); }
  for (const audio of ["", "0", "0x00", "00 01", "https://other.example/audio.mp3", "0g"]) {
    assert.throws(() => observe({ ...wire.result, data: { status: 2, audio } }));
  }
});

test("bounded JSON delivery requires complete valid UTF-8 EOF and exact unencoded length", async () => {
  const body = { ...wire.result, trace_id: "synthetic-é" }, bytes = new TextEncoder().encode(JSON.stringify(body));
  const split = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  assert.deepEqual([...(await readMiniMaxSpeech(new Response(split, { headers: { "content-type": "application/json", "content-length": String(bytes.length) } }), request, signal())).audio], [0, 255, 128]);
  for (const response of [
    Response.json(wire.result, { status: 206 }), new Response(null, { status: 302 }),
    new Response(bytes, { headers: { "content-type": "text/event-stream" } }),
    new Response(bytes, { headers: { "content-type": "application/json", "content-length": String(bytes.length + 1) } }),
    new Response(Uint8Array.of(255), { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "20000000" } }),
  ]) await assert.rejects(readMiniMaxSpeech(response, request, signal()));
});

test("cancellation interrupts a stalled native body without finalizing partial audio or retrying POST", async () => {
  const controller = new AbortController(); let canceled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"data":')); }, cancel() { canceled = true; } });
  const pending = readMiniMaxSpeech(new Response(body, { headers: { "content-type": "application/json" } }), request, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
});

