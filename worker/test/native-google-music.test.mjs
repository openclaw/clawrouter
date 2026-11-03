import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareNativeGoogleMusic } = await import("../native-google-music.ts");
const { observeGoogleMusic, prepareGoogleMusic } = await import("../google-music.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/music.json", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"))]).providers[0];
// A proposed leaf selection, not a declaration or actual routing activation.
const endpoint = { ...provider.endpoints.find(value => value.id === "generate_content"), modelPassthrough: undefined,
  request_format: "google.music_generate", response_format: "google.music" };
const jsonLimit = 8 * 1024 * 1024, audioLimit = 4 * 1024 * 1024;
// Offline 44.1 kHz stereo 192 kbit/s silence, ffmpeg/libmp3lame; no vendor audio.
const mp3 = Buffer.from("//uwZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+7JkAA/wAABpAAAACAAADSAAAAEAAAGkAAAAIAAANIAAAARMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+7JkAA/wAABpAAAACAAADSAAAAEAAAGkAAAAIAAANIAAAARMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=", "base64");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=";
function wave(total = 1808) {
  const bytes = Buffer.alloc(total); bytes.write("RIFF"); bytes.writeUInt32LE(total - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(176400, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(total - 44, 40); return bytes;
}
const selection = (upstream = "lyria-3-clip-preview", body = structuredClone(wire.request.body)) => ({ provider, endpoint,
  model: { id: "google/" + upstream, upstream, capabilities: ["audio.generate"] }, capability: "audio.generate", body, pathParams: { model: upstream }, method: "POST" });
const native = model => prepareNativeGoogleMusic(selection(model));
const payload = (mimeType = "audio/mpeg", data = mp3) => ({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [
  { text: "Synthetic lyrics remain unchanged." }, { inlineData: { mimeType, data: data.toString("base64") } },
] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9, thoughtsTokenCount: 2, totalTokenCount: 16 } });
const response = (body = payload(), headers = {}, status = 200) => Response.json(body, { headers, status });
async function read(upstream, model, signal = new AbortController().signal) {
  const prepared = native(model), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("Lyria wrapper preserves both frozen native selections, original JSON and exact destination", () => {
  for (const model of ["lyria-3-clip-preview", "lyria-3-pro-preview"]) {
    const selected = selection(model), before = structuredClone(selected), prepared = prepareNativeGoogleMusic(selected);
    assert.deepEqual(selected, before); assert.equal(prepared.origin, "https://generativelanguage.googleapis.com");
    assert.equal(prepared.path, `/v1beta/models/${model}:generateContent`); assert.equal(prepared.tariff, undefined); assert.equal(prepared.query, undefined);
    assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
    for (const url of [prepared.origin + prepared.path + "?key=synthetic", prepared.origin + prepared.path + "?alt=sse", "https://other.example" + prepared.path])
      assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  }
  assert.equal(prepareNativeGoogleMusic({ ...selection(), endpoint: { ...endpoint, request_format: "google.generate_content" } }), undefined);
});

test("Lyria wrapper rejects newer identities, mismatched selectors, stream/query paths and tariff overrides", () => {
  for (const model of ["lyria-3.5", "lyria-realtime-exp", "google/lyria-3-clip-preview"]) assert.throws(() => prepareNativeGoogleMusic(selection(model)));
  for (const change of [{ provider: { ...provider, id: "google" } }, { model: null }, { method: "GET" }, { capability: "llm.generate" },
    { pathParams: { model: "lyria-3-pro-preview" } }, { pathParams: { ...selection().pathParams, extra: "x" } }, { nativeQuery: {} }])
    assert.throws(() => prepareNativeGoogleMusic({ ...selection(), ...change }));
  for (const change of [{ method: "GET" }, { path: "/v1beta/models/${model}:streamGenerateContent" }, { path_params: [] },
    { upstreamPath: endpoint.path }, { response_format: "google.generate_content" }, { query: { alt: "sse" } }, { modelPassthrough: {} },
    { streaming: true }, { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { requestPricing: {} }])
    assert.throws(() => prepareNativeGoogleMusic({ ...selection(), endpoint: { ...endpoint, ...change } }));
});

test("Lyria inline inputs require explicit matching MIME and native prompt composition without file authority", () => {
  const body = part => ({ ...structuredClone(wire.request.body), contents: [{ role: "user", parts: [{ text: "Keep these lyrics and composition." }, part] }] });
  const valid = body({ inlineData: { mimeType: "image/png", data: png } });
  assert.ok(prepareNativeGoogleMusic(selection(undefined, valid)));
  for (const part of [{ inlineData: { data: png } }, { inlineData: { mimeType: ["image/png"], data: png } },
    { inlineData: { mimeType: "image/jpeg", data: png } }, { inlineData: { mimeType: "image/heif", data: png } },
    { inlineData: { mimeType: "image/png", data: png.replace(/=+$/, "") } }, { fileData: { fileUri: "https://assets.example/private" } },
    { inlineData: { mimeType: "audio/mpeg", data: mp3.toString("base64") } }]) assert.throws(() => prepareNativeGoogleMusic(selection(undefined, body(part))));
  for (const change of [{ tools: [] }, { cachedContent: "cachedContents/synthetic" }, { responseFormat: "wav" }])
    assert.throws(() => prepareNativeGoogleMusic(selection(undefined, { ...wire.request.body, ...change })));
  assert.throws(() => prepareNativeGoogleMusic(selection(undefined, body({ inlineData: { mimeType: "image/png", data: "A".repeat(jsonLimit) } }))));
});

test("Lyria pre-dispatch lease charges 64 MiB and refuses exhausted shared capacity", () => {
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(jsonLimit), true);
  const output = native().acquire(); assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
  output.release(); input.release(); assert.equal(bodyBudgetCharged(), baseline);
  const other = new BodyLease(); assert.equal(other.grow(20 * 1024 * 1024), true);
  try { assert.throws(() => native().acquire(), /capacity is busy/); } finally { other.release(); }
});

test("Lyria complete MP3 and Pro PCM16 WAV preserve bytes, lyrics and native usage without billing inference", async () => {
  for (const [model, mime, bytes] of [["lyria-3-clip-preview", "audio/mpeg", mp3], ["lyria-3-pro-preview", "audio/mpeg", mp3], ["lyria-3-pro-preview", "audio/wav", wave()]]) {
    const body = payload(mime, bytes), result = await read(response(body, { "x-private-upstream": "synthetic" }), model);
    const delivered = await result.response.json(); assert.deepEqual(delivered, body);
    assert.deepEqual(Buffer.from(delivered.candidates[0].content.parts[1].inlineData.data, "base64"), bytes);
    assert.deepEqual(result.usage, { tokens: null, outcome: "success" }); assert.equal(result.usage.requestCostReceipt, undefined);
    assert.equal(result.response.headers.get("x-private-upstream"), null);
  }
  await assert.rejects(read(response(payload("audio/wav", wave())), "lyria-3-clip-preview"));
});

test("Lyria missing MIME compatibility default never qualifies explicit wrapper output", async () => {
  const absent = payload(); delete absent.candidates[0].content.parts[1].inlineData.mimeType;
  assert.equal(observeGoogleMusic(absent, prepareGoogleMusic("lyria-3-clip-preview", wire.request.body), true).track.mimeType, "audio/mpeg");
  await assert.rejects(read(response(absent)));
  for (const mime of [null, ["audio/mpeg"], "audio/mp3", "application/octet-stream", "audio/pcm", "audio/mpeg; codecs=mp3"])
    await assert.rejects(read(response(payload(mime))));
  await assert.rejects(read(response(payload("audio/mpeg", wave()))));
});

test("Lyria rejects truncated MP3 frames, malformed tags and invalid WAV chunk or PCM framing", async () => {
  for (const bytes of [mp3.subarray(0, -1), Buffer.from([255, 251, 144, 0]), Buffer.concat([mp3, Buffer.from([0])]), Buffer.from("ID3\x04\0\0\x7f\x7f\x7f\x7f")])
    await assert.rejects(read(response(payload("audio/mpeg", bytes))));
  for (const offset of [4, 20, 22, 28, 32, 34, 40]) {
    const bytes = wave(); bytes[offset] ^= 1; await assert.rejects(read(response(payload("audio/wav", bytes)), "lyria-3-pro-preview"));
  }
  const unpadded = payload(); unpadded.candidates[0].content.parts[1].inlineData.data = "YQ"; await assert.rejects(read(response(unpadded)));
});

test("Lyria removes thought tracks while preserving final lyrics and usage metadata", async () => {
  const body = payload(); body.candidates[0].content.parts.unshift({ thought: true, inlineData: { data: "synthetic-private-thought" } });
  const delivered = await (await read(response(body))).response.json(); assert.deepEqual(delivered, payload());
  assert.equal(body.candidates[0].content.parts.length, 3); assert.equal(JSON.stringify(delivered).includes("synthetic-private-thought"), false);
});

test("Lyria text-only, duplicate tracks, blocked or nonterminal results never publish a prefix or retry instruction", async () => {
  for (const reason of [undefined, "MAX_TOKENS", "SAFETY", "OTHER"]) { const body = payload(); body.candidates[0].finishReason = reason; await assert.rejects(read(response(body))); }
  const text = payload(); text.candidates[0].content.parts.pop(); await assert.rejects(read(response(text)));
  const duplicate = payload(); duplicate.candidates[0].content.parts.push(duplicate.candidates[0].content.parts[1]); await assert.rejects(read(response(duplicate)));
  for (const body of [{ ...payload(), error: {} }, { ...payload(), promptFeedback: { blockReason: "SAFETY" } }]) await assert.rejects(read(response(body)));
  const remote = payload(); remote.candidates[0].content.parts.push({ text: "file", fileData: { fileUri: "https://assets.example/audio.mp3" } }); await assert.rejects(read(response(remote)));
});

test("Lyria decoded-track and JSON bounds admit exact limits and reject overflow", async () => {
  const body = payload("audio/wav", wave(audioLimit));
  assert.equal(Buffer.from((await (await read(response(body), "lyria-3-pro-preview")).response.json()).candidates[0].content.parts[1].inlineData.data, "base64").length, audioLimit);
  await assert.rejects(read(response(payload("audio/wav", wave(audioLimit + 4))), "lyria-3-pro-preview"));
  const text = JSON.stringify(payload()), exact = text + " ".repeat(jsonLimit - Buffer.byteLength(text)), headers = { "content-type": "application/json" };
  assert.ok(await read(new Response(exact, { headers })));
  await assert.rejects(read(new Response(exact + " ", { headers })));
});

test("Lyria requires complete HTTP200 UTF-8 EOF and correct lengths without redirects, ranges or encoded bodies", async () => {
  const text = JSON.stringify(payload()), headers = { "content-type": "application/json" };
  for (const length of ["-1", "1.5", "bad", String(jsonLimit + 1), String(Buffer.byteLength(text) - 1), String(Buffer.byteLength(text) + 1)])
    await assert.rejects(read(new Response(text, { headers: { ...headers, "content-length": length } })));
  await assert.rejects(read(new Response(text, { headers: { ...headers, "content-encoding": "identity", "content-length": "1" } })));
  for (const status of [202, 206, 302, 422, 500]) await assert.rejects(read(response(payload(), {}, status)));
  for (const override of [{ "content-type": "text/plain" }, { "content-range": "bytes 0-1/100" }, { "content-encoding": "gzip" }]) await assert.rejects(read(response(payload(), override)));
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  for (const bytes of [new Uint8Array([0xff]), '{"candidates":']) await assert.rejects(read(new Response(bytes, { headers })));
});

test("Lyria abort, timeout and interrupted delivery cancel local reading without partial success or free-work evidence", async () => {
  const prefix = new TextEncoder().encode(JSON.stringify(payload()).slice(0, -1)), headers = { "content-type": "application/json" };
  let first = true;
  const broken = new ReadableStream({ pull(c) { if (first) { first = false; c.enqueue(prefix); } else c.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(new Response(broken, { headers })), { message: "invalid_native_google_music_response" });
  for (const name of ["AbortError", "TimeoutError"]) {
    const controller = new AbortController(); let canceled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(prefix); }, cancel() { canceled = true; } });
    const pending = read(new Response(stream, { headers }), undefined, controller.signal); controller.abort(new DOMException("synthetic", name));
    await assert.rejects(pending); assert.equal(canceled, true);
  }
});
