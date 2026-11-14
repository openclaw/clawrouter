import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream } = await import("../providers.ts");
const { FEATHERLESS_MODELS_FORMAT, featherlessCatalogRequest, filterFeatherlessModels, readFeatherlessModels } = await import("../featherless-model-catalog.ts");
const { discoveryAllows, modelDiscoveryResponse } = await import("../model-discovery.ts");
const { HttpOperation } = await import("../http-operation.ts");
const existing = parse(readFileSync(new URL("../../providers/featherless.provider.yaml", import.meta.url), "utf8"));
// Foundation fixtures remain independent; bundled activation has its own suite.
existing.capabilities = existing.capabilities.filter(capability => capability.endpoint !== "catalog");
delete existing.endpoints.catalog;
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities = manifest.capabilities.filter(row => row.endpoint !== "models_list");
  manifest.capabilities.push({ id: "models.list", endpoint: "models_list", methods: ["GET"] });
  manifest.endpoints.models_list = { method: "GET", path: "/models", requestFormat: FEATHERLESS_MODELS_FORMAT,
    responseFormat: FEATHERLESS_MODELS_FORMAT, headers: { accept: "application/json" }, timeoutMs: 10000 };
  return manifest;
}

test("Featherless catalog compiles a bodyless route with the original selected key and fixed query on every page", () => {
  const manifest = fixture(), before = structuredClone(manifest), snapshot = compile(manifest), provider = snapshot.providers[0];
  const endpoint = provider.endpoints.find(row => row.id === "models_list");
  assert.deepEqual(manifest, before); assert.equal(endpoint.path, "/models"); assert.equal(endpoint.upstreamPath, undefined);
  assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]); assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.request_format, "featherless.models"); assert.equal(endpoint.response_format, "featherless.models");
  assert.equal(endpoint.requestPricing, undefined); assert.equal(endpoint.modelPassthrough, undefined);
  const baseline = compile(existing);
  assert.deepEqual(snapshot.model_index, baseline.model_index); assert.deepEqual(provider.models, baseline.providers[0].models);
  assert.deepEqual(provider.endpoints.find(row => row.id === "chat_completions"), baseline.providers[0].endpoints.find(row => row.id === "chat_completions"));
  const upstream = configuredUpstream(provider, null, { FEATHERLESS_API_KEY: "synthetic-selected-key" });
  for (const page of [1, 2, 9]) {
    const request = featherlessCatalogRequest(upstream.baseUrl, "synthetic-selected-key", page, new AbortController().signal);
    assert.equal(request.url, `https://api.featherless.ai/v1/models?capabilities=chat&page=${page}&per_page=100`);
    assert.equal(request.body, null); assert.equal(request.method, "GET");
    assert.equal(request.headers.get("authorization"), upstream.headers.get("authorization"));
    assert.deepEqual([...request.headers], [["accept", "application/json"], ["authorization", "Bearer synthetic-selected-key"]]);
    assert.equal(request.redirect, "manual"); assert.equal(request.credentials, "omit");
  }
  assert.equal(endpoint.auth, null);
  assert.equal(provider.auth.schemes[0].secretKind, "api_key");
});

test("Featherless catalog rejects alternate methods, native format aliases, query/body features and duplicate discovery routes", () => {
  const changes = [
    m => { m.endpoints.models_list.method = "POST"; }, m => { delete m.endpoints.models_list.method; },
    m => { m.endpoints.models_list.path = "/v1/models"; }, m => { m.endpoints.models_list.path += "?limit=1"; },
    m => { m.endpoints.models_list.requestFormat = "featherless.models_v2"; },
    m => { m.endpoints.models_list.responseFormat = "openai.models"; },
    m => { m.endpoints.models_list.requestFormat = m.endpoints.models_list.responseFormat = "openai.models"; },
    m => { m.endpoints.models_list.upstreamPath = "/models"; },
    m => { m.endpoints.models_list.pathParams = ["model"]; },
    m => { m.endpoints.models_list.pathParamStyles = { model: "segment" }; },
    m => { m.endpoints.models_list.query = { capabilities: "chat", page: "1", per_page: "100" }; },
    m => { m.endpoints.models_list.streaming = "sse"; }, m => { m.endpoints.models_list.modelPassthrough = {}; },
    m => { m.endpoints.models_list.nativeProxy = false; },
    m => { m.endpoints.models_list.outputTokenLimit = { field: "limit", minimum: 1, maximum: 100 }; },
    m => { m.capabilities.find(row => row.endpoint === "models_list").id = "llm.chat"; },
    m => { m.capabilities.find(row => row.endpoint === "models_list").methods = ["GET", "POST"]; },
    m => { m.capabilities = m.capabilities.filter(row => row.endpoint !== "models_list"); },
    m => { m.endpoints.other_models = structuredClone(m.endpoints.models_list); m.capabilities.push({ id: "models.list", endpoint: "other_models", methods: ["GET"] }); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /featherless.models|invalid manifest/, String(change)); }
});

