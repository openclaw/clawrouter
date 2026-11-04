import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
const { prepareNativeMiniMaxMusic } = await import("../native-minimax-music.ts");
const { assertNativeResponseDestination } = await import("../native-response.ts");
const { BodyLease, bodyBudgetBytes, bodyBudgetCharged } = await import("../body-budget.ts");
const { nativeMatch, prepareNativeRequest, prepareManifestRequest } = await import("../proxy-selection.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/minimax/music.json", import.meta.url), "utf8"));
// Locally generated test tone, not provider synthesis. ffprobe: MP3, 44100 Hz,
// stereo, 256000 bps; full ffmpeg decode: 13824 PCM16 bytes. No Worker transcoder.
const mp3 = Buffer.from("//vQZAAABt5WRpVx4AIAAA0goAABLRopAhn+AAAAADSDAAAAAVWDbLVNnsM1ejTLIHMgJQ2xDDl06OXQo2ohjNYvMTjMx+QzII9Mai0xOITDITMGgcFAcAwAdABIAEAEAEAJALgXA0zTIOPWPWTs01GzvGBOIYhigVjzXu/fv38ffvukB5TWbxKfN/6Ufx7/+947yJSlKUo8fv73ve8N+8eUpSlIDx+/ve97w37x5EpSlIER+/ve973jvHlKUpSkR+/fv379+/fvHjx48ePHjx+/fv379+/f0AAAAAA8PDw8MAAAAAA8PDw8MAAAAAA8PDw8MAAAAAA8PDw8MAAAAMZ7LsDHK/eYwUAKqMj/xNjB/gLoyvdKKN/UM7zCJw3I6s4bqBoKqeesJECAGhMTrDGjC7QxAwYsA6HgBswIcBAUrNxZM8JX1bm/pMjrWFM5to22zHJfWlv1bRtF3GQkSaMRJopQxKtG5bf7jsxSXjMZgMxnIwwQzJBHm7GFjKx+PbRkgqmDRcY1GhjcfGAhCYmE9W9KsprtWzeq6xMTC8Ahgw6HjDoiBARMKBUwoGaKzPz+X35jtSmlNnIKgowaDDB4QCwDMFAUwQCUERgUBGAwBVwllP2MYcpdUXz288a91I0siWZTmLxF4loooqAsqTGk1yWV7lSVZ49qUuX/frWsZBlTLGeFQVnMGM6h6SuTCbUah+3JZ6VVa17O1W/edXV6S01/mVa3cufT02MpoLVNVkT637jpVcXReKNMqhlyVhf////////z7jJdZSm5Ys3a3LMW////////yldJXu2O6y3yxYiVyfUwggHNMlBasTB4gx8xt3ELMFIDqTCTewk68oAtMAMBXzgghB8wBwEBMsSGLzAHAE0wMQAyYaYMMAQJMg4O8IgARHJl1YxF1onQIIqTTbfRC74I4TuM21DsY+1zyl9hVSaeNE7M2bO7rUHEiclrkxi7ZteGz6nlq82HLyXgkopsJo0BcpA7rU2UNtpl0KbDUW2JNtx85rwyEYzSnKbKSzS6tpoY3XdLIGG77c5XO88WnwamaXclHrl93VYqr22TsyPugzkEONdlj/////9s+i1SpG0SDIl1Fr/////70mRtAAc8ikEGfSAAAAANIMAAADZSKQQZ/oAAAAA0gwAAAP//lqaNHJOBthZFcFWTALA2cxITiNMERCXzIGqbExWUNiM9CH5zVuxtEwBQCWOZ3F/TAEgSo7A0MRMfAF3jBzAAkSAADBRgC8DAAhg1QQSYS2CZ44PJDZxMjRlGw+e57K5CzYcuQ5fTOtUbFabwl+UN05pSP5iGT5n6jZmyKOtW8cp6Zvy6wZmm+Z3muZDhCaDnaZjkTT4y2W4U8vy5dv4jQzmiJtmRoXmBgGGeZXmIoLU+qaVYVrOXKl+3MXjEwIjLsbyQWDGgLDGkGzDoeDHAKrt3VqxYwq389UW7NTVHcAoQGMQ/GMgPGIwtGOA4GJAFGPw7GNgnBweZauflXwztTuqXvaLtezT7r4GTA+GKgPKHmSw2A4WTCECTH4SgsFph6CpicCxg6JturN1IzLL1q5lh+OsrtTt+zao8sZ6h5WxsmJIKmBABmHormIoImEYcmJoomGoDmK4pmJ4ehgXmOIvmIYNsqMdxXIhOy7Vp62VTmXabmXbdj////////Kn5Yt52KfKzzW6W1////////5gcABjOH4JBowsAoxFBUwMDYw4BAIB4wuEYw6AowQCYxAEQwsAIxCEQxEDgMCxMQU1FNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVAAkgAQAQQMgxQkjVZVlQwDAB3MBsAD/80rM/kMZOJnTAVQJowE8CM/zHbBKkwSIOqMA1AJQYAof5loIqmcgRmYC4GQKAX/zCrQGMow9sy2hGRCBQYA4DCA//8xoTmjHUKlMYAIYyAzEhGAsBQCk+xkAT//zGMIJMD4dIytzIjCsCJMTkkwvM0NhTSnm///zFtEuMB0IoxFRXjEhBuMH0PwxOxOpTZhpeLKZJ///+YfYQphzj//vSZFoADqF8QLZ/wAAAAA0gwAAAAAABpBwAACAAADSDgAAEIGMqKEYKIlph6jHGKiF8YMQv6MqlMMIMpyv4jL////5hTiBAIVIwnhLTB/C0MDcGUwyhDTBBBIMDgK8w0Ax1KX4UNYDCG6vrId//////koHphiCKmHwECYKQXZiBCJmFkBMYRQf5iIBzmCYFoYUQiph6BL7lsBQ1MsycKbWCZVG///////8wJRBjCgD/MLIB8wixJDCCDBME4FAwwxFDBOBhMCMKYw1w2gAAgYRYahhjg8GBiEIYY4byymVS9mThT7xPtR3K1NM0tb/////////8MDfMEkJIwpQkDAzBfMF8KgwmwYgAE6YMYURg7gNGCUF2YKoQRgcgQmDsFyYGoIwEBjMIoJf///////94X1mGYuDKGYuDLGYuDOPDDNFMqkxBTUU0LjCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=", "base64");
const provider = { id: "minimax", base_urls: { default: "https://api.minimax.io" } };
// Candidate selections confer no music product, regional or credential authority.
const endpoint = { id: "music", method: "POST", path: "/v1/music_generation", path_params: [], query: {}, streaming: null,
  request_format: "minimax.music", response_format: "minimax.music" };
