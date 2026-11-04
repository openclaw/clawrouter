import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { miniMaxMusicModels, miniMaxMusicAvailability, prepareMiniMaxMusic, inspectMiniMaxCoverBase64, observeMiniMaxMusic, readMiniMaxMusic, readMiniMaxMusicStream } from "../minimax-music.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/minimax/music.json", import.meta.url)));
const prepare = body => prepareMiniMaxMusic("global", body);
const signal = () => new AbortController().signal;
const sse = frames => frames.map(frame => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n";

test("finite frozen music requests retain explicit region, MP3 settings and availability disposition", () => {
  assert.deepEqual(miniMaxMusicModels, ["music-2.6", "music-2.6-free", "music-cover", "music-cover-free"]);
  assert.equal(miniMaxMusicAvailability.paid, "existing_paying_users_only");
  assert.equal(miniMaxMusicAvailability.free, "discontinuation_announced_date_unspecified");
  for (const model of miniMaxMusicModels) {
    const body = { ...(model.startsWith("music-cover") ? wire.cover : wire.request), model };
    for (const region of ["global", "cn"]) {
      const request = prepareMiniMaxMusic(region, body);
      assert.equal(request.origin, region === "global" ? "https://api.minimax.io" : "https://api.minimaxi.com");
      assert.equal(request.path, "/v1/music_generation"); assert.deepEqual(request.body, body);
      assert.equal(request.headers.has("authorization"), false);
    }
  }
  for (const body of [{ ...wire.request, model: "music-3.0" }, { ...wire.request, stream: null },
    { ...wire.request, output_format: "url" }, { ...wire.request, audio_setting: { ...wire.request.audio_setting, format: "wav" } }]) assert.throws(() => prepare(body));
});

test("MiniMax unary preparation qualifies only global regular frozen models without changing native input", () => {
  for (const model of ["music-2.6", "music-2.6-free"]) {
    const body = { ...wire.request, model, stream: false }, before = structuredClone(body);
    const request = prepareMiniMaxMusic("global", body);
    assert.equal(request.body, body); assert.deepEqual(body, before);
    assert.equal(request.origin, "https://api.minimax.io"); assert.equal(request.headers.get("accept"), "application/json");
    assert.throws(() => prepareMiniMaxMusic("cn", body));
    for (const field of ["audio_url", "audio_base64"]) for (const value of [undefined, null, "", "synthetic"])
      assert.throws(() => prepare({ ...body, [field]: value }));
  }
  for (const model of ["music-cover", "music-cover-free"]) assert.throws(() => prepare({ ...wire.cover, model, stream: false }));
  for (const stream of [undefined, null, 0, "false"]) assert.throws(() => prepare({ ...wire.request, stream }));
  assert.equal(prepare(wire.request).headers.get("accept"), "text/event-stream, application/json");
});

test("MiniMax unary observation requires one complete terminal JSON envelope and preserves native unknown cost", async () => {
  const request = prepare({ ...wire.request, stream: false }), terminal = wire.frames[2];
  const result = await readMiniMaxMusic(Response.json(terminal), request, signal());
  assert.deepEqual(result.frames, [terminal]); assert.deepEqual([...result.audio], [0, 255, 128]);
  assert.equal(result.mimeType, "audio/mpeg"); assert.equal(result.durationMillis, 25); assert.equal(result.upstreamCostMicros, null);
  assert.throws(() => observeMiniMaxMusic(wire.frames, request, true), /unary_frames/);
  assert.throws(() => observeMiniMaxMusic([terminal], request, false));
  await assert.rejects(readMiniMaxMusic(Response.json(wire.frames[0]), request, signal()));
  await assert.rejects(readMiniMaxMusic(new Response(sse([terminal]), { headers: { "content-type": "text/event-stream" } }), request, signal()));
});

test("instrumental/lyrics options and missing cover audio fail before egress", () => {
  const { lyrics_optimizer, ...body } = wire.request;
  assert.equal(prepare({ ...body, is_instrumental: true }).body.is_instrumental, true);
  assert.equal(prepare({ ...body, lyrics: "Synthetic lyrics" }).body.lyrics, "Synthetic lyrics");
  for (const candidate of [{ ...body }, { ...wire.request, is_instrumental: true },
    { ...body, is_instrumental: true, lyrics: "Synthetic lyrics" }, { ...wire.request, model: "music-cover" },
    { ...wire.cover, lyrics_optimizer: true }, { ...wire.cover, cover_feature_id: "foreign" },
    { ...wire.cover, audio_base64: "AQID" }, { ...wire.cover, audio_url: "https://user:synthetic@media.example/a.mp3" }]) assert.throws(() => prepare(candidate));
  const { audio_url, ...cover } = wire.cover;
  assert.equal(prepare({ ...cover, audio_base64: "AQID" }).body.audio_base64, "AQID");
});

// Bounded test-only oracle for the replaced validator, including its roundtrip.
const oldAtob = globalThis.atob, oldBtoa = globalThis.btoa, coverAudioLimit = 8 * 1024 * 1024;
function oldCoverBase64(value) {
  if (typeof value !== "string" || value.length > Math.ceil(coverAudioLimit / 3) * 4
    || !value || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    const raw = oldAtob(value);
    return raw.length && raw.length <= coverAudioLimit && oldBtoa(raw) === value ? { decodedBytes: raw.length } : null;
  } catch { return null; }
}
function inspectedCoverBase64(value) {
  try { return inspectMiniMaxCoverBase64(value); }
  catch (error) { assert.match(error.message, /^invalid_minimax_music_(text|audio_base64)$/); return null; }
}

test("cover scalar inspection matches the old bounded roundtrip across canonical bytes", () => {
  for (let size = 1; size <= 96; size++) {
    const bytes = Buffer.from(Array.from({ length: size }, (_, index) => (index * 73 + size) & 255));
    const encoded = bytes.toString("base64"), result = inspectMiniMaxCoverBase64(encoded);
    assert.deepEqual(result, oldCoverBase64(encoded)); assert.equal(result.decodedBytes, size);
    assert.deepEqual(Object.keys(result), ["decodedBytes"]); assert.equal(Object.isFrozen(result), true);
  }
});

test("cover scalar inspection preserves every final-sextet padding and unused-bit decision", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (const prefix of alphabet) for (const tail of alphabet) {
    for (const encoded of [prefix + tail + "==", "A" + prefix + tail + "="])
      assert.deepEqual(inspectedCoverBase64(encoded), oldCoverBase64(encoded));
  }
  for (const encoded of ["AB==", "AAB=", "/x==", "//9="]) assert.equal(inspectedCoverBase64(encoded), null);
});

