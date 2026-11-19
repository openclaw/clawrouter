import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateGradiumSpeech } from "../gradium-speech.ts";

const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/gradium/speech.json", import.meta.url), "utf8"));

test("Gradium accepts the frozen unary consumer formats without rewriting text or voice settings", () => {
  for (const output_format of wire.consumerOutputFormats) {
    const body = { ...wire.request.body, output_format, text: "Aé😀e\u0301" }, original = structuredClone(body);
    validateGradiumSpeech(body);
    assert.deepEqual(body, original);
  }
});

test("Gradium rejects the native JSON-stream modes rather than treating them as binary audio", () => {
  for (const only_audio of [undefined, false, "true", 1, null]) {
    assert.throws(() => validateGradiumSpeech({ ...wire.request.body, only_audio }), /only_audio:true/);
  }
  assert.throws(() => validateGradiumSpeech({ ...wire.request.body, stream: true }), /does not support stream/);
});

test("Gradium rejects absent native input, unsupported formats and malformed settings", () => {
  for (const field of ["text", "voice_id"]) {
    for (const value of [undefined, null, "", " ", 4]) {
      assert.throws(() => validateGradiumSpeech({ ...wire.request.body, [field]: value }), /requires/);
    }
  }
  for (const output_format of [undefined, "mp3", "pcm", "", 1]) {
    assert.throws(() => validateGradiumSpeech({ ...wire.request.body, output_format }), /supports wav/);
  }
  for (const json_config of [null, {}, "null", "[]", "false", "{", "1"]) {
    assert.throws(() => validateGradiumSpeech({ ...wire.request.body, json_config }), /encoded JSON object/);
  }
  assert.doesNotThrow(() => validateGradiumSpeech({ ...wire.request.body, json_config: undefined }));
});
