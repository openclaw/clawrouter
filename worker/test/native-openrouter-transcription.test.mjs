import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
const { prepareNativeOpenRouterTranscription } = await import("../native-openrouter-transcription.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/transcription.json", import.meta.url), "utf8"));
const model = "openai/whisper-large-v3-turbo", format = "openrouter.audio_transcription";
const requestLimit = 24 * 1024 * 1024, audioLimit = 16 * 1024 * 1024, responseLimit = 1024 * 1024;
// Public client e2ea1f2b7cbb6aa5efb3645f319be8114be280ab audio-transcription.test-support.ts:
// 2,048-byte PCM16LE 8 kHz mono WAV, independently fully decoded before publication.
function wave(total = 2048) {
  const value = Buffer.alloc(total, 42); value.write("RIFF"); value.writeUInt32LE(total - 8, 4); value.write("WAVEfmt ", 8);
  value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22); value.writeUInt32LE(8000, 24);
  value.writeUInt32LE(16000, 28); value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34);
  value.write("data", 36); value.writeUInt32LE(total - 44, 40); return value;
}
// Existing public native-google-music.test.mjs fixture: fully decoded 44.1 kHz
// stereo MP3, 1,880 bytes. This is offline silence, not a provider generation.
const mp3 = Buffer.from("//uwZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+7JkAA/wAABpAAAACAAADSAAAAEAAAGkAAAAIAAANIAAAARMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+7JkAA/wAABpAAAACAAADSAAAAEAAAGkAAAAIAAANIAAAARMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=", "base64");
const wav = wave();
// Candidate declaration shape under the existing /api base; activation is separate.
const endpoint = { id: "transcriptions", method: "POST", path: "/v1/audio/transcriptions", path_params: [],
  path_param_styles: {}, query: {}, streaming: null, request_format: format, response_format: format };
const body = (bytes = wav, audioFormat = "wav") => ({ model, input_audio: { data: bytes.toString("base64"), format: audioFormat }, language: "en", temperature: 0.25 });
const selection = (value = body()) => ({ provider: { id: "openrouter", base_urls: { default: "https://openrouter.ai/api" } }, endpoint,
  model: { id: "openrouter/" + model, upstream: model, capabilities: ["audio.transcription"] }, capability: "audio.transcription",
  body: value, pathParams: {}, method: "POST" });
