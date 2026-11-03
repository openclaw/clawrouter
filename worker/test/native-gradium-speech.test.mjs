import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareNativeGradiumSpeech } = await import("../native-gradium-speech.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/gradium/speech.json", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/gradium.provider.yaml", import.meta.url), "utf8"))]).providers[0];
const endpoint = provider.endpoints.find(endpoint => endpoint.id === "speech");
const wav = Uint8Array.from(Buffer.from(wire.response.base64, "base64"));
// Synthetic transport bytes, not a generated voice or decoder/playback proof.
const opus = Uint8Array.from(Buffer.from("OggS\0synthetic OpusHead transport fixture", "utf8"));
const limit = 16 * 1024 * 1024;
const selection = (body = wire.request.body) => ({ provider, endpoint, model: null, capability: "audio.speech", body: structuredClone(body), pathParams: {}, method: "POST" });
const native = format => prepareNativeGradiumSpeech(selection({ ...wire.request.body, output_format: format ?? "wav" }));
const response = (bytes = wav, headers = {}, status = 200) => new Response(bytes, { status, headers: { "content-type": "audio/wav", ...headers } });
async function read(prepared, input, signal = new AbortController().signal) {
  const lease = prepared.acquire();
  try { return await prepared.read(input, signal); } finally { lease.release(); }
}

test("published model-less Gradium selection preserves native JSON and pins the existing response ABI destination", () => {
  const selected = selection({ ...wire.request.body, model_name: "default" }), before = structuredClone(selected.body);
  const prepared = prepareNativeGradiumSpeech(selected);
  assert.deepEqual(selected.body, before); assert.equal(selected.model, null);
  assert.equal(prepared.origin, "https://api.gradium.ai"); assert.equal(prepared.path, wire.request.path);
  assert.equal(prepared.tariff, undefined);
  assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
  for (const url of ["https://other.example" + prepared.path, prepared.origin + "/other", prepared.origin + prepared.path + "?key=synthetic"]) {
    assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  }
  assert.equal(prepareNativeGradiumSpeech({ ...selected, endpoint: { ...endpoint, request_format: "openai.audio_speech" } }), undefined);
});
test("wrong route, model selectors and streaming modes are rejected before dispatch", () => {
  const selected = selection();
  for (const change of [{ model: { upstream: "invented" } }, { method: "GET" }, { capability: "chat.completions" }, { pathParams: { model: "invented" } }]) {
    assert.throws(() => prepareNativeGradiumSpeech({ ...selected, ...change }), /qualified model-less/);
  }
  for (const change of [{ method: "GET" }, { path: "/v1/audio/speech" }, { upstreamPath: "/other" }, { response_format: "openai.audio" },
    { streaming: true }, { lifecycle: {} }, { responsesLifecycle: {} }, { websocket: {} }, { modelPassthrough: true }]) {
    assert.throws(() => prepareNativeGradiumSpeech({ ...selected, endpoint: { ...endpoint, ...change } }));
  }
  for (const change of [{ model: "invented" }, { only_audio: false }, { stream: true }, { text: " " }, { voice_id: "" }, { json_config: "[]" }]) {
    assert.throws(() => prepareNativeGradiumSpeech(selection({ ...wire.request.body, ...change })));
  }
});
test("ulaw_8000 is refused before egress until its native HTTP MIME pair is qualified", t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected fetch"); });
  const before = bodyBudgetCharged();
  assert.throws(() => native("ulaw_8000"), /WAV and Ogg Opus only/);
  assert.throws(() => native("pcm")); assert.equal(bodyBudgetCharged(), before);
});
test("the accepted 16 MiB output bound charges 32 MiB before dispatch and refuses exhausted shared capacity", () => {
  const prepared = native(), baseline = bodyBudgetCharged(), lease = prepared.acquire();
  assert.equal(bodyBudgetCharged(), baseline + 2 * limit); lease.release(); assert.equal(bodyBudgetCharged(), baseline);
  const other = new BodyLease(); assert.equal(other.grow(40 * 1024 * 1024), true);
  try { assert.throws(() => prepared.acquire(), /capacity is busy/); }
  finally { other.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});
test("qualified WAV and Ogg Opus return unchanged complete bytes with no fabricated usage or tariff", async () => {
  for (const [format, mime, bytes] of [["wav", "audio/wav", wav], ["opus", "audio/ogg", opus], ["opus", 'audio/ogg; codecs="opus"', opus]]) {
    const source = new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i++) { controller.enqueue(new Uint8Array()); controller.enqueue(bytes.subarray(i, i + 1)); }
      controller.close();
    } });
    const observed = await read(native(format), response(source, { "content-type": mime, "content-length": String(bytes.byteLength), "x-private-upstream": "synthetic" }));
    assert.deepEqual(new Uint8Array(await observed.response.arrayBuffer()), bytes);
    assert.deepEqual(observed.usage, { tokens: null, outcome: "success" });
    assert.equal(observed.response.headers.get("content-length"), String(bytes.byteLength));
    assert.equal(observed.response.headers.get("content-type"), format === "wav" ? "audio/wav" : "audio/ogg");
    assert.equal(observed.response.headers.get("x-private-upstream"), null);
  }
});
test("HTTP errors, mismatched MIME, redirects, ranges and encoded bodies never produce successful usage", async () => {
  for (const input of [response(wav, {}, 206), response(wav, {}, 422), response(wav, { "content-type": "audio/ogg" }),
    response(wav, { "content-type": "application/octet-stream" }), response(wav, { "content-type": "application/json" }),
    response(wav, { "content-range": "bytes 0-7/100" }), response(wav, { "content-encoding": "gzip" })]) {
    await assert.rejects(read(native(), input), /invalid_gradium_binary_response/);
  }
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(read(native(), redirected));
  for (const mime of ["audio/opus", "audio/ogg; codecs=vorbis", "audio/ogg; codecs=opus; codecs=vorbis"]) {
    await assert.rejects(read(native("opus"), response(opus, { "content-type": mime })));
  }
});
test("bounded EOF is required even without a length header; malformed, short and overlong lengths fail", async () => {
  const complete = await read(native(), response());
  assert.deepEqual(new Uint8Array(await complete.response.arrayBuffer()), wav);
  for (const length of ["-1", "1.5", "1, 1", "not-a-length", String(Number.MAX_SAFE_INTEGER + 1), String(limit + 1), String(wav.byteLength - 1), String(wav.byteLength + 1)]) {
    await assert.rejects(read(native(), response(wav, { "content-length": length })));
  }
  await assert.rejects(read(native(), response(new Uint8Array())));
  await assert.rejects(read(native(), new Response(null, { headers: { "content-type": "audio/wav" } })));
});
test("the exact output limit is accepted and a streamed overflow cancels without delivering partial audio", async () => {
  const bytes = new Uint8Array(limit); bytes.set(wav); bytes[limit - 1] = 17;
  const complete = await read(native(), response(bytes, { "content-length": String(limit) }));
  const result = new Uint8Array(await complete.response.arrayBuffer());
  assert.equal(result.byteLength, limit); assert.equal(result[limit - 1], 17);
  let canceled = false;
  const overflow = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(limit + 1)); }, cancel() { canceled = true; } });
  await assert.rejects(read(native(), response(overflow))); assert.equal(canceled, true);
});
test("disconnect and cancellation after partial audio remain uncertain and never return success", async () => {
  let sent = false;
  const broken = new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(wav.subarray(0, 8)); }
    else controller.error(new Error("synthetic disconnect"));
  } });
  await assert.rejects(read(native(), response(broken)), /invalid_gradium_binary_response/);
  const abort = new AbortController(); let canceled = false;
  const pending = new ReadableStream({ start(controller) { controller.enqueue(wav.subarray(0, 8)); }, cancel() { canceled = true; } });
  const result = read(native(), response(pending), abort.signal); abort.abort();
  await assert.rejects(result, /invalid_gradium_binary_response/); assert.equal(canceled, true);
  const already = new AbortController(); already.abort();
  await assert.rejects(read(native(), response(), already.signal));
});
