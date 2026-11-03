import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream } = await import("../providers.ts");
const { BASETEN_MODELS_FORMAT, basetenCatalogRequest, filterBasetenModels, readBasetenModels } = await import("../baseten-model-catalog.ts");
const { discoveryAllows, modelDiscoveryResponse } = await import("../model-discovery.ts");
const { HttpOperation } = await import("../http-operation.ts");
const existing = parse(readFileSync(new URL("../../providers/baseten.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities = manifest.capabilities.filter(row => row.endpoint !== "models_list");
  manifest.capabilities.push({ id: "models.list", endpoint: "models_list", methods: ["GET"] });
  manifest.endpoints.models_list = { method: "GET", path: "/models", requestFormat: BASETEN_MODELS_FORMAT,
    responseFormat: BASETEN_MODELS_FORMAT, headers: { accept: "application/json" }, timeoutMs: 10000 };
  return manifest;
}

test("Baseten native catalog compiles one bodyless GET without remapping, model changes or credential substitution", () => {
  const manifest = fixture(), before = structuredClone(manifest), snapshot = compile(manifest), provider = snapshot.providers[0];
  const endpoint = provider.endpoints.find(row => row.id === "models_list");
  assert.deepEqual(manifest, before); assert.equal(endpoint.path, "/models"); assert.equal(endpoint.upstreamPath, undefined);
  assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]); assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.request_format, "baseten.models"); assert.equal(endpoint.response_format, "baseten.models");
  assert.equal(endpoint.requestPricing, undefined); assert.equal(endpoint.modelPassthrough, undefined);
  const baseline = compile(existing);
  assert.deepEqual(snapshot.model_index, baseline.model_index); assert.deepEqual(provider.models, baseline.providers[0].models);
  assert.deepEqual(provider.endpoints.find(row => row.id === "chat_completions"), baseline.providers[0].endpoints.find(row => row.id === "chat_completions"));
  const upstream = configuredUpstream(provider, null, { BASETEN_API_KEY: "synthetic-selected-key" });
  const request = basetenCatalogRequest(upstream.baseUrl, "synthetic-selected-key", new AbortController().signal);
  assert.equal(request.url, "https://inference.baseten.co/v1/models"); assert.equal(request.body, null);
  assert.equal(request.headers.get("authorization"), upstream.headers.get("authorization"));
  assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-key");
  assert.equal(request.redirect, "error"); assert.equal(request.credentials, "omit");
});

test("Baseten catalog rejects alternate methods, native format aliases, query/body features and duplicate discovery routes", () => {
  const changes = [
    m => { m.endpoints.models_list.method = "POST"; }, m => { delete m.endpoints.models_list.method; },
    m => { m.endpoints.models_list.path = "/v1/models"; }, m => { m.endpoints.models_list.path += "?limit=1"; },
    m => { m.endpoints.models_list.requestFormat = "baseten.models_v2"; },
    m => { m.endpoints.models_list.responseFormat = "openai.models"; },
    m => { m.endpoints.models_list.requestFormat = m.endpoints.models_list.responseFormat = "openai.models"; },
    m => { m.endpoints.models_list.upstreamPath = "/models"; },
    m => { m.endpoints.models_list.pathParams = ["model"]; },
    m => { m.endpoints.models_list.pathParamStyles = { model: "segment" }; },
    m => { m.endpoints.models_list.query = { limit: "1" }; },
    m => { m.endpoints.models_list.streaming = "sse"; }, m => { m.endpoints.models_list.modelPassthrough = {}; },
    m => { m.endpoints.models_list.nativeProxy = false; },
    m => { m.endpoints.models_list.outputTokenLimit = { field: "limit", minimum: 1, maximum: 100 }; },
    m => { m.capabilities.find(row => row.endpoint === "models_list").id = "llm.chat"; },
    m => { m.capabilities.find(row => row.endpoint === "models_list").methods = ["GET", "POST"]; },
    m => { m.capabilities = m.capabilities.filter(row => row.endpoint !== "models_list"); },
    m => { m.endpoints.other_models = structuredClone(m.endpoints.models_list); m.capabilities.push({ id: "models.list", endpoint: "other_models", methods: ["GET"] }); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /baseten.models|invalid manifest/, String(change)); }
});