function selection(model = "music-2.6", body = { ...structuredClone(wire.request), model, stream: false }) {
  return { provider, endpoint, model: { id: "minimax/" + model, upstream: model, capabilities: ["music.generate"] },
    capability: "music.generate", body, pathParams: {}, method: "POST" };
}
const native = (selected = selection()) => prepareNativeMiniMaxMusic(selected);
function payload() {
  const body = structuredClone(wire.frames[2]); body.data.audio = mp3.toString("hex");
  body.extra_info.music_size = mp3.length; body.extra_info.music_duration = 78; body.extra_info.music_channel = 2;
  return body;
}
const response = (body = payload(), headers = {}, status = 200) => Response.json(body, { headers, status });
async function read(upstream, selected = selection(), signal = new AbortController().signal) {
  const prepared = native(selected), lease = prepared.acquire();
  try { return await prepared.read(upstream, signal); } finally { lease.release(); }
}

test("MiniMax music binds two frozen unary models and preserves native JSON and playable test audio", async () => {
  assert.equal(mp3.length, 2507);
  assert.equal(createHash("sha256").update(mp3).digest("hex"), "7c0efecf1ae057e304fff4b9f7775107044d4db9efe0d82c7df465876aa5a0ce");
  for (const model of ["music-2.6", "music-2.6-free"]) {
    const selected = selection(model), before = structuredClone(selected), prepared = native(selected);
    assert.deepEqual(selected, before); assert.equal(prepared.origin, provider.base_urls.default); assert.equal(prepared.path, endpoint.path);
    for (const key of ["query", "tariff", "body", "headers"]) assert.equal(prepared[key], undefined);
    const body = { ...payload(), model }, result = await read(response(body), selected);
    assert.deepEqual(await result.response.json(), body); assert.deepEqual(Buffer.from(body.data.audio, "hex"), mp3);
  }
});

