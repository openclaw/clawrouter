import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { googleSpeechModels, googleSpeechPreviewCutoff, prepareGoogleSpeech } = await import("../google-speech.ts");
const { prepareNativeGoogleSpeech } = await import("../native-google-speech.ts");
const { modelSupportsEndpoint, createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { nativeModelEligible } = await import("../../shared/native-model-eligibility.ts");
const { configuredUpstream } = await import("../providers.ts");
const existing = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/speech.json", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
const ids = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
const now = Date.parse("2026-11-03T00:00:00Z");
test.beforeEach(t => t.mock.method(Date, "now", () => now));
function fixture(isolated = false) {
  const manifest = structuredClone(existing);
  if (isolated) {
    // Provider-wide mutations must reach the speech guard, not unrelated image/music guards.
    manifest.capabilities = manifest.capabilities.filter(row => !["image_generate", "music_generate"].includes(row.endpoint));
    delete manifest.endpoints.image_generate;
    delete manifest.endpoints.music_generate;
    manifest.models.entries = manifest.models.entries.filter(row => !row.capabilities.some(id => ["image.generate", "audio.generate"].includes(id)));
  }
  for (const [id, interactions] of [["speech_generate_content", false], ["speech_interactions", true]]) {
    if (!manifest.capabilities.some(value => value.id === "audio.speech" && value.endpoint === id))
      manifest.capabilities.push({ id: "audio.speech", endpoint: id, methods: ["POST"] });
    manifest.endpoints[id] ??= { method: "POST", path: interactions ? "/v1beta/interactions" : "/v1beta/models/${model}:generateContent",
      pathParams: interactions ? [] : ["model"], requestFormat: `google.${id}`, responseFormat: `google.${id}`,
      ...(interactions ? { nativeProxy: false } : {}) };
  }
  for (const upstream of ids) if (!manifest.models.entries.some(value => value.id === `google/${upstream}`))
    manifest.models.entries.push({ id: `google/${upstream}`, upstream, capabilities: ["audio.speech"] });
  return manifest;
}
function selection(provider, model, endpoint) {
  const interactions = endpoint.request_format === "google.speech_interactions";
  const body = structuredClone(interactions ? wire.interactions.request : wire.generateContent.request);
  if (interactions) body.model = model.upstream;
  return { provider, model, body, endpoint, capability: "audio.speech", method: "POST", pathParams: interactions ? {} : { model: model.upstream } };
}

test("Google speech compiled declarations bind all five actual codec models to their qualified wrapper transport", () => {
  const manifest = fixture(), before = structuredClone(manifest), provider = compile(manifest).providers[0];
  assert.deepEqual(manifest, before); assert.deepEqual([...googleSpeechModels], ids);
  for (const upstream of ids) {
    const model = provider.models.find(value => value.upstream === upstream);
    const eligible = provider.endpoints.filter(endpoint => modelSupportsEndpoint(provider, model, endpoint));
    assert.equal(eligible.length, 1);
    const selected = selection(provider, model, eligible[0]), prepared = prepareGoogleSpeech(upstream, selected.body, now);
    const native = prepareNativeGoogleSpeech(selected);
    assert.equal(native.path, prepared.path); assert.equal(native.origin, "https://generativelanguage.googleapis.com");
    assert.equal(prepared.body, selected.body); assert.equal(native.tariff, undefined);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
    assert.equal(configuredUpstream(provider, null, { GOOGLE_API_KEY: "synthetic-selected-key" }).headers.get("x-goog-api-key"), "synthetic-selected-key");
    assert.equal(selected.endpoint.native_proxy, prepared.transport !== "interactions");
  }
});

test("shared speech eligibility filters actual manifest catalog offers without endpoint ordering or extra metadata", () => {
  for (const reverse of [false, true]) {
    const manifest = fixture();
    if (reverse) manifest.endpoints = Object.fromEntries(Object.entries(manifest.endpoints).reverse());
    const provider = compile(manifest).providers[0], catalog = createRouteCatalog([provider]);
    for (const [id, expected] of [["speech_generate_content", ids.slice(0, 3)], ["speech_interactions", ids.slice(3)]]) {
      const offer = catalog.manifestProxy.find(value => value.endpoint === id);
      assert.deepEqual(offer.models.map(model => model.id).sort(), expected.map(id => `google/${id}`).sort());
      assert.equal(offer.route, `/v1/proxy/google-gemini/${id}`);
    }
    const generic = provider.endpoints.find(value => value.id === "generate_content");
    assert.ok(provider.models.filter(model => ids.includes(model.upstream)).every(model => !modelSupportsEndpoint(provider, model, generic)));
  }
});

test("compiled previews expire through the actual trusted selector while stateless Interactions remains eligible", t => {
  const provider = compile(fixture()).providers[0], cutoff = Date.parse(googleSpeechPreviewCutoff);
  t.mock.method(Date, "now", () => cutoff);
  const catalog = createRouteCatalog([provider]);
  assert.deepEqual(catalog.manifestProxy.find(value => value.endpoint === "speech_generate_content").models, []);
  assert.equal(catalog.manifestProxy.find(value => value.endpoint === "speech_interactions").models.length, 2);
  for (const endpoint of provider.endpoints.filter(value => value.request_format.startsWith("google.speech"))) {
    for (const model of provider.models.filter(value => ids.includes(value.upstream))) {
      assert.equal(modelSupportsEndpoint(provider, model, endpoint), nativeModelEligible(endpoint.request_format, model.upstream, cutoff));
    }
  }
  // Compilation retains historical facts; only the runtime clock decides live eligibility.
  assert.deepEqual(compile(fixture()).providers[0].models, provider.models);
});

test("Google speech declaration preserves all existing generic and embedding endpoint/model facts", () => {
  const original = compile(existing), snapshot = compile(fixture());
  for (const endpoint of original.providers[0].endpoints) assert.deepEqual(snapshot.providers[0].endpoints.find(value => value.id === endpoint.id), endpoint);
  for (const [id, model] of Object.entries(original.model_index)) assert.deepEqual(snapshot.model_index[id], model);
  assert.deepEqual(snapshot.capability_index["llm.generate"], original.capability_index["llm.generate"]);
  assert.deepEqual(snapshot.capability_index["llm.stream"], original.capability_index["llm.stream"]);
});

test("Google speech declarations reject format/path aliases, stream or query bypasses and native Interactions ambiguity", () => {
  const changes = [
    m => { m.endpoints.speech_generate_content.requestFormat = "google.speech"; },
    m => { m.endpoints.speech_generate_content.responseFormat = "google.generate_content"; },
    m => { m.endpoints.speech_generate_content.requestFormat = m.endpoints.speech_generate_content.responseFormat = "google.generate_content"; },
    m => { m.endpoints.speech_generate_content.path = "/v1beta/models/${model}:streamGenerateContent"; },
    m => { m.endpoints.speech_generate_content.pathParams = []; },
    m => { m.endpoints.speech_interactions.pathParams = ["model"]; },
    m => { m.endpoints.speech_interactions.nativeProxy = true; }, m => { delete m.endpoints.speech_interactions.nativeProxy; },
    m => { m.endpoints.speech_interactions.pathParamStyles = { model: "segment" }; },
    m => { m.endpoints.speech_generate_content.pathParamStyles = { model: "relative_path" }; },
    m => { m.endpoints.speech_interactions.method = "GET"; }, m => { delete m.endpoints.speech_interactions.method; },
    m => { m.endpoints.speech_interactions.upstreamPath = "/v1beta/interactions"; },
    m => { m.endpoints.speech_interactions.query = { alt: "sse" }; }, m => { m.endpoints.speech_interactions.streaming = "sse"; },
    m => { m.endpoints.speech_interactions.modelPassthrough = {}; },
    m => { m.endpoints.speech_interactions.outputTokenLimit = { field: "max_tokens", minimum: 1, maximum: 100 }; },
    m => { m.capabilities.find(value => value.endpoint === "speech_interactions").methods.push("GET"); },
    m => { m.endpoints.other_speech = structuredClone(m.endpoints.speech_interactions); m.capabilities.push({ id: "audio.speech", endpoint: "other_speech", methods: ["POST"] }); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google speech|invalid manifest/, String(change)); }
});

test("Google speech declarations reject origin, credential and transformation overrides", () => {
  assert.doesNotThrow(() => compile(fixture(true)));
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default += "/v1beta"; }, m => { m.baseUrls.other = "https://other.example"; },
    m => { m.routing.baseUrlParam = "base_url"; }, m => { m.routing.serviceParam = "service"; },
    m => { m.auth.schemes[0].header = "Authorization"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.grantTransports = { api_key: { headers: { "x-goog-api-key": "synthetic" } } }; },
    m => { m.endpoints.speech_interactions.auth = "none"; }, m => { m.endpoints.speech_interactions.requestHeaders = ["x-goog-api-key"]; },
    m => { m.endpoints.speech_interactions.headers = { "x-goog-api-key": "synthetic" }; },
    m => { m.adapter.injectHeaders = { "x-goog-api-key": "synthetic" }; }, m => { m.adapter.injectQuery = { key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["x-goog-api-key"]; },
  ];
  for (const change of changes) { const manifest = fixture(true); change(manifest); assert.throws(() => compile(manifest), /Google speech|Google embeddings|invalid manifest/, String(change)); }
});

