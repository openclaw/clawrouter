import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { prepareNativeOpenRouterPcmSpeech: prepare } = await import("../native-openrouter-pcm-speech.ts");
const { prepareNativeOpenRouterSpeech: prepareMp3 } = await import("../native-openrouter-speech.ts");
const { prepareOpenRouterSpeech, readOpenRouterSpeech } = await import("../openrouter-speech.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");

const model = "google/gemini-3.1-flash-tts-preview", limit = 16 * 1024 * 1024;
const provider = { id: "openrouter", base_urls: { default: "https://openrouter.ai/api" } };
const endpoint = { method: "POST", path: "/v1/audio/speech", request_format: "openai.audio_speech",
  response_format: "audio.binary", path_params: [], query: {} };
// Synthetic transport bytes only: no signedness, byte order, playback, voice
// availability, native synthesis or invoice claim is made by this fixture.
const audio = new Uint8Array([0, 0, 1, 0, 255, 127]);
const invalid = { message: "invalid_native_openrouter_pcm_speech_response" };
function selection(extra = {}) {
  return { provider, endpoint, model: { upstream: model, capabilities: ["audio.speech"] }, capability: "audio.speech",
    method: "POST", pathParams: {}, body: { model, input: "Synthetic speech.", voice: "Kore", response_format: "pcm", ...extra } };
}
function response(headers = {}, bytes = audio, status = 200) {
  return new Response(bytes, { status, headers: { "content-type": "audio/pcm", ...headers } });
}
async function read(upstream = response(), selected = selection(), signal = new AbortController().signal) {
  const native = prepare(selected), lease = native.acquire();
  try { return await native.read(upstream, signal); } finally { lease.release(); }
}
const tick = () => new Promise(setImmediate);
function stream(parts) {
  let index = 0;
  return new ReadableStream({ pull(controller) {
    if (index === parts.length) controller.close(); else controller.enqueue(parts[index++]);
  } }, { highWaterMark: 0 });
}

test("exact Gemini PCM preserves request, opaque output and unknown usage", async () => {
  const selected = selection({ provider: { zdr: true, data_collection: "deny" } }), before = structuredClone(selected);
  const native = prepare(selected);
  assert.deepEqual(selected, before);
  assert.equal(native.origin, "https://openrouter.ai"); assert.equal(native.path, "/api/v1/audio/speech");
  for (const key of ["body", "headers", "query", "tariff"]) assert.equal(native[key], undefined);
  const result = await read(response({ "x-generation-id": "gen-synthetic-pcm" }), selected);
  assert.deepEqual(new Uint8Array(await result.response.arrayBuffer()), audio);
  assert.equal(result.response.headers.get("content-type"), "audio/pcm");
  assert.equal(result.response.headers.get("content-length"), String(audio.length));
  assert.equal(result.response.headers.get("x-generation-id"), "gen-synthetic-pcm");
  assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  const observed = await readOpenRouterSpeech(response(), prepareOpenRouterSpeech(model, selected.body), new AbortController().signal);
  assert.equal(observed.sampleRate, null); assert.equal(observed.billableCharacters, null); assert.equal(observed.upstreamCostMicros, null);
  assert.equal(result.voiceCompatible, undefined); assert.equal(result.sampleRate, undefined);
});

test("unrelated models fall through, while existing MP3 preparation stays unchanged", () => {
  assert.equal(prepare({ ...selection(), provider: { ...provider, id: "google" } }), undefined);
  assert.equal(prepare({ ...selection(), endpoint: { ...endpoint, request_format: "openai.chat_completions" } }), undefined);
  for (const upstream of ["hexgrad/kokoro-82m", "elevenlabs/eleven-turbo-v2", "mistralai/voxtral-mini-tts-2603", "openrouter/auto", "google/gemini-3.1-flash-tts", "google/other"]) {
    const selected = { ...selection({ model: upstream, response_format: "mp3" }), model: { upstream, capabilities: ["audio.speech"] } };
    assert.equal(prepare(selected), undefined);
    if (!upstream.startsWith("google/") && upstream !== "openrouter/auto") assert.ok(prepareMp3(selected));
  }
  assert.equal(prepare({ ...selection(), model: null }), undefined);
  assert.throws(() => prepareMp3(selection()));
});

