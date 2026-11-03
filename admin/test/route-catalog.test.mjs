import "../../test/helpers/typescript-resolver.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createRouteCatalog } from "../../shared/route-catalog.ts";
const { demoCatalog } = await import("../src/demo-catalog.ts");

test("catalog routes restrict models and samples to each endpoint's capabilities", () => {
  const provider = { id: "fixture", class: "openai_compatible", routing: { modelPrefixes: ["fixture/"] }, capabilities: [{ id: "llm.chat", endpoint: "chat" }, { id: "llm.embeddings", endpoint: "embeddings" }, { id: "unknown", endpoint: "raw" }],
    models: [{ id: "chat-only", capabilities: ["llm.chat"] }, { id: "embed-only", capabilities: ["llm.embeddings"] }],
    endpoints: ["chat", "embeddings", "raw"].map(id => ({ id, methods: ["POST"], path_params: [], request_format: null, response_format: null, streaming: id === "chat" ? "sse" : null })) };
  const { openaiCompatible, manifestProxy } = createRouteCatalog([provider]);
  assert.deepEqual(openaiCompatible[0].endpoints, ["/v1/chat/completions", "/v1/embeddings"]);
  assert.deepEqual(manifestProxy.map(route => [route.endpoint, route.sampleModel, route.models.map(model => model.id), route.streaming]), [["chat", "chat-only", ["chat-only"], true], ["embeddings", "embed-only", ["embed-only"], false], ["raw", null, [], false]]);
  assert.equal(manifestProxy[0].requestFormat, null);
  assert.deepEqual(manifestProxy[0].pathParams, []);
  assert.equal(manifestProxy[0].route, "/v1/proxy/fixture/chat");
});

test("demo exposes modern unified routes and endpoint-specific model options", () => {
  const { routes } = demoCatalog();
  const openai = routes.openaiCompatible.find(provider => provider.provider === "openai");
  for (const path of ["/v1/decisions", "/v1/responses/compact", "/v1/responses/input_tokens", "/v1/moderations", "/v1/audio/speech", "/v1/audio/transcriptions", "/v1/images/generations"]) assert.ok(openai.endpoints.includes(path), path);
  const speech = routes.manifestProxy.find(route => route.provider === "openai" && route.requestFormat === "openai.audio_speech");
  assert.ok(speech.models.length);
  assert.ok(speech.models.every(model => model.capabilities.includes("audio.speech")));
  assert.ok(speech.models.some(model => model.id === speech.sampleModel));
  assert.ok(!speech.models.some(model => model.capabilities.includes("llm.embeddings")));
});

function decisionProvider(format) {
  return { id: "decision-fixture", class: "openai_compatible", routing: {},
    capabilities: [{ id: "llm.chat", endpoint: "chat" }, { id: "llm.decisions", endpoint: "decisions" }],
    models: [{ id: "chat", capabilities: ["llm.chat"] }, { id: "decision", capabilities: ["llm.decisions"] },
      { id: "mixed", capabilities: ["llm.chat", "llm.decisions"] }],
    endpoints: [{ id: "chat", methods: ["POST"], path_params: [], request_format: "openai.chat_completions", response_format: "openai.chat_completions" },
      { id: "decisions", methods: ["POST"], path_params: [], request_format: format, response_format: format }] };
}

test("native decision cards remain in their manifest route without false OpenAI decision offers", () => {
  const routes = createRouteCatalog([decisionProvider("baseten.systemone")]);
  assert.deepEqual(routes.openaiCompatible[0].endpoints, ["/v1/chat/completions"]);
  assert.deepEqual(routes.openaiCompatible[0].models.map(model => [model.id, model.capabilities, model.endpoints]),
    [["chat", ["llm.chat"], ["/v1/chat/completions"]], ["mixed", ["llm.chat"], ["/v1/chat/completions"]]]);
  const native = routes.manifestProxy.find(route => route.endpoint === "decisions");
  assert.equal(native.requestFormat, "baseten.systemone"); assert.equal(native.responseFormat, "baseten.systemone");
  assert.deepEqual(native.models.map(model => model.id), ["decision", "mixed"]);
});

test("actual OpenAI decision formats preserve legacy decision discovery", () => {
  const routes = createRouteCatalog([decisionProvider("openai.decisions")]);
  assert.ok(routes.openaiCompatible[0].endpoints.includes("/v1/decisions"));
  assert.deepEqual(routes.openaiCompatible[0].models.find(model => model.id === "decision").endpoints, ["/v1/decisions"]);
});

for (const mismatch of ["request", "response", "method", "binding"]) test(`legacy decision discovery rejects mismatched ${mismatch} qualification`, () => {
  const provider = decisionProvider("openai.decisions"), endpoint = provider.endpoints[1];
  if (mismatch === "request") endpoint.request_format = "baseten.systemone";
  if (mismatch === "response") endpoint.response_format = "baseten.systemone";
  if (mismatch === "method") endpoint.methods = ["GET"];
  if (mismatch === "binding") {
    provider.endpoints.push({ ...endpoint, id: "native", request_format: "baseten.systemone", response_format: "baseten.systemone" });
    provider.capabilities.unshift({ id: "llm.decisions", endpoint: "native" });
  }
  const routes = createRouteCatalog([provider]);
  assert.ok(!routes.openaiCompatible[0].endpoints.includes("/v1/decisions"));
  assert.ok(!routes.openaiCompatible[0].models.some(model => model.id === "decision"));
});
