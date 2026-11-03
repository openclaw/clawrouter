import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { miniMaxMusicModels, miniMaxMusicAvailability, prepareMiniMaxMusic, observeMiniMaxMusic, readMiniMaxMusic } from "../minimax-music.ts";
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
  for (const body of [{ ...wire.request, model: "music-3.0" }, { ...wire.request, stream: false },
    { ...wire.request, output_format: "url" }, { ...wire.request, audio_setting: { ...wire.request.audio_setting, format: "wav" } }]) assert.throws(() => prepare(body));
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