test("the selected capability, route and final native destination are exact", () => {
  const native = prepare(selection());
  assert.doesNotThrow(() => assertNativeResponseDestination(native, new URL("https://openrouter.ai/api/v1/audio/speech")));
  for (const url of ["https://openrouter.ai/v1/audio/speech", "https://openrouter.ai/api/api/v1/audio/speech",
    "https://other.example/api/v1/audio/speech", "https://openrouter.ai/api/v1/audio/speech?format=pcm",
    "https://openrouter.ai/api/v1/audio/speech#synthetic"]) assert.throws(() => assertNativeResponseDestination(native, new URL(url)));
  for (const patch of [{ provider: { ...provider, base_urls: { default: "https://openrouter.ai" } } },
    { model: { upstream: model, capabilities: ["llm.chat"] } }, { capability: "llm.chat" },
    { method: "GET" }, { pathParams: { model } }, { nativeQuery: {} }]) assert.throws(() => prepare({ ...selection(), ...patch }));
  for (const patch of [{ method: "GET" }, { path: "/api/v1/audio/speech" }, { path: "/v1/audio/speech/" },
    { response_format: "binary" }, { upstreamPath: endpoint.path }, { path_params: ["model"] }, { query: { format: "pcm" } },
    { streaming: "sse" }, { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => prepare({ ...selection(), endpoint: { ...endpoint, ...patch } }));
});

test("explicit PCM and voice are required; speed, aliases, secrets and references are denied", () => {
  for (const patch of [{ model: "google/gemini-3.1-flash-tts" }, { model: "openrouter/auto" }, { voice: undefined }, { voice: "" },
    { voice: "x".repeat(129) }, { voice: "../Kore" }, { response_format: undefined }, { response_format: "mp3" }, { response_format: "wav" },
    { speed: undefined }, { speed: 1 }, { speed: 1.1 }, { speed: null }, { input: ["turn"] }, { input: "" }, { input: " " },
    { input: "\ud800" }, { input: "\udc00" }, { instructions: "synthetic" }, { stream: true }, { api_key: "synthetic" },
    { base_url: "https://other.example" }, { input_references: [{ url: "https://media.example/test.pcm" }] },
    { provider: { only: ["other"] } }, { provider: { options: {} } }]) assert.throws(() => prepare(selection(patch)));
});

test("UTF-16 and JSON request bounds preserve complete valid Unicode", () => {
  for (const input of ["a".repeat(32768), "😀".repeat(16384), "\u0001".repeat(32768)]) assert.ok(prepare(selection({ input })));
  for (const input of ["a".repeat(32769), "😀".repeat(16385)]) assert.throws(() => prepare(selection({ input })));
  assert.throws(() => prepare(selection({ extra: "x".repeat(256 * 1024 + 1) })));
});

test("pre-dispatch lease charges 64 MiB with independent ingress in the 96 MiB pool", () => {
  const baseline = bodyBudgetCharged(), ingress = new BodyLease(); let lease;
  try {
    assert.equal(bodyBudgetBytes, 96 * 1024 * 1024); assert.equal(ingress.grow(8 * 1024 * 1024), true);
    lease = prepare(selection()).acquire(); assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
    assert.throws(() => prepare(selection()).acquire(), /capacity is busy/);
  } finally { lease?.release(); ingress.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("identity reader view preserves exact original Content-Length", async () => {
  const upstream = response({ "content-encoding": "identity", "content-length": String(audio.length) });
  assert.deepEqual(new Uint8Array(await (await read(upstream)).response.arrayBuffer()), audio);
  assert.equal(upstream.headers.get("content-encoding"), "identity");
  assert.equal(upstream.headers.get("content-length"), String(audio.length));
  for (const encoding of [undefined, "identity"]) for (const length of [audio.length - 2, audio.length + 2])
    await assert.rejects(read(response({ "content-length": String(length), ...(encoding ? { "content-encoding": encoding } : {}) })), invalid);
});

test("HTTP, MIME, encoding, range and malformed metadata fail without output", async () => {
  for (const headers of [{ "content-type": "audio/mpeg" }, { "content-type": "audio/wav" }, { "content-type": "audio/L16" },
    { "content-type": "audio/pcm; rate=24000" }, { "content-range": "bytes 0-5/10" }, { "content-encoding": "gzip" },
    { "content-encoding": "" }, { "content-encoding": "identity,gzip" }, { "content-length": "-1" }, { "content-length": "x" },
    { "content-length": "1.5" }, { "content-length": "0" }, { "content-length": String(limit + 1) },
    { "x-generation-id": "https://other.example/job" }, { "x-generation-id": "x".repeat(257) }]) await assert.rejects(read(response(headers)), invalid);
  const missing = response(); missing.headers.delete("content-type"); await assert.rejects(read(missing), invalid);
  const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected), invalid);
  for (const status of [201, 202, 206, 302, 422, 500]) await assert.rejects(read(response({}, audio, status)), invalid);
  await assert.rejects(read(response({}, new Uint8Array())), invalid);
  await assert.rejects(read(response({}, null)), invalid);
});

test("only aggregate framing is even; odd transport chunks remain unchanged", async () => {
  const result = await read(response({ "content-length": "6" }, stream([audio.subarray(0, 1), audio.subarray(1, 4), audio.subarray(4)])));
  assert.deepEqual(new Uint8Array(await result.response.arrayBuffer()), audio);
  for (const bytes of [audio.subarray(0, 1), audio.subarray(0, 5)])
    await assert.rejects(read(response({ "content-length": String(bytes.length) }, bytes)), invalid);
});

test("complete opaque bytes are accepted through 16 MiB; overflow is atomic failure", async () => {
  const bytes = new Uint8Array(limit); bytes.set(audio, limit - audio.length);
  const result = await read(response({ "content-length": String(limit) }, stream([bytes])));
  const delivered = new Uint8Array(await result.response.arrayBuffer());
  assert.equal(delivered.length, limit); assert.deepEqual(delivered.subarray(-audio.length), audio);
  await assert.rejects(read(response({}, stream([bytes, new Uint8Array(2)]))), invalid);
});

test("small views cannot hide oversized or shared backing buffers", async () => {
  for (const chunk of [new Uint8Array(new ArrayBuffer(limit + 1), 0, 2), new Uint8Array(new SharedArrayBuffer(2)), new DataView(new ArrayBuffer(2))])
    await assert.rejects(read(response({}, stream([chunk]))), invalid);
});

test("Buffer views are copied by the unchanged codec instead of retaining mutable backing", async () => {
  const backing = Buffer.alloc(4096), chunk = backing.subarray(17, 23); chunk.set(audio);
  let controller, settled = false;
  const pending = read(response({}, new ReadableStream({ start(value) { controller = value; } })));
  const observed = pending.then(value => { settled = true; return value; });
  controller.enqueue(chunk); await tick(); assert.equal(settled, false);
  chunk.fill(9); controller.close();
  assert.deepEqual(new Uint8Array(await (await observed).response.arrayBuffer()), audio);
});

test("8192 reads includes empty chunks, data and the final EOF", async () => {
  function chunks(empty) {
    let count = 0;
    return new ReadableStream({ pull(controller) {
      if (count++ < empty) controller.enqueue(new Uint8Array());
      else if (count === empty + 1) controller.enqueue(audio);
      else controller.close();
    } }, { highWaterMark: 0 });
  }
  assert.deepEqual(new Uint8Array(await (await read(response({}, chunks(8190)))).response.arrayBuffer()), audio);
  await assert.rejects(read(response({}, chunks(8191))), invalid);
  let reads = 0, canceled = false;
  const endless = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array()); }, cancel() { canceled = true; } });
  await assert.rejects(read(response({}, endless)), invalid); await tick();
  assert.equal(canceled, true); assert.ok(reads <= 8195);
});