test("cover scalar inspection rejects the old invalid alphabet, padding and non-string inputs without echo", () => {
  for (const value of [undefined, null, 1, [], {}, new String("AQID"), "", "A", "AA", "AAA", "AAAAA",
    "=AAA", "A=AA", "AA=A", "A===", "====", "AQID=", "AQID====", "AA==AAAA", "AQID\n", "\nAQID",
    " A==", "AA\t=", "AA\r=", "AA-_=", "AA-_", "____", "----", "AAé=", "AA\0=", "AA😀", "AA\ud800=",
    "data:audio/mpeg;base64,AQID", "https://media.example/audio.mp3"]) {
    assert.equal(oldCoverBase64(value), null); assert.equal(inspectedCoverBase64(value), null);
  }
});

test("cover inspection preserves exact 8MiB boundary even when max-plus-one has the same encoded length", t => {
  const { audio_url, ...cover } = wire.cover;
  for (const size of [coverAudioLimit - 1, coverAudioLimit, coverAudioLimit + 1]) {
    const encoded = Buffer.alloc(size, 255).toString("base64"), expected = oldCoverBase64(encoded);
    assert.equal(encoded.length, Math.ceil(coverAudioLimit / 3) * 4);
    assert.deepEqual(inspectedCoverBase64(encoded), expected);
    const decode = t.mock.method(globalThis, "atob", () => { throw new Error("unexpected cover decode"); });
    const encode = t.mock.method(globalThis, "btoa", () => { throw new Error("unexpected cover encode"); });
    try {
      for (const model of ["music-cover", "music-cover-free"]) {
        const body = { ...cover, model, audio_base64: encoded };
        if (size <= coverAudioLimit) assert.equal(prepare(body).body, body);
        else assert.throws(() => prepare(body), /invalid_minimax_music_audio_base64/);
      }
      assert.equal(decode.mock.callCount(), 0); assert.equal(encode.mock.callCount(), 0);
    } finally { t.mock.restoreAll(); }
  }
});

