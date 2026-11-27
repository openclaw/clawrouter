import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { googleSpeechModels, googleSpeechPreviewCutoff, prepareGoogleSpeech, observeGoogleSpeech } from "../google-speech.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/speech.json", import.meta.url), "utf8"));
const now = Date.parse("2026-11-03T00:00:00Z");
const prepare = row => prepareGoogleSpeech(row.model, structuredClone(row.request), now);
const legacy = prepare(wire.generateContent), modern = prepare(wire.interactions);
const pcm = "AAD/fw==";

test("Google speech preserves all five frozen native model transports and rejects silent aliases", () => {
  assert.equal(googleSpeechModels.length, 5);
  for (const model of googleSpeechModels) {
    const interactions = model.startsWith("gemini-3.8-"), body = structuredClone(interactions ? wire.interactions.request : wire.generateContent.request);
    if (interactions) body.model = model;
    const value = prepareGoogleSpeech(model, body, now);
    assert.equal(value.body, body);
    assert.equal(value.path, interactions ? "/v1beta/interactions" : "/v1beta/models/" + model + ":generateContent");
    assert.equal(value.headers.get("x-goog-api-key"), null);
  }
  for (const model of ["gemini-3.1-flash-tts", "gemini-3.8-live", "gemini-new-tts"]) assert.throws(() => prepareGoogleSpeech(model, wire.generateContent.request, now));
});

test("Google preview speech fails closed at its explicit qualification cutoff without remapping", () => {
  const cutoff = Date.parse(googleSpeechPreviewCutoff);
  assert.doesNotThrow(() => prepareGoogleSpeech(legacy.model, legacy.body, cutoff - 1));
  for (const model of googleSpeechModels.slice(0, 3)) assert.throws(() => prepareGoogleSpeech(model, legacy.body, cutoff), /qualification_expired/);
  assert.doesNotThrow(() => prepareGoogleSpeech(modern.model, modern.body, cutoff));
});

test("Google speech requires stateless unary text/audio requests and exact output format", () => {
  for (const patch of [{ store: true }, { store: undefined }, { stream: true }, { background: true }, { previous_interaction_id: "unbound" }, { model: "gemini-3.8-flash-lite-tts" }]) {
    assert.throws(() => prepareGoogleSpeech(modern.model, { ...modern.body, ...patch }, now));
  }
  for (const patch of [{ mime_type: "audio/mp3" }, { sample_rate: 8000 }, { type: "text" }]) {
    assert.throws(() => prepareGoogleSpeech(modern.model, { ...modern.body, response_format: { ...modern.body.response_format, ...patch } }, now));
  }
  const invalid = structuredClone(legacy.body);
  invalid.contents[0].parts[0] = { inlineData: { mimeType: "audio/wav", data: pcm } };
  assert.throws(() => prepareGoogleSpeech(legacy.model, invalid, now));
  invalid.contents[0].parts[0] = { text: "x".repeat(65537) };
  assert.throws(() => prepareGoogleSpeech(legacy.model, invalid, now));
  assert.throws(() => prepareGoogleSpeech(legacy.model, { ...legacy.body, tools: [] }, now));
});

test("Google dialogue preserves speaker identity and style without inventing a one-speaker map", () => {
  assert.deepEqual(prepare(wire.dialogue).body, wire.dialogue.request);
  for (const mutate of [
    body => { body.generation_config.speech_config.speakers.pop(); },
    body => { body.generation_config.speech_config.speakers[1].speaker = "Narrator"; },
    body => { body.input[0].content[1].annotations[0].speaker = "Unknown"; },
    body => { delete body.input[0].content[0].annotations; },
    body => { body.input[0].content[0].annotations[0].type = "citation"; },
  ]) {
    const body = structuredClone(wire.dialogue.request); mutate(body);
    assert.throws(() => prepareGoogleSpeech(wire.dialogue.model, body, now));
  }
});

test("Google native complete audio supports explicit PCM, output aliases and step envelopes", () => {
  const a = observeGoogleSpeech(wire.generateContent.response, legacy, true), b = observeGoogleSpeech(wire.interactions.response, modern, true);
  assert.equal(a.audio[0].pcmBytes, 4); assert.equal(b.audio[0].base64, pcm);
  assert.deepEqual(a.body.usageMetadata, wire.generateContent.response.usageMetadata);
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
  const alternative = { status: "completed", steps: [{ content: [{ type: "audio", mimeType: "audio/l16", data: "AAD_fw" }] }] };
  assert.equal(observeGoogleSpeech(alternative, modern, true).audio[0].base64, pcm);
  assert.equal(observeGoogleSpeech({ outputAudio: { data: pcm } }, modern, true).audio[0].pcmBytes, 4);
});

function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(40, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
test("Google WAV output requires complete mono PCM16 24kHz framing instead of trusting the label", () => {
  const value = bytes => ({ status: "completed", output_audio: { mime_type: "audio/wav", data: bytes.toString("base64") } });
  assert.equal(observeGoogleSpeech(value(wav()), modern, true).audio[0].pcmBytes, 4);
  for (const mutate of [
    bytes => { bytes.writeUInt32LE(10, 4); }, bytes => { bytes.writeUInt16LE(2, 22); },
    bytes => { bytes.writeUInt32LE(8000, 24); }, bytes => { bytes.writeUInt32LE(100, 40); },
  ]) { const bytes = wav(); mutate(bytes); assert.throws(() => observeGoogleSpeech(value(bytes), modern, true)); }
  assert.throws(() => observeGoogleSpeech(value(Buffer.from([0, 1])), modern, true));
});

test("Google partial, blocked, ambiguous or malformed audio cannot publish successful speech", () => {
  assert.throws(() => observeGoogleSpeech(wire.interactions.response, modern, false));
  for (const body of [
    { ...wire.interactions.response, status: "in_progress" }, { ...wire.interactions.response, error: {} },
    { ...wire.interactions.response, model: "other" }, { ...wire.interactions.response, outputAudio: { data: pcm } },
    { status: "completed", steps: [{ content: [{ type: "text", text: "no audio" }] }] },
  ]) assert.throws(() => observeGoogleSpeech(body, modern, true));
  const stopped = structuredClone(wire.generateContent.response); stopped.candidates[0].finishReason = "MAX_TOKENS";
  assert.throws(() => observeGoogleSpeech(stopped, legacy, true));
  for (const data of ["", "AA", "AB==", "bad!", "A==="]) assert.throws(() => observeGoogleSpeech({ output_audio: { data } }, modern, true));
  for (const mime_type of ["audio/mpeg", "audio/l16;rate=8000", "audio/l16;rate=24000;rate=8000", "audio/l16;bits=8"]) {
    assert.throws(() => observeGoogleSpeech({ output_audio: { data: pcm, mime_type } }, modern, true));
  }
  const later = { steps: [{ content: [{ type: "audio", data: pcm }, { type: "audio", data: "invalid!" }] }] };
  assert.throws(() => observeGoogleSpeech(later, modern, true), "a valid prefix cannot conceal malformed later audio");
});
