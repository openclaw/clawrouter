import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareNativeGoogleMediaUnderstanding } = await import("../native-google-media-understanding.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/media-understanding.json", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"))]).providers[0];
const generic = provider.endpoints.find(value => value.id === "generate_content");
// Offline 16x16 H.264 blue frame, ffmpeg/libx264; decoder-qualified, no vendor asset.
const video = Buffer.from("AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAsBtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB53RyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAABAAAAAAAYNtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAEubWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA7nN0YmwAAACic3RzZAAAAAAAAAABAAAAkmF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAEMTGF2YyBsaWJ4MjY0AAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAAAsYXZjQwFCwAr/4QAVZ0LACtp7ARAAAAMAEAAAAwAg8SJqAQAEaM4PyAAAABBwYXNwAAAAAQAAAAEAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAChtdmV4AAAAIHRyZXgAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAAA9dWR0YQAAADVtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAAhpbHN0AAAAaG1vb2YAAAAQbWZoZAAAAAAAAAABAAAAUHRyYWYAAAAcdGZoZAACADgAAAABAABAAAAAAm4BAQAAAAAAFHRmZHQBAAAAAAAAAAAAAAAAAAAYdHJ1bgAAAAUAAAABAAAAcAIAAAAAAAJ2bWRhdAAAAlMGBf//T9xF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0xIGRlYmxvY2s9MDowOjAgYW5hbHlzZT0wOjAgbWU9ZGlhIHN1Ym1lPTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTAgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9MCB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MACAAAAAE2WIhDoRigACMXHAAEPKOAAIBeAAAABDbWZyYQAAACt0ZnJhAQAAAAAAAAEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAtwBAQEAAAAQbWZybwAAAAAAAABD", "base64");
function wave(total = 1004) {
  const bytes = Buffer.alloc(total); bytes.write("RIFF"); bytes.writeUInt32LE(total - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(total - 44, 40); return bytes;
}
// Candidate leaf selections; actual declaration/dispatch qualification is separate.
function selection(mode = "audio", bytes = mode === "audio" ? wave() : video) {
  const body = structuredClone(wire[mode]); body.contents[0].parts[1].inline_data.data = bytes.toString("base64");
  const capability = mode === "audio" ? "audio.transcription" : "video.understanding";
  return { provider, endpoint: { ...generic, modelPassthrough: undefined, request_format: `google.${mode}_understanding`, response_format: "google.generate_content" },
    model: { id: "google/" + wire.model, upstream: wire.model, capabilities: [capability] }, capability, body, pathParams: { model: wire.model }, method: "POST" };
}
const payload = () => structuredClone(wire.response), response = (body = payload(), headers = {}, status = 200) => Response.json(body, { headers, status });
async function read(upstream, signal = new AbortController().signal) {
  const prepared = prepareNativeGoogleMediaUnderstanding(selection()), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("inline media wrapper preserves both frozen modality bodies, playable bytes and exact selected destination", () => {
  for (const mode of ["audio", "video"]) {
    const selected = selection(mode), before = structuredClone(selected), prepared = prepareNativeGoogleMediaUnderstanding(selected);
    assert.deepEqual(selected, before); assert.equal(prepared.origin, "https://generativelanguage.googleapis.com"); assert.equal(prepared.path, wire.path);
    assert.equal(prepared.tariff, undefined); assert.equal(prepared.query, undefined);
    assert.deepEqual(Buffer.from(selected.body.contents[0].parts[1].inline_data.data, "base64"), mode === "audio" ? wave() : video);
    assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
    for (const url of [prepared.origin + prepared.path + "?alt=sse", prepared.origin + prepared.path + "?key=synthetic", "https://other.example" + prepared.path])
      assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  }
  assert.equal(prepareNativeGoogleMediaUnderstanding({ ...selection(), endpoint: { ...generic, request_format: "google.generate_content" } }), undefined);
});

test("inline media denies wrong models, modalities, path selectors, query and generic bypass options", () => {
  const selected = selection(), endpoint = selected.endpoint;
  for (const change of [{ provider: { ...provider, id: "google" } }, { model: null }, { model: { upstream: "gemini-3.8-flash" } },
    { capability: "video.understanding" }, { method: "GET" }, { pathParams: { model: "other" } }, { nativeQuery: {} }])
    assert.throws(() => prepareNativeGoogleMediaUnderstanding({ ...selected, ...change }));
  for (const change of [{ path: "/v1beta/interactions" }, { path_params: [] }, { method: "GET" }, { upstreamPath: endpoint.path },
    { response_format: "google.image" }, { query: { alt: "sse" } }, { streaming: true }, { lifecycle: {} }, { responsesLifecycle: {} },
    { websocket: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => prepareNativeGoogleMediaUnderstanding({ ...selected, endpoint: { ...endpoint, ...change } }));
});

test("inline media requires explicit qualified MIME and canonical container bytes without defaulting or asset authority", () => {
  for (const mode of ["audio", "video"]) {
    for (const mime of [undefined, null, ["audio/wav"], "application/octet-stream", mode === "audio" ? "audio/mp3" : "video/webm"]) {
      const selected = selection(mode); selected.body.contents[0].parts[1].inline_data.mime_type = mime; assert.throws(() => prepareNativeGoogleMediaUnderstanding(selected));
    }
    assert.throws(() => prepareNativeGoogleMediaUnderstanding(selection(mode, Buffer.from([0, 1, 2, 3]))));
    const remote = selection(mode); remote.body.contents[0].parts[1] = { file_data: { file_uri: "https://assets.example/media" } };
    assert.throws(() => prepareNativeGoogleMediaUnderstanding(remote));
    for (const change of [{ tools: [] }, { cachedContent: "unowned" }, { generationConfig: { responseModalities: ["AUDIO"] } }]) {
      const selected = selection(mode); Object.assign(selected.body, change); assert.throws(() => prepareNativeGoogleMediaUnderstanding(selected));
    }
  }
  assert.throws(() => prepareNativeGoogleMediaUnderstanding(selection("audio", video)));
  assert.throws(() => prepareNativeGoogleMediaUnderstanding(selection("video", wave())));
  const noncanonical = selection(); noncanonical.body.contents[0].parts[1].inline_data.data = "AAECAw"; assert.throws(() => prepareNativeGoogleMediaUnderstanding(noncanonical));
});

test("inline audio rejects malformed WAV sizes, alignment, channel or rate fields", () => {
  for (const offset of [4, 16, 20, 22, 24, 28, 32, 34, 40]) {
    const bytes = wave(); bytes[offset] ^= 1; assert.throws(() => prepareNativeGoogleMediaUnderstanding(selection("audio", bytes)));
  }
  assert.throws(() => prepareNativeGoogleMediaUnderstanding(selection("audio", wave().subarray(0, -1))));
});

test("inline video validates bounded MP4 boxes and a video track without claiming a duration invoice", () => {
  for (const bytes of [video.subarray(0, -1), Buffer.concat([video, Buffer.from([0])]), Buffer.from(video)]) {
    if (bytes.length === video.length) bytes.writeUInt32BE(1, 0);
    assert.throws(() => prepareNativeGoogleMediaUnderstanding(selection("video", bytes)));
  }
  const noVideo = Buffer.from(video), at = noVideo.indexOf("vide"); assert.ok(at > 0); noVideo.write("soun", at);
  assert.throws(() => prepareNativeGoogleMediaUnderstanding(selection("video", noVideo)));
  const badBrand = Buffer.from(video); badBrand.write("qt  ", 8); assert.throws(() => prepareNativeGoogleMediaUnderstanding(selection("video", badBrand)));
});

test("inline media input and output capacity fits the shared pool and refuses exhausted pre-dispatch admission", () => {
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(8 * 1024 * 1024), true);
  const prepared = prepareNativeGoogleMediaUnderstanding(selection()), output = prepared.acquire();
  assert.equal(bodyBudgetCharged(), baseline + 48 * 1024 * 1024); output.release(); input.release(); assert.equal(bodyBudgetCharged(), baseline);
  const occupied = new BodyLease(); assert.equal(occupied.grow(33 * 1024 * 1024), true);
  try { assert.throws(() => prepared.acquire(), /capacity is busy/); } finally { occupied.release(); }
  assert.ok(prepareNativeGoogleMediaUnderstanding(selection("audio", wave(4 * 1024 * 1024))));
  assert.throws(() => prepareNativeGoogleMediaUnderstanding(selection("audio", wave(4 * 1024 * 1024 + 2))));
  const huge = selection(); huge.body.contents[0].parts[1].inline_data.data = "A".repeat(8 * 1024 * 1024); assert.throws(() => prepareNativeGoogleMediaUnderstanding(huge));
});

test("inline media returns complete native final text and usage with no token or duration cost inference", async () => {
  const result = await read(response(payload(), { "x-private-upstream": "synthetic" }));
  assert.deepEqual(await result.response.json(), wire.response); assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  assert.equal(result.usage.requestCostReceipt, undefined); assert.equal(result.response.headers.get("x-private-upstream"), null);
  const body = payload(); body.candidates[0].content.parts.unshift({ thought: true, text: "synthetic-private-thought", thoughtSignature: "synthetic" });
  assert.deepEqual(await (await read(response(body))).response.json(), wire.response);
});

test("inline media rejects partial, blocked, thought-only and mixed generated-media or tool output", async () => {
  for (const reason of [undefined, "MAX_TOKENS", "SAFETY"]) { const body = payload(); body.candidates[0].finishReason = reason; await assert.rejects(read(response(body))); }
  for (const body of [{ ...payload(), error: {} }, { ...payload(), promptFeedback: { blockReason: "SAFETY" } }, { candidates: [] }]) await assert.rejects(read(response(body)));
  for (const part of [{ thought: true, text: "only thought" }, { text: " " }, { text: "prefix", file_data: {} },
    { text: "prefix", function_call: {} }, { inlineData: { mimeType: "image/png", data: "AA==" } }]) {
    const body = payload(); body.candidates[0].content.parts = [part]; await assert.rejects(read(response(body)));
  }
});

test("inline media requires bounded complete HTTP200 JSON with valid EOF and exact declared lengths", async () => {
  const text = JSON.stringify(payload()), headers = { "content-type": "application/json" }, limit = 1024 * 1024;
  const exact = text + " ".repeat(limit - Buffer.byteLength(text)); assert.ok(await read(new Response(exact, { headers })));
  await assert.rejects(read(new Response(exact + " ", { headers })));
  for (const length of ["-1", "1.5", "bad", String(limit + 1), String(Buffer.byteLength(text) - 1), String(Buffer.byteLength(text) + 1)])
    await assert.rejects(read(new Response(text, { headers: { ...headers, "content-length": length } })));
  await assert.rejects(read(new Response(text, { headers: { ...headers, "content-encoding": "identity", "content-length": "1" } })));
  for (const status of [202, 206, 302, 422, 500]) await assert.rejects(read(response(payload(), {}, status)));
  for (const extra of [{ "content-type": "text/plain" }, { "content-range": "bytes 0-1/100" }, { "content-encoding": "gzip" }]) await assert.rejects(read(response(payload(), extra)));
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  await assert.rejects(read(new Response(new Uint8Array([0xff]), { headers })));
});

test("inline media abort, timeout and interrupted delivery never publish a prefix or authorize replay", async () => {
  const prefix = new TextEncoder().encode(JSON.stringify(payload()).slice(0, -1)), headers = { "content-type": "application/json" }; let first = true;
  const broken = new ReadableStream({ pull(c) { if (first) { first = false; c.enqueue(prefix); } else c.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(new Response(broken, { headers })), { message: "invalid_native_google_media_understanding_response" });
  for (const name of ["AbortError", "TimeoutError"]) {
    const controller = new AbortController(); let canceled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(prefix); }, cancel() { canceled = true; } });
    const pending = read(new Response(stream, { headers }), controller.signal); controller.abort(new DOMException("synthetic", name));
    await assert.rejects(pending); assert.equal(canceled, true);
  }
});