test("complete EOF is required before any output; interruption is sanitized", async () => {
  let controller, settled = false;
  const pending = read(response({}, new ReadableStream({ start(value) { controller = value; } }))).then(result => { settled = true; return result; });
  controller.enqueue(audio); await tick(); assert.equal(settled, false);
  controller.close(); assert.deepEqual(new Uint8Array(await (await pending).response.arrayBuffer()), audio);
  const broken = new ReadableStream({ start(value) { value.enqueue(audio); value.error(new Error("synthetic private upstream detail")); } });
  await assert.rejects(read(response({}, broken)), invalid);
});

test("abort and timeout cancel pending reads without success or a retained response lease", async () => {
  for (const name of ["AbortError", "TimeoutError"]) for (const preAborted of [false, true]) {
    const baseline = bodyBudgetCharged(), abort = new AbortController(); let canceled = false;
    if (preAborted) abort.abort(new DOMException("synthetic", name));
    const upstream = response({}, new ReadableStream({ start(controller) { controller.enqueue(audio); }, cancel() { canceled = true; } }));
    const pending = read(upstream, selection(), abort.signal);
    if (!preAborted) { await tick(); abort.abort(new DOMException("synthetic", name)); }
    await assert.rejects(pending, invalid); await tick();
    assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), baseline);
  }
});

test("the common owner retains capacity through output cancellation; the leaf cannot release it", async () => {
  const baseline = bodyBudgetCharged(), native = prepare(selection()), lease = native.acquire();
  try {
    const result = await native.read(response(), new AbortController().signal);
    assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
    await result.response.body.cancel();
    assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
  } finally { lease.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("only opaque binary headers and unknown usage escape; no fetch, playback labels or paid replay", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected fetch"); });
  const result = await read(response({ "set-cookie": "synthetic", "x-private-upstream": "synthetic", "x-billed-characters": "123", "x-sample-rate": "24000" }));
  await result.response.body.cancel();
  assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  assert.equal(result.response.headers.get("cache-control"), "no-store"); assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  for (const key of ["set-cookie", "x-private-upstream", "x-billed-characters", "x-sample-rate", "content-encoding", "content-disposition"])
    assert.equal(result.response.headers.get(key), null);
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
