import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { prepareManifestRequest, prepareNativeRequest } = await import("../proxy-selection.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");

// Declaration shape published by PR454. Its provider/codec files remain owned
// by that source; this fixture does not substitute for its binary runtime tests.
function fixture() {
  return {
    schema: "clawrouter.service-provider.v1", id: "gradium", displayName: "Gradium fixture", class: "rest_json",
    service: { platform: "gradium", kind: "tool_provider", configKeys: ["GRADIUM_API_KEY"] },
    auth: { schemes: [{ type: "api_key", header: "x-api-key", secretKind: "api_key" }] },
    baseUrls: { default: "https://api.gradium.ai" }, routing: { nativePrefixes: ["clawrouter-gradium", "gradium"] },
    adapter: { request: "rest_json", response: "rest_json" },
    capabilities: [{ id: "audio.speech", endpoint: "speech", methods: ["POST"] }],
    endpoints: { speech: { path: "/api/post/speech/tts", requestFormat: "gradium.speech", responseFormat: "audio.binary", timeoutMs: 120000 } },
  };
}
const compile = manifest => compileProviderSnapshot([manifest]);
const input = output_format => ({ text: "Synthetic café fixture", voice_id: "synthetic-voice", only_audio: true,
  output_format, model_name: "default", json_config: '{"padding_bonus":0}' });

test("Gradium compiles one model-less native speech offer without an OpenAI alias or invented price", () => {
  const snapshot = compile(fixture()), provider = snapshot.providers[0], endpoint = provider.endpoints[0];
  assert.deepEqual(snapshot.model_index, {}); assert.deepEqual(provider.models, []);
  assert.deepEqual(snapshot.capability_index, { "audio.speech": [{ provider: "gradium", endpoint: "speech", methods: ["POST"] }] });
  assert.equal(endpoint.path, "/api/post/speech/tts"); assert.equal(endpoint.method, "POST");
  assert.equal(endpoint.request_format, "gradium.speech"); assert.equal(endpoint.response_format, "audio.binary");
  assert.equal(endpoint.timeout_ms, 120000); assert.equal(endpoint.streaming, null); assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.modelPassthrough, undefined); assert.equal(endpoint.requestPricing, undefined);
  assert.deepEqual(provider.auth.schemes, fixture().auth.schemes);
  const catalog = createRouteCatalog([provider]);
  assert.deepEqual(catalog.openaiCompatible, []);
  assert.equal(catalog.manifestProxy[0].sampleModel, null); assert.deepEqual(catalog.manifestProxy[0].models, []);
  assert.equal(catalog.manifestProxy[0].requestFormat, "gradium.speech");
});

test("native Gradium settings survive native and manifest selection without becoming policy model IDs", () => {
  const provider = compile(fixture()).providers[0], endpoint = provider.endpoints[0];
  for (const format of ["wav", "opus", "ulaw_8000"]) {
    const body = input(format), before = structuredClone(body);
    for (const selected of [prepareManifestRequest(provider, endpoint, body, {}, {}), prepareNativeRequest(provider, endpoint, body, endpoint.path, {})]) {
      assert.equal(selected.model, null); assert.deepEqual(selected.body, before); assert.deepEqual(selected.pathParams, {});
    }
    assert.deepEqual(body, before);
  }
  assert.throws(() => prepareManifestRequest(provider, endpoint, { ...input("wav"), model: "default" }, {}, {}), error => error.code === "model_capability_unsupported");
  assert.throws(() => prepareManifestRequest(provider, endpoint, input("wav"), { model: "synthetic-model" }, {}), error => error.code === "model_capability_unsupported");
});

test("Gradium credit counts or native settings cannot certify a dollar budget; fixed policy remains distinct", () => {
  const provider = compile(fixture()).providers[0], endpoint = provider.endpoints[0];
  for (const format of ["wav", "opus", "ulaw_8000"]) {
    const body = input(format), unknown = estimateCost(null, body, null, "audio.speech", endpoint);
    assert.equal(unknown.inputTokens, null); assert.equal(unknown.outputTokens, null);
    assert.throws(() => validateBudgetReservation("audio.speech", unknown, 1000000), error => error.code === "pricing_required");
    const fixed = estimateCost(null, body, 17, "audio.speech", endpoint);
    assert.equal(fixed.basis, "policy_fixed"); assert.equal(fixed.reserveMicros, 17);
    assert.equal(fixed.inputTokens, null); assert.equal(fixed.outputTokens, null);
    assert.doesNotThrow(() => validateBudgetReservation("audio.speech", fixed, 1000000));
  }
});