test("MiniMax music rejects wrong capability, regional destination, aliases and alternate route authority", () => {
  const prepared = native();
  assert.doesNotThrow(() => assertNativeResponseDestination(prepared, new URL(prepared.origin + prepared.path)));
  for (const url of [prepared.origin + prepared.path + "?GroupId=synthetic", prepared.origin + "/anthropic/v1/messages",
    "https://api.minimaxi.com" + prepared.path, "https://other.example" + prepared.path])
    assert.throws(() => assertNativeResponseDestination(prepared, new URL(url)));
  for (const change of [{ provider: { ...provider, id: "minimax-portal" } }, { provider: { ...provider, base_urls: { default: "https://api.minimaxi.com" } } },
    { provider: { ...provider, base_urls: { default: "https://api.minimax.io/anthropic" } } },
    { model: null }, { model: { ...selection().model, capabilities: ["audio.speech"] } }, { capability: "audio.speech" },
    { method: "GET" }, { pathParams: { model: "music-2.6" } }, { nativeQuery: {} }])
    assert.throws(() => native({ ...selection(), ...change }));
  for (const model of ["music-3.0", "music-cover", "music-cover-free", "minimax/music-2.6"])
    assert.throws(() => native(selection(model)));
  for (const change of [{ method: "GET" }, { path: "/v1/t2a_v2" }, { response_format: "audio.binary" },
    { upstreamPath: endpoint.path }, { path_params: ["model"] }, { query: { GroupId: "synthetic" } }, { streaming: "ndjson" },
    { websocket: {} }, { lifecycle: {} }, { responsesLifecycle: {} }, { modelPassthrough: {} }, { requestPricing: {} }])
    assert.throws(() => native({ ...selection(), endpoint: { ...endpoint, ...change } }));
  assert.equal(native({ ...selection(), endpoint: { ...endpoint, request_format: "minimax.speech" } }), undefined);
});

test("MiniMax music requires explicit unary hex settings and bounded prompt or lyrics without references", () => {
  const request = selection().body;
  for (const body of [{ ...request, stream: true }, { ...request, stream: undefined }, { ...request, output_format: "url" },
    { ...request, model: "music-2.6-free" }, { ...request, GroupId: "synthetic" }, { ...request, api_key: "synthetic" },
    { ...request, audio_setting: { ...request.audio_setting, sample_rate: 32000 } },
    { ...request, audio_setting: { ...request.audio_setting, bitrate: 128000 } },
    { ...request, prompt: "x".repeat(2001) }, { ...request, prompt: "😀".repeat(1001) },
    { ...request, lyrics: "x".repeat(3501), lyrics_optimizer: undefined }, { ...request, extra: "x".repeat(65537) }])
    assert.throws(() => native(selection("music-2.6", body)));
  for (const key of ["audio_url", "audio_base64", "file_id", "feature_id", "reference"])
    for (const value of [undefined, null, "", "synthetic"]) assert.throws(() => native(selection("music-2.6", { ...request, [key]: value })));
  const { lyrics_optimizer, ...plain } = request;
  for (const options of [{ lyrics: "Synthetic complete lyrics" }, { is_instrumental: true }])
    assert.ok(native(selection("music-2.6", { ...plain, ...options })));
  assert.ok(native(selection("music-2.6", { ...plain, prompt: "x".repeat(2000), lyrics: "x".repeat(3500) })));
});

