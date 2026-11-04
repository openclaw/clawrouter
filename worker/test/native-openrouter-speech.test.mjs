import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
const { prepareNativeOpenRouterSpeech: prepare } = await import("../native-openrouter-speech.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
// Reuse the offline, decoder-verified 24 kHz mono / 128 kbps MP3 test tone from
// native-xai-speech.test.mjs. This is not OpenRouter synthesis or billing proof.
const fixture = {"base64":"//PExABJDAo0AVx4ATRqNNGo80mmzUqvNbr01yqzRJJMGJA4FKD5vVPz+M+juz0eFOxzs4a2zVZ9MrjsxaITFwkMQB4w8IDEQkMRB4w0FjCQOMEAQtYBjAdwBOAAwAWARgqxMzLOgtgtgmgmg9BcFBEvDT5pmmh6vj0f7gMDI8pl+yRNXvvEB4r399+937OrGR5SlHjxkV7O/fv379+zqxkePHjx48ZFer379+/fv2dWKx48ePHjxkV7O/fv379+/VjI8ePHjx48Z379+/fv379kePHjx48ePGd+/fv379+/ePHjx48ePHj9+/fv379+/ePHjx48ePHj9+/fv379+/ePHjx48ePHj9+/fv379/HePHjx48ePIj9+/fv37+94kB48ePKUpe8N+/uHhgAAAAAqAADAYMBYUabTMHxGMSRaeJYUwcBIwvF8yPcI9yRQlSc+pHIw4ZY2if0z7JoxREYWChiBiwXBgyN5gC5lB5jCIYcZunQbbCSzhC1QFFpi//PExE5krDpgX53QAMstFCCD10K8M03Ea4qnzIJUxUhXCXcsNImmL8nnEMPoEUk3VsxNIGN31clrMSf52m8nn4eS0/BspZi4gEVmsfmLcABDKYy/s1Go1VbyXO48lM/DyG8nmXjGKUm4imZfGMQm0eymM1qamq0tLlTPxCKaHIRTQ5IDGojCDTPIzGnjCBzOHzGmDCAzNG6amxxx1llvHHVM/EIpn4hFM/EgrQ5IDMpDIBzUJTMnjJAzTITMmgElNIdMyWByU0RmmtY0uOsst48/L/+tDk5WhycrRSirRS9Wll6sY0QJETJCzGhBYiZISY0EPETIBTGgCYiZAGAjRWKMcBBRrX/v/y3+Osq28auWVbHGlll65LOXJZy5LOXJZ9yxu5YzuWCIoAjoONDxQDGQg0NFAUZDDQsUBxkONCRQIKiRoOKBhUaNBhQOIjxorFUwhDGRJAY0i6Y4mEGTBqjo7D78jaDTGsDeuDTjkbzFDwgiIRBlzxjA6CqXqAVB//PExC5O7Do0Cdp4ANYK9SCYssEhFxHpE1FxOFJCTAphcTRNEnJOUJXQ3g1ROVCnTRNFQrogwhRcWVhQ00VS3EqE2NFxgp1DUJXQkwOYlrjBTpoqFeEmCPFxmynTRUK8N4NUXGJthOVQrxbh6lDTcFWsrUW4epQ0jQVaytRbh6lDJGlVrK1FuHqUMkaVWsrUX4epQyPssLLIX4gyhkfZYWWQvxOlTCZrsLLIX4nSphM12FlkL8TpUtzNdhZZC/E6VLczXYWWQvxOlS3M13rLIX4nSpbldt69kOYnSpbldO9eyHMTplYldO9eyHMTplYldO9eyHMTplYldPBeyHMTplYldPBeyHMTplYlFPBeyHMTpxYlFGgvZDmJ0kxBTUU0LjCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq","bytes":1152,"sha256":"9048e9affe6127656a008c1d51225ef0283fc1ac439d59b1bc3a6f083c5e550c","decodedPcmBytes":3456};
const audio = Buffer.from(fixture.base64, "base64");
const models = ["hexgrad/kokoro-82m", "elevenlabs/eleven-turbo-v2", "mistralai/voxtral-mini-tts-2603"];
const provider = { id: "openrouter", base_urls: { default: "https://openrouter.ai/api" } };
const endpoint = { method: "POST", path: "/v1/audio/speech", request_format: "openai.audio_speech",
  response_format: "audio.binary", path_params: [], query: {} };
function selection(model = models[0], extra = {}) {
  return { provider, endpoint, model: { upstream: model, capabilities: ["audio.speech"] }, capability: "audio.speech",
    method: "POST", pathParams: {}, body: { model, input: "Synthetic speech.", voice: "af_alloy", response_format: "mp3", ...extra } };
}
function response(headers = {}, bytes = audio, status = 200) {
  return new Response(bytes, { status, headers: { "content-type": "audio/mpeg", ...headers } });
}
async function read(upstream = response(), selected = selection(), signal = new AbortController().signal) {
  const native = prepare(selected), lease = native.acquire();
  try { return await native.read(upstream, signal); } finally { lease.release(); }
}
const invalid = { message: "invalid_native_openrouter_speech_response" };

test("three selected MP3 models reuse complete native bytes without changing request or identity", async () => {
  assert.equal(audio.length, fixture.bytes); assert.equal(createHash("sha256").update(audio).digest("hex"), fixture.sha256);
  for (const model of models) {
    const selected = selection(model, { provider: { zdr: true, data_collection: "deny" }, speed: 1.1 });
    const before = structuredClone(selected), native = prepare(selected);
    assert.deepEqual(selected, before);
    assert.equal(native.origin, "https://openrouter.ai"); assert.equal(native.path, "/api/v1/audio/speech");
    for (const key of ["body", "headers", "query", "tariff"]) assert.equal(native[key], undefined);
    const result = await read(response({ "x-generation-id": "gen-synthetic-123" }), selected);
    assert.deepEqual(Buffer.from(await result.response.arrayBuffer()), audio);
    assert.equal(result.response.headers.get("content-type"), "audio/mpeg");
    assert.equal(result.response.headers.get("content-length"), String(audio.length));
    assert.equal(result.response.headers.get("x-generation-id"), "gen-synthetic-123");
    assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  }
});

test("the final /api URL, selected model, format and capability are exact", () => {
  const native = prepare(selection());
  assert.doesNotThrow(() => assertNativeResponseDestination(native, new URL("https://openrouter.ai/api/v1/audio/speech")));
  for (const url of ["https://openrouter.ai/v1/audio/speech", "https://openrouter.ai/api/api/v1/audio/speech",
    "https://other.example/api/v1/audio/speech", "https://openrouter.ai/api/v1/audio/speech?format=mp3",
    "https://openrouter.ai/api/v1/audio/speech#synthetic"]) assert.throws(() => assertNativeResponseDestination(native, new URL(url)));
  for (const patch of [{ provider: { ...provider, base_urls: { default: "https://openrouter.ai" } } },
    { model: null }, { model: { upstream: models[0], capabilities: ["llm.chat"] } }, { capability: "llm.chat" },
    { method: "GET" }, { pathParams: { model: models[0] } }, { nativeQuery: {} }]) assert.throws(() => prepare({ ...selection(), ...patch }));
  for (const patch of [{ method: "GET" }, { path: "/api/v1/audio/speech" }, { path: "/v1/audio/speech/" },
    { response_format: "binary" }, { upstreamPath: endpoint.path }, { path_params: ["model"] }, { query: { format: "mp3" } },
    { streaming: "sse" }, { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => prepare({ ...selection(), endpoint: { ...endpoint, ...patch } }));
  assert.equal(prepare({ ...selection(), provider: { ...provider, id: "openai" } }), undefined);
  assert.equal(prepare({ ...selection(), endpoint: { ...endpoint, request_format: "openai.chat_completions" } }), undefined);
});

test("PCM, Gemini, aliases, missing voice/format and unowned references stay closed", () => {
  for (const model of ["google/gemini-3.1-flash-tts-preview", "openrouter/auto", "other/model"]) assert.throws(() => prepare(selection(model)));
  for (const patch of [{ model: models[1] }, { voice: undefined }, { voice: "" }, { voice: "x".repeat(129) },
    { response_format: undefined }, { response_format: "pcm" }, { response_format: "wav" }, { input: ["turn"] }, { input: "" },
    { input: " " }, { input: "\ud800" }, { instructions: "synthetic" }, { stream: true }, { api_key: "synthetic" },
    { base_url: "https://other.example" }, { input_references: [{ url: "https://media.example/test.mp3" }] },
    { provider: { only: ["other"] } }, { provider: { options: {} } }, { speed: "1" }, { speed: 0.24 }, { speed: 4.01 }])
    assert.throws(() => prepare(selection(models[0], patch)));
});

test("native text keeps the 32768 UTF-16 limit and bounded JSON, without a 4096-character fallback", () => {
  for (const input of ["a".repeat(32768), "😀".repeat(16384), "\u0001".repeat(32768)]) assert.ok(prepare(selection(models[0], { input })));
  for (const input of ["a".repeat(32769), "😀".repeat(16385)]) assert.throws(() => prepare(selection(models[0], { input })));
  assert.throws(() => prepare(selection(models[0], { extra: "a".repeat(256 * 1024 + 1) })));
});

test("pre-dispatch capacity charges 64 MiB alongside ingress in the 96 MiB pool", () => {
  assert.equal(bodyBudgetBytes, 96 * 1024 * 1024);
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(8 * 1024 * 1024), true);
  const lease = prepare(selection()).acquire(); assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
  assert.throws(() => prepare(selection()).acquire(), /capacity is busy/);
  lease.release(); input.release(); assert.equal(bodyBudgetCharged(), baseline);
});

test("identity encoding cannot bypass exact original Content-Length validation", async () => {
  const headers = { "content-encoding": "identity", "content-length": String(audio.length) }, upstream = response(headers);
  assert.deepEqual(Buffer.from(await (await read(upstream)).response.arrayBuffer()), audio);
  assert.equal(upstream.headers.get("content-encoding"), "identity"); assert.equal(upstream.headers.get("content-length"), String(audio.length));
  for (const encoding of [undefined, "identity"]) for (const length of [audio.length - 1, audio.length + 1]) {
    const fields = { "content-length": String(length), ...(encoding ? { "content-encoding": encoding } : {}) };
    await assert.rejects(read(response(fields)), invalid);
  }
});

test("HTTP/MIME/encoding/range errors and malformed generation IDs never deliver audio", async () => {
  for (const headers of [{ "content-type": "audio/pcm" }, { "content-type": "application/json" }, { "content-type": "audio/mpeg; charset=utf-8" },
    { "content-range": "bytes 0-3/100" }, { "content-encoding": "gzip" }, { "content-encoding": "" }, { "content-encoding": "identity,gzip" },
    { "content-length": "-1" }, { "content-length": "x" }, { "content-length": "1.5" }, { "content-length": "0" },
    { "content-length": String(16 * 1024 * 1024 + 1) }, { "x-generation-id": "https://other.example/job" }, { "x-generation-id": "x".repeat(257) }])
    await assert.rejects(read(response(headers)), invalid);
  const missing = response(); missing.headers.delete("content-type"); await assert.rejects(read(missing), invalid);
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected), invalid);
  for (const status of [201, 202, 206, 302, 422, 500]) await assert.rejects(read(response({}, audio, status)), invalid);
  await assert.rejects(read(response({}, new Uint8Array())), invalid);
});

