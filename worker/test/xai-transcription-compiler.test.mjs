import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareXaiTranscription, readXaiTranscription, xaiTranscriptionPath, xaiTranscriptionServiceDefault } = await import("../xai-transcription.ts");
const { prepareManifestRequest, prepareNativeRequest } = await import("../proxy-selection.ts");
const { configuredUpstream } = await import("../providers.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const existing = parse(readFileSync(new URL("../../providers/xai.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/transcription.json", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities.push({ id: "audio.transcription", endpoint: "stt", methods: ["POST"] });
  manifest.endpoints.stt = { method: "POST", path: "/v1/stt", pathParams: [], requestFormat: "xai.stt", responseFormat: "xai.stt" };
  return manifest;
}
function selected() {
  const snapshot = compile(fixture()), provider = snapshot.providers[0];
  return { snapshot, provider, endpoint: provider.endpoints.find(endpoint => endpoint.id === "stt") };
}
const file = () => new File([Uint8Array.from(wire.audioBytes)], wire.request.filename, { type: wire.request.mime });

test("xAI STT compiles a model-less native offer alongside unchanged Chat identities and token cards", () => {
  const { snapshot, provider, endpoint } = selected(), before = compile(existing);
  assert.deepEqual(snapshot.model_index, before.model_index);
  for (const previous of before.providers[0].endpoints) assert.deepEqual(provider.endpoints.find(endpoint => endpoint.id === previous.id), previous);
  assert.equal(endpoint.path, xaiTranscriptionPath); assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.request_format, "xai.stt"); assert.equal(endpoint.response_format, "xai.stt");
  assert.deepEqual(endpoint.path_params, []); assert.deepEqual(endpoint.query, {}); assert.equal(endpoint.streaming, null);
  const catalog = createRouteCatalog([provider]), offer = catalog.manifestProxy.find(offer => offer.endpoint === "stt");
  assert.equal(offer.sampleModel, null); assert.deepEqual(offer.models, []);
  assert.deepEqual(catalog.openaiCompatible, createRouteCatalog(before.providers).openaiCompatible);
});

test("compiled parsed-field selection preserves the actual native file-last form and original xAI credential", async () => {
  const { provider, endpoint } = selected(), auth = configuredUpstream(provider, null, { XAI_API_KEY: "synthetic-original-key" });
  assert.equal(auth.baseUrl + endpoint.path, "https://api.x.ai/v1/stt");
  assert.equal(auth.headers.get("authorization"), "Bearer synthetic-original-key");
  for (const fields of [wire.request.fields, {}]) for (const native of [false, true]) {
    const before = { ...fields }, result = native ? prepareNativeRequest(provider, endpoint, fields, endpoint.path, {})
      : prepareManifestRequest(provider, endpoint, fields, {}, {});
    assert.equal(result.model, null); assert.deepEqual(result.body, before); assert.deepEqual(fields, before);
    const prepared = prepareXaiTranscription({ file: file(), fields: result.body });
    assert.equal(prepared.path, endpoint.path); assert.deepEqual([...prepared.body.keys()], [...Object.keys(fields), "file"]);
    assert.equal(prepared.body.has("model"), false); assert.equal(prepared.body.has("prompt"), false);
    assert.deepEqual([...new Uint8Array(await prepared.body.get("file").arrayBuffer())], wire.audioBytes);
    assert.equal(prepared.headers.has("authorization"), false); assert.equal(prepared.headers.has("content-type"), false);
  }
});

test("complete STT observations preserve silence and native duration without inventing a model card or invoice", async () => {
  const { provider, endpoint } = selected();
  for (const body of [wire.result, wire.silence, { ...wire.result, model: xaiTranscriptionServiceDefault }]) {
    const result = await readXaiTranscription(Response.json(body), new AbortController().signal);
    assert.deepEqual(result.body, body); assert.equal(result.text, body.text.trim());
    assert.equal(result.nativeDurationSeconds, body.duration); assert.equal(result.upstreamCostMicros, null);
    assert.equal(result.observedModel, body.model ?? null);
    assert.equal(prepareManifestRequest(provider, endpoint, wire.request.fields, {}, {}).model, null);
  }
});

