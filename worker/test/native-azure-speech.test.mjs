import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareNativeAzureSpeech } = await import("../native-azure-speech.ts");
const { prepareAzureSpeechSsml, azureSpeechSsmlLimit } = await import("../azure-speech-ssml.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/azure-speech/ssml.json", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/azure-speech.provider.yaml", import.meta.url), "utf8"))]).providers[0];
const endpoint = provider.endpoints.find(endpoint => endpoint.id === "speech");
const limit = 16 * 1024 * 1024, format = "audio-24khz-48kbitrate-mono-mp3";
// Offline silence: lavfi anullsrc, 24 kHz mono, libmp3lame 48 kbit/s, 0.05 s,
// write_xing=0/id3v2_version=0. This is transport evidence, not vendor audio.
const mp3 = Uint8Array.from(Buffer.from("//NkxAAAAANIAAAAAExBTUVVVVVMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NkxHwAAANIAAAAAFVVVVVVVVVMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NkxHwAAANIAAAAAFVVVVVVVVVMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NkxHwAAANIAAAAAFVVVVVVVVVMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NkxHwAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV", "base64"));
const input = () => ({ body: wire.request.body, contentType: "application/ssml+xml; charset=utf-8", outputFormat: format, region: "eastus" });
const selection = () => ({ provider, endpoint, model: null, capability: "audio.speech", body: {}, pathParams: {}, method: "POST" });
const native = () => prepareNativeAzureSpeech(selection(), input());
const response = (bytes = mp3, headers = {}, status = 200) => new Response(bytes, { status, headers: { "content-type": "audio/mpeg", ...headers } });
async function read(prepared, upstream, signal = new AbortController().signal) {
  const lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("Azure uses actual compiled regional SSML without mutating native input or inventing JSON/body overrides", () => {
  const selected = selection(), original = structuredClone(selected), raw = input(), before = { ...raw };
  const prepared = prepareNativeAzureSpeech(selected, raw);
  assert.deepEqual(selected, original); assert.deepEqual(raw, before); assert.equal(provider.models.length, 0);
  assert.equal(prepared.origin, "https://eastus.tts.speech.microsoft.com"); assert.equal(prepared.path, "/cognitiveservices/v1");
  assert.equal(prepared.query, undefined); assert.equal(prepared.tariff, undefined); assert.equal(prepared.body, undefined);
  assert.equal(prepareAzureSpeechSsml(raw.body, raw.contentType, raw.outputFormat).body, raw.body);
  assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
  for (const url of ["https://westus.tts.speech.microsoft.com" + prepared.path, prepared.origin + prepared.path + "?format=mp3",
    prepared.origin + "/other", "https://other.example" + prepared.path]) assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  assert.equal(prepareNativeAzureSpeech({ ...selected, endpoint: { ...endpoint, request_format: "openai.audio_speech" } }, raw), undefined);
});

test("Azure rejects alternate routes, model selectors, query and streaming before dispatch", () => {
  for (const change of [{ provider: { ...provider, id: "azure" } }, { model: { upstream: "invented" } }, { method: "GET" },
    { capability: "chat.completions" }, { pathParams: { region: "westus" } }, { nativeQuery: {} }])
    assert.throws(() => prepareNativeAzureSpeech({ ...selection(), ...change }, input()));
  for (const change of [{ method: "GET" }, { path: "/cognitiveservices/v2" }, { upstreamPath: endpoint.path }, { path_params: ["region"] },
    { query: { region: "westus" } }, { response_format: "openai.audio" }, { streaming: true }, { lifecycle: {} },
    { responsesLifecycle: {} }, { websocket: {} }, { modelPassthrough: true }])
    assert.throws(() => prepareNativeAzureSpeech({ ...selection(), endpoint: { ...endpoint, ...change } }, input()));
});

test("Azure requires explicit MP3 and UTF-8 SSML while retaining the selected public region", () => {
  for (const contentType of ["application/ssml+xml", " application/ssml+xml; charset=\"UTF-8\" "])
    assert.ok(prepareNativeAzureSpeech(selection(), { ...input(), contentType }));
  for (const outputFormat of [undefined, "mp3", "ogg-24khz-16bit-mono-opus", "raw-8khz-8bit-mono-mulaw"])
    assert.throws(() => prepareNativeAzureSpeech(selection(), { ...input(), outputFormat }));
  for (const contentType of [undefined, "application/json", "application/ssml+xml; charset=utf-16", "application/ssml+xml; x=1", "application/ssml+xml; charset=utf-8; charset=utf-8"])
    assert.throws(() => prepareNativeAzureSpeech(selection(), { ...input(), contentType }));
  for (const region of [undefined, "", "EASTUS", "eastus.example.com", "../eastus", "eastus@host", "x".repeat(33)])
    assert.throws(() => prepareNativeAzureSpeech(selection(), { ...input(), region }));
  assert.equal(prepareNativeAzureSpeech(selection(), { ...input(), region: "westus2" }).origin, "https://westus2.tts.speech.microsoft.com");
});

test("Azure validates the real SSML byte bound, XML and character evidence without token or invoice conversion", () => {
  const raw = input(), text = "Synthetic café &amp; 中文 😀";
  for (const body of [undefined, "\uFEFF" + raw.body, raw.body.replace(text, "\ud800"), raw.body.replace(text, "<audio src=\"https://audio.example\"/>"),
    raw.body.replace(text, "&#38;"), raw.body.replace(text, " "), raw.body.replace(text, "x".repeat(azureSpeechSsmlLimit)),
    raw.body.replace(text, "中".repeat(Math.floor(azureSpeechSsmlLimit / 3)))])
    assert.throws(() => prepareNativeAzureSpeech(selection(), { ...raw, body }));
  const overhead = new TextEncoder().encode(raw.body.replace(text, "")).length;
  const exact = raw.body.replace(text, "x".repeat(azureSpeechSsmlLimit - overhead));
  assert.equal(new TextEncoder().encode(exact).length, azureSpeechSsmlLimit);
  assert.ok(prepareNativeAzureSpeech(selection(), { ...raw, body: exact }));
  const qualified = prepareAzureSpeechSsml(raw.body, raw.contentType, raw.outputFormat);
  assert.equal(qualified.characterUpperBound, text.length * 2); assert.equal(qualified.inputCodePoints, [..."Synthetic café & 中文 😀"].length);
  assert.equal(native().tariff, undefined);
});

test("Azure leases 32 MiB before dispatch and denies exhausted capacity without output usage", () => {
  const prepared = native(), baseline = bodyBudgetCharged(), lease = prepared.acquire();
  assert.equal(bodyBudgetCharged(), baseline + 2 * limit); lease.release(); assert.equal(bodyBudgetCharged(), baseline);
  const other = new BodyLease(); assert.equal(other.grow(40 * 1024 * 1024), true);
  try { assert.throws(() => prepared.acquire(), /capacity is busy/); } finally { other.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("Azure returns complete unchanged MP3 with null tokens and removes upstream headers", async () => {
  const chunks = new ReadableStream({ start(c) { for (const byte of mp3) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const result = await read(native(), response(chunks, { "content-length": String(mp3.length), "x-private-upstream": "synthetic" }));
  assert.deepEqual(new Uint8Array(await result.response.arrayBuffer()), mp3); assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  assert.equal(result.response.headers.get("content-type"), "audio/mpeg"); assert.equal(result.response.headers.get("content-length"), String(mp3.length));
  assert.equal(result.response.headers.get("x-private-upstream"), null); assert.equal(result.response.headers.get("cache-control"), "no-store");
});

test("Azure rejects HTTP errors, redirects, ranges, encoded output and unqualified MIME without relabeling", async () => {
  for (const upstream of [response(mp3, {}, 206), response(mp3, {}, 302), response(mp3, {}, 422), response(mp3, {}, 500),
    ...["audio/pcm", "audio/ogg", "audio/wav", "application/octet-stream", "audio/mpeg; codecs=opus"].map(mime => response(mp3, { "content-type": mime })),
    response(mp3, { "content-range": "bytes 0-7/100" }), response(mp3, { "content-encoding": "gzip" })])
    await assert.rejects(read(native(), upstream), /invalid_azure_speech_binary_response/);
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(native(), redirected));
});

test("Azure requires nonempty complete EOF and bounded matching lengths, cancelling overflow", async () => {
  assert.deepEqual(new Uint8Array(await (await read(native(), response())).response.arrayBuffer()), mp3);
  for (const length of ["-1", "1.5", "1, 1", "invalid", String(Number.MAX_SAFE_INTEGER + 1), String(limit + 1), "0", String(mp3.length - 1), String(mp3.length + 1)])
    await assert.rejects(read(native(), response(mp3, { "content-length": length })));
  await assert.rejects(read(native(), response(new Uint8Array())));
  await assert.rejects(read(native(), new Response(null, { headers: { "content-type": "audio/mpeg" } })));
  const large = new Uint8Array(limit); large.set(mp3); large[limit - 1] = 17;
  const full = await read(native(), response(large)); assert.equal((await full.response.arrayBuffer()).byteLength, limit);
  let canceled = false;
  const overflow = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(limit + 1)); }, cancel() { canceled = true; } });
  await assert.rejects(read(native(), response(overflow))); assert.equal(canceled, true);
});

test("Azure interruption and abort expose neither partial HTTP200 bytes nor a free-work verdict", async () => {
  let first = true;
  const partial = new ReadableStream({ pull(c) { if (first) { first = false; c.enqueue(mp3.subarray(0, 4)); } else c.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(native(), response(partial)), { message: "invalid_azure_speech_binary_response" });
  const abort = new AbortController(); let canceled = false;
  const stalled = new ReadableStream({ start(c) { c.enqueue(mp3.subarray(0, 4)); }, cancel() { canceled = true; } });
  const pending = read(native(), response(stalled), abort.signal); abort.abort(); await assert.rejects(pending); assert.equal(canceled, true);
  const already = new AbortController(); already.abort(); await assert.rejects(read(native(), response(), already.signal));
});
