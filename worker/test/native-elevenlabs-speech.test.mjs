import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareNativeElevenLabsSpeech } = await import("../native-elevenlabs-speech.ts");
const { qualifyNativeQuery } = await import("../native-query.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/elevenlabs/speech.json", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/elevenlabs.provider.yaml", import.meta.url), "utf8"))]).providers[0];
const endpoint = provider.endpoints.find(endpoint => endpoint.id === "speech");
const mp3 = Uint8Array.from(Buffer.from(wire.response.base64, "base64")), limit = 16 * 1024 * 1024;
function selection(body = wire.request.body, query = wire.request.query) {
  const selected = { provider, endpoint, model: null, capability: "audio.speech", body: structuredClone(body), pathParams: { ...wire.request.pathParams }, method: "POST" };
  selected.nativeQuery = qualifyNativeQuery(selected, query, new URL("https://router.example/v1/proxy/elevenlabs/speech"));
  return selected;
}
const native = () => prepareNativeElevenLabsSpeech(selection());
const response = (bytes = mp3, headers = {}, status = 200) => new Response(bytes, { status, headers: { "content-type": "audio/mpeg", ...headers } });
async function read(prepared, input, signal = new AbortController().signal) {
  const lease = prepared.acquire();
  try { return await prepared.read(input, signal); } finally { lease.release(); }
}

test("ElevenLabs uses the actual compiled voice route, native JSON and immutable query binding", () => {
  const selected = selection(), before = structuredClone(selected.body), prepared = prepareNativeElevenLabsSpeech(selected);
  assert.deepEqual(selected.body, before); assert.equal(selected.model, null); assert.equal(provider.models.length, 0);
  assert.equal(prepared.origin, "https://api.elevenlabs.io"); assert.equal(prepared.path, wire.request.path);
  assert.equal(prepared.query, selected.nativeQuery); assert.equal(Object.isFrozen(prepared.query), true); assert.equal(prepared.tariff, undefined);
  assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path + "?" + new URLSearchParams(wire.request.query))));
  for (const url of [prepared.origin + prepared.path, prepared.origin + prepared.path + "?output_format=pcm_16000",
    prepared.origin + prepared.path + "?output_format=mp3_44100_128&optimize_streaming_latency=3",
    prepared.origin + prepared.path + "?output_format=mp3_44100_128&optimize_streaming_latency=2&key=synthetic",
    "https://other.example" + prepared.path]) assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  assert.equal(prepareNativeElevenLabsSpeech({ ...selected, endpoint: { ...endpoint, request_format: "openai.audio_speech" } }), undefined);
});

test("ElevenLabs requires the qualified binding and never derives its output format from body or defaults", () => {
  const selected = selection();
  for (const nativeQuery of [undefined, {}, { ...selected.nativeQuery }, Object.freeze({ ...selected.nativeQuery, outputFormat: "pcm_16000" }),
    Object.freeze({ ...selected.nativeQuery, protocol: "other" }), Object.freeze({ ...selected.nativeQuery, optimizeStreamingLatency: 2 }),
    Object.freeze({ ...selected.nativeQuery, extra: "synthetic" })]) assert.throws(() => prepareNativeElevenLabsSpeech({ ...selected, nativeQuery }));
  const defaults = prepareNativeElevenLabsSpeech(selection(wire.request.body, {}));
  assert.deepEqual(defaults.query, { protocol: "elevenlabs.speech", outputFormat: "mp3_44100_128" });
  for (const latency of ["0", "1", "2", "3", "4"]) assert.equal(prepareNativeElevenLabsSpeech(selection(wire.request.body, { optimize_streaming_latency: latency })).query.optimizeStreamingLatency, latency);
});

test("ElevenLabs rejects alternate routes, model selectors and unsupported streaming before dispatch", () => {
  const selected = selection();
  for (const change of [{ provider: { ...provider, id: "other" } }, { model: { upstream: "invented" } }, { method: "GET" },
    { capability: "chat.completions" }, { pathParams: {} }, { pathParams: { voice_id: "../other" } }, { pathParams: { ...selected.pathParams, model: "invented" } }])
    assert.throws(() => prepareNativeElevenLabsSpeech({ ...selected, ...change }));
  for (const change of [{ method: "GET" }, { path: "/v1/text-to-speech/${voice_id}/stream" }, { path_params: [] }, { upstreamPath: speechPath() },
    { query: { output_format: "mp3_44100_128" } }, { response_format: "openai.audio" }, { streaming: true }, { lifecycle: {} },
    { responsesLifecycle: {} }, { websocket: {} }, { modelPassthrough: true }]) assert.throws(() => prepareNativeElevenLabsSpeech({ ...selected, endpoint: { ...endpoint, ...change } }));
});
function speechPath() { return "/v1/text-to-speech/${voice_id}"; }

test("ElevenLabs validates actual frozen native settings without model aliasing or invented codec imports", () => {
  for (const change of [{ text: " " }, { text: "x".repeat(10_001) }, { text: "\ud800" }, { model: "invented" }, { model_id: "" },
    { stream: true }, { output_format: "mp3_44100_128" }, { seed: -1 }, { seed: 2 ** 32 }, { seed: 1.5 },
    { apply_text_normalization: "invalid" }, { language_code: "english" }, { voice_settings: null },
    { voice_settings: { stability: NaN } }, { voice_settings: { similarity_boost: 2 } }, { voice_settings: { style: -1 } },
    { voice_settings: { use_speaker_boost: "true" } }, { voice_settings: { speed: 0.4 } }, { voice_settings: { unknown: true } }])
    assert.throws(() => prepareNativeElevenLabsSpeech(selection({ ...wire.request.body, ...change })));
  for (const body of [{ ...wire.request.body, seed: 0, language_code: "en" }, { ...wire.request.body, seed: 2 ** 32 - 1, apply_text_normalization: "off" }]) {
    const selected = selection(body); prepareNativeElevenLabsSpeech(selected); assert.deepEqual(selected.body, body);
  }
});

