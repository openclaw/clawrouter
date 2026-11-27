import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareMistralRealtime, MistralRealtimeConnection, mistralRealtimeModel } from "../mistral-realtime.ts";
const fixture = JSON.parse(readFileSync(new URL("../../providers/_fixtures/mistral/realtime.json", import.meta.url), "utf8"));
const wire = JSON.stringify;
function connection() { const value = new MistralRealtimeConnection(prepareMistralRealtime()); value.server(wire(fixture.created)); value.client(wire(fixture.setup)); value.server(wire(fixture.updated)); return value; }

test("Mistral frozen connection preserves native model/query and rejects unscoped upgrades", () => {
  const request = prepareMistralRealtime(); assert.equal(request.model, mistralRealtimeModel); assert.equal(request.path, fixture.path);
  assert.deepEqual(Object.fromEntries(request.query), fixture.query); assert.deepEqual(request.setup, fixture.setup);
  assert.equal(request.headers, undefined);
  for (const config of [{ model: "voxtral-mini-transcribe-realtime-3-0" }, { sampleRate: 0 }, { targetStreamingDelayMs: 1.5 }, { encoding: "mp3" }, { token: "synthetic" }]) assert.throws(() => prepareMistralRealtime(config));
});

test("the socket cannot forward audio until native setup acknowledgment matches its format", () => {
  const value = new MistralRealtimeConnection(prepareMistralRealtime());
  assert.throws(() => value.client(wire(fixture.audio)), /not_ready/);
  value.server(wire(fixture.created)); assert.throws(() => value.client(wire(fixture.audio)), /not_ready/);
  value.client(wire(fixture.setup)); assert.throws(() => value.client(wire(fixture.audio)), /not_ready/);
  const wrong = structuredClone(fixture.updated); wrong.session.audio_format.sample_rate = 16000;
  assert.throws(() => value.server(wire(wrong)), /format_mismatch/);
  const foreign = structuredClone(fixture.updated); foreign.session.request_id = "another-session";
  assert.throws(() => value.server(wire(foreign)), /session_mismatch/);
  assert.equal(value.server(wire(fixture.updated)).ready, true);
  assert.deepEqual(value.client(wire(fixture.audio)), fixture.audio);
  assert.throws(() => value.client(wire(fixture.setup)), /setup_order/);
});

test("all six frozen audio encodings validate sample alignment without transcoding", () => {
  for (const [encoding, width] of Object.entries({ pcm_s16le: 2, pcm_s32le: 4, pcm_f16le: 2, pcm_f32le: 4, pcm_mulaw: 1, pcm_alaw: 1 })) {
    const request = prepareMistralRealtime({ encoding, sampleRate: 16000 }), value = new MistralRealtimeConnection(request);
    value.server(wire(fixture.created)); value.client(wire(request.setup));
    value.server(wire({ type: "session.updated", session: { ...fixture.updated.session, audio_format: { encoding, sample_rate: 16000 } } }));
    const audio = { type: "input_audio.append", audio: Buffer.alloc(width).toString("base64") };
    assert.deepEqual(value.client(wire(audio)), audio);
    if (width > 1) assert.throws(() => value.client(wire({ type: "input_audio.append", audio: "AA==" })), /audio/);
    for (const data of ["Zh==", "AAECAw=", "AAECAw===", ""]) assert.throws(() => value.client(wire({ type: "input_audio.append", audio: data })), /audio/);
  }
});

test("flush/end drains through native done, with no final transcript fabricated on disconnect", () => {
  const value = connection(); value.client(wire(fixture.audio)); value.client(wire(fixture.flush)); value.client(wire(fixture.end));
  assert.throws(() => value.client(wire(fixture.audio)), /not_ready/);
  assert.equal(value.server(wire(fixture.delta)).partial, "Synthetic ");
  const done = value.server(wire(fixture.done)); assert.equal(done.terminal, "done"); assert.equal(done.final, fixture.done.text);
  assert.deepEqual(done.usage, fixture.done.usage); assert.equal(done.costMicros, undefined);
  assert.throws(() => value.server(wire(fixture.done)), /closed/);
  const lost = connection(); lost.server(wire(fixture.delta)); assert.equal(lost.close(), undefined);
  assert.throws(() => lost.server(wire(fixture.done)), /closed/); assert.equal(fixture.qualification.socketCloseProvesFree, false);
});

test("finalized segments are not replayed by terminal full text or punctuation-only tails", () => {
  const value = connection(); value.server(wire(fixture.delta));
  assert.equal(value.server(wire(fixture.segment)).final, fixture.segment.text);
  value.server(wire({ type: "transcription.text.delta", text: "... " }));
  assert.equal(value.server(wire(fixture.done)).final, null);
  const later = connection(); later.server(wire(fixture.segment)); later.server(wire({ type: "transcription.text.delta", text: "More words." }));
  assert.equal(later.server(wire(fixture.done)).final, "More words.");
});

test("errors discard pending speech and cannot turn partial output into terminal success", () => {
  const value = connection(); value.server(wire(fixture.delta));
  const error = value.server(wire(fixture.error)); assert.equal(error.terminal, "error"); assert.equal(error.final, null); assert.equal(error.usage, null);
  assert.throws(() => value.server(wire(fixture.done)), /closed/);
  const beforeReady = new MistralRealtimeConnection(prepareMistralRealtime()); assert.equal(beforeReady.server(wire(fixture.error)).terminal, "error");
});

test("transcript accumulation is bounded by UTF-8 bytes and unknown events or models fail closed", () => {
  const value = connection(); value.server(wire({ type: "transcription.text.delta", text: "é".repeat(131072) }));
  assert.throws(() => value.server(wire({ type: "transcription.text.delta", text: "x" })), /transcript_limit/);
  assert.throws(() => value.client(wire(fixture.audio)), /not_ready/);
  const other = connection(); assert.throws(() => other.server(wire({ ...fixture.done, model: "another-model" })), /model_mismatch/);
  assert.throws(() => other.server(wire({ type: "transcription.translation", text: "unexpected" })), /server_event/);
  assert.throws(() => other.client(" ".repeat(1048577)), /frame/);
});