test("complete delivery is byte-bounded at 16 MiB before codec assembly", async () => {
  // Byte-limit fixture: a large zero-padded ID3 tag followed by the playable tone.
  // The padding has no duration/usage meaning; playability evidence is the tone above.
  const bytes = Buffer.alloc(16 * 1024 * 1024);
  bytes.write("ID3"); bytes[3] = 4;
  const size = bytes.length - audio.length - 10;
  for (let i = 0; i < 4; i++) bytes[6 + i] = size >>> (7 * (3 - i)) & 127;
  audio.copy(bytes, bytes.length - audio.length);
  assert.equal((await (await read(response({ "content-length": String(bytes.length) }, bytes))).response.arrayBuffer()).byteLength, bytes.length);
  await assert.rejects(read(response({}, new Uint8Array(bytes.length + 1))), invalid);
});

test("8192 reads include every empty/data chunk and the final EOF", async () => {
  function chunks(empty) {
    let count = 0;
    return new ReadableStream({ pull(controller) {
      if (count++ < empty) controller.enqueue(new Uint8Array());
      else if (count === empty + 1) controller.enqueue(audio);
      else controller.close();
    } });
  }
  assert.deepEqual(Buffer.from(await (await read(response({}, chunks(8190)))).response.arrayBuffer()), audio);
  await assert.rejects(read(response({}, chunks(8191))), invalid);
  let reads = 0, canceled = false;
  const endless = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array()); }, cancel() { canceled = true; } });
  await assert.rejects(read(response({}, endless)), invalid);
  await new Promise(setImmediate); assert.equal(canceled, true); assert.ok(reads <= 8195);
});

