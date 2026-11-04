import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream } = await import("../providers.ts");
const { VENICE_MODELS_FORMAT, veniceCatalogRequest, filterVeniceModels, readVeniceModels } = await import("../venice-model-catalog.ts");
const { discoveryAllows, modelDiscoveryResponse } = await import("../model-discovery.ts");
const { HttpOperation } = await import("../http-operation.ts");
const existing = parse(readFileSync(new URL("../../providers/venice.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities = manifest.capabilities.filter(row => row.endpoint !== "models_list");
  manifest.capabilities.push({ id: "models.list", endpoint: "models_list", methods: ["GET"] });
  manifest.endpoints.models_list = { method: "GET", path: "/models", requestFormat: VENICE_MODELS_FORMAT,
    responseFormat: VENICE_MODELS_FORMAT, headers: { accept: "application/json" }, timeoutMs: 10000 };
  return manifest;
}

test("Venice public catalog compiles a bodyless GET without forwarding the private inference credential", () => {
  const manifest = fixture(), before = structuredClone(manifest), snapshot = compile(manifest), provider = snapshot.providers[0];
  const endpoint = provider.endpoints.find(row => row.id === "models_list");
  assert.deepEqual(manifest, before); assert.equal(endpoint.path, "/models"); assert.equal(endpoint.upstreamPath, undefined);
  assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]); assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.request_format, "venice.models"); assert.equal(endpoint.response_format, "venice.models");
  assert.equal(endpoint.requestPricing, undefined); assert.equal(endpoint.modelPassthrough, undefined);
  const baseline = compile(existing);
  assert.deepEqual(snapshot.model_index, baseline.model_index); assert.deepEqual(provider.models, baseline.providers[0].models);
  assert.deepEqual(provider.endpoints.find(row => row.id === "chat_completions"), baseline.providers[0].endpoints.find(row => row.id === "chat_completions"));
  const upstream = configuredUpstream(provider, null, { VENICE_API_KEY: "synthetic-selected-key" });
  const request = veniceCatalogRequest(upstream.baseUrl, new AbortController().signal);
  assert.equal(request.url, "https://api.venice.ai/api/v1/models?type=text"); assert.equal(request.body, null);
  assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-selected-key");
  assert.deepEqual([...request.headers], [["accept", "application/json"]]);
  assert.equal(endpoint.auth, null);
  assert.equal(provider.auth.schemes[0].secretKind, "api_key");
  assert.equal(request.redirect, "manual"); assert.equal(request.credentials, "omit");
});

test("Venice catalog rejects alternate methods, native format aliases, query/body features and duplicate discovery routes", () => {
  const changes = [
    m => { m.endpoints.models_list.method = "POST"; }, m => { delete m.endpoints.models_list.method; },
    m => { m.endpoints.models_list.path = "/v1/models"; }, m => { m.endpoints.models_list.path += "?limit=1"; },
    m => { m.endpoints.models_list.requestFormat = "venice.models_v2"; },
    m => { m.endpoints.models_list.responseFormat = "openai.models"; },
    m => { m.endpoints.models_list.requestFormat = m.endpoints.models_list.responseFormat = "openai.models"; },
    m => { m.endpoints.models_list.upstreamPath = "/models"; },
    m => { m.endpoints.models_list.pathParams = ["model"]; },
    m => { m.endpoints.models_list.pathParamStyles = { model: "segment" }; },
    m => { m.endpoints.models_list.query = { type: "text" }; },
    m => { m.endpoints.models_list.streaming = "sse"; }, m => { m.endpoints.models_list.modelPassthrough = {}; },
    m => { m.endpoints.models_list.nativeProxy = false; },
    m => { m.endpoints.models_list.outputTokenLimit = { field: "limit", minimum: 1, maximum: 100 }; },
    m => { m.capabilities.find(row => row.endpoint === "models_list").id = "llm.chat"; },
    m => { m.capabilities.find(row => row.endpoint === "models_list").methods = ["GET", "POST"]; },
    m => { m.capabilities = m.capabilities.filter(row => row.endpoint !== "models_list"); },
    m => { m.endpoints.other_models = structuredClone(m.endpoints.models_list); m.capabilities.push({ id: "models.list", endpoint: "other_models", methods: ["GET"] }); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /venice.models|invalid manifest/, String(change)); }
});

test("Venice catalog rejects foreign origins, transport overrides and caller credential/header injection", () => {
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://api.venice.ai/v1"; },
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
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /venice.models|invalid manifest/, String(change)); }
});

