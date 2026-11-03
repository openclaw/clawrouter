import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareSenseAudioUpload, observeSenseAudioTranscription, senseAudioFileLimit, senseAudioModel } from "../senseaudio-transcription.ts";

const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/senseaudio/transcription.json", import.meta.url), "utf8"));
const bytes = Buffer.from(wire.request.file.base64, "base64");
const upload = (fields = {}, file = new File([bytes], wire.request.file.name, { type: wire.request.file.type })) => ({ file, fields: { ...wire.request.fields, ...fields } });

test("SenseAudio builds the frozen native multipart request without leaking router model IDs", async () => {
  for (const model of [senseAudioModel, `senseaudio/${senseAudioModel}`]) {
    const input = upload({ model, prompt: "synthetic café" }), form = prepareSenseAudioUpload(input);
    assert.equal(form.get("model"), senseAudioModel);
    assert.equal(form.get("language"), "zh");
    assert.equal(form.get("prompt"), "synthetic café");
    assert.equal(form.get("file").name, "synthetic.wav");
    assert.equal(form.get("file").type, "audio/wav");
    assert.deepEqual(Buffer.from(await form.get("file").arrayBuffer()), bytes);
    assert.equal(input.fields.model, model);
  }
});

test("SenseAudio enforces its smaller direct-upload limit independently of the generic parser", () => {
  assert.doesNotThrow(() => prepareSenseAudioUpload(upload({}, new File([new Uint8Array(senseAudioFileLimit)], "bound.wav", { type: "audio/wav" }))));
  for (const size of [0, senseAudioFileLimit + 1]) {
    assert.throws(() => prepareSenseAudioUpload(upload({}, new File([new Uint8Array(size)], "bound.wav", { type: "audio/wav" }))), /10000000/);
  }
});

test("SenseAudio preserves playable AAC as an AAC file instead of relabelling it as M4A", async () => {
  const sample = wire.aacFile, data = Buffer.from(sample.base64, "base64");
  let at = 0, frames = 0;
  while (at < data.length) {
    assert.equal(data[at], 0xff); assert.equal(data[at + 1] & 0xf6, 0xf0);
    assert.equal((data[at + 2] >> 2) & 15, 8, "16 kHz ADTS sampling frequency index");
    const size = ((data[at + 3] & 3) << 11) | (data[at + 4] << 3) | (data[at + 5] >> 5);
    assert.ok(size > 7 && at + size <= data.length); at += size; frames++;
  }
  assert.equal(frames, 3); assert.equal(at, data.length);
  const file = new File([data], sample.name, { type: sample.type }), form = prepareSenseAudioUpload(upload({ language: "eng" }, file));
  assert.equal(form.get("file").name, "synthetic.aac"); assert.equal(form.get("file").type, "audio/aac");
  assert.deepEqual(Buffer.from(await form.get("file").arrayBuffer()), data);
  assert.equal(form.get("language"), "eng"); assert.equal(form.get("model"), senseAudioModel);
  assert.throws(() => prepareSenseAudioUpload(upload({}, new File([data], "synthetic.m4a", { type: "audio/aac" }))));
});

test("SenseAudio WAV fixture is a complete PCM container and native duration is separate evidence", () => {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF"); assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  assert.equal(bytes.toString("ascii", 8, 16), "WAVEfmt "); assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 1); assert.equal(bytes.readUInt32LE(24), 8000); assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.toString("ascii", 36, 40), "data"); assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
  assert.equal(wire.mediaEvidence.responseIsIndependentSyntheticExample, true);
  assert.equal(wire.mediaEvidence.durationIsInvoiceEvidence, false);
});

test("SenseAudio rejects unsupported identity, fields, framing results and response modes", () => {
  for (const fields of [{ model: "openai/whisper-1" }, { file_id: "synthetic-file" }, { stream: "true" }, { response_format: "text" }, { language: "zh-CN" }, { prompt: "é".repeat(8193) }]) {
    assert.throws(() => prepareSenseAudioUpload(upload(fields)));
  }
  for (const [name, type] of [["../bad.wav", "audio/wav"], ["bad.wav", "text/plain"], ["bad.webm", "audio/webm"]]) {
    assert.throws(() => prepareSenseAudioUpload(upload({}, new File([bytes], name, { type }))));
  }
  assert.doesNotThrow(() => prepareSenseAudioUpload(upload({ language: "eng", stream: "false", response_format: "json" })));
});

test("SenseAudio observes complete text and distinguishes seconds from milliseconds", () => {
  assert.deepEqual(observeSenseAudioTranscription(wire.response, true), { text: wire.response.text, durationSeconds: 1.25 });
  assert.deepEqual(observeSenseAudioTranscription({ text: "", audio_info: { duration: 1250 } }, true), { text: "", durationSeconds: 1.25 });
  assert.deepEqual(observeSenseAudioTranscription({ text: "synthetic", duration: 0 }, true), { text: "synthetic", durationSeconds: 0 });
  for (const value of [{ text: "partial" }, { text: "partial", duration: 4 }]) assert.equal(observeSenseAudioTranscription(value, false), null);
  for (const value of [{}, [], { text: 4 }, { text: "synthetic", error: "rejected" }]) assert.equal(observeSenseAudioTranscription(value, true), null);
});

test("SenseAudio missing, conflicting and malformed duration never become free or token-priced evidence", () => {
  for (const value of [
    {}, { duration: "1" }, { duration: -1 }, { duration: Infinity }, { duration: NaN },
    { duration: 1, audio_info: { duration: 1001 } },
    { duration: null, audio_info: { duration: 1000 } },
    { audio_info: { duration: "1000" } }, { usage: { total_tokens: 300 } },
  ]) assert.deepEqual(observeSenseAudioTranscription({ text: "synthetic", ...value }, true), { text: "synthetic", durationSeconds: null });
  assert.equal(wire.billing.actualProviderCostMicrousd, null);
});
