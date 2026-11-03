import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream } = await import("../providers.ts");
const { ARCEE_MODELS_FORMAT, arceeCatalogRequest, filterArceeModels, readArceeModels } = await import("../arcee-model-catalog.ts");
const { discoveryAllows, modelDiscoveryResponse } = await import("../model-discovery.ts");
const { HttpOperation } = await import("../http-operation.ts");
const existing = parse(readFileSync(new URL("../../providers/arcee.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities = manifest.capabilities.filter(row => row.endpoint !== "models_list");
  manifest.capabilities.push({ id: "models.list", endpoint: "models_list", methods: ["GET"] });
  manifest.endpoints.models_list = { method: "GET", path: "/models", requestFormat: ARCEE_MODELS_FORMAT,
    responseFormat: ARCEE_MODELS_FORMAT, headers: { accept: "application/json" }, timeoutMs: 10000 };
  return manifest;
}

test("Arcee native catalog compiles one bodyless GET without remapping, model changes or credential substitution", () => {
  const manifest = fixture(), before = structuredClone(manifest), snapshot = compile(manifest), provider = snapshot.providers[0];
  const endpoint = provider.endpoints.find(row => row.id === "models_list");
  assert.deepEqual(manifest, before); assert.equal(endpoint.path, "/models"); assert.equal(endpoint.upstreamPath, undefined);
  assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]); assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.request_format, "arcee.models"); assert.equal(endpoint.response_format, "arcee.models");
  assert.equal(endpoint.requestPricing, undefined); assert.equal(endpoint.modelPassthrough, undefined);
  const baseline = compile(existing);
  assert.deepEqual(snapshot.model_index, baseline.model_index); assert.deepEqual(provider.models, baseline.providers[0].models);
  assert.deepEqual(provider.endpoints.find(row => row.id === "chat_completions"), baseline.providers[0].endpoints.find(row => row.id === "chat_completions"));
  const upstream = configuredUpstream(provider, null, { ARCEEAI_API_KEY: "synthetic-selected-key" });
  const request = arceeCatalogRequest(upstream.baseUrl, "synthetic-selected-key", new AbortController().signal);
  assert.equal(request.url, "https://api.arcee.ai/api/v1/models"); assert.equal(request.body, null);
  assert.equal(request.headers.get("authorization"), upstream.headers.get("authorization"));
  assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-key");
  assert.equal(request.redirect, "error"); assert.equal(request.credentials, "omit");
});

test("Arcee catalog rejects alternate methods, native format aliases, query/body features and duplicate discovery routes", () => {
  const changes = [
    m => { m.endpoints.models_list.method = "POST"; }, m => { delete m.endpoints.models_list.method; },
    m => { m.endpoints.models_list.path = "/v1/models"; }, m => { m.endpoints.models_list.path += "?limit=1"; },
    m => { m.endpoints.models_list.requestFormat = "arcee.models_v2"; },
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
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /arcee.models|invalid manifest/, String(change)); }
});

test("Arcee catalog rejects foreign origins, transport overrides and caller credential/header injection", () => {
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://api.arcee.ai/v1"; },
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
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /arcee.models|invalid manifest/, String(change)); }
});

const ids = ["trinity-mini", "trinity-large-preview", "trinity-large-thinking"];
const row = id => ({ id, name: id, input_modalities: ["text"], output_modalities: ["text"], context_length: 4096, max_output_length: 1024 });

test("Arcee compiled discovery preserves exact direct policy identities without OpenRouter aliases or seeded empty results", () => {
  const provider = compile(fixture()).providers[0], before = structuredClone(provider.models);
  const payload = { data: ids.map(id => ({ ...row(id), openrouter: { slug: `arcee-ai/${id}` } })) };
  for (const id of ids) {
    assert.deepEqual(filterArceeModels(payload, upstream => discoveryAllows({ models: [`arcee/${id}`] }, provider, upstream)), { data: [row(id)] });
    assert.deepEqual(filterArceeModels(payload, upstream => discoveryAllows({ models: [`openrouter/arcee-ai/${id}`] }, provider, upstream)), { data: [] });
  }
  assert.deepEqual(filterArceeModels(payload, id => discoveryAllows({ models: [] }, provider, id)), { data: [] });
  assert.deepEqual(filterArceeModels({ data: [] }, () => true), { data: [] });
  assert.deepEqual(provider.models, before);
});

test("Arcee native required modalities and limits never borrow static Chat facts or serving entitlement", () => {
  const provider = compile(fixture()).providers[0], allows = id => discoveryAllows({ models: null }, provider, id);
  for (const field of ["input_modalities", "output_modalities", "context_length", "max_output_length"]) {
    const native = row(ids[0]); delete native[field];
    assert.throws(() => filterArceeModels({ data: [native] }, allows), error => error.code === "invalid_model_discovery_response");
  }
  assert.deepEqual(filterArceeModels({ data: [{ ...row(ids[0]), output_modalities: ["image"] }] }, allows), { data: [] });
  const native = { ...row(ids[0]), max_output_length: 8192 };
  assert.deepEqual(filterArceeModels({ data: [native] }, allows), { data: [native] });
  assert.equal(provider.models[0].contextWindow, undefined);
});

test("Arcee six independent native price strings never become compiled tariffs or zero defaults", async () => {
  const provider = compile(fixture()).providers[0], before = structuredClone(provider.models), allows = id => discoveryAllows({ models: null }, provider, id);
  const pricing = { prompt: "0.000001", completion: "0.000002", image: "0.003", request: "0.004", input_cache_reads: "0", input_cache_writes: "0.000005" };
  const native = { ...row(ids[0]), pricing };
  assert.deepEqual(await readArceeModels(Response.json({ data: [native] }), new AbortController().signal, allows), { data: [native] });
  const absent = filterArceeModels({ data: [row(ids[0])] }, allows).data[0];
  for (const key of ["pricing", "supported_features", "supported_sampling_parameters"]) assert.equal(Object.hasOwn(absent, key), false);
  const partial = filterArceeModels({ data: [{ ...row(ids[0]), pricing: { prompt: "0.000001" } }] }, allows);
  assert.deepEqual(partial.data[0].pricing, { prompt: "0.000001" });
  assert.deepEqual(provider.models, before); assert.equal(provider.models[0].pricing, null);
});

test("Arcee native data-only catalog does not broaden the strict OpenAI decoder", async () => {
  const provider = compile(fixture()).providers[0], payload = { data: [row(ids[0])] };
  const endpoint = { ...provider.endpoints.find(row => row.id === "models_list"), request_format: "openai.models", response_format: "openai.models" };
  assert.deepEqual(filterArceeModels(payload, () => true), payload);
  await assert.rejects(modelDiscoveryResponse(Response.json(payload), provider, endpoint, { models: null }, {}, new HttpOperation(),
    async () => { throw new Error("OpenAI rejection cannot paginate or replay"); }), error => error.code === "invalid_model_discovery_response");
});
