import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareFalMusic, observeFalMusic, readFalMusic, assertFalMusicDispatch } from "../fal-music.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/fal/music.json", import.meta.url)));
const prepare = (index, changes = {}) => prepareFalMusic(wire.requests[index].model, { ...wire.requests[index].body, ...changes });

test("three frozen fal music products preserve native wire, model identity and per-model output format", () => {
  for (let i = 0; i < wire.requests.length; i++) {
    const prepared = prepare(i), result = observeFalMusic(wire.responses[i], prepared);
    assert.equal(prepared.path, "/" + wire.requests[i].model);
    assert.deepEqual(prepared.body, wire.requests[i].body); assert.notEqual(prepared.body, wire.requests[i].body);
    assert.equal(prepared.format, i === 0 ? "mp3" : "wav"); assert.equal(prepared.headers.has("authorization"), false);
    assert.equal(result.selectedModel, prepared.model); assert.equal(result.audio.format, prepared.format);
    assert.equal(result.upstreamCostMicros, null); assert.equal(result.audio.headers, undefined);
  }
});
test("MiniMax lyric/instrumental modes stay distinct and undocumented duration is rejected", () => {
  assert.equal(prepare(0, { lyrics_optimizer: false, lyrics: "[Verse]\nA synthetic song" }).body.lyrics_optimizer, false);
  assert.equal(prepare(0, { lyrics_optimizer: false, is_instrumental: true }).body.is_instrumental, true);
  for (const changes of [{ duration: 30 }, { lyrics: "synthetic", is_instrumental: true }, { lyrics: "synthetic" },
    { lyrics_optimizer: false }, { prompt: "short" }, { lyrics: "x".repeat(3501) },
    { audio_setting: { sample_rate: 44100, bitrate: 256000, format: "wav" } }]) assert.throws(() => prepare(0, changes));
});
test("ACE-Step accepts bounded fractional duration; Stable Audio requires integer 1–190 seconds", () => {
  assert.equal(prepare(1, { duration: 5.5 }).body.duration, 5.5);
  assert.equal(prepare(2, { seconds_total: 190 }).body.seconds_total, 190);
  for (const duration of [0, 4.9, 241, NaN, "30"]) assert.throws(() => prepare(1, { duration }));
  for (const seconds_total of [0, 1.5, 191, "12"]) assert.throws(() => prepare(2, { seconds_total }));
  for (const i of [1, 2]) assert.throws(() => prepare(i, { lyrics: "synthetic" }));
  assert.throws(() => prepare(2, { instrumental: true }));
});
test("callbacks, input references, malformed Unicode and unsupported model paths cannot escape the frozen contract", () => {
  for (const changes of [{ webhookUrl: "https://sink.example/hook" }, { image_url: "https://assets.example/image.png" }, { prompt: "\ud800" }]) assert.throws(() => prepare(1, changes));
  assert.throws(() => prepareFalMusic("fal-ai/other/music", wire.requests[1].body));
});
test("original dispatch requires the synchronous origin, exact selected path and native Key credentials", () => {
  const prepared = prepare(1);
  const request = (url, method = "POST", auth = "Key synthetic-original") => new Request(url, { method, headers: { authorization: auth, "content-type": "application/json" } });
  assertFalMusicDispatch(request("https://fal.run" + prepared.path), prepared);
  for (const req of [request("https://queue.fal.run" + prepared.path), request("https://other.example" + prepared.path),
    request("https://fal.run/" + wire.requests[2].model), request("https://fal.run" + prepared.path + "?webhookUrl=fixture"),
    request("https://fal.run" + prepared.path, "GET"), request("https://fal.run" + prepared.path, "POST", "Bearer synthetic")]) {
    assert.throws(() => assertFalMusicDispatch(req, prepared));
  }
});
test("queue acknowledgements, error envelopes and partial output never masquerade as a synchronous result", () => {
  for (const body of [{ request_id: "fixture", audio: wire.responses[1].audio }, { status: "IN_PROGRESS", audio: wire.responses[1].audio },
    { detail: "synthetic error", audio: wire.responses[1].audio }, { error: {}, audio: wire.responses[1].audio },
    { audio: [] }, { audio: {} }, { ...wire.responses[1], model: wire.requests[0].model }]) assert.throws(() => observeFalMusic(body, prepare(1)));
});
test("one bounded URL descriptor keeps MIME, advisory length and unsafe destinations fail-closed", () => {
  for (const url of ["http://assets.example/a", "https://127.0.0.1/a", "https://user:secret@assets.example/a", "https://host.internal/a", "data:audio/wav;base64,AA=="]) {
    assert.throws(() => observeFalMusic({ audio: url }, prepare(1)));
  }
  for (const file_size of [0, -1, 0.5, 16 * 1024 * 1024 + 1, "1024"]) assert.throws(() => observeFalMusic({ audio: { url: wire.responses[1].audio.url, file_size } }, prepare(1)));
  assert.throws(() => observeFalMusic({ audio: { ...wire.responses[1].audio, content_type: "text/html" } }, prepare(1)));
  assert.equal(observeFalMusic(wire.responses[2], prepare(2)).audio.mimeType, null);
});
test("strict complete JSON delivery rejects redirects, range/truncation and local cancellation without replay or a free-cost claim", async () => {
  assert.equal((await readFalMusic(Response.json(wire.responses[0]), prepare(0), new AbortController().signal)).upstreamCostMicros, null);
  for (const response of [
    Response.json(wire.responses[0], { status: 202 }), Response.json(wire.responses[0], { headers: { "content-range": "bytes 0-1/2" } }),
    Response.json(wire.responses[0], { headers: { "content-length": "9999" } }), new Response(null, { status: 302 }),
    Response.json({ detail: "timeout" }, { status: 504, headers: { "x-fal-needs-retry": "1" } }),
  ]) await assert.rejects(readFalMusic(response, prepare(0), new AbortController().signal));
  const signal = AbortSignal.abort();
  await assert.rejects(readFalMusic(Response.json(wire.responses[0]), prepare(0), signal));
});