test("model-less compiled STT denies hard-dollar budgets and keeps explicit fixed policy charges separate", () => {
  const { endpoint } = selected(), capability = "audio.transcription", cost = estimateCost(null, wire.request.fields, null, capability, endpoint);
  assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
  for (const [caller, providerLimit] of [[10000, null], [null, 10000], [10000, 10000]]) {
    assert.throws(() => validateBudgetReservation(capability, cost, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
    for (const fixed of [0, 17]) {
      const explicit = estimateCost(null, wire.request.fields, fixed, capability, endpoint);
      assert.deepEqual(explicit, { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
      assert.doesNotThrow(() => validateBudgetReservation(capability, explicit, caller, { monthlyBudgetMicros: providerLimit }));
    }
  }
});

test("xAI STT cannot select priced Chat, insert the service default or silently drop generic prompt hints", () => {
  const { provider, endpoint } = selected();
  for (const model of [provider.models[0].id, provider.models[0].upstream, xaiTranscriptionServiceDefault, "xai/stt"]) {
    assert.throws(() => prepareManifestRequest(provider, endpoint, { ...wire.request.fields, model }, {}, {}), error => error.code === "model_capability_unsupported");
  }
  for (const fields of [{ ...wire.request.fields, model: xaiTranscriptionServiceDefault }, { ...wire.request.fields, prompt: "synthetic hint" },
    { url: "https://example.com/audio.wav" }]) assert.throws(() => prepareXaiTranscription({ file: file(), fields }));
  for (const change of [
    m => { m.models.entries[0].capabilities.push("audio.transcription"); },
    m => { m.models.entries.push({ id: `xai/${xaiTranscriptionServiceDefault}`, upstream: xaiTranscriptionServiceDefault, capabilities: ["audio.transcription"] }); },
    m => { m.capabilities.at(-1).id = "llm.chat"; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /xAI STT|invalid manifest/); }
});

test("STT compilation rejects alternate protocols, models, origins and multipart credential or boundary overrides", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://other.example"; },
    m => { m.endpoints.stt.path = "/v1/audio/transcriptions"; }, m => { m.endpoints.stt.pathParams = ["model"]; },
    m => { m.endpoints.stt.requestFormat = "openai.audio_transcriptions"; }, m => { m.endpoints.stt.responseFormat = "openai.chat_completions"; },
    m => { m.endpoints.stt.requestFormat = "xai.stt_stream"; }, m => { m.endpoints.stt.method = "GET"; },
    m => { m.endpoints.stt.streaming = "sse"; }, m => { m.endpoints.stt.query = { language: "en" }; },
    m => { m.endpoints.stt.modelPassthrough = {}; }, m => { m.endpoints.stt.upstreamPath = "/v1/stt"; },
    m => { m.endpoints.stt.auth = "none"; }, m => { m.endpoints.stt.requestHeaders = ["authorization"]; },
    m => { m.endpoints.stt.headers = { "content-type": "multipart/form-data" }; },
    m => { m.endpoints.stt.requestPricing = { unit: "request", version: "synthetic", effectiveAt: "2026-11-03", source: "https://example.com/tariff", successfulResponseMicros: 1 }; },
    m => { m.auth.schemes[0].required = false; }, m => { m.auth.schemes[0].format = "Token ${secret}"; },
    m => { m.auth.grantTransports = { api_key: { baseUrl: "https://other.example" } }; },
    m => { m.adapter.injectHeaders = { Authorization: "synthetic" }; }, m => { m.adapter.injectQuery = { model: "synthetic" }; },
    m => { m.adapter.requestTransforms = { renameFields: [{ from: "prompt", to: "language" }] }; },
    m => { m.capabilities.at(-1).methods = ["POST", "GET"]; }, m => { m.endpoints.other = structuredClone(m.endpoints.stt); },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /xAI STT|invalid manifest/, String(change)); }
});
