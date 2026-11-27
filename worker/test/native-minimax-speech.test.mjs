import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
const { prepareNativeMiniMaxSpeech } = await import("../native-minimax-speech.ts");
const { miniMaxSpeechModels } = await import("../minimax-speech.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/minimax/speech.json", import.meta.url), "utf8"));
// Locally generated 440 Hz test tone, not native provider synthesis. ffprobe:
// MP3, 32000 Hz, mono; full ffmpeg decode: 11520 PCM16 bytes. No transcoder runs in the Worker.
const mp3 = Buffer.from("//tYxAAADkBFMnWUgAIIH6WLOxAAASSTkMMUxRzJLMskxwy+bpAA43oj97PnE52zRHLXqbsTa+74YFAIAgGBQKEDE5o0aNHMPqBAEDm1P/v6PP9Hv6Pf0fxOBAQdDAPh/AgY4Pg+D4Pg4CAIAgCAPg+D4PgQEAQBAMA+D4Pg+BAQBA5Hg+foAAAgQQMLRcMWyIHAGMERzL6g0UjlcRjSVPjULxzfAXzWb7jZcxTD0JDCsLCgQGhgITmKgGcDzVwNUOSC4b8LQhSIgqHw/45QuYVsQ0c0ZX/8miLECKJFSKmRe//8mjEul0yLxeRRMf//8yLxeMS6XUi8bCUJf/waEt////7FxUrPFQAACRIAgCAhAGzAPAFUwIgClMA6AsDB//tYxAuCDpAvDR33gAICQeEhv5SgUwgow+Ea0MgpZGjYChpUxGkZqMLvCKDCZwYYwJcA6MAjAATANgCcMAAVNCzQalWWjaYomfddOOac92/xqVatUcqtFPyXdp6jFvrR+/T3oTRcS29bB5P/+/9YX3tUgCoGYoDgsxYIMxHTVjo6VxMFyBEjGwzhY4agKKMH2HKDBswcICgRJKAbDAAqOgAibrVH3A4KPnMyKrktoWjumtU+l39X/oi1elO7et2s3S3b/10uiN32322dbr9ry22pZLqpkv0T7JdHLuqNVmTXW6ZrEq37br//xW/ZffYSmr2qAChCA0eAEiYAwGgF8eArDApwAQwYoC3MeFS/Tl3AHswbwfWMFUCHDAigK028//tYxBaCESYPBq/oqoIUQeDBv4ipwyyMwo4GAVbo7PSG19dlntx+5Uat0v1uKerb9kj0XR143TS51Y6WdG/b71ul3TSySrqnHIpyJfnvZ32pdNVb9d9zJZL701Z00912WyW/r9tV01xa/dLb1hiVyUyWVMBAjBgsxUcMsQTZ54wRQIXMXZmezeDA1swL4XwMN4ByDA7AJUwGEBCMAsAHzAEwAoDAAqdUCyqHabjdMnSlXMmrsv2ufbG/yks1HTq9c90VU6o3/71tsqPS6X9Oy7fk6Xppbbb9/1S6W2o9Wbp7put6N162Sz6b/hb0ult6qLNvrpuqKgAAGB4wDEAfAABoYBgAiGBDAMxgO4IiYJeEQmJIja5iZ8jOZ2oCjGFC//tYxBSAELQtCxX0gAJ8LakDNtABhFhh2AN0YWAETGCeAWQOAzDAOwEcwC0AVDgBNYgBADht6rQG2ha8e3jsV8q1xFsjuW10U6dMe0YlWEEDnkgoRbq3EVLqEfGolCIzGpWA/XYbU/RX68DMobwgihdtRW+UrnZiBAU0wtMcFTJ4QmgzCg9eNJtS910UWI4SARgdwmXHgF7GHGGJo9fJcTAehKEqZF4vfjnHuUxyEoaIl01UXkv8e5fNyULhoS5fWiipJ1o/+bkoXDQvl83LhcNGpaP//y+X0y4XEC+bplxBAv/Xq1///ppmiCBummaCA9II59+ebl5v//////h6QQHpBAekEB7WUUkFRSQVFJBVfDDolCUJR8lASACrCUAE//tYxAeDymQtFDzBgAAAADSAAAAEKVK4+e1mYUDVwlBV1QNB1Z0Sgq4RKBo8s6JQViJQNHlnRKCsRKBo8s6JQ1EUGnrOlXdP//T7un3dPu6et3I9buR63ciqTEFNRTQuMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "base64");
const provider = { id: "minimax", base_urls: { default: "https://api.minimax.io" } };
// Candidate leaf selections do not establish credential product/region authority.
const endpoint = { id: "speech", method: "POST", path: "/v1/t2a_v2", path_params: [], query: {}, streaming: null,
  request_format: "minimax.speech", response_format: "minimax.speech" };
function selection(model = wire.request.model, body = { ...structuredClone(wire.request), model }) {
  return { provider, endpoint, model: { id: "minimax/" + model, upstream: model, capabilities: ["audio.speech"] },
    capability: "audio.speech", body, pathParams: {}, method: "POST" };
}
const native = (selected = selection()) => prepareNativeMiniMaxSpeech(selected);
function payload() {
  const body = structuredClone(wire.result);
  body.data.audio = mp3.toString("hex");
  body.extra_info.audio_size = mp3.length; body.extra_info.audio_length = 180;
  return body;
}
const response = (body = payload(), headers = {}, status = 200) => Response.json(body, { headers, status });
async function read(upstream, selected = selection(), signal = new AbortController().signal) {
  const prepared = native(selected), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("MiniMax binds all eight frozen models and preserves native request and generated playable audio bytes", async () => {
  assert.equal(mp3.length, 1440);
  assert.equal(createHash("sha256").update(mp3).digest("hex"), "b81463dbee2508047cae558523d65ffe60da44c131dffa9eea043fc308e6cea3");
  assert.equal(miniMaxSpeechModels.length, 8);
  for (const model of miniMaxSpeechModels) {
    const selected = selection(model), before = structuredClone(selected), prepared = native(selected);
    assert.deepEqual(selected, before); assert.equal(prepared.origin, provider.base_urls.default); assert.equal(prepared.path, wire.path);
    for (const key of ["query", "tariff", "body", "headers"]) assert.equal(prepared[key], undefined);
    const body = { ...payload(), model }, result = await read(response(body), selected);
    assert.deepEqual(await result.response.json(), body);
    assert.deepEqual(Buffer.from(body.data.audio, "hex"), mp3);
  }
});

test("MiniMax leaf cannot select portal, CN, alternate destinations or caller query authority", () => {
  const prepared = native();
  assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
  for (const url of [prepared.origin + prepared.path + "?GroupId=synthetic", prepared.origin + "/anthropic/v1/messages",
    "https://api.minimaxi.com" + prepared.path, "https://other.example" + prepared.path])
    assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  for (const change of [{ provider: { ...provider, id: "minimax-portal" } }, { provider: { ...provider, base_urls: { default: "https://api.minimaxi.com" } } },
    { provider: { ...provider, base_urls: { default: "https://api.minimax.io/anthropic" } } },
    { model: null }, { model: { ...selection().model, capabilities: ["llm.chat"] } }, { capability: "llm.chat" },
    { method: "GET" }, { pathParams: { model: wire.request.model } }, { nativeQuery: {} }])
    assert.throws(() => native({ ...selection(), ...change }));
  for (const change of [{ method: "GET" }, { path: "/v1/t2a_async_v2" }, { response_format: "audio.binary" },
    { upstreamPath: endpoint.path }, { path_params: ["model"] }, { query: { GroupId: "synthetic" } }, { streaming: "sse" },
    { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => native({ ...selection(), endpoint: { ...endpoint, ...change } }));
  assert.equal(native({ ...selection(), endpoint: { ...endpoint, request_format: "openai.chat_completions" } }), undefined);
});

test("MiniMax preserves the frozen explicit voice, MP3 and hex modes without aliases or secret inputs", () => {
  for (const body of [{ ...wire.request, model: "speech-3.0" }, { ...wire.request, stream: true }, { ...wire.request, output_format: "url" },
    { ...wire.request, GroupId: "synthetic" }, { ...wire.request, api_key: "synthetic" }, { ...wire.request, voice_modify: {} },
    { ...wire.request, voice_setting: { ...wire.request.voice_setting, speed: "1" } },
    { ...wire.request, audio_setting: { format: "mp3", sample_rate: 44100 } },
    { ...wire.request, text: "x".repeat(10000) }, { ...wire.request, text: "😀".repeat(5000) },
    { ...wire.request, extra: "x".repeat(65537) }]) assert.throws(() => native(selection(wire.request.model, body)));
  assert.ok(native(selection(wire.request.model, { ...wire.request, text: "x".repeat(9999) })));
  assert.throws(() => native(selection("speech-2.6-hd", wire.request)));
});

test("MiniMax reserves 64 MiB before dispatch alongside existing ingress capacity", () => {
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(8 * 1024 * 1024), true);
  const output = native().acquire(); assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
  output.release(); input.release(); assert.equal(bodyBudgetCharged(), baseline);
  const occupied = new BodyLease(); assert.equal(occupied.grow((bodyBudgetBytes - baseline - 62 * 1024 * 1024) / 2), true);
  try { assert.throws(() => native().acquire(), /capacity is busy/); } finally { occupied.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("MiniMax returns native JSON and preserves characters without token, invoice or URL-fetch authority", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected audio fetch"); });
  for (const characters of [0, 12, undefined, -1, "12", 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const body = payload(); body.data.audio = " " + body.data.audio.toUpperCase() + " ";
    if (characters === undefined) delete body.extra_info.usage_characters; else body.extra_info.usage_characters = characters;
    const result = await read(response(body, { "x-private-upstream": "synthetic", "set-cookie": "synthetic" }));
    assert.deepEqual(await result.response.json(), body);
    assert.deepEqual(result.usage, { tokens: null, outcome: "success" }); assert.equal(result.usage.requestCostReceipt, undefined);
    assert.equal(result.response.headers.get("content-type"), "application/json"); assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("x-private-upstream"), null); assert.equal(result.response.headers.get("set-cookie"), null);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("MiniMax rejects native errors, partial status, foreign model and inconsistent audio metadata", async () => {
  for (const change of [b => { b.data.status = 1; }, b => { b.base_resp.status_code = 1008; }, b => { delete b.base_resp; },
    b => { b.data = null; }, b => { b.model = "speech-2.6-hd"; }, b => { b.model = null; }, b => { b.error = null; },
    b => { b.extra_info.audio_size--; }, b => { b.extra_info.audio_format = "wav"; },
    b => { b.extra_info.audio_sample_rate = 44100; }, b => { b.extra_info.audio_channel = 2; }]) {
    const body = payload(); change(body); await assert.rejects(read(response(body)));
  }
  for (const hex of ["", "0", "0x00", "00 01", "0g", "https://other.example/audio.mp3"])
    await assert.rejects(read(response({ ...payload(), data: { status: 2, audio: hex } })));
});

test("MiniMax bounds decoded audio at 4 MiB and complete response JSON at 8 MiB plus 64 KiB", async () => {
  const audioLimit = 4 * 1024 * 1024, jsonLimit = audioLimit * 2 + 65536, body = payload();
  delete body.extra_info.audio_length; delete body.extra_info.usage_characters;
  // Whole generated MP3 frames remain intact when repeated; this is a byte-bound fixture, not measured synthesis.
  const repeats = Math.floor(audioLimit / mp3.length);
  body.data.audio = mp3.toString("hex").repeat(repeats); body.extra_info.audio_size = mp3.length * repeats;
  const result = await read(response(body)); assert.equal((await result.response.json()).data.audio.length, body.data.audio.length);
  body.data.audio += mp3.toString("hex"); body.extra_info.audio_size += mp3.length;
  await assert.rejects(read(response(body)));
  const text = JSON.stringify(payload()), exact = text + " ".repeat(jsonLimit - Buffer.byteLength(text)), headers = { "content-type": "application/json" };
  assert.deepEqual(await (await read(new Response(exact, { headers }))).response.json(), payload());
  await assert.rejects(read(new Response(exact + " ", { headers })));
  await assert.rejects(read(response(undefined, { "content-length": String(jsonLimit + 1) })));
});

test("MiniMax requires complete HTTP200 JSON UTF-8 with identity encoding and exact lengths", async () => {
  for (const headers of [{ "content-type": "audio/mpeg" }, { "content-type": "application/json; charset=utf-16" },
    { "content-type": "application/json; charset=\"utf-8" }, { "content-range": "bytes 0-1/10" }, { "content-encoding": "gzip" },
    { "content-length": "-1" }, { "content-length": "bad" }, { "content-length": "1.5" }, { "content-length": "1" }])
    await assert.rejects(read(response(undefined, headers)));
  for (const status of [201, 206, 302, 422, 500]) await assert.rejects(read(response(undefined, {}, status)));
  for (const headers of [{}, { "content-encoding": "identity" }]) {
    const redirected = response(undefined, headers); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  }
  const text = JSON.stringify(payload()), headers = { "content-type": "application/json; charset=\"UTF-8\"", "content-encoding": "identity" };
  assert.deepEqual(await (await read(new Response(text, { headers: { ...headers, "content-length": String(Buffer.byteLength(text)) } }))).response.json(), payload());
  await assert.rejects(read(new Response(text, { headers: { ...headers, "content-length": String(Buffer.byteLength(text) + 1) } })));
});

test("MiniMax waits for full EOF and rejects truncated, invalid UTF-8 and interrupted JSON", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload())), headers = { "content-type": "application/json" }; let controller, settled = false;
  const upstream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers });
  const pending = read(upstream).then(result => { settled = true; return result; });
  controller.enqueue(bytes); await new Promise(setImmediate); assert.equal(settled, false);
  controller.close(); assert.deepEqual(await (await pending).response.json(), payload());
  await assert.rejects(read(new Response(bytes.subarray(0, -1), { headers })));
  await assert.rejects(read(new Response(new Uint8Array([0xff]), { headers })));
  const broken = new ReadableStream({ start(value) { value.enqueue(bytes); value.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(new Response(broken, { headers })), { message: "invalid_native_minimax_speech_response" });
});

test("MiniMax abort and timeout cancel stalled reading and release capacity without partial success", async () => {
  for (const name of ["AbortError", "TimeoutError"]) for (const alreadyAborted of [false, true]) {
    const baseline = bodyBudgetCharged(), abort = new AbortController(); let canceled = false;
    if (alreadyAborted) abort.abort(new DOMException("synthetic", name));
    const stream = new ReadableStream({ cancel() { canceled = true; } });
    const pending = read(new Response(stream, { headers: { "content-type": "application/json" } }), selection(), abort.signal);
    if (!alreadyAborted) { await new Promise(setImmediate); abort.abort(new DOMException("synthetic", name)); }
    await assert.rejects(pending); assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), baseline);
  }
});
