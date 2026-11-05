import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { openRouterTranscriptionModels, prepareOpenRouterTranscription, readOpenRouterTranscription } = await import("../openrouter-transcription.ts");
const { configuredUpstream } = await import("../providers.ts");
const { prepareManifestRequest, prepareNativeRequest } = await import("../proxy-selection.ts");
const { prepareUpstreamRequest } = await import("../proxy-upstream-request.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const existing = parse(readFileSync(new URL("../../providers/openrouter.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/transcription.json", import.meta.url)));
const format = "openrouter.audio_transcription", upstream = "openai/whisper-large-v3-turbo";
const compile = manifest => compileProviderSnapshot([manifest]);
function baseline() {
  const manifest = structuredClone(existing);
  manifest.capabilities = manifest.capabilities.filter(value => value.id !== "audio.transcription" || value.endpoint !== "transcription");
  manifest.models.entries = manifest.models.entries.filter(value => value.id !== `openrouter/${upstream}`);
  delete manifest.endpoints.transcription;
  return manifest;
}
function fixture() {
  const manifest = baseline();
  manifest.capabilities.push({ id: "audio.transcription", endpoint: "transcription", methods: ["POST"] });
  manifest.endpoints.transcription = { method: "POST", path: "/v1/audio/transcriptions", requestFormat: format, responseFormat: format };
  manifest.models.entries.push({ id: `openrouter/${upstream}`, upstream, capabilities: ["audio.transcription"],
    nativeCapabilities: { version: "clawrouter.native-capabilities.v1", endpoints: { transcription: {
      sources: ["https://openrouter.ai/docs/guides/overview/multimodal/stt"], checkedAt: "2026-11-04", input: ["audio"],
    } } } });
  return manifest;
}
function selected() {
  const snapshot = compile(fixture()), provider = snapshot.providers[0];
  return { snapshot, provider, endpoint: provider.endpoints.find(value => value.id === "transcription"),
    model: provider.models.find(value => value.upstream === upstream) };
}

test("OpenRouter transcription schema composes the existing API base and suffix with the landed JSON codec", async () => {
  const { provider, endpoint, model } = selected();
  assert.deepEqual([...openRouterTranscriptionModels], [upstream]);
  assert.equal(endpoint.request_format, format); assert.equal(endpoint.response_format, format);
  assert.equal(endpoint.method, "POST"); assert.deepEqual(endpoint.methods, ["POST"]);
  assert.equal(endpoint.native_proxy, true); assert.equal(endpoint.streaming, null);
  assert.deepEqual(endpoint.path_params, []); assert.deepEqual(endpoint.query, {});
  assert.equal(endpoint.upstreamPath, undefined); assert.equal(endpoint.modelPassthrough, undefined);
  const auth = configuredUpstream(provider, null, { OPENROUTER_API_KEY: "synthetic-selected-key", OPENROUTER_SITE_URL: "https://example.com" });
  assert.equal(auth.baseUrl, "https://openrouter.ai/api");
  assert.equal(auth.headers.get("authorization"), "Bearer synthetic-selected-key");
  assert.equal(auth.headers.get("http-referer"), "https://example.com"); assert.equal(auth.headers.get("x-title"), "ClawRouter");
  const prepared = prepareOpenRouterTranscription(model.upstream, wire.request);
  const outbound = prepareUpstreamRequest(new Request("https://router.example/v1/native/openrouter/v1/audio/transcriptions", {
    method: "POST", headers: { "content-type": "application/json" },
  }), {}, { provider, endpoint, model, body: wire.request, pathParams: {}, capability: "audio.transcription", method: "POST" }, {}, auth, "http");
  assert.equal(outbound.url.href, "https://openrouter.ai/api/v1/audio/transcriptions");
  assert.equal(outbound.url.pathname, prepared.path);
  assert.deepEqual(await new Response(outbound.requestBody).json(), wire.request);
  assert.equal(outbound.headers.get("authorization"), "Bearer synthetic-selected-key");
  assert.equal(prepared.path, "/api/v1/audio/transcriptions");
  assert.equal(`/v1/native/${provider.id}${endpoint.path}`, "/v1/native/openrouter/v1/audio/transcriptions");
  assert.equal(prepared.headers.get("content-type"), "application/json");
  assert.equal(prepared.headers.has("authorization"), false);
  assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
  assert.deepEqual(model.nativeCapabilities.endpoints.transcription.input, ["audio"]);
});

test("registered native and manifest model selection preserve the actual JSON audio body and exact codec identity", () => {
  const { provider, endpoint, model } = selected();
  for (const [native, body] of [[true, wire.request], [false, { ...wire.request, model: model.id }]]) {
    const original = structuredClone(body);
    const result = native ? prepareNativeRequest(provider, endpoint, body, endpoint.path, {})
      : prepareManifestRequest(provider, endpoint, body, {}, {});
    assert.equal(result.model.id, model.id); assert.deepEqual(result.pathParams, {});
    assert.deepEqual(result.body, wire.request); assert.deepEqual(body, original);
    const prepared = prepareOpenRouterTranscription(result.model.upstream, result.body);
    assert.equal(prepared.audioBytes, Buffer.from(wire.request.input_audio.data, "base64").length);
    assert.deepEqual(prepared.body, wire.request);
  }
  for (const body of [{ ...wire.request, model: "openai/whisper-1" }, new FormData(),
    { ...wire.request, input_audio: { url: "https://example.com/audio.wav", format: "wav" } }]) {
    assert.throws(() => prepareOpenRouterTranscription(model.upstream, body));
  }
});

test("compiled transcription uses the actual complete JSON reader without converting seconds or native cost to tokens or invoices", async () => {
  const { model } = selected();
  for (const body of [wire.result, wire.silent, wire.unmetered]) {
    const result = await readOpenRouterTranscription(Response.json(body), model.upstream, new AbortController().signal);
    assert.deepEqual(result.body, body); assert.equal(result.upstreamCostMicros, null);
    assert.equal(result.audioSeconds, body.usage?.seconds ?? null);
    assert.equal(result.nativeCost, body.usage?.cost ?? null);
    assert.equal(result.totalTokens, body.usage?.total_tokens ?? null);
    assert.equal(result.text, body.text.trim());
  }
  for (const response of [Response.json({ ...wire.result, model: "openai/whisper-1" }),
    Response.json(wire.result, { status: 202 }), Response.json(wire.result, { headers: { "content-length": "1" } })]) {
    await assert.rejects(() => readOpenRouterTranscription(response, model.upstream, new AbortController().signal));
  }
});

test("the unpriced compiled model denies both hard-dollar budgets and keeps explicit policy charges separate", () => {
  const { model, endpoint } = selected(), capability = "audio.transcription";
  const cost = estimateCost(model, wire.request, null, capability, endpoint);
  assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
  for (const [caller, providerLimit] of [[10000, null], [null, 10000], [10000, 10000]]) {
    assert.throws(() => validateBudgetReservation(capability, cost, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
  }
  for (const fixed of [0, 17]) {
    const priced = estimateCost(model, wire.request, fixed, capability, endpoint);
    assert.deepEqual(priced, { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
    assert.doesNotThrow(() => validateBudgetReservation(capability, priced, 10000));
  }
});

test("OpenRouter transcription declarations preserve existing Chat and Responses routes and attribution", () => {
  const before = compile(baseline()), manifest = fixture();
  for (const endpoints of [manifest.endpoints, Object.fromEntries(Object.entries(manifest.endpoints).reverse())]) {
    const after = compile({ ...manifest, endpoints });
    for (const endpoint of before.providers[0].endpoints) assert.deepEqual(after.providers[0].endpoints.find(value => value.id === endpoint.id), endpoint);
    for (const [id, model] of Object.entries(before.model_index)) assert.deepEqual(after.model_index[id], model);
    assert.deepEqual(after.providers[0].adapter, before.providers[0].adapter);
  }
});

test("OpenRouter transcription schema rejects multipart aliases, duplicate API prefixes and alternate transports", () => {
  for (const change of [
    m => { m.endpoints.transcription.path = "/api/v1/audio/transcriptions"; },
    m => { m.endpoints.transcription.path = "/v1/audio/transcriptions/other"; },
    m => { m.endpoints.transcription.upstreamPath = "/api/v1/audio/transcriptions"; },
    m => { m.endpoints.transcription.requestFormat = m.endpoints.transcription.responseFormat = "openai.audio_transcriptions"; },
    m => { m.endpoints.transcription.responseFormat = "openai.chat_completions"; },
    m => { m.endpoints.transcription.requestFormat = format + "_future"; },
    m => { m.endpoints.transcription.method = "GET"; }, m => { m.endpoints.transcription.nativeProxy = false; },
    m => { m.endpoints.transcription.streaming = "sse"; }, m => { m.endpoints.transcription.websocket = "openai.realtime"; },
    m => { m.endpoints.transcription.query = { model: upstream }; }, m => { m.endpoints.transcription.pathParams = ["model"]; },
    m => { m.endpoints.transcription.pathParamStyles = { model: "segment" }; }, m => { m.endpoints.transcription.modelPassthrough = {}; },
    m => { m.endpoints.transcription.responsesLifecycle = { retrieve: "responses", cancel: "responses" }; },
    m => { m.capabilities.at(-1).id = "llm.chat"; }, m => { m.capabilities.at(-1).methods = ["POST", "GET"]; },
    m => { m.endpoints.other = structuredClone(m.endpoints.transcription); },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /OpenRouter transcription|invalid manifest/, String(change)); }
});

test("OpenRouter transcription compilation preserves the selected origin and credential against overrides", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { m.baseUrls.default += "/v1"; }, m => { m.baseUrls.other = "https://other.example"; },
    m => { m.routing.baseUrlParam = "base_url"; }, m => { m.routing.serviceParam = "service"; },
    m => { m.auth.schemes[0].header = "x-api-key"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.schemes[0].format = "Token ${secret}"; }, m => { m.auth.schemes.push(structuredClone(m.auth.schemes[0])); },
    m => { m.auth.grantTransports = { api_key: { baseUrl: "https://other.example" } }; },
    m => { m.endpoints.transcription.auth = "none"; }, m => { m.endpoints.transcription.requestHeaders = ["authorization"]; },
    m => { m.endpoints.transcription.headers = { "content-type": "multipart/form-data" }; },
    m => { m.adapter.injectHeaders.Authorization = "synthetic"; }, m => { m.adapter.injectQuery = { api_key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["authorization"]; },
    m => { m.adapter.requestTransforms = { renameFields: [{ from: "input_audio", to: "file" }] }; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /OpenRouter transcription|invalid manifest/, String(change)); }
});

test("only the frozen transcription model and existing audio input facts compile without invented token or byte tariffs", () => {
  for (const change of [
    m => { m.models.entries.at(-1).upstream = "openai/whisper-1"; },
    m => { m.models.entries.at(-1).capabilities.push("llm.chat"); },
    m => { m.models.entries.pop(); }, m => { m.models.entries.at(-1).pricingRef = "openrouter-auto"; },
    m => { m.models.entries.at(-1).endpointPricing = { transcription: { pricingRef: "openrouter-auto", pricing: null } }; },
    m => { m.endpoints.transcription.outputTokenLimit = { field: "max_tokens", minimum: 1, maximum: 1024 }; },
    m => { m.models.entries.at(-1).nativeCapabilities.endpoints.transcription.contextWindow = 16 * 1024 * 1024; },
    m => { m.models.entries.at(-1).nativeCapabilities.endpoints.transcription.maxOutputTokens = 1024 * 1024; },
    m => { m.models.entries.at(-1).nativeCapabilities.endpoints.transcription.input = ["text"]; },
    m => { m.models.entries.at(-1).nativeCapabilities.endpoints.transcription.maxInputBytes = 16 * 1024 * 1024; },
    m => { m.models.entries.at(-1).nativeCapabilities.endpoints.transcription.output = ["text"]; },
    m => { m.endpoints.transcription.requestPricing = { unit: "request", version: "synthetic", effectiveAt: "2026-11-04",
      source: "https://example.com/synthetic-tariff", successfulResponseMicros: 1 }; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /OpenRouter transcription|invalid manifest/, String(change)); }
});
