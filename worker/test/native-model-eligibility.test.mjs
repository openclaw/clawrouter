import "../../test/helpers/typescript-resolver.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nativeModelEligible, nativeModelEligibilityRevision } from "../../shared/native-model-eligibility.ts";
const { createRouteCatalog, modelSupportsEndpoint } = await import("../../shared/route-catalog.ts");
import { googleSpeechModels, googleSpeechPreviewCutoff, prepareGoogleSpeech } from "../google-speech.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/speech.json", import.meta.url), "utf8"));
const cutoff = Date.parse(googleSpeechPreviewCutoff), before = cutoff - 1;
const formats = ["google.speech_generate_content", "google.speech_interactions"];

for (const model of googleSpeechModels) test(`${model} eligibility agrees with the actual native codec transport`, () => {
  const body = structuredClone(model.startsWith("gemini-3.8-") ? wire.interactions.request : wire.generateContent.request);
  if (body.model) body.model = model;
  const prepared = prepareGoogleSpeech(model, body, before);
  for (const format of formats) assert.equal(nativeModelEligible(format, model, before), format === `google.speech_${prepared.transport}`);
  assert.equal(nativeModelEligible(`google.speech_${prepared.transport}`, model, cutoff), prepared.transport === "interactions");
});

test("speech eligibility rejects missing, unqualified and alias identities without changing unrelated protocols", () => {
  for (const model of [null, undefined, "", "google-gemini/gemini-3.8-flash-tts", "gemini-3.1-flash-tts", "gemini-new-tts", "gemini-3.5-flash"]) {
    for (const format of formats) assert.equal(nativeModelEligible(format, model, before), false);
    assert.equal(nativeModelEligible("google.generate_content", model, before), true);
    assert.equal(nativeModelEligible("openai.audio_speech", model, cutoff), true);
  }
  for (const now of [NaN, Infinity, -Infinity]) for (const format of formats) for (const model of googleSpeechModels) assert.equal(nativeModelEligible(format, model, now), false);
  assert.notEqual(nativeModelEligibilityRevision(before), nativeModelEligibilityRevision(cutoff));
  assert.equal(nativeModelEligibilityRevision(cutoff), nativeModelEligibilityRevision(cutoff + 60_000));
});

test("the shared manifest catalog binds one capability to the qualified model transport and cutoff", t => {
  let now = before; t.mock.method(Date, "now", () => now);
  const provider = { id: "google-gemini", class: "native", routing: {},
    models: googleSpeechModels.map(upstream => ({ id: `google-gemini/${upstream}`, upstream, capabilities: ["audio.speech"] })),
    capabilities: formats.map((_, index) => ({ id: "audio.speech", endpoint: `speech_${index}` })),
    endpoints: formats.map((request_format, index) => ({ id: `speech_${index}`, request_format, methods: ["POST"], path_params: [] })),
  };
  const rows = () => createRouteCatalog([provider]).manifestProxy.map(route => route.models.map(model => model.id));
  assert.deepEqual(rows(), [provider.models.slice(0, 3).map(model => model.id), provider.models.slice(3).map(model => model.id)]);
  now = cutoff;
  assert.deepEqual(rows(), [[], provider.models.slice(3).map(model => model.id)]);
  assert.equal(modelSupportsEndpoint(provider, provider.models[0], provider.endpoints[0]), false);
  assert.equal(modelSupportsEndpoint(provider, { ...provider.models[3], availability: { version: "clawrouter.model-availability.v1", status: "stopped" } }, provider.endpoints[1]), false);
});