test("actual cover preparation uses scalar inspection without decoding or changing input ownership", t => {
  const decode = t.mock.method(globalThis, "atob", () => { throw new Error("unexpected cover decode"); });
  const encode = t.mock.method(globalThis, "btoa", () => { throw new Error("unexpected cover encode"); });
  const { audio_url, ...cover } = wire.cover;
  for (const model of ["music-cover", "music-cover-free"]) for (const region of ["global", "cn"]) {
    const body = Object.freeze({ ...cover, model, audio_base64: "AQID" });
    const request = prepareMiniMaxMusic(region, body);
    assert.equal(request.body, body); assert.equal(request.body.audio_base64, "AQID");
    for (const audio_base64 of ["AB==", "AAB=", "AA-_", "A==="])
      assert.throws(() => prepareMiniMaxMusic(region, { ...body, audio_base64 }), /invalid_minimax_music_audio_base64/);
  }
  assert.equal(decode.mock.callCount(), 0); assert.equal(encode.mock.callCount(), 0);
});

test("terminal aggregate replaces matching deltas once and never duplicates audio or invents cost", () => {
  const request = prepare(wire.request), result = observeMiniMaxMusic(wire.frames, request, true);
  assert.deepEqual([...result.audio], [0, 255, 128]); assert.equal(result.durationMillis, 25); assert.equal(result.upstreamCostMicros, null);
  assert.equal(result.frames.length, 3);
  const terminalOnly = observeMiniMaxMusic([wire.frames[2]], request, true);
  assert.deepEqual(terminalOnly.audio, result.audio);
  const noAggregate = structuredClone(wire.frames); delete noAggregate[2].data.audio;
  assert.deepEqual(observeMiniMaxMusic(noAggregate, request, true).audio, result.audio);
  const mismatch = structuredClone(wire.frames); mismatch[2].data.audio = "80";
  assert.throws(() => observeMiniMaxMusic(mismatch, request, true), /terminal_audio_mismatch/);
});

test("premature completion, post-terminal frames, vendor errors and metadata mismatch cannot finalize a track", () => {
  const request = prepare(wire.request);
  assert.throws(() => observeMiniMaxMusic(wire.frames, request, false));
  for (const frames of [
    wire.frames.slice(0, 2), [...wire.frames, wire.frames[0]],
    [{ ...wire.frames[2], base_resp: { status_code: 1008 } }],
    [{ ...wire.frames[2], model: "music-cover" }],
    [{ ...wire.frames[2], task_id: "unbound" }],
    [{ ...wire.frames[2], extra_info: { music_size: 4 } }],
    [{ ...wire.frames[2], data: { status: 2, audio: "https://media.example/result.mp3" } }],
    [{ ...wire.frames[2], data: { status: 2, audio: "" } }],
  ]) assert.throws(() => observeMiniMaxMusic(frames, request, true));
});

test("SSE read stages complete audio across byte chunks and rejects DONE without terminal or incomplete events", async () => {
  const request = prepare(wire.request), encoded = new TextEncoder().encode(sse(wire.frames));
  const stream = new ReadableStream({ start(controller) {
    for (let index = 0; index < encoded.length; index += 7) controller.enqueue(encoded.slice(index, index + 7)); controller.close();
  } });
  const result = await readMiniMaxMusic(new Response(stream, { headers: { "content-type": "text/event-stream" } }), request, signal());
  assert.deepEqual([...result.audio], [0, 255, 128]);
  assert.deepEqual((await readMiniMaxMusic(Response.json(wire.frames[2]), request, signal())).audio, result.audio);
  for (const body of [sse(wire.frames.slice(0, 2)), "data: " + JSON.stringify(wire.frames[2]),
    sse(wire.frames) + "data: " + JSON.stringify(wire.frames[2]) + "\n\n"]) {
    await assert.rejects(readMiniMaxMusic(new Response(body, { headers: { "content-type": "text/event-stream" } }), request, signal()));
  }
});