test("no audio is returned before EOF; interrupted or shortened delivery stays incomplete", async () => {
  let controller, settled = false;
  const pending = read(response({}, new ReadableStream({ start(value) { controller = value; } }))).then(result => { settled = true; return result; });
  controller.enqueue(audio); await new Promise(setImmediate); assert.equal(settled, false);
  controller.close(); assert.deepEqual(Buffer.from(await (await pending).response.arrayBuffer()), audio);
  const broken = new ReadableStream({ start(value) { value.enqueue(audio); value.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(response({}, broken)), invalid);
  await assert.rejects(read(response({ "content-length": String(audio.length) }, audio.subarray(0, -1))), invalid);
});

test("abort/timeout cancels active and pre-aborted streams and releases the response lease", async () => {
  for (const name of ["AbortError", "TimeoutError"]) for (const preAborted of [false, true]) {
    const baseline = bodyBudgetCharged(), controller = new AbortController(); let canceled = false;
    if (preAborted) controller.abort(new DOMException("synthetic", name));
    const pending = read(response({}, new ReadableStream({ cancel() { canceled = true; } })), selection(), controller.signal);
    if (!preAborted) { await new Promise(setImmediate); controller.abort(new DOMException("synthetic", name)); }
    await assert.rejects(pending, invalid); await new Promise(setImmediate);
    assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), baseline);
  }
});

