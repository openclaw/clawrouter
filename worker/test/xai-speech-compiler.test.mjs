import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareXaiSpeech, readXaiSpeech, xaiSpeechFormats } = await import("../xai-speech.ts");
const { prepareManifestRequest, prepareNativeRequest } = await import("../proxy-selection.ts");
const { configuredUpstream } = await import("../providers.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const existing = parse(readFileSync(new URL("../../providers/xai.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/speech.json", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities.push({ id: "audio.speech", endpoint: "tts", methods: ["POST"] });
  manifest.endpoints.tts = { method: "POST", path: "/v1/tts", pathParams: [], requestFormat: "xai.tts", responseFormat: "audio.binary" };
  return manifest;
}
function selected() {
  const snapshot = compile(fixture()), provider = snapshot.providers[0];
  return { snapshot, provider, endpoint: provider.endpoints.find(endpoint => endpoint.id === "tts") };
}

test("xAI TTS compiles a model-less binary offer while preserving existing Chat identities and legacy routes", () => {
  const { snapshot, provider, endpoint } = selected(), before = compile(existing);
  assert.deepEqual(snapshot.model_index, before.model_index);
  for (const previous of before.providers[0].endpoints) assert.deepEqual(provider.endpoints.find(endpoint => endpoint.id === previous.id), previous);
  assert.equal(endpoint.path, "/v1/tts"); assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.request_format, "xai.tts"); assert.equal(endpoint.response_format, "audio.binary");
  assert.deepEqual(endpoint.path_params, []); assert.deepEqual(endpoint.query, {}); assert.equal(endpoint.streaming, null);
  const catalog = createRouteCatalog([provider]), offer = catalog.manifestProxy.find(offer => offer.endpoint === "tts");
  assert.equal(offer.sampleModel, null); assert.deepEqual(offer.models, []);
  assert.deepEqual(catalog.openaiCompatible, createRouteCatalog(before.providers).openaiCompatible);
});

test("native and manifest xAI speech selection preserve the actual codec body and original Bearer key", () => {
  const { provider, endpoint } = selected(), original = structuredClone(wire.request);
  const auth = configuredUpstream(provider, null, { XAI_API_KEY: "synthetic-original-key" });
  assert.equal(auth.baseUrl + endpoint.path, "https://api.x.ai/v1/tts");
  assert.equal(auth.headers.get("authorization"), "Bearer synthetic-original-key");
  for (const codec of Object.keys(xaiSpeechFormats)) for (const native of [false, true]) {
    const body = { ...wire.request, output_format: { codec } }, before = structuredClone(body);
    const request = native ? prepareNativeRequest(provider, endpoint, body, endpoint.path, {})
      : prepareManifestRequest(provider, endpoint, body, {}, {});
    assert.equal(request.model, null); assert.deepEqual(request.pathParams, {});
    const prepared = prepareXaiSpeech(request.body);
    assert.equal(prepared.path, endpoint.path); assert.deepEqual(prepared.body, before);
    assert.equal(prepared.headers.get("accept"), xaiSpeechFormats[codec]);
    assert.equal(prepared.headers.has("authorization"), false); assert.equal(Object.hasOwn(prepared.body, "model"), false);
  }
  assert.deepEqual(wire.request, original);
  assert.throws(() => prepareManifestRequest(provider, endpoint, { ...wire.request, model: "grok-4.3" }, {}, {}), error => error.code === "model_capability_unsupported");
});

test("the existing xAI reader preserves codec-specific complete bytes without inventing billable duration or tokens", async () => {
  const { provider, endpoint } = selected();
  for (const [codec, mime] of Object.entries(xaiSpeechFormats)) {
    const body = { ...wire.request, output_format: { codec } };
    const request = prepareXaiSpeech(prepareNativeRequest(provider, endpoint, body, endpoint.path, {}).body);
    const audio = Uint8Array.from(wire.audioBytes);
    const result = await readXaiSpeech(new Response(audio, { headers: { "content-type": mime, "content-length": String(audio.length) } }), request, new AbortController().signal);
    assert.deepEqual(result.audio, audio); assert.equal(result.mimeType, mime);
    assert.equal(result.sampleRateBasis, "service_default"); assert.equal(result.upstreamCostMicros, null);
    await assert.rejects(() => readXaiSpeech(new Response(audio, { headers: { "content-type": "application/json" } }), request, new AbortController().signal));
    await assert.rejects(() => readXaiSpeech(new Response(audio, { headers: { "content-type": mime, "content-length": String(audio.length + 1) } }), request, new AbortController().signal));
  }
});