test("Featherless catalog rejects foreign origins, transport overrides and caller credential/header injection", () => {
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://api.featherless.ai"; },
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
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /featherless.models|invalid manifest/, String(change)); }
});

const frozenId = "Qwen/Qwen3-32B";
const page = (data, current = 1, total = 844) => ({ data,
  pagination: { current_page: current, per_page: 100, total_items: total, total_pages: Math.ceil(total / 100) }, total });

test("Featherless exact original-policy filtering preserves short and empty intermediate-page progress without seeding rows", () => {
  const provider = compile(fixture()).providers[0], before = structuredClone(provider.models);
  const payload = page([{ id: frozenId }], 2);
  const allows = id => discoveryAllows({ models: [`featherless/${frozenId}`] }, provider, id);
  assert.deepEqual(filterFeatherlessModels(payload, allows, 2), payload);
  assert.deepEqual(filterFeatherlessModels(payload, id => discoveryAllows({ models: [] }, provider, id), 2), page([], 2));
  assert.deepEqual(filterFeatherlessModels(page([], 2), allows, 2), page([], 2));
  assert.deepEqual(filterFeatherlessModels(page([], 1, 0), allows, 1), page([], 1, 0));
  assert.throws(() => filterFeatherlessModels(payload, allows, 1), error => error.code === "invalid_model_discovery_response");
  assert.deepEqual(provider.models, before);
});

test("Featherless account flags and model limits remain independent observations rather than serving entitlement", () => {
  const provider = compile(fixture()).providers[0], allows = id => discoveryAllows({ models: null }, provider, id);
  assert.deepEqual(filterFeatherlessModels(page([{ id: frozenId }]), allows, 1), page([{ id: frozenId }]));
  const observed = { id: frozenId, is_gated: true, available_on_current_plan: true,
    context_length: 4096, max_completion_tokens: 8192, concurrency_cost: 2, features: { tool_use: false, image_input: true } };
  assert.deepEqual(filterFeatherlessModels(page([observed]), allows, 1), page([observed]));
  for (const patch of [{ available_on_current_plan: false }, { status: "inactive" }, { object: "embedding" }]) {
    assert.deepEqual(filterFeatherlessModels(page([{ ...observed, ...patch }]), allows, 1), page([]));
  }
  assert.throws(() => filterFeatherlessModels(page([{ id: frozenId, available_on_current_plan: "true" }]), allows, 1),
    error => error.code === "invalid_model_discovery_response");
});

test("Featherless native prices stay independent decimal observations without static inference tariffs or zero defaults", async () => {
  const provider = compile(fixture()).providers[0], before = structuredClone(provider.models);
  const allows = id => discoveryAllows({ models: null }, provider, id);
  const observed = { id: frozenId, pricing: { prompt: "0.000001", completion: "0.000002", image: "0", request: "0.01" } };
  assert.deepEqual(await readFeatherlessModels(Response.json(page([observed], 2)), new AbortController().signal, allows, 2), page([observed], 2));
  const absent = filterFeatherlessModels(page([{ id: frozenId }]), allows, 1).data[0];
  for (const key of ["pricing", "context_length", "max_completion_tokens", "available_on_current_plan", "is_gated", "features"]) {
    assert.equal(Object.hasOwn(absent, key), false);
  }
  assert.deepEqual(filterFeatherlessModels(page([{ id: frozenId, pricing: { prompt: 1, completion: "0.000002" } }]), allows, 1),
    page([{ id: frozenId, pricing: { completion: "0.000002" } }]));
  assert.deepEqual(provider.models, before);
});

test("Featherless page registration retains validated pagination and leaves the strict OpenAI decoder unchanged", async () => {
  const provider = compile(fixture()).providers[0], payload = page([{ id: frozenId }], 2);
  assert.throws(() => filterFeatherlessModels({ data: payload.data }, () => true, 2), error => error.code === "invalid_model_discovery_response");
  await assert.rejects(readFeatherlessModels(Response.json(payload), new AbortController().signal, () => true, 1),
    error => error.code === "invalid_model_discovery_response");
  const endpoint = { ...provider.endpoints.find(row => row.id === "models_list"), request_format: "openai.models", response_format: "openai.models" };
  await assert.rejects(modelDiscoveryResponse(Response.json(payload), provider, endpoint, { models: null }, {}, new HttpOperation(),
    async () => { throw new Error("OpenAI rejection cannot paginate or replay"); }), error => error.code === "invalid_model_discovery_response");
});