test("Google speech declarations reject newer models, aliases, generic Chat capabilities and borrowed tariffs", () => {
  const changes = [
    m => { m.models.entries.at(-1).upstream = "gemini-new-tts"; }, m => { m.models.entries.at(-1).id = "google/speech-alias"; },
    m => { m.models.entries.at(-1).capabilities.push("llm.generate"); },
    m => { m.models.entries.at(-1).pricing = structuredClone(m.models.entries[0].pricing); },
    m => { m.models.entries.at(-1).pricingRef = "unqualified"; },
    m => { m.models.entries.at(-1).endpointPricing = { speech_interactions: { pricingRef: "unqualified", pricing: null } }; },
    m => { m.models.entries.at(-1).availability = { version: "clawrouter.model-availability.v1", status: "upstream_alias", effectiveAt: "2026-11-03", checkedAt: "2026-11-03", servingModel: "gemini-new-tts", sources: ["https://example.com/synthetic-evidence"] }; },
    m => { m.models.entries = m.models.entries.filter(value => !value.capabilities.includes("audio.speech")); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google speech|invalid manifest/, String(change)); }
});

test("compiled speech routes cannot swap native transport or bypass actual stateless body ownership", () => {
  const provider = compile(fixture()).providers[0], endpoints = provider.endpoints.filter(value => value.request_format.startsWith("google.speech"));
  for (const upstream of ids) {
    const model = provider.models.find(value => value.upstream === upstream);
    const wrong = endpoints.find(endpoint => !nativeModelEligible(endpoint.request_format, upstream, now));
    assert.throws(() => prepareNativeGoogleSpeech(selection(provider, model, wrong)), error => error.code === "invalid_native_google_speech_route");
  }
  const model = provider.models.find(value => value.upstream === ids[3]), endpoint = endpoints.find(value => value.request_format === "google.speech_interactions");
  for (const mutate of [b => { b.store = true; }, b => { b.previous_interaction_id = "synthetic-unowned"; }, b => { b.model = ids[4]; }, b => { b.stream = true; }]) {
    const selected = selection(provider, model, endpoint); mutate(selected.body);
    assert.throws(() => prepareNativeGoogleSpeech(selected), error => error.code === "invalid_native_google_speech_request");
  }
});