test("ElevenLabs leases 32 MiB before dispatch and refuses exhausted capacity without successful usage", () => {
  const prepared = native(), baseline = bodyBudgetCharged(), lease = prepared.acquire();
  assert.equal(bodyBudgetCharged(), baseline + 2 * limit); lease.release(); assert.equal(bodyBudgetCharged(), baseline);
  const other = new BodyLease(); assert.equal(other.grow(40 * 1024 * 1024), true);
  try { assert.throws(() => prepared.acquire(), /capacity is busy/); } finally { other.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("ElevenLabs returns only complete byte-exact MP3 with null tokens and stripped upstream headers", async () => {
  const chunks = new ReadableStream({ start(controller) { for (const byte of mp3) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const result = await read(native(), response(chunks, { "content-length": String(mp3.length), "x-private-upstream": "synthetic" }));
  assert.deepEqual(new Uint8Array(await result.response.arrayBuffer()), mp3); assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  assert.equal(result.response.headers.get("content-type"), "audio/mpeg"); assert.equal(result.response.headers.get("content-length"), String(mp3.length));
  assert.equal(result.response.headers.get("x-private-upstream"), null);
});

test("ElevenLabs rejects upstream errors, unqualified MIME, redirects, ranges and encoded output", async () => {
  for (const input of [response(mp3, {}, 206), response(mp3, {}, 422), response(mp3, {}, 500),
    ...["audio/pcm", "audio/ogg", "audio/wav", "application/octet-stream", "audio/mpeg; codecs=opus"].map(mime => response(mp3, { "content-type": mime })),
    response(mp3, { "content-range": "bytes 0-7/100" }), response(mp3, { "content-encoding": "gzip" })])
    await assert.rejects(read(native(), input), /invalid_elevenlabs_binary_response/);
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(native(), redirected));
});

test("ElevenLabs requires bounded complete EOF with valid matching lengths", async () => {
  assert.deepEqual(new Uint8Array(await (await read(native(), response())).response.arrayBuffer()), mp3);
  for (const length of ["-1", "1.5", "1, 1", "invalid", String(Number.MAX_SAFE_INTEGER + 1), String(limit + 1), String(mp3.length - 1), String(mp3.length + 1)])
    await assert.rejects(read(native(), response(mp3, { "content-length": length })));
  await assert.rejects(read(native(), response(new Uint8Array())));
  await assert.rejects(read(native(), new Response(null, { headers: { "content-type": "audio/mpeg" } })));
  const large = new Uint8Array(limit); large.set(mp3); large[limit - 1] = 17;
  const full = await read(native(), response(large)); assert.equal((await full.response.arrayBuffer()).byteLength, limit);
  let canceled = false;
  const overflow = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(limit + 1)); }, cancel() { canceled = true; } });
  await assert.rejects(read(native(), response(overflow))); assert.equal(canceled, true);
});

test("ElevenLabs interruption and abort never expose partial HTTP200 audio or a free-work verdict", async () => {
  let first = true;
  const partial = new ReadableStream({ pull(c) { if (first) { first = false; c.enqueue(mp3.subarray(0, 4)); } else c.error(new Error("synthetic interrupted audio")); } });
  await assert.rejects(read(native(), response(partial)), /invalid_elevenlabs_binary_response/);
  const abort = new AbortController(); let canceled = false;
  const stalled = new ReadableStream({ start(c) { c.enqueue(mp3.subarray(0, 4)); }, cancel() { canceled = true; } });
  const pending = read(native(), response(stalled), abort.signal); abort.abort(); await assert.rejects(pending); assert.equal(canceled, true);
  const already = new AbortController(); already.abort(); await assert.rejects(read(native(), response(), already.signal));
});
for (const mode of ["headers", "abort", "cleanup-rejection"]) test(`source retirement holds capacity through ${mode}, including reentrant cancellation`, { timeout: 5000 }, async t => {
  const ready = Promise.withResolvers(), canceled = Promise.withResolvers(), cleanup = Promise.withResolvers();
  const abort = new AbortController(), baseline = bodyBudgetCharged();
  let cancels = 0, completed = false;
  const source = new ReadableStream({
    pull() { ready.resolve(); },
    cancel() { cancels++; abort.abort(); canceled.resolve(); return cleanup.promise; },
  }, { highWaterMark: 0 });
  const prepared = native(), lease = prepared.acquire();
  t.after(() => { cleanup.resolve(); lease.release(); });
  const result = prepared.read(response(source, mode === "headers" ? { "content-type": "application/json" } : {}), abort.signal)
    .finally(() => { completed = true; lease.release(); });
  const rejected = assert.rejects(result);
  if (mode !== "headers") { await ready.promise; abort.abort(); }
  await canceled.promise; await new Promise(setImmediate);
  assert.equal(cancels, 1); assert.equal(completed, false); assert.equal(source.locked, true);
  assert.equal(bodyBudgetCharged(), baseline + 32 * 1024 * 1024);
  const competing = new BodyLease();
  assert.equal(competing.grow(33 * 1024 * 1024), false); competing.release();
  if (mode === "cleanup-rejection") cleanup.reject(new Error("synthetic cleanup rejection")); else cleanup.resolve();
  await rejected;
  assert.equal(cancels, 1); assert.equal(source.locked, false);
  assert.equal(bodyBudgetCharged(), baseline);
  lease.release(); assert.equal(bodyBudgetCharged(), baseline);
});
