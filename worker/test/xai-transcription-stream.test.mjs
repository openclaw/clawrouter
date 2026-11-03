import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareXaiTranscriptionStream, XaiTranscriptionStreamConnection } from "../xai-transcription-stream.ts";
const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/transcription-stream.json", import.meta.url)));
const wire = JSON.stringify;
function make(query = fixture.query) { return new XaiTranscriptionStreamConnection(new URLSearchParams(query)); }
function start(query) { const state = make(query); state.opened(); state.server(wire(fixture.ready)); return state; }
function active(query) { const state = start(query); state.clientAudio(Uint8Array.from(fixture.audioBytes)); return state; }

test("native query preserves frozen telephony choices and omitted model without accepting new formats or credentials", () => {
  const request = prepareXaiTranscriptionStream(new URLSearchParams(fixture.query));
  assert.equal(request.path, "/v1/stt"); assert.equal(request.query.toString(), fixture.query);
  assert.equal(request.encoding, "mulaw"); assert.equal(request.sampleRate, 8000); assert.equal(request.query.has("model"), false);
  for (const query of [
    fixture.query + "&model=grok-voice-transcribe-2.0", fixture.query + "&api_key=synthetic",
    fixture.query + "&sample_rate=16000", fixture.query.replace("8000", "08000"), fixture.query.replace("8000", "96000"),
    fixture.query.replace("mulaw", "opus"), fixture.query.replace("true", "1"), fixture.query.replace("endpointing=800", "endpointing=5001"),
    fixture.query.replace("sample_rate=8000&", ""), fixture.query + "&multichannel=true",
  ]) assert.throws(() => prepareXaiTranscriptionStream(new URLSearchParams(query)));
  for (const sample of [8000, 16000, 22050, 24000, 44100, 48000]) {
    assert.equal(prepareXaiTranscriptionStream(new URLSearchParams(fixture.query.replace("8000", String(sample)))).sampleRate, sample);
  }
});

test("binary audio requires both an opened upgrade and native readiness; returned bytes are isolated", () => {
  const unopened = make(); assert.throws(() => unopened.server(wire(fixture.ready)));
  const waiting = make(); waiting.opened(); assert.throws(() => waiting.clientAudio(Uint8Array.of(1)));
  const state = start(), input = Uint8Array.from(fixture.audioBytes), output = state.clientAudio(input);
  input[0] = 99; assert.deepEqual([...output], fixture.audioBytes);
  assert.throws(() => state.server(wire(fixture.ready)));
  assert.equal(state.close().outcome, "incomplete");
});

test("chunk finals lock text; utterance finals are already stitched and session transcript replaces rather than appends", () => {
  const state = active(), observations = fixture.events.map(event => state.server(wire(event)));
  assert.deepEqual(observations.map(o => o.partial), ["Synthetic", "Synthetic", "Synthetic utterance.", null, null]);
  assert.deepEqual(observations.map(o => o.utterance), [null, null, null, "Synthetic utterance.", "Next."]);
  assert.ok(observations.every(o => o.terminal === null && o.upstreamCostMicros === null));
  // Identical successive native utterances cannot be deduped solely by text.
  assert.equal(state.server(wire(fixture.events.at(-1))).utterance, "Next.");
  state.client(wire(fixture.end)); const done = state.server(wire(fixture.done));
  assert.equal(done.terminal, "done"); assert.equal(done.utterance, null); assert.equal(done.partial, null);
  assert.equal(done.transcript, "Synthetic utterance. Next."); assert.equal(done.nativeDurationSeconds, 0.6);
  assert.equal(done.upstreamCostMicros, null); assert.equal(state.close().outcome, "done");
  assert.throws(() => state.server(wire(fixture.done))); assert.equal(state.close().outcome, "done");
});

test("disconnect drops locked text and never finalizes or replays it on another connection", () => {
  const state = active(); assert.equal(state.server(wire(fixture.events[1])).partial, "Synthetic");
  assert.deepEqual(state.close(), { outcome: "incomplete", validatedAudioBytes: 4, upstreamCostMicros: null });
  assert.throws(() => state.opened()); assert.throws(() => state.clientAudio(Uint8Array.of(1)));
  const replacement = active(); assert.equal(replacement.server(wire(fixture.events[2])).partial, "utterance.");
});

test("terminal evidence and errors stay distinct from complete text and vendor cost", () => {
  const beforeReady = make(); beforeReady.opened();
  assert.equal(beforeReady.server(wire(fixture.error)).terminal, "error"); assert.equal(beforeReady.close().upstreamCostMicros, null);
  assert.throws(() => active().server(wire(fixture.done)));
  for (const duration of [undefined, -1, "0.6", 86401, null]) {
    const state = active(); state.client(wire(fixture.end)); assert.throws(() => state.server(wire({ ...fixture.done, duration })));
    assert.equal(state.close().outcome, "incomplete");
  }
  const silence = start(); silence.client(wire(fixture.end));
  const done = silence.server(wire({ type: "transcript.done", text: "", duration: 0 }));
  assert.equal(done.terminal, "done"); assert.equal(done.upstreamCostMicros, null);
});

test("foreign channels, conflicting text, unknown messages and oversized native data close the decoder", () => {
  for (const event of [
    { ...fixture.events[0], channel_index: 1 }, { ...fixture.events[0], speech_final: true },
    { ...fixture.events[0], transcript: "conflict" }, { ...fixture.events[0], error: {} },
    { ...fixture.events[0], text: "x".repeat(256 * 1024 + 1) }, { ...fixture.events[0], text: "\ud800" },
    { type: "session.updated" }, { type: "transcript.partial", text: "missing final flags" },
  ]) { const state = active(); assert.throws(() => state.server(wire(event))); assert.equal(state.close().outcome, "incomplete"); }
  for (const event of [{ type: "Finalize" }, { type: "audio.done", channel: 1 }, { type: "audio.append", audio: "AA==" }]) {
    assert.throws(() => active().client(wire(event)));
  }
  assert.throws(() => active().server("{")); assert.throws(() => active().server("x".repeat(1024 * 1024 + 1)));
});

test("raw audio alignment, size and session limits do not invent duration or allow post-end audio", () => {
  const pcmQuery = fixture.query.replace("mulaw", "pcm");
  assert.throws(() => start(pcmQuery).clientAudio(Uint8Array.of(1)));
  assert.throws(() => start().clientAudio(new Uint8Array()));
  assert.throws(() => start().clientAudio(new Uint8Array(65537)));
  const bounded = start(), chunk = new Uint8Array(65536);
  for (let i = 0; i < 256; i++) bounded.clientAudio(chunk);
  assert.throws(() => bounded.clientAudio(Uint8Array.of(1)));
  assert.equal(bounded.close().upstreamCostMicros, null);
  const ended = active(); ended.client(wire(fixture.end)); assert.throws(() => ended.clientAudio(Uint8Array.of(1)));
});
