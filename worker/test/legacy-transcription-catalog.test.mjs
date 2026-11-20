import assert from "node:assert/strict";
import test from "node:test";
import { createRouteCatalog } from "../../shared/route-catalog.ts";

function provider(format, modelLess = false) {
  return { id: "wire-fixture", class: "openai_compatible", routing: {},
    capabilities: [{ id: "llm.chat", endpoint: "chat" }, { id: "audio.transcription", endpoint: "transcribe" }],
    models: [{ id: "chat", capabilities: ["llm.chat"] }, ...modelLess ? [] : [
      { id: "audio", capabilities: ["audio.transcription"] }, { id: "mixed", capabilities: ["llm.chat", "audio.transcription"] },
    ]],
    endpoints: [{ id: "chat", methods: ["POST"], path_params: [], request_format: "openai.chat_completions", response_format: "openai.chat_completions" },
      { id: "transcribe", methods: ["POST"], path_params: [], request_format: format, response_format: format }],
  };
}

for (const format of ["xai.stt", "groq.transcription", "mistral.transcription", "openrouter.audio_transcription", "unknown.transcription"]) {
  test(`${format} remains native without inheriting a legacy OpenAI transport`, () => {
    const routes = createRouteCatalog([provider(format)]), legacy = routes.openaiCompatible[0];
    assert.deepEqual(legacy.endpoints, ["/v1/chat/completions"]);
    assert.deepEqual(legacy.models.map(model => [model.id, model.capabilities, model.endpoints]), [
      ["chat", ["llm.chat"], ["/v1/chat/completions"]], ["mixed", ["llm.chat"], ["/v1/chat/completions"]],
    ]);
    const native = routes.manifestProxy.find(route => route.endpoint === "transcribe");
    assert.equal(native.requestFormat, format); assert.equal(native.responseFormat, format);
    assert.deepEqual(native.models.map(model => model.id), ["audio", "mixed"]);
  });
}

test("model-less native transcription leaves the existing legacy Chat catalog unchanged", () => {
  const withSpeech = provider("xai.stt", true), before = structuredClone(withSpeech);
  before.capabilities.pop(); before.endpoints.pop();
  const routes = createRouteCatalog([withSpeech]);
  assert.deepEqual(routes.openaiCompatible, createRouteCatalog([before]).openaiCompatible);
  const native = routes.manifestProxy.find(route => route.endpoint === "transcribe");
  assert.equal(native.sampleModel, null); assert.deepEqual(native.models, []);
});

test("matching OpenAI transcription preserves legacy model and endpoint offers", () => {
  const legacy = createRouteCatalog([provider("openai.audio_transcriptions")]).openaiCompatible[0];
  assert.deepEqual(legacy.endpoints, ["/v1/chat/completions", "/v1/audio/transcriptions"]);
  assert.deepEqual(legacy.models.find(model => model.id === "audio").endpoints, ["/v1/audio/transcriptions"]);
});

for (const mismatch of ["request", "response", "method", "missing", "first-binding"]) {
  test(`transcription projection rejects ${mismatch} mismatch without choosing a later binding`, () => {
    const fixture = provider("openai.audio_transcriptions"), endpoint = fixture.endpoints[1];
    if (mismatch === "request") endpoint.request_format = "xai.stt";
    if (mismatch === "response") endpoint.response_format = "xai.stt";
    if (mismatch === "method") endpoint.methods = ["GET"];
    if (mismatch === "missing") fixture.endpoints.pop();
    if (mismatch === "first-binding") {
      fixture.endpoints.push({ ...endpoint, id: "native", request_format: "xai.stt", response_format: "xai.stt" });
      fixture.capabilities.unshift({ id: "audio.transcription", endpoint: "native" });
    }
    const legacy = createRouteCatalog([fixture]).openaiCompatible[0];
    assert.deepEqual(legacy.endpoints, ["/v1/chat/completions"]);
    assert.ok(legacy.models.every(model => !model.capabilities.includes("audio.transcription")));
  });
}