test("native reader rejects binary/URL fallback, HTTP errors, truncation and aborted stalled streams", async () => {
  const request = prepare(wire.request);
  for (const response of [
    new Response("synthetic", { headers: { "content-type": "audio/mpeg" } }),
    Response.json(wire.frames[2], { status: 202 }), new Response(null, { status: 302 }),
    new Response(Uint8Array.of(255), { headers: { "content-type": "text/event-stream" } }),
    new Response(sse(wire.frames), { headers: { "content-type": "text/event-stream", "content-length": "1" } }),
  ]) await assert.rejects(readMiniMaxMusic(response, request, signal()));
  let canceled = false; const controller = new AbortController();
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: {")); }, cancel() { canceled = true; } });
  const pending = readMiniMaxMusic(new Response(stream, { headers: { "content-type": "text/event-stream" } }), request, controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(canceled, true);
});

const streamHeaders = { "content-type": "text/event-stream" }, audioBound = 8 * 1024 * 1024;
function boundedStream(parts, width = 65536) {
  const iterator = parts[Symbol.iterator](); let current, offset = 0;
  return new ReadableStream({ pull(controller) {
    if (!current || offset === current.length) {
      const next = iterator.next(); if (next.done) { controller.close(); return; }
      current = typeof next.value === "string" ? new TextEncoder().encode(next.value) : next.value; offset = 0;
    }
    const end = Math.min(current.length, offset + width);
    controller.enqueue(new Uint8Array(current.subarray(offset, end))); offset = end;
  }, cancel() { iterator.return?.(); current = undefined; } }, { highWaterMark: 0 });
}
const boundedRead = (parts, width, model = "music-2.6") => readMiniMaxMusicStream(
  new Response(boundedStream(parts, width), { headers: streamHeaders }), model, signal());
const frame = (audio, status = 2, extra = {}) => ({ base_resp: { status_code: 0 }, data: { audio, status }, ...extra });

test("bounded MiniMax streaming preserves both selected models across arbitrary UTF8 and hex fragmentation", async () => {
  for (const model of ["music-2.6", "music-2.6-free"]) {
    const text = sse([frame("00ff", 1, { model }), frame("00ff80ab", "2", { model, note: "雪😀",
      extra_info: { music_size: 4, music_sample_rate: 44100, bitrate: 256000, music_duration: 0 } })]);
    for (const width of [1, 7, 1024]) {
      const result = await boundedRead([text], width, model);
      assert.deepEqual([...result.audio], [0, 255, 128, 171]); assert.equal(result.audio.buffer.byteLength, audioBound);
      assert.equal(result.terminal.data.audio, undefined); assert.equal(result.terminal.note, "雪😀");
      assert.equal(result.durationMillis, 0); assert.equal(result.upstreamCostMicros, null); assert.equal(result.model, model);
      assert.equal(result.frames, undefined);
    }
  }
});

function* largeFrames(previous, total = audioBound) {
  const audio = function* (size, terminal) {
    yield 'data: {"base_resp":{"status_code":0},"data":{"audio":"';
    for (let offset = 0; offset < size;) {
      const end = Math.min(size, offset + 16384, offset < previous ? previous : size);
      yield (offset < previous ? "11" : "22").repeat(end - offset); offset = end;
    }
    yield '","status":' + (terminal ? 2 : 1) + '}}\n\n';
  };
  yield* audio(previous, false); yield* audio(total, true);
}
test("one full 8MiB accumulator handles status-last aggregates on both sides of the in-place compaction boundary", async () => {
  for (const previous of [2 * 1024 * 1024, 6 * 1024 * 1024]) {
    const result = await boundedRead(largeFrames(previous));
    assert.equal(result.audio.byteLength, audioBound); assert.equal(result.audio.buffer.byteLength, audioBound);
    assert.ok(result.audio.subarray(0, previous).every(byte => byte === 17));
    assert.ok(result.audio.subarray(previous).every(byte => byte === 34));
  }
  await assert.rejects(boundedRead(largeFrames(1, audioBound + 1)));
  function* overflowingDelta() { for (const part of largeFrames(6 * 1024 * 1024, 6 * 1024 * 1024)) yield part.replace('"status":2', '"status":1'); }
  await assert.rejects(boundedRead(overflowingDelta()));
});

test("bounded stream handles terminal-only, no-aggregate, empty deltas and JSON field ordering without duplicating audio", async () => {
  for (const frames of [[frame("00ff")], [frame("00", 1), frame("ff", 1), frame("")],
    [frame("", 1), { data: { status: "2", audio: " 00FF " }, base_resp: { status_code: 0 } }]]) {
    assert.deepEqual([...(await boundedRead([sse(frames)], 3)).audio], [0, 255]);
  }
  const multi = 'data: {"base_resp":{"status_code":0},\r\ndata: "data":{"status":2,"audio":"00ff"}}\r\n\r\n';
  assert.deepEqual([...(await boundedRead([multi], 1)).audio], [0, 255]);
});

test("bounded stream requires terminal plus complete event and physical EOF, never DONE alone", async () => {
  for (const text of ["data: [DONE]\n\n", sse([frame("00", 1)]), 'data: '+JSON.stringify(frame("00")),
    sse([frame("00")]) + 'data: {}\n\n', sse([frame("00")]) + "data: [DONE]\n\n",
    sse([frame("00")]).replace("[DONE]", "[DONE]x"), sse([frame("00")]).replace("[DONE]", "[DONE]\ndata: x")])
    await assert.rejects(boundedRead([text], 1));
  let controller, settled = false, canceled = false; const abort = new AbortController();
  const pending = readMiniMaxMusicStream(new Response(new ReadableStream({ start(c) { controller = c; }, cancel() { canceled = true; } }),
    { headers: streamHeaders }), "music-2.6", abort.signal).then(value => { settled = true; return value; });
  controller.enqueue(new TextEncoder().encode(sse([frame("00")])));
  await new Promise(setImmediate); assert.equal(settled, false);
  abort.abort(new DOMException("synthetic caller", "AbortError"));
  await assert.rejects(pending); assert.equal(canceled, true);
});

test("bounded stream rejects errors, aggregate mismatch, unsafe controls and metadata contradictions", async () => {
  for (const frames of [[frame("00", 1), frame("ff")], [frame("00ff", 1), frame("00")],
    [frame("00", 1), frame("00", 2, { error: null })], [frame("00", 2, { model: "music-cover" })],
    [frame("00", 2, { base_resp: { status_code: 2013 } })], [frame("00", 2, { task_id: "unbound" })],
    [frame("00", 2, { extra_info: { music_size: 2 } })], [frame("00", 2, { extra_info: { bitrate: 128000 } })],
    [frame("00", 2, { extra_info: { music_duration: -1 } })], [frame("00", 2, { extra_info: { music_sample_rate: 32000 } })],
    [frame(null)], [frame(" ")], [frame("0")], [frame("00 01")], [frame("0g")], [frame("00", 3)]])
    await assert.rejects(boundedRead([sse(frames)], 7));
  await assert.rejects(boundedRead(['event: error\n' + sse([frame("00")])], 3));
  for (const field of ["audio_url", "audio_base64", "file", "file_id", "url", "task_id"]) {
    const item = frame("00"); item.data[field] = null;
    await assert.rejects(boundedRead([sse([item])]));
  }
});

test("bounded stream limits parser depth, metadata, duplicate keys, frames and SSE fields", async () => {
  const nested = frame("00"); nested.note = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
  for (const text of [sse([nested]), sse([frame("00", 2, { note: "a".repeat(32769) })]),
    'data: {"base_resp":{"status_code":0},"data":{"audio":"00","audio":"01","status":2}}\n\n',
    'data: {"base_resp":{"status_code":0},"data":{"audio":"00","status":1,"status":2}}\n\n',
    "unknown: value\n\n", sse([...Array.from({ length: 2048 }, () => frame("", 1)), frame("00")])])
    await assert.rejects(boundedRead([text]));
  assert.deepEqual([...(await boundedRead([sse([...Array.from({ length: 2047 }, () => frame("", 1)), frame("00")])])).audio], [0]);
});

test("bounded stream counts every empty read and rejects oversized physical views/backing", async () => {
  let pulls = 0, canceled = false;
  const empty = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(0)); }, cancel() { canceled = true; } }, { highWaterMark: 0 });
  await assert.rejects(readMiniMaxMusicStream(new Response(empty, { headers: streamHeaders }), "music-2.6", signal()));
  assert.equal(pulls, 262144); assert.equal(canceled, true);
  for (const bytes of [new Uint8Array(65537), new Uint8Array(65537).subarray(0, 1)]) {
    let stopped = false;
    await assert.rejects(readMiniMaxMusicStream(new Response(new ReadableStream({ start(c) { c.enqueue(bytes); }, cancel() { stopped = true; } }),
      { headers: streamHeaders }), "music-2.6", signal()));
    assert.equal(stopped, true);
  }
});