const ids = ["zai-org-glm-5-2", "zai-org-glm-4.7", "venice-uncensored-1-2", "google-gemma-4-31b-it", "kimi-k2-6", "deepseek-v3.2",
  "qwen3-235b-a22b-thinking-2507", "qwen3-coder-480b-a35b-instruct-turbo", "qwen3-vl-235b-a22b", "grok-4-5", "qwen-3-7-max", "qwen-3-7-plus",
  "claude-fable-5", "claude-opus-5", "claude-sonnet-4-6", "openai-gpt-56-sol", "zai-org-glm-4.6", "google-gemma-3-27b-it", "kimi-k2-5"];
const row = (id, model_spec) => ({ id, object: "model", type: "text", ...(model_spec ? { model_spec } : {}) });
const list = data => ({ object: "list", type: "text", data });

test("Venice public catalog composes exact original-policy filtering for every frozen ID without traits or fallback seeds", () => {
  const provider = compile(fixture()).providers[0], before = structuredClone(provider.models), payload = list(ids.map(id => row(id)));
  for (const id of ids) {
    assert.deepEqual(filterVeniceModels(payload, upstream => discoveryAllows({ models: [`venice/${id}`] }, provider, upstream)), list([row(id)]));
  }
  for (const model of ["venice/default", "venice/function_calling_default", "venice/synthetic-ungranted"]) {
    assert.deepEqual(filterVeniceModels(payload, id => discoveryAllows({ models: [model] }, provider, id)), list([]));
  }
  assert.deepEqual(filterVeniceModels(payload, id => discoveryAllows({ models: [] }, provider, id)), list([]));
  assert.deepEqual(filterVeniceModels(list([]), () => true), list([])); assert.deepEqual(provider.models, before);
});

test("Venice sparse capabilities, independent limits and dated privacy/deprecation observations do not create entitlements", () => {
  const provider = compile(fixture()).providers[0], allows = id => discoveryAllows({ models: null }, provider, id);
  assert.deepEqual(filterVeniceModels(list([row(ids[6])]), allows), list([row(ids[6])]));
  const spec = { availableContextTokens: 4096, maxCompletionTokens: 8192, privacy: "anonymized", offline: false,
    capabilities: { supportsFunctionCalling: false, supportsReasoningEffort: true }, deprecation: { date: "2026-10-01T00:00:00.000Z" } };
  assert.deepEqual(filterVeniceModels(list([row(ids[0], spec)]), allows), list([row(ids[0], spec)]));
  assert.deepEqual(filterVeniceModels(list([row(ids[0], { ...spec, offline: true }), { ...row(ids[1]), type: "image" }]), allows), list([]));
  const absent = filterVeniceModels(list([row(ids[0])]), allows).data[0];
  assert.equal(Object.hasOwn(absent, "model_spec"), false); assert.equal(Object.hasOwn(provider.models[0], "nativeCapabilities"), false);
});

test("Venice USD and DIEM prices remain separate observations with independent extended rates and no executable tariff", async () => {
  const provider = compile(fixture()).providers[0], before = structuredClone(provider.models), allows = id => discoveryAllows({ models: null }, provider, id);
  const pricing = { input: { usd: 1, diem: 2 }, output: { diem: 3 }, cache_input: { usd: 0 },
    extended: { context_token_threshold: 200000, input: { usd: 4 }, cache_write: { diem: 5 } } };
  const payload = list([row(ids[0], { pricing })]);
  assert.deepEqual(await readVeniceModels(Response.json(payload), new AbortController().signal, allows), payload);
  const noThreshold = { ...pricing, extended: { input: { usd: 4 } } };
  assert.deepEqual(filterVeniceModels(list([row(ids[0], { pricing: noThreshold })]), allows), list([row(ids[0])]));
  assert.deepEqual(filterVeniceModels(list([row(ids[0], { pricing: { input: { diem: 2 }, output: { usd: "1" } } })]), allows),
    list([row(ids[0], { pricing: { input: { diem: 2 } } })]));
  assert.deepEqual(provider.models, before);
});

test("Venice native text envelope registration preserves bounded reading and the strict OpenAI decoder", async () => {
  const provider = compile(fixture()).providers[0], payload = { data: [row(ids[0])] };
  assert.throws(() => filterVeniceModels(payload, () => true), error => error.code === "invalid_model_discovery_response");
  await assert.rejects(readVeniceModels(Response.json({ ...list([row(ids[0])]), next_page: "synthetic" }), new AbortController().signal, () => true),
    error => error.code === "invalid_model_discovery_response");
  const endpoint = { ...provider.endpoints.find(row => row.id === "models_list"), request_format: "openai.models", response_format: "openai.models" };
  await assert.rejects(modelDiscoveryResponse(Response.json(payload), provider, endpoint, { models: null }, {}, new HttpOperation(),
    async () => { throw new Error("OpenAI rejection cannot paginate or replay"); }), error => error.code === "invalid_model_discovery_response");
});
