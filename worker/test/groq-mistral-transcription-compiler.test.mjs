import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { groqMistralAudio, prepareGroqMistralAudio, readGroqMistralAudio } = await import("../groq-mistral-audio.ts");
const { prepareManifestRequest, prepareNativeRequest } = await import("../proxy-selection.ts");
const { configuredUpstream } = await import("../providers.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const providers = ["groq", "mistral"];
const existing = Object.fromEntries(providers.map(id => [id, parse(readFileSync(new URL(`../../providers/${id}.provider.yaml`, import.meta.url), "utf8"))]));
const wire = Object.fromEntries(providers.map(id => [id, JSON.parse(readFileSync(new URL(`../../providers/_fixtures/${id}/transcription.json`, import.meta.url), "utf8"))]));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture(id) {
  const manifest = structuredClone(existing[id]), upstream = groqMistralAudio[id].model;
  manifest.capabilities.push({ id: "audio.transcription", endpoint: "transcription", methods: ["POST"] });
  manifest.endpoints.transcription = { method: "POST", path: "/v1/audio/transcriptions", pathParams: [],
    requestFormat: `${id}.transcription`, responseFormat: `${id}.transcription` };
  manifest.models.entries.push({ id: `${id}/${upstream}`, upstream, capabilities: ["audio.transcription"],
    nativeCapabilities: { version: "clawrouter.native-capabilities.v1", endpoints: { transcription: {
      sources: [id === "groq" ? "https://console.groq.com/docs/speech-to-text" : "https://docs.mistral.ai/api/endpoint/audio/transcriptions"],
      checkedAt: "2026-11-03", input: ["audio"],
    } } } });
  return manifest;
}
function selected(id) {
  const provider = compile(fixture(id)).providers[0], endpoint = provider.endpoints.find(endpoint => endpoint.id === "transcription");
  return { provider, endpoint, model: provider.models.find(model => model.upstream === groqMistralAudio[id].model) };
}
function upload(id, fields = wire[id].fields) {
  const file = wire[id].file;
  return { fields: { ...fields }, file: new File([Buffer.from(file.base64, "base64")], file.name, { type: file.type }) };
}

test("compiled Groq/Mistral bases and suffixes compose the landed multipart codec with the original Bearer credential", async () => {
  for (const id of providers) {
    const { provider, endpoint, model } = selected(id), contract = groqMistralAudio[id];
    const auth = configuredUpstream(provider, null, { [`${id.toUpperCase()}_API_KEY`]: "synthetic-original-key" });
    assert.equal(auth.baseUrl + endpoint.path, contract.origin + contract.path);
    assert.equal(auth.headers.get("authorization"), "Bearer synthetic-original-key");
    assert.equal(endpoint.request_format, `${id}.transcription`); assert.equal(endpoint.response_format, `${id}.transcription`);
    assert.equal(endpoint.native_proxy, true); assert.equal(endpoint.streaming, null);
    assert.deepEqual(endpoint.path_params, []); assert.deepEqual(endpoint.query, {});
    assert.equal(endpoint.upstreamPath, undefined); assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
    for (const native of [false, true]) {
      // Selection composes parsed fields only; shared multipart ingress is not activated by this test.
      const fields = { ...wire[id].fields, model: native ? model.upstream : model.id }, before = { ...fields };
      const request = native ? prepareNativeRequest(provider, endpoint, fields, endpoint.path, {})
        : prepareManifestRequest(provider, endpoint, fields, {}, {});
      assert.deepEqual(fields, before); assert.equal(request.model.id, model.id);
      const prepared = prepareGroqMistralAudio(id, upload(id, request.body));
      assert.equal(prepared.path, wire[id].path); assert.equal(prepared.model, model.upstream);
      assert.deepEqual([...prepared.body.keys()], [...Object.keys(wire[id].fields), "file"]);
      assert.deepEqual(Buffer.from(await prepared.body.get("file").arrayBuffer()), Buffer.from(wire[id].file.base64, "base64"));
      assert.equal(prepared.headers.has("authorization"), false); assert.equal(prepared.headers.has("content-type"), false);
    }
  }
});

test("the transcription offer is audio-only and preserves every existing Chat or embedding model and endpoint", () => {
  for (const id of providers) {
    const before = compile(existing[id]), manifest = fixture(id);
    for (const endpoints of [manifest.endpoints, Object.fromEntries(Object.entries(manifest.endpoints).reverse())]) {
      const after = compile({ ...manifest, endpoints }), provider = after.providers[0];
      for (const endpoint of before.providers[0].endpoints) assert.deepEqual(provider.endpoints.find(value => value.id === endpoint.id), endpoint);
      for (const [modelId, model] of Object.entries(before.model_index)) assert.deepEqual(after.model_index[modelId], model);
      const offer = createRouteCatalog([provider]).manifestProxy.find(offer => offer.endpoint === "transcription");
      assert.equal(offer.requestFormat, `${id}.transcription`);
      assert.deepEqual(offer.models.map(model => model.id), [`${id}/${groqMistralAudio[id].model}`]);
      const chat = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");
      assert.throws(() => prepareManifestRequest(provider, chat, { model: `${id}/${groqMistralAudio[id].model}` }, {}, {}), error => error.code === "model_capability_unsupported");
    }
  }
});

test("compiled unknown audio prices deny caller and provider hard-dollar budgets while policy-fixed remains explicit", () => {
  for (const id of providers) {
    const { model, endpoint } = selected(id), capability = "audio.transcription";
    const cost = estimateCost(model, wire[id].fields, null, capability, endpoint);
    assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
    for (const [caller, provider] of [[10000, null], [null, 10000], [10000, 10000]]) {
      assert.throws(() => validateBudgetReservation(capability, cost, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
      for (const fixed of [0, 17]) {
        const explicit = estimateCost(model, wire[id].fields, fixed, capability, endpoint);
        assert.deepEqual(explicit, { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
        assert.doesNotThrow(() => validateBudgetReservation(capability, explicit, caller, { monthlyBudgetMicros: provider }));
      }
    }
  }
});

test("compiled identity survives native observations and Mistral prompt incompatibility remains explicit", async () => {
  for (const id of providers) {
    const { model } = selected(id);
    const result = await readGroqMistralAudio(Response.json(wire[id].response), id, new AbortController().signal);
    assert.deepEqual(result.body, wire[id].response); assert.equal(result.requestedModel, model.upstream);
    assert.equal(result.costMicros, undefined); assert.equal(result.tokens, undefined);
    assert.equal(result.observedModel, id === "mistral" ? "voxtral-mini-2602" : null);
    assert.equal(result.observedAudioSeconds, id === "mistral" ? 2 : null);
    assert.equal(model.upstream, groqMistralAudio[id].model); assert.equal(model.pricing, null);
    const fields = { ...wire[id].fields, prompt: "Synthetic context" };
    if (id === "mistral") assert.throws(() => prepareGroqMistralAudio(id, upload(id, fields)), /mistral_prompt_unqualified/);
    else assert.equal(prepareGroqMistralAudio(id, upload(id, fields)).body.get("prompt"), fields.prompt);
  }
});

test("transcription schemas reject cross-provider formats, prefix duplication, credential and multipart boundary overrides", () => {
  for (const id of providers) for (const change of [
    m => { m.id = "other"; }, m => { m.baseUrls.default += "/v1"; }, m => { m.baseUrls.other = "https://other.example"; },
    m => { m.endpoints.transcription.path = "/openai/v1/audio/transcriptions"; },
    m => { m.endpoints.transcription.requestFormat = m.endpoints.transcription.responseFormat = id === "groq" ? "mistral.transcription" : "groq.transcription"; },
    m => { m.endpoints.transcription.requestFormat = "openai.audio_transcriptions"; },
    m => { m.endpoints.transcription.responseFormat = "openai.chat_completions"; },
    m => { m.endpoints.transcription.requestFormat += "_future"; }, m => { m.endpoints.transcription.method = "GET"; },
    m => { m.endpoints.transcription.streaming = "sse"; }, m => { m.endpoints.transcription.query = { model: "other" }; },
    m => { m.endpoints.transcription.upstreamPath = "/v1/audio/transcriptions"; }, m => { m.endpoints.transcription.auth = "none"; },
    m => { m.endpoints.transcription.headers = { "Content-Type": "multipart/form-data; boundary=caller" }; },
    m => { m.endpoints.transcription.requestHeaders = ["authorization"]; },
    m => { m.auth.schemes[0].required = false; }, m => { m.auth.schemes[0].format = "Token ${secret}"; },
    m => { m.auth.grantTransports = { api_key: { baseUrl: "https://other.example" } }; },
    m => { m.routing.baseUrlParam = "base"; }, m => { m.adapter.injectHeaders = { Authorization: "synthetic" }; },
    m => { m.adapter.injectQuery = { key: "synthetic" }; }, m => { m.adapter.passthroughHeaders = ["content-type"]; },
    m => { m.adapter.requestTransforms = { renameFields: [{ from: "prompt", to: "context_bias" }] }; },
    m => { m.endpoints.other = structuredClone(m.endpoints.transcription); },
  ]) { const manifest = fixture(id); change(manifest); assert.throws(() => compile(manifest), /Groq\/Mistral transcription|invalid manifest/, String(change)); }
});

test("finite transcription models cannot acquire Chat eligibility, aliases or fabricated token and request tariffs", () => {
  for (const id of providers) for (const change of [
    m => { m.models.entries.at(-1).upstream = "other"; }, m => { m.models.entries.at(-1).id += "-other"; },
    m => { m.models.entries.pop(); }, m => { m.models.entries.at(-1).capabilities.push("llm.chat"); },
    m => { m.models.entries.at(-1).pricing = structuredClone(m.models.entries[0].pricing); },
    m => { m.models.entries.at(-1).pricingRef = m.models.entries[0].pricingRef; },
    m => { m.models.entries.at(-1).endpointPricing = { transcription: { pricingRef: "synthetic", pricing: null } }; },
    m => { m.models.entries.at(-1).nativeCapabilities.endpoints.transcription.contextWindow = 25000000; },
    m => { m.models.entries.at(-1).nativeCapabilities.endpoints.transcription.maxOutputTokens = 1048576; },
    m => { m.models.entries.at(-1).nativeCapabilities.endpoints.transcription.input = ["text"]; },
    m => { m.models.entries.at(-1).nativeCapabilities.endpoints.transcription.maxInputBytes = 25000000; },
    m => { m.endpoints.transcription.modelPassthrough = {}; },
    m => { m.endpoints.transcription.outputTokenLimit = { field: "max_tokens", minimum: 1, maximum: 1024 }; },
    m => { m.endpoints.transcription.requestPricing = { unit: "request", version: "synthetic", effectiveAt: "2026-11-03",
      source: "https://example.com/synthetic-tariff", successfulResponseMicros: 1 }; },
    m => { m.capabilities.at(-1).id = "llm.chat"; }, m => { m.capabilities.at(-1).methods = ["POST", "GET"]; },
  ]) { const manifest = fixture(id); change(manifest); assert.throws(() => compile(manifest), /Groq\/Mistral transcription|invalid manifest/, String(change)); }
});