test("Baseten catalog rejects foreign origins, transport overrides and caller credential/header injection", () => {
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://api.baseten.co/v1"; },
    m => { m.baseUrls.default += "?key=synthetic"; }, m => { m.baseUrls.extra = "https://untrusted.example"; },
    m => { m.routing.baseUrlParam = "base_url"; }, m => { m.routing.serviceParam = "service"; },
    m => { m.auth.schemes[0].header = "x-api-key"; }, m => { m.auth.schemes[0].format = "Token ${secret}"; },
    m => { m.auth.schemes[0].secretKind = "oauth"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.grantTransports = { api_key: { endpointPaths: { models_list: "/other" } } }; },
    m => { m.endpoints.models_list.auth = "none"; }, m => { m.endpoints.models_list.requestHeaders = ["authorization"]; },
    m => { m.endpoints.models_list.headers = { authorization: "Bearer synthetic" }; },
    m => { m.adapter.injectHeaders = { authorization: "Bearer synthetic" }; },
    m => { m.adapter.injectQuery = { key: "synthetic" }; }, m => { m.adapter.passthroughHeaders = ["authorization"]; },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /baseten.models|invalid manifest/, String(change)); }
});

test("Baseten compiled discovery composes the original policy filter and excludes the complete decision namespace", () => {
  const provider = compile(fixture()).providers[0], model = provider.models[0];
  const decisions = ["baseten-elephant-9b-latest", "baseten-mammoth-27b-latest", "baseten-joey-2b-latest", "synthetic-future"]
    .map(id => ({ id: `decision-models/${id}`, object: "model" }));
  const payload = { data: [...decisions, { id: model.upstream }] };
  const result = filterBasetenModels(payload, id => discoveryAllows({ models: [model.id] }, provider, id));
  assert.deepEqual(result, { data: [{ id: model.upstream }] });
  assert.deepEqual(filterBasetenModels(payload, () => true), result);
  assert.deepEqual(filterBasetenModels(payload, id => discoveryAllows({ models: [] }, provider, id)), { data: [] });
  assert.deepEqual(filterBasetenModels({ data: [] }, () => true), { data: [] });
  for (const key of ["pricing", "context_length", "max_completion_tokens", "supported_features"]) assert.equal(Object.hasOwn(result.data[0], key), false);
  assert.equal(result.object, undefined);
});

test("Baseten native price and limit observations never mutate compiled tariffs or imply enforced serving limits", async () => {
  const provider = compile(fixture()).providers[0], before = structuredClone(provider.models), id = provider.models[0].upstream;
  const payload = { data: [{ id, context_length: "100", max_completion_tokens: "200", pricing: { prompt: "0", completion: "0.000001" } }] };
  const result = await readBasetenModels(Response.json(payload), new AbortController().signal,
    id => discoveryAllows({ models: [provider.models[0].id] }, provider, id));
  assert.deepEqual(result, { data: [{ id, context_length: 100, max_completion_tokens: 200, pricing: { prompt: "0", completion: "0.000001" } }] });
  assert.equal(result.data[0].pricing.input_cache_read, undefined); assert.deepEqual(provider.models, before);
});

test("Baseten data-only registration leaves the strict OpenAI catalog decoder unchanged", async () => {
  const provider = compile(fixture()).providers[0], payload = { data: [{ id: provider.models[0].upstream }] };
  const endpoint = { ...provider.endpoints.find(row => row.id === "models_list"), request_format: "openai.models", response_format: "openai.models" };
  assert.deepEqual(filterBasetenModels(payload, () => true), payload);
  await assert.rejects(modelDiscoveryResponse(Response.json(payload), provider, endpoint, { models: null }, {}, new HttpOperation(),
    async () => { throw new Error("OpenAI rejection cannot paginate or replay"); }), error => error.code === "invalid_model_discovery_response");
});