const native = (selected = selection()) => prepareNativeOpenRouterTranscription(selected);
const response = (value = wire.result, headers = {}, status = 200) => Response.json(value, { headers, status });
async function read(upstream, signal = new AbortController().signal) {
  const prepared = native(), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("OpenRouter binds the native JSON model and /api base without changing playable WAV or MP3 bytes", () => {
  for (const [bytes, audioFormat, hash] of [[wav, "wav", "5efcd8ff93f78a2a9177e4db8b767662c7feb49aec41238f78fad5ceb6d635ed"],
    [mp3, "mp3", "94bf451427043b32a9893976aefdea79d784323e5422f1f986fb22548615162b"]]) {
    assert.ok(bytes.length >= 1024); assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
    const selected = selection(body(bytes, audioFormat)), before = structuredClone(selected), prepared = native(selected);
    assert.deepEqual(selected, before); assert.deepEqual(Buffer.from(selected.body.input_audio.data, "base64"), bytes);
    assert.equal(prepared.origin, "https://openrouter.ai"); assert.equal(prepared.path, "/api/v1/audio/transcriptions");
    for (const key of ["query", "tariff", "body", "headers"]) assert.equal(prepared[key], undefined);
    assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
    for (const url of [prepared.origin + "/v1/audio/transcriptions", prepared.origin + "/api" + prepared.path,
      prepared.origin + prepared.path + "?temperature=0.25", "https://other.example" + prepared.path])
      assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  }
});

test("OpenRouter leaf rejects foreign model, multipart and unqualified route selection", () => {
  assert.equal(native({ ...selection(), endpoint: { ...endpoint, request_format: "openai.audio_transcriptions" } }), undefined);
  for (const change of [{ provider: { ...selection().provider, id: "openai" } },
    { provider: { ...selection().provider, base_urls: { default: "https://openrouter.ai" } } }, { model: null },
    { model: { ...selection().model, upstream: "openai/whisper-1" } }, { model: { ...selection().model, capabilities: ["llm.chat"] } },
    { capability: "llm.chat" }, { method: "GET" }, { pathParams: { model } }, { nativeQuery: {} }])
    assert.throws(() => native({ ...selection(), ...change }));
  for (const change of [{ method: "GET" }, { path: "/api/v1/audio/transcriptions" }, { upstreamPath: endpoint.path },
    { path_params: ["model"] }, { response_format: "openai.audio_transcriptions" }, { query: { temperature: "0.25" } },
    { streaming: "sse" }, { websocket: "openai.realtime" }, { lifecycle: {} }, { responsesLifecycle: {} },
    { modelPassthrough: {} }, { requestPricing: {} }]) assert.throws(() => native({ ...selection(), endpoint: { ...endpoint, ...change } }));
});

test("OpenRouter request validation preserves the finite JSON wire instead of multipart or URL fallback", () => {
  for (const fields of [{ model: "openrouter/" + model }, { prompt: "synthetic hint" }, { response_format: "text" }, { stream: true },
    { language: "eng" }, { temperature: -1 }, { temperature: 1.1 }, { temperature: "0.5" }, { provider: { order: ["synthetic"] } },
    { input_audio: { url: "https://audio.example/recording.wav", format: "wav" } },
    { input_audio: { data: wav.toString("base64"), format: "mp4" } },
    { input_audio: { data: "data:audio/wav;base64," + wav.toString("base64"), format: "wav" } },
    { input_audio: { data: wav.toString("base64").replace(/=+$/, ""), format: "wav" } }])
    assert.throws(() => native(selection({ ...body(), ...fields })));
  const multipart = new FormData(); multipart.set("file", new File([wav], "synthetic.wav", { type: "audio/wav" }));
  assert.throws(() => native(selection(multipart)));
});

test("OpenRouter bounds JSON before codec cloning and keeps the 16 MiB audio limit", () => {
  assert.ok(native(selection(body(wave(audioLimit)))));
  assert.throws(() => native(selection(body(wave(audioLimit + 2)))));
  assert.throws(() => native(selection({ ...body(), input_audio: { data: "A".repeat(requestLimit), format: "wav" } })));
});

test("OpenRouter charges 16 MiB response capacity and at most 64 MiB with the accepted request lease", () => {
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(requestLimit), true);
  const output = native().acquire(); assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
  output.release(); input.release(); assert.equal(bodyBudgetCharged(), baseline);
  const other = new BodyLease(); assert.equal(other.grow(41 * 1024 * 1024), true);
  try { assert.throws(() => native().acquire(), /capacity is busy/); } finally { other.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("OpenRouter delivers complete native JSON and bounded diagnostic identity without an invoice receipt", async () => {
  const result = await read(response(wire.result, { "x-generation-id": wire.generationId, "x-private-upstream": "synthetic" }));
  assert.deepEqual(await result.response.json(), wire.result);
  assert.equal(result.response.headers.get("x-generation-id"), wire.generationId);
  assert.equal(result.response.headers.get("x-private-upstream"), null);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(result.usage, { tokens: { input: 42, output: 8, total: 50, cached: null,
    cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null }, outcome: "success" });
  assert.equal(result.usage.requestCostReceipt, undefined);
});

test("OpenRouter silence remains successful and absent usage never becomes zero or synthesized tokens", async () => {
  for (const text of ["", " \t\n"]) {
    const value = { text, usage: { seconds: 3.5, cost: 0.25 } }, result = await read(response(value));
    assert.deepEqual(await result.response.json(), value);
    assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  }
  for (const [usage, expected] of [[{ input_tokens: 7 }, [7, null, null]], [{ output_tokens: 3 }, [null, 3, null]],
    [{ total_tokens: 10 }, [null, null, 10]], [{ input_tokens: 7, output_tokens: 3 }, [7, 3, null]]]) {
    const result = await read(response({ text: "synthetic", usage }));
    assert.deepEqual([result.usage.tokens.input, result.usage.tokens.output, result.usage.tokens.total], expected);
  }
  assert.deepEqual((await read(response(wire.unmetered))).usage, { tokens: null, outcome: "success" });
});

test("OpenRouter rejects present null error/model fields and invalid native usage before delivery", async () => {
  for (const value of [{ text: "synthetic", error: null }, { text: "synthetic", model: null },
    { text: "synthetic", error: {} }, { text: "synthetic", model: "openai/whisper-1" }, { text: "synthetic", finish_reason: "length" },
    {}, { text: 1 }, { text: "\ud800" }, { text: "x".repeat(262145) }, { text: "synthetic", usage: { cost: -1 } },
    { text: "synthetic", usage: { input_tokens: 1.5 } }, { text: "synthetic", usage: { total_tokens: "7" } }])
    await assert.rejects(read(response(value)));
  assert.equal((await (await read(response({ text: "", model }))).response.json()).model, model);
  for (const id of ["contains/slash", "x".repeat(257)]) await assert.rejects(read(response(undefined, { "x-generation-id": id })));
});

test("OpenRouter requires HTTP 200 UTF-8 JSON, identity encoding and complete declared lengths", async () => {
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/json; charset=utf-16" },
    { "content-type": "application/json; charset=\"utf-8" }, { "content-encoding": "gzip" }, { "content-range": "bytes 0-3/9" },
    { "content-length": "-1" }, { "content-length": "1.5" }, { "content-length": "1" }]) await assert.rejects(read(response(undefined, headers)));
  for (const status of [201, 206, 302, 400, 422, 429, 500]) await assert.rejects(read(response(undefined, {}, status)));
  for (const headers of [{}, { "content-encoding": "identity" }]) {
    const value = response(undefined, headers); Object.defineProperty(value, "redirected", { value: true }); await assert.rejects(read(value));
  }
  const bytes = JSON.stringify(wire.result);
  assert.deepEqual(await (await read(new Response(bytes, { headers: { "content-type": "application/json; charset=UTF-8",
    "content-encoding": "identity", "content-length": String(Buffer.byteLength(bytes)) } }))).response.json(), wire.result);
});

test("OpenRouter bounds the complete response at 1 MiB with no partial transcript delivery", async () => {
  const value = { text: "synthetic", metadata: "" }, overhead = Buffer.byteLength(JSON.stringify(value));
  value.metadata = "x".repeat(responseLimit - overhead);
  assert.equal((await (await read(response(value))).response.json()).metadata.length, responseLimit - overhead);
  value.metadata += "x"; await assert.rejects(read(response(value)));
  await assert.rejects(read(response(wire.result, { "content-length": String(responseLimit + 1) })));
});

test("OpenRouter waits for full EOF and rejects invalid UTF-8, truncation and interrupted output", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(wire.result)); let controller, settled = false;
  const upstream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "application/json" } });
  const pending = read(upstream).then(value => { settled = true; return value; });
  controller.enqueue(bytes); await new Promise(setImmediate); assert.equal(settled, false);
  controller.close(); assert.deepEqual(await (await pending).response.json(), wire.result);
  await assert.rejects(read(new Response(bytes.subarray(0, -1), { headers: { "content-type": "application/json" } })));
  await assert.rejects(read(new Response(new Uint8Array([0xff, 0xfe]), { headers: { "content-type": "application/json" } })));
  await assert.rejects(read(new Response(new ReadableStream({ start(value) { value.enqueue(bytes); value.error(new Error("synthetic interruption")); } }),
    { headers: { "content-type": "application/json" } })));
});

test("OpenRouter abort cancels a stalled reader and releases capacity without successful usage", async () => {
  for (const alreadyAborted of [false, true]) {
    const baseline = bodyBudgetCharged(), abort = new AbortController(); let canceled = false;
    if (alreadyAborted) abort.abort();
    const upstream = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } });
    const pending = read(upstream, abort.signal);
    if (!alreadyAborted) { await new Promise(setImmediate); abort.abort(); }
    await assert.rejects(pending); assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), baseline);
  }
});
