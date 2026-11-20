import assert from "node:assert/strict";
import test from "node:test";
import { googleAudioRequest } from "../google-audio-classification.ts";

test("explicit native music and speech formats classify without assuming a model or tariff", () => {
  for (const format of ["google.music_generate", "google.speech_generate_content", "google.speech_interactions"])
    for (const body of [null, undefined, {}, []]) assert.equal(googleAudioRequest(null, body, format), true);
});
test("frozen selected audio identities cannot inherit generic text behavior when modalities are omitted", () => {
  for (const model of ["lyria-3-clip-preview", "lyria-3-pro-preview", "gemini-3.1-flash-tts-preview",
    "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"])
    assert.equal(googleAudioRequest(model, {}, "google.generate_content"), true);
  for (const model of [undefined, null, "google/lyria-3-pro-preview", "lyria-new", "gemini-3.5-flash", "gemini-3-pro-image"])
    assert.equal(googleAudioRequest(model, {}, "google.generate_content"), false);
});
test("native AUDIO and integer enum aliases classify output across ProtoJSON field names", () => {
  for (const value of ["AUDIO", 3, "3"]) for (const outer of ["generationConfig", "generation_config"])
    for (const inner of ["responseModalities", "response_modalities"])
      assert.equal(googleAudioRequest(null, { [outer]: { [inner]: ["TEXT", value] } }, "google.generate_content"), true);
});
test("outer ProtoJSON aliases retain last-value and null semantics", () => {
  const audio = { responseModalities: ["AUDIO"] }, text = { responseModalities: ["TEXT"] };
  for (const [body, expected] of [[{ generationConfig: text, generation_config: audio }, true],
    [{ generation_config: audio, generationConfig: text }, false], [{ generationConfig: audio, generation_config: null }, false]])
    assert.equal(googleAudioRequest(null, body, "google.generate_content"), expected);
});
test("inner ProtoJSON aliases retain last-value and null semantics", () => {
  for (const [config, expected] of [[{ responseModalities: ["TEXT"], response_modalities: ["AUDIO"] }, true],
    [{ response_modalities: ["AUDIO"], responseModalities: ["TEXT"] }, false], [{ responseModalities: ["AUDIO"], response_modalities: null }, false]])
    assert.equal(googleAudioRequest(null, { generationConfig: config }, "google.generate_content"), expected);
});
test("inline audio inputs, prompts, body model strings and function content do not select audio output", () => {
  const body = { model: "lyria-3-pro-preview", contents: [{ parts: [{ text: "AUDIO" },
    { inlineData: { mimeType: "audio/wav", data: "synthetic" } }, { functionResponse: { response: { generationConfig: { responseModalities: ["AUDIO"] } } } }] }],
    tools: [{ functionDeclarations: [{ name: "AUDIO" }] }] };
  assert.equal(googleAudioRequest("gemini-3.5-flash", body, "google.generate_content"), false);
});
test("unrelated protocols never acquire a native Google audio contract", () => {
  for (const format of ["openai.chat_completions", "google.embed_content", "google.omni_video_create", "google.image_generate", "audio.binary"])
    assert.equal(googleAudioRequest("lyria-3-pro-preview", { generationConfig: { responseModalities: ["AUDIO"] } }, format), false);
});
test("missing, text/image output and malformed non-audio values do not invent audio intent", () => {
  for (const modalities of [null, undefined, [], ["TEXT"], ["IMAGE"], [1, 2], "AUDIO", {}])
    assert.equal(googleAudioRequest(null, { generationConfig: { responseModalities: modalities } }, "google.generate_content"), false);
});