test("bounded stream enforces full original wire limit and identity Content-Length", async () => {
  const text = sse([frame("00")]), cap = audioBound * 5 + 65536;
  function* envelope(extra = 0) {
    let remaining = cap - Buffer.byteLength(text) + extra;
    while (remaining >= 3) { const n = Math.min(remaining, 32768); yield ":" + "x".repeat(n - 3) + "\n\n"; remaining -= n; }
    yield "\n".repeat(remaining); yield text;
  }
  assert.equal((await boundedRead(envelope())).audio.length, 1);
  await assert.rejects(boundedRead(envelope(1)));
  for (const length of [String(Buffer.byteLength(text)), String(Buffer.byteLength(text) + 1)]) {
    const pending = readMiniMaxMusicStream(new Response(boundedStream([text]), { headers: {
      ...streamHeaders, "content-encoding": "identity", "content-length": length } }), "music-2.6", signal());
    if (Number(length) === Buffer.byteLength(text)) assert.equal((await pending).audio.length, 1); else await assert.rejects(pending);
  }
});

test("bounded stream cancels failed reads and rejects HTTP/MIME/encoding/UTF8 errors", async () => {
  for (const headers of [{ "content-type": "application/json" }, { "content-type": "audio/mpeg" },
    { "content-type": "text/event-stream; charset=utf-16" }, { "content-encoding": "gzip" },
    { "content-range": "bytes 0-1/2" }, { "content-length": "01" }, { "content-length": "-1" }])
    await assert.rejects(readMiniMaxMusicStream(new Response(sse([frame("00")]), { headers: { ...streamHeaders, ...headers } }), "music-2.6", signal()));
  for (const status of [201, 206, 302, 500])
    await assert.rejects(readMiniMaxMusicStream(new Response("invalid", { status, headers: streamHeaders }), "music-2.6", signal()));
  await assert.rejects(boundedRead([new Uint8Array([255])]));
  for (const model of ["music-cover", "music-3.0", "minimax/music-2.6"])
    await assert.rejects(boundedRead([sse([frame("00")])], 64, model));
  for (const already of [false, true]) {
    let stopped = false; const abort = new AbortController();
    if (already) abort.abort();
    const pending = readMiniMaxMusicStream(new Response(new ReadableStream({ cancel() { stopped = true; } }), { headers: streamHeaders }), "music-2.6", abort.signal);
    if (!already) { await new Promise(setImmediate); abort.abort(); }
    await assert.rejects(pending); assert.equal(stopped, true);
  }
});

