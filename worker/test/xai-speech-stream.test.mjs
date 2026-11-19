import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareXaiSpeechStream, XaiSpeechStreamConnection } from "../xai-speech-stream.ts";
const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/speech-stream.json", import.meta.url)));
const wire = JSON.stringify;
function start(request = fixture.request) {
  const state = new XaiSpeechStreamConnection(request); state.opened();
  for (const frame of prepareXaiSpeechStream(request).frames) state.client(wire(frame));
  return state;
}

test("native socket query and UTF-16-safe frames preserve the complete admitted utterance", () => {
  const request = prepareXaiSpeechStream(fixture.request);
  assert.equal(request.path, "/v1/tts"); assert.equal(request.query.toString(), fixture.query);
  assert.deepEqual(request.frames, fixture.client); assert.equal(request.query.has("model"), false);
  assert.equal(request.query.has("api_key"), false);
  const text = "x".repeat(14999) + "🦊" + "y".repeat(15001);
  const frames = prepareXaiSpeechStream({ ...fixture.request, text }).frames;
  assert.equal(frames[0].delta.length, 14999);
  assert.equal(frames.filter(f => f.type === "text.delta").map(f => f.delta).join(""), text);
  assert.ok(frames.slice(0, -1).every(f => f.delta.length <= 15000 && f.delta.isWellFormed()));
  for (const field of [{ model: "tts-1" }, { with_timestamps: true }, { replace: {} }]) {
    assert.throws(() => prepareXaiSpeechStream({ ...fixture.request, ...field }));
  }
});

test("decoded byte identity stays provisional until exactly one native audio.done", () => {
  const state = start(), chunks = [];
  for (const event of fixture.server) {
    const result = state.server(wire(event)); assert.equal(result.upstreamCostMicros, null);
    if (result.audio) { chunks.push(...result.audio); assert.equal(result.terminal, null); }
    else assert.equal(result.terminal, "done");
  }
  assert.deepEqual(chunks, fixture.audioBytes);
  assert.deepEqual(state.close(), { outcome: "done", receivedAudioBytes: 4, validatedTextUtf16Units: fixture.request.text.length, upstreamCostMicros: null });
  assert.throws(() => state.server(wire(fixture.server.at(-1))));
  assert.equal(state.close().outcome, "done");
  assert.throws(() => state.client(wire(fixture.client[0])));
});

test("socket close and provider error never turn partial audio into completion or zero cost", () => {
  for (const interrupted of [true, false]) {
    const state = start(); state.server(wire(fixture.server[0]));
    if (!interrupted) assert.equal(state.server(wire(fixture.error)).terminal, "error");
    const outcome = state.close(); assert.equal(outcome.outcome, interrupted ? "incomplete" : "error");
    assert.equal(outcome.receivedAudioBytes, 2); assert.equal(outcome.upstreamCostMicros, null);
    assert.throws(() => state.opened()); assert.throws(() => state.client(wire(fixture.client[0])));
  }
  const state = new XaiSpeechStreamConnection(fixture.request);
  assert.equal(state.close().outcome, "incomplete");
});

test("only the pre-admitted text is dispatchable; no new turn, replacement, clear or early terminal", () => {
  for (const event of [fixture.client[1], { type: "text.delta", delta: "different" }, { type: "text.clear" }, { type: "session.update", replace: {} }, { ...fixture.client[0], model: "other" }]) {
    const state = new XaiSpeechStreamConnection(fixture.request); state.opened();
    assert.throws(() => state.client(wire(event))); assert.equal(state.close().outcome, "incomplete");
  }
  const beforeOpen = new XaiSpeechStreamConnection(fixture.request);
  assert.throws(() => beforeOpen.client(wire(fixture.client[0])));
  const early = new XaiSpeechStreamConnection(fixture.request); early.opened(); early.client(wire(fixture.client[0]));
  early.server(wire(fixture.server[0]));
  assert.throws(() => early.server(wire(fixture.server.at(-1))));
  assert.equal(early.close().outcome, "incomplete");
  assert.throws(() => start().server(wire(fixture.server.at(-1))));
});

test("malformed, noncanonical, oversized and unknown events poison only the current connection", () => {
  for (const event of [
    { type: "audio.delta", delta: "" }, { type: "audio.delta", delta: "AB==" },
    { type: "audio.delta", delta: "AAE" }, { type: "audio.delta", delta: "AAE=\n" },
    { type: "audio.delta", delta: "A===" }, { type: "audio.clear" },
    { type: "session.updated" }, { type: "audio.delta", delta: "AAE=", error: {} },
  ]) {
    const state = start(); assert.throws(() => state.server(wire(event)));
    assert.equal(state.close().outcome, "incomplete");
    assert.throws(() => state.server(wire(fixture.server[0])));
  }
  for (const malformed of ["{", "null", "x".repeat(24 * 1024 * 1024)]) {
    assert.throws(() => start().server(malformed));
  }
  const state = start(), delta = wire({ type: "audio.delta", delta: Buffer.alloc(256 * 1024).toString("base64") });
  for (let i = 0; i < 64; i++) state.server(delta);
  assert.throws(() => state.server(wire(fixture.server[0])));
  assert.equal(state.close().outcome, "incomplete");
});

test("PCM alignment is checked across chunks, without fabricating usage from byte lengths", () => {
  const odd = start(); odd.server(wire({ type: "audio.delta", delta: "AA==" }));
  assert.throws(() => odd.server(wire(fixture.server.at(-1))));
  const joined = start(); joined.server(wire({ type: "audio.delta", delta: "AA==" })); joined.server(wire({ type: "audio.delta", delta: "AQ==" }));
  assert.equal(joined.server(wire(fixture.server.at(-1))).terminal, "done");
  assert.equal(joined.close().upstreamCostMicros, null);
});

test("event limits bound low-byte streams and completion remains single-use", () => {
  const state = start();
  for (let i = 0; i < 8190; i++) state.server(wire({ type: "audio.delta", delta: "AAE=" }));
  assert.throws(() => state.server(wire(fixture.server.at(-1))));
  assert.equal(state.close().outcome, "incomplete");
});