test("Gradium rejects alternate formats, raw JSON streams, model passthrough and mismatched native paths", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { m.class = "openai_compatible"; },
    m => { m.endpoints.speech.requestFormat = "gradium.other"; }, m => { m.endpoints.speech.requestFormat = "openai.audio_speech"; },
    m => { m.endpoints.speech.responseFormat = "gradium.speech"; }, m => { m.endpoints.speech.responseFormat = "rest_json"; },
    m => { m.endpoints.speech.path = "/api/post/speech/tts/other"; }, m => { m.endpoints.speech.method = "GET"; },
    m => { m.endpoints.speech.upstreamPath = "/api/post/speech/tts"; }, m => { m.endpoints.speech.pathParams = ["model"]; },
    m => { m.endpoints.speech.query = { only_audio: "false" }; }, m => { m.endpoints.speech.streaming = "sse"; },
    m => { m.endpoints.speech.nativeProxy = false; }, m => { m.endpoints.speech.modelPassthrough = {}; },
    m => { m.endpoints.speech.outputTokenLimit = { field: "max_tokens", minimum: 1, maximum: 100 }; },
    m => { m.capabilities[0].id = "llm.chat"; }, m => { m.capabilities[0].methods = ["POST", "GET"]; },
    m => { m.capabilities.push({ id: "llm.chat", endpoint: "speech" }); },
    m => { m.endpoints.other = structuredClone(m.endpoints.speech); },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /gradium\.speech|invalid manifest/, String(change)); }
});

test("Gradium declarations pin the original native origin, x-api-key scheme and unchanged JSON settings", () => {
  for (const change of [
    m => { m.baseUrls.default = "https://api.gradium.ai/api"; }, m => { m.baseUrls.other = "https://speech.example"; },
    m => { m.auth.schemes[0].header = "Authorization"; }, m => { m.auth.schemes[0].secretKind = "oauth"; },
    m => { m.auth.schemes = [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }]; },
    m => { m.auth.schemes.push(structuredClone(m.auth.schemes[0])); },
    m => { m.auth.grantTransports = { api_key: { baseUrl: "https://speech.example" } }; },
    m => { m.endpoints.speech.auth = "none"; }, m => { m.endpoints.speech.requestHeaders = ["x-api-key"]; },
    m => { m.endpoints.speech.headers = { "x-api-key": "synthetic" }; },
    m => { m.adapter.injectHeaders = { "x-api-key": "synthetic" }; }, m => { m.adapter.injectQuery = { api_key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["x-api-key"]; }, m => { m.adapter.request = "openai"; }, m => { m.adapter.response = "openai"; },
    m => { m.adapter.requestTransforms = { renameFields: [{ from: "text", to: "input" }] }; },
    m => { m.routing.baseUrlParam = "GRADIUM_ORIGIN"; }, m => { m.routing.serviceParam = "GRADIUM_SERVICE"; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /gradium\.speech|invalid manifest/, String(change)); }
});

test("model-less Gradium declarations reject fabricated cards, model namespaces and outcome tariffs", () => {
  for (const change of [
    m => { m.models = { entries: [{ id: "gradium/default", upstream: "default", capabilities: ["audio.speech"] }] }; },
    m => { m.routing.modelPrefixes = ["gradium/"]; },
    m => { m.endpoints.speech.requestPricing = { unit: "request", version: "synthetic", effectiveAt: "2026-11-03",
      source: "https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee", outcome: "xai.responses_violation",
      maximumAdditionalMicros: 50000, receipt: "xai.usage.cost_in_usd_ticks" }; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /gradium\.speech|invalid manifest/, String(change)); }
  const empty = fixture(); empty.models = { entries: [] }; empty.routing.modelPrefixes = [];
  assert.deepEqual(compile(empty).model_index, {});
});