test("bounded BYOB path follows returned window ownership through small terminal and EOF", async () => {
  const bytes = new TextEncoder().encode(sse([frame("00ff80")])); let offset = 0;
  const source = new ReadableStream({ type: "bytes", pull(c) {
    if (offset === bytes.length) { c.close(); c.byobRequest?.respond(0); return; }
    const view = c.byobRequest.view, n = Math.min(view.byteLength, 7, bytes.length - offset);
    new Uint8Array(view.buffer, view.byteOffset, n).set(bytes.subarray(offset, offset + n)); offset += n;
    c.byobRequest.respond(n);
  } });
  const result = await readMiniMaxMusicStream(new Response(source, { headers: streamHeaders }), "music-2.6", signal());
  assert.deepEqual([...result.audio], [0, 255, 128]); assert.equal(result.audio.buffer.byteLength, audioBound);
});

test("bounded reader waits for cancellation completion before relinquishing its failed operation", async () => {
  const abort = new AbortController(); let finishCancel, settled = false;
  const pending = readMiniMaxMusicStream(new Response(new ReadableStream({
    cancel() { return new Promise(resolve => { finishCancel = resolve; }); },
  }), { headers: streamHeaders }), "music-2.6", abort.signal);
  const observed = pending.catch(error => { settled = true; throw error; });
  await new Promise(setImmediate); abort.abort(); await new Promise(setImmediate);
  assert.equal(typeof finishCancel, "function"); assert.equal(settled, false);
  finishCancel(); await assert.rejects(observed); assert.equal(settled, true);
});