test("model-less xAI speech text and service defaults cannot certify upstream-dollar admission", () => {
  const { endpoint } = selected();
  const cost = estimateCost(null, wire.request, null, "audio.speech", endpoint);
  assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
  assert.throws(() => validateBudgetReservation("audio.speech", cost, 10000), error => error.code === "pricing_required");
  for (const charge of [0, 17]) {
    const fixed = estimateCost(null, wire.request, charge, "audio.speech", endpoint);
    assert.deepEqual(fixed, { reserveMicros: charge, basis: "policy_fixed", inputTokens: null, outputTokens: null });
    assert.doesNotThrow(() => validateBudgetReservation("audio.speech", fixed, 10000));
  }
});

test("xAI speech declarations reject binary aliases, alternate paths, socket or stream expansion and fabricated models", () => {
  const changes = [
    m => { m.id = "other"; }, m => { m.class = "rest_json"; },
    m => { m.endpoints.tts.requestFormat = "openai.audio_speech"; }, m => { m.endpoints.tts.requestFormat = "xai.tts_stream"; },
    m => { m.endpoints.tts.responseFormat = "binary"; }, m => { m.endpoints.tts.responseFormat = "xai.tts"; },
    m => { m.endpoints.tts.path = "/v1/audio/speech"; }, m => { m.endpoints.tts.path = "/v1/tts/voices"; },
    m => { m.endpoints.tts.method = "GET"; }, m => { delete m.endpoints.tts.method; },
    m => { m.endpoints.tts.pathParams = ["model"]; }, m => { delete m.endpoints.tts.pathParams; },
    m => { m.endpoints.tts.query = { sample_rate: "24000" }; }, m => { m.endpoints.tts.upstreamPath = "/v1/tts"; },
    m => { m.endpoints.tts.streaming = "sse"; }, m => { m.endpoints.tts.websocket = "openai.realtime"; },
    m => { m.endpoints.tts.nativeProxy = false; }, m => { m.endpoints.tts.modelPassthrough = {}; },
    m => { m.capabilities.at(-1).methods = ["POST", "GET"]; }, m => { m.capabilities.at(-1).id = "llm.chat"; },
    m => { m.endpoints.other = structuredClone(m.endpoints.tts); },
    m => { m.models.entries[0].capabilities.push("audio.speech"); },
    m => { m.models.entries.push({ id: "xai/tts-default", upstream: "tts-default", capabilities: ["audio.speech"] }); },
    m => { m.endpoints.tts.outputTokenLimit = { field: "max_tokens", minimum: 1, maximum: 100 }; },
    m => { m.endpoints.tts.requestPricing = { unit: "request", version: "synthetic", effectiveAt: "2026-11-03",
      source: "https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee", outcome: "xai.responses_violation",
      maximumAdditionalMicros: 50000, receipt: "xai.usage.cost_in_usd_ticks" }; },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /xai\.tts|invalid manifest/, String(change)); }
});

test("xAI TTS keeps credential, origin, native field and per-codec header authority out of declarations", () => {
  const changes = [
    m => { m.baseUrls.default = "https://speech.example"; }, m => { m.baseUrls.other = "https://api.x.ai/v1"; },
    m => { m.auth.schemes[0].header = "x-api-key"; }, m => { m.auth.schemes[0].secretKind = "oauth"; },
    m => { m.auth.schemes[0].required = false; }, m => { m.auth.schemes[0].format = "${secret}"; },
    m => { m.auth.schemes.push(structuredClone(m.auth.schemes[0])); },
    m => { m.auth.grantTransports = { api_key: { baseUrl: "https://speech.example" } }; },
    m => { m.routing.baseUrlParam = "XAI_ORIGIN"; }, m => { m.routing.serviceParam = "XAI_SERVICE"; },
    m => { m.endpoints.tts.auth = "none"; }, m => { m.endpoints.tts.requestHeaders = ["Authorization"]; },
    m => { m.endpoints.tts.headers = { Authorization: "synthetic" }; }, m => { m.endpoints.tts.headers = { accept: "audio/mpeg" }; },
    m => { m.adapter.injectHeaders = { Authorization: "synthetic" }; }, m => { m.adapter.injectQuery = { api_key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["Authorization"]; },
    m => { m.adapter.requestTransforms = { renameFields: [{ from: "text", to: "input" }] }; },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /xai\.tts|invalid manifest/, String(change)); }
});