test("MiniMax music reserves 64 MiB alongside ingress within the actual 96 MiB pool", () => {
  assert.equal(bodyBudgetBytes, 96 * 1024 * 1024);
  const baseline = bodyBudgetCharged(), input = new BodyLease(); assert.equal(input.grow(8 * 1024 * 1024), true);
  const output = native().acquire(); assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
  output.release(); input.release(); assert.equal(bodyBudgetCharged(), baseline);
  const occupied = new BodyLease(); assert.equal(occupied.grow((bodyBudgetBytes - baseline - 62 * 1024 * 1024) / 2), true);
  try { assert.throws(() => native().acquire(), /capacity is busy/); } finally { occupied.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test("MiniMax music preserves native observations without token, invoice or URL-fetch authority", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected audio fetch"); });
  for (const duration of [0, 78, undefined]) {
    const body = payload(); body.data.audio = " " + body.data.audio.toUpperCase() + " ";
    if (duration === undefined) delete body.extra_info.music_duration; else body.extra_info.music_duration = duration;
    body.extra_info.synthetic_unqualified_cost = 42;
    const result = await read(response(body, { "x-private-upstream": "synthetic", "set-cookie": "synthetic" }));
    assert.deepEqual(await result.response.json(), body); assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
    assert.equal(result.usage.requestCostReceipt, undefined);
    assert.equal(result.response.headers.get("content-type"), "application/json"); assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("x-private-upstream"), null); assert.equal(result.response.headers.get("set-cookie"), null);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("MiniMax music rejects native errors, partial status, wrong model, settings and size", async () => {
  for (const change of [b => { b.data.status = 1; }, b => { b.base_resp.status_code = 1008; }, b => { delete b.base_resp; },
    b => { b.data = null; }, b => { b.model = "music-2.6-free"; }, b => { b.model = null; }, b => { b.error = null; },
    b => { b.extra_info.music_size--; }, b => { b.extra_info.music_sample_rate = 32000; },
    b => { b.extra_info.bitrate = 128000; }, b => { b.extra_info.music_duration = -1; }]) {
    const body = payload(); change(body); await assert.rejects(read(response(body)), { message: "invalid_native_minimax_music_response" });
  }
  for (const hex of ["", "0", "0x00", "00 01", "0g", "https://other.example/audio.mp3"])
    await assert.rejects(read(response({ ...payload(), data: { status: 2, audio: hex } })));
  for (const key of ["audio_url", "audio_base64", "file_id", "file", "url", "task_id"]) for (const field of ["root", "data"]) {
    const body = payload(); (field === "root" ? body : body.data)[key] = null;
    await assert.rejects(read(response(body)));
  }
});

test("MiniMax music bounds full decoded audio and complete JSON before delivery", async () => {
  const audioLimit = 4 * 1024 * 1024, jsonLimit = audioLimit * 2 + 65536, body = payload();
  delete body.extra_info.music_duration;
  // Repeated whole generated MP3 frames test byte limits, not measured synthesis.
  const repeats = Math.floor(audioLimit / mp3.length);
  body.data.audio = mp3.toString("hex").repeat(repeats); body.extra_info.music_size = mp3.length * repeats;
  const result = await read(response(body)); assert.equal((await result.response.json()).data.audio.length, body.data.audio.length);
  body.data.audio += mp3.toString("hex"); body.extra_info.music_size += mp3.length;
  await assert.rejects(read(response(body)));
  const text = JSON.stringify(payload()), exact = text + " ".repeat(jsonLimit - Buffer.byteLength(text)), headers = { "content-type": "application/json" };
  assert.deepEqual(await (await read(new Response(exact, { headers }))).response.json(), payload());
  await assert.rejects(read(new Response(exact + " ", { headers })));
  await assert.rejects(read(response(undefined, { "content-length": String(jsonLimit + 1) })));
});

test("MiniMax music requires HTTP200 JSON UTF-8, identity encoding and exact lengths", async () => {
  for (const headers of [{ "content-type": "audio/mpeg" }, { "content-type": "text/event-stream" }, { "content-type": "application/json; charset=utf-16" },
    { "content-type": 'application/json; charset="utf-8' }, { "content-range": "bytes 0-1/10" }, { "content-encoding": "gzip" },
    { "content-length": "-1" }, { "content-length": "bad" }, { "content-length": "1.5" }, { "content-length": "1" }])
    await assert.rejects(read(response(undefined, headers)));
  for (const status of [201, 206, 302, 422, 500]) await assert.rejects(read(response(undefined, {}, status)));
  for (const headers of [{}, { "content-encoding": "identity" }]) {
    const redirected = response(undefined, headers); Object.defineProperty(redirected, "redirected", { value: true }); await assert.rejects(read(redirected));
  }
  const text = JSON.stringify(payload()), headers = { "content-type": 'application/json; charset="UTF-8"', "content-encoding": "identity" };
  assert.deepEqual(await (await read(new Response(text, { headers: { ...headers, "content-length": String(Buffer.byteLength(text)) } }))).response.json(), payload());
  await assert.rejects(read(new Response(text, { headers: { ...headers, "content-length": String(Buffer.byteLength(text) + 1) } })));
});

test("MiniMax music waits for full EOF and rejects interrupted or malformed JSON without partial success", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload())), headers = { "content-type": "application/json" }; let controller, settled = false;
  const pending = read(new Response(new ReadableStream({ start(value) { controller = value; } }), { headers }))
    .then(result => { settled = true; return result; });
  controller.enqueue(bytes); await new Promise(setImmediate); assert.equal(settled, false);
  controller.close(); assert.deepEqual(await (await pending).response.json(), payload());
  await assert.rejects(read(new Response(bytes.subarray(0, -1), { headers })));
  await assert.rejects(read(new Response(new Uint8Array([0xff]), { headers })));
  const broken = new ReadableStream({ start(value) { value.enqueue(bytes); value.error(new Error("synthetic upstream detail")); } });
  await assert.rejects(read(new Response(broken, { headers })), { message: "invalid_native_minimax_music_response" });
});

test("MiniMax music abort and timeout cancel stalled reading and release capacity", async () => {
  for (const name of ["AbortError", "TimeoutError"]) for (const alreadyAborted of [false, true]) {
    const baseline = bodyBudgetCharged(), abort = new AbortController(); let canceled = false;
    if (alreadyAborted) abort.abort(new DOMException("synthetic", name));
    const pending = read(new Response(new ReadableStream({ cancel() { canceled = true; } }),
      { headers: { "content-type": "application/json" } }), selection(), abort.signal);
    if (!alreadyAborted) { await new Promise(setImmediate); abort.abort(new DOMException("synthetic", name)); }
    await assert.rejects(pending); assert.equal(canceled, true); assert.equal(bodyBudgetCharged(), baseline);
  }
});

function streamSelection(model = "music-2.6") {
  const selected = selection(model);
  selected.body.stream = true; selected.endpoint = { ...endpoint, streaming: "sse" };
  return selected;
}
function streamResponse(frames, width = 4096, headers = {}) {
  const bytes = new TextEncoder().encode(frames.map(frame => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n");
  let offset = 0;
  return new Response(new ReadableStream({ pull(c) {
    if (offset === bytes.length) { c.close(); return; }
    const end = Math.min(bytes.length, offset + width); c.enqueue(bytes.slice(offset, end)); offset = end;
  } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream", ...headers } });
}
function decodeFrozenConsumer(text) {
  const chunks = []; let complete = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim(); if (!json || json === "[DONE]") continue;
    const frame = JSON.parse(json); assert.equal(frame.base_resp.status_code, 0);
    if (String(frame.data.status) === "2") { complete = true; if (chunks.length) continue; }
    if (frame.data.audio) chunks.push(Buffer.from(frame.data.audio, "hex"));
  }
  assert.equal(complete, true); return Buffer.concat(chunks);
}

test("MiniMax streaming emits one complete native SSE aggregate preserving both model identities and playable fixture hash", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("no leaf I/O or paid replay"); });
  for (const model of ["music-2.6", "music-2.6-free"]) {
    const selected = streamSelection(model), original = structuredClone(selected), prepared = native(selected), lease = prepared.acquire();
    try {
      assert.deepEqual(selected, original); assert.equal(prepared.origin, provider.base_urls.default); assert.equal(prepared.path, endpoint.path);
      const terminal = { ...payload(), model }, delta = { base_resp: { status_code: 0 }, data: { audio: mp3.subarray(0, 100).toString("hex"), status: 1 } };
      const result = await prepared.read(streamResponse([delta, terminal], 7, { "x-private-upstream": "synthetic", "set-cookie": "synthetic" }), new AbortController().signal);
      assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
      assert.equal(result.usage.requestCostReceipt, undefined); assert.equal(result.usage.nativeRequestUsage, undefined);
      assert.equal(result.response.headers.get("content-type"), "text/event-stream");
      assert.equal(result.response.headers.get("content-length"), null); assert.equal(result.response.headers.get("set-cookie"), null);
      assert.equal(result.response.headers.get("x-private-upstream"), null);
      const text = await result.response.text(), frames = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      assert.equal(frames.length, 1); assert.equal(frames[0].data.status, 2); assert.equal(frames[0].model, model);
      assert.deepEqual(frames[0].extra_info, terminal.extra_info);
      assert.equal(createHash("sha256").update(decodeFrozenConsumer(text)).digest("hex"), "7c0efecf1ae057e304fff4b9f7775107044d4db9efe0d82c7df465876aa5a0ce");
    } finally { lease.release(); }
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("MiniMax streaming freezes only scalar response context, never a prepared request", async () => {
  const selected = streamSelection(), prepared = native(selected), lease = prepared.acquire();
  selected.body.model = "music-cover"; selected.body.stream = false; selected.body.prompt = "changed";
  selected.model.upstream = "music-2.6-free"; selected.endpoint.streaming = null;
  try {
    const result = await prepared.read(streamResponse([{ ...payload(), model: "music-2.6" }]), new AbortController().signal);
    assert.deepEqual(decodeFrozenConsumer(await result.response.text()), mp3);
  } finally { lease.release(); }
});

test("one SSE-capable endpoint preserves explicit unary and streaming for both models through native and manifest request selectors", async () => {
  // Candidate catalog only: this exercises existing request selectors, not
  // production registration, credential authority or common dispatch.
  const shared = { ...endpoint, streaming: "sse", native_proxy: true, methods: ["POST"] };
  const candidate = { ...provider, endpoints: [shared], routing: { modelPrefixes: ["minimax/"] },
    capabilities: [{ id: "music.generate", endpoint: shared.id }],
    models: [selection().model, selection("music-2.6-free").model],
    adapter: { requestTransforms: { renameFields: [] } } };
  for (const model of ["music-2.6", "music-2.6-free"]) for (const stream of [false, true]) for (const path of ["native", "manifest"]) {
    const body = { ...structuredClone(wire.request), model: path === "native" ? model : `minimax/${model}`, stream };
    const matches = candidate.endpoints.filter(item => nativeMatch(item, endpoint.path));
    assert.deepEqual(matches, [shared]); // One native path; no mode-based alias ordering.
    const prepared = path === "native" ? prepareNativeRequest(candidate, matches[0], body, endpoint.path, {})
      : prepareManifestRequest(candidate, shared, body, {}, {});
    assert.equal(prepared.model.upstream, model); assert.equal(prepared.body.model, model); assert.equal(prepared.body.stream, stream);
    const leaf = native({ ...selection(model), provider: candidate, endpoint: shared, ...prepared }), lease = leaf.acquire();
    try {
      const nativeBody = { ...payload(), model };
      const result = await leaf.read(stream ? streamResponse([nativeBody]) : response(nativeBody), new AbortController().signal);
      assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
      if (stream) { assert.equal(result.response.headers.get("content-type"), "text/event-stream"); assert.deepEqual(decodeFrozenConsumer(await result.response.text()), mp3); }
      else { assert.match(result.response.headers.get("content-type"), /^application\/json/); assert.deepEqual(await result.response.json(), nativeBody); }
    } finally { lease.release(); }
  }
});

test("dual-mode music keeps explicit boolean selection and rejects unsupported endpoint stream modes", () => {
  for (const model of ["music-2.6", "music-2.6-free"]) {
    for (const mode of [null, undefined]) {
      const selected = selection(model); selected.endpoint = { ...endpoint, streaming: mode };
      assert.ok(native(selected)); selected.body.stream = true; assert.throws(() => native(selected));
    }
    for (const mode of ["ndjson", "websocket", "json", "", false, true]) for (const stream of [false, true]) {
      const selected = selection(model); selected.body.stream = stream; selected.endpoint = { ...endpoint, streaming: mode };
      assert.throws(() => native(selected));
    }
    for (const stream of [undefined, null, 0, 1, "true", "false"]) {
      const selected = streamSelection(model); selected.body.stream = stream; assert.throws(() => native(selected));
    }
  }
});

test("MiniMax streaming requires exact SSE declaration and excludes CN, cover, references and alternate response routes", () => {
  for (const change of [{ endpoint: { ...endpoint, streaming: null } }, { endpoint: { ...endpoint, streaming: "sse", response_format: "audio.binary" } },
    { provider: { ...provider, base_urls: { default: "https://api.minimaxi.com" } } }, { capability: "audio.speech" }, { nativeQuery: {} }])
    assert.throws(() => native({ ...streamSelection(), ...change }));
  for (const model of ["music-cover", "music-cover-free", "music-3.0"]) assert.throws(() => native(streamSelection(model)));
  for (const field of ["audio_url", "audio_base64", "cover_feature_id", "reference", "file_id"]) {
    const selected = streamSelection(); selected.body[field] = null; assert.throws(() => native(selected));
    selected.body[field] = undefined; assert.throws(() => native(selected));
  }
  const implicit = streamSelection(); delete implicit.body.stream; assert.throws(() => native(implicit));
});

test("MiniMax streaming keeps caller-owned 64MiB charge through downstream EOF or cancellation", async () => {
  for (const cancel of [false, true]) {
    const baseline = bodyBudgetCharged(), ingress = new BodyLease(); assert.equal(ingress.grow(8 * 1024 * 1024), true);
    const prepared = native(streamSelection()), lease = prepared.acquire();
    try {
      assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
      const result = await prepared.read(streamResponse([payload()]), new AbortController().signal);
      assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
      const reader = result.response.body.getReader();
      if (cancel) { const first = await reader.read(); assert.equal(first.done, false); await reader.cancel(); }
      else { for (;;) { const part = await reader.read(); if (part.done) break; assert.ok(part.value.length <= 65536); } }
      reader.releaseLock();
      // Common delivery owns the lease; the leaf never releases it on read completion.
      assert.equal(bodyBudgetCharged(), baseline + 80 * 1024 * 1024);
    } finally { lease.release(); ingress.release(); }
    assert.equal(bodyBudgetCharged(), baseline);
  }
});

test("MiniMax streaming rejects partial EOF and cancels stalled reads without returning success or leaking capacity", async () => {
  for (const completeFrame of [false, true]) {
    const baseline = bodyBudgetCharged(), abort = new AbortController(), prepared = native(streamSelection()), lease = prepared.acquire();
    let canceled = false, controller, settled = false;
    const response = new Response(new ReadableStream({ start(c) { controller = c; }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
    const pending = prepared.read(response, abort.signal).then(result => { settled = true; return result; });
    try {
      controller.enqueue(new TextEncoder().encode(completeFrame ? "data: " + JSON.stringify(payload()) + "\n\n" : 'data: {"data":{"audio":"'));
      await new Promise(setImmediate); assert.equal(settled, false); abort.abort(new DOMException("synthetic caller", "AbortError"));
      await assert.rejects(pending, { message: "invalid_native_minimax_music_response" }); assert.equal(canceled, true);
    } finally { lease.release(); }
    assert.equal(bodyBudgetCharged(), baseline);
  }
});

test("MiniMax streaming downstream signal abort errors delivery without a fallback or lease transfer", async () => {
  const baseline = bodyBudgetCharged(), prepared = native(streamSelection()), lease = prepared.acquire(), abort = new AbortController();
  try {
    const result = await prepared.read(streamResponse([payload()]), abort.signal), reader = result.response.body.getReader();
    await reader.read(); const reason = new DOMException("synthetic downstream", "AbortError"); abort.abort(reason);
    await assert.rejects(reader.read(), error => error === reason); reader.releaseLock();
    assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
  } finally { lease.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