test("only safe binary headers and unknown token usage escape, with no fetch or paid replay", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected fetch"); });
  const result = await read(response({ "set-cookie": "synthetic", "x-private-upstream": "synthetic", "x-billed-characters": "123" }));
  assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  assert.equal(result.response.headers.get("cache-control"), "no-store"); assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  for (const key of ["set-cookie", "x-private-upstream", "x-billed-characters", "content-encoding"]) assert.equal(result.response.headers.get(key), null);
  assert.equal(fetch.mock.callCount(), 0);
});
for (const mode of ["headers", "abort", "cleanup-rejection"]) test(`source retirement holds capacity through ${mode}, including reentrant cancellation`, { timeout: 5000 }, async t => {
  const ready = Promise.withResolvers(), canceled = Promise.withResolvers(), cleanup = Promise.withResolvers();
  const abort = new AbortController(), baseline = bodyBudgetCharged();
  let cancels = 0, completed = false;
  const source = new ReadableStream({
    pull() { ready.resolve(); },
    cancel() { cancels++; abort.abort(); canceled.resolve(); return cleanup.promise; },
  }, { highWaterMark: 0 });
  const prepared = prepare(selection()), lease = prepared.acquire();
  t.after(() => { cleanup.resolve(); lease.release(); });
  const result = prepared.read(response(mode === "headers" ? { "content-type": "application/json" } : {}, source), abort.signal)
    .finally(() => { completed = true; lease.release(); });
  const rejected = assert.rejects(result);
  if (mode !== "headers") { await ready.promise; abort.abort(); }
  await canceled.promise; await new Promise(setImmediate);
  assert.equal(cancels, 1); assert.equal(completed, false); assert.equal(source.locked, true);
  assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
  const competing = new BodyLease();
  assert.equal(competing.grow(17 * 1024 * 1024), false); competing.release();
  if (mode === "cleanup-rejection") cleanup.reject(new Error("synthetic cleanup rejection")); else cleanup.resolve();
  await rejected;
  assert.equal(cancels, 1); assert.equal(source.locked, false);
  assert.equal(bodyBudgetCharged(), baseline);
  lease.release(); assert.equal(bodyBudgetCharged(), baseline);
});

test("a rejected counting transform retains its original pipe until source cancellation settles", { timeout: 5000 }, async t => {
  const canceled = Promise.withResolvers(), cleanup = Promise.withResolvers();
  let sent = false, complete = false, cancels = 0;
  const source = new ReadableStream({
    pull(controller) { if (!sent) { sent = true; controller.enqueue("invalid binary chunk"); } },
    cancel() { cancels++; canceled.resolve(); return cleanup.promise; },
  }, { highWaterMark: 0 });
  const native = prepare(selection()), baseline = bodyBudgetCharged(), lease = native.acquire();
  t.after(() => { cleanup.resolve(); lease.release(); });
  const result = native.read(response({}, source), new AbortController().signal)
    .finally(() => { complete = true; lease.release(); });
  const rejected = assert.rejects(result);
  await canceled.promise; await new Promise(setImmediate);
  assert.equal(complete, false); assert.equal(source.locked, true); assert.equal(cancels, 1);
  assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
  cleanup.reject(new Error("synthetic source cleanup rejection")); await rejected;
  assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), baseline); assert.equal(cancels, 1);
});
