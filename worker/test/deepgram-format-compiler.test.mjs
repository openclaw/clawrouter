import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";

// Schema fixture only. No bundled provider or claim of executable binary dispatch.
const fixture = {
  schema: "clawrouter.service-provider.v1", id: "deepgram", displayName: "Deepgram", class: "custom_adapter",
  service: { kind: "api_provider", configKeys: ["DEEPGRAM_API_KEY"] },
  baseUrls: { default: "https://api.deepgram.com" },
  auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Token ${secret}", secretKind: "api_key" }] },
  capabilities: [{ id: "audio.transcription", endpoint: "listen", methods: ["POST"] }],
  endpoints: { listen: { path: "/v1/listen", requestFormat: "deepgram.prerecorded", responseFormat: "deepgram.prerecorded" } },
  models: { entries: [{ id: "deepgram/nova-3", upstream: "nova-3", capabilities: ["audio.transcription"] }] },
};
const compile = manifest => compileProviderSnapshot([manifest]);

test("Deepgram raw-audio format compiles its exact native route and remains unpriced", () => {
  for (const explicit of [false, true]) {
    const manifest = structuredClone(fixture);
    if (explicit) Object.assign(manifest.endpoints.listen, { method: "POST", nativeProxy: true, query: {}, pathParams: [], headers: {} });
    const snapshot = compile(manifest), endpoint = snapshot.providers[0].endpoints[0];
    assert.equal(endpoint.path, "/v1/listen");
    assert.equal(endpoint.method, "POST");
    assert.equal(endpoint.request_format, "deepgram.prerecorded");
    assert.equal(endpoint.response_format, "deepgram.prerecorded");
    assert.equal(endpoint.streaming, null);
    assert.equal(endpoint.modelPassthrough, undefined);
    assert.equal(snapshot.model_index["deepgram/nova-3"].pricing, null);
    assert.deepEqual(endpoint.query, {}, "native repeated query values belong to the runtime URLSearchParams");
  }
});

test("Deepgram schema rejects JSON substitution, alternate lifecycle and static query/header injection", () => {
  const cases = [
    { path: "/v1/speak" }, { method: "GET" }, { nativeProxy: false },
    { requestFormat: "openai.audio_transcriptions" }, { responseFormat: "provider.native" },
    { streaming: "sse" }, { websocket: "openai.realtime" }, { modelPassthrough: {} },
    { auth: "none" }, { query: { callback: "https://example.com/callback" } }, { query: { model: "nova-3" } },
    { headers: { "content-type": "application/json" } }, { requestHeaders: ["authorization"] },
    { pathParams: ["model"] }, { pathParamStyles: { model: "segment" } },
    { outputTokenLimit: { field: "max_tokens", minimum: 1, maximum: 1024 } },
    { responsesLifecycle: { retrieve: "read", cancel: "cancel" } },
  ];
  for (const changed of cases) {
    const manifest = structuredClone(fixture); Object.assign(manifest.endpoints.listen, changed);
    assert.throws(() => compile(manifest), /invalid manifest/, JSON.stringify(changed));
  }
});

test("Deepgram compiler rejects cross-provider, credential, model and capability broadening", () => {
  const cases = [
    m => { m.id = "other"; },
    m => { m.endpoints.listen.requestFormat = m.endpoints.listen.responseFormat = "deepgram.future"; },
    m => { m.endpoints.listen.requestFormat = m.endpoints.listen.responseFormat = "openai.audio_transcriptions"; }, m => { m.baseUrls.default = "https://example.com"; },
    m => { m.auth.schemes[0].format = "Bearer ${secret}"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.schemes[0].header = "x-api-key"; }, m => { m.auth.schemes.push(m.auth.schemes[0]); },
    m => { m.auth.grantTransports = { api_key: { headers: { Authorization: "fixture" } } }; },
    m => { m.adapter = { injectQuery: { callback: "https://example.com/callback" } }; },
    m => { m.adapter = { passthroughHeaders: ["authorization"] }; },
    m => { m.adapter = { injectHeaders: { "content-type": "application/json" } }; },
    m => { m.adapter = { requestTransforms: { renameFields: [{ from: "audio", to: "url" }] } }; },
    m => { m.capabilities[0].methods.push("GET"); }, m => { m.capabilities[0].id = "llm.chat"; },
    m => { m.endpoints.other = structuredClone(m.endpoints.listen); },
    m => { m.models.entries[0].upstream = "nova-future"; }, m => { m.models.entries = []; },
  ];
  for (const mutate of cases) {
    const manifest = structuredClone(fixture); mutate(manifest);
    assert.throws(() => compile(manifest), /deepgram.prerecorded|invalid manifest/);
  }
});

test("a raw-audio byte bound cannot be turned into a token or flat-request price", () => {
  const pricing = { effectiveAt: "2026-11-03", source: "https://example.com/synthetic-tariff", inputMicrosPerMillion: 1, outputMicrosPerMillion: 1, maxInputTokens: 25000000, defaultMaxOutputTokens: 1 };
  for (const changed of [{ pricing, pricingRef: "invented-token-rate" }, { pricingRef: "unqualified" }, { endpointPricing: { listen: { pricing, pricingRef: "invented" } } }]) {
    const manifest = structuredClone(fixture); Object.assign(manifest.models.entries[0], changed);
    assert.throws(() => compile(manifest), /deepgram.prerecorded|invalid manifest/);
  }
  const manifest = structuredClone(fixture);
  manifest.endpoints.listen.requestPricing = { unit: "request", version: "fixture", effectiveAt: "2026-11-03", source: "https://example.com/synthetic-tariff", successfulResponseMicros: 1 };
  assert.throws(() => compile(manifest), /invalid manifest/);
});
