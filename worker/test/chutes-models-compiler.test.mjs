import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream } = await import("../providers.ts");
const { CHUTES_MODELS_FORMAT, chutesCatalogRequest, filterChutesModels, readChutesModels } = await import("../chutes-model-catalog.ts");
const { discoveryAllows, modelDiscoveryResponse } = await import("../model-discovery.ts");
const { HttpOperation } = await import("../http-operation.ts");
const existing = parse(readFileSync(new URL("../../providers/chutes.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities = manifest.capabilities.filter(row => row.endpoint !== "models_list");
  manifest.capabilities.push({ id: "models.list", endpoint: "models_list", methods: ["GET"] });
  manifest.endpoints.models_list = { method: "GET", path: "/models", requestFormat: CHUTES_MODELS_FORMAT,
    responseFormat: CHUTES_MODELS_FORMAT, headers: { accept: "application/json" }, timeoutMs: 10000 };
  return manifest;
}

test("Chutes public catalog compiles a bodyless GET without forwarding the private inference credential", () => {
  const manifest = fixture(), before = structuredClone(manifest), snapshot = compile(manifest), provider = snapshot.providers[0];
  const endpoint = provider.endpoints.find(row => row.id === "models_list");
  assert.deepEqual(manifest, before); assert.equal(endpoint.path, "/models"); assert.equal(endpoint.upstreamPath, undefined);
  assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]); assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.request_format, "chutes.models"); assert.equal(endpoint.response_format, "chutes.models");
  assert.equal(endpoint.requestPricing, undefined); assert.equal(endpoint.modelPassthrough, undefined);
  const baseline = compile(existing);
  assert.deepEqual(snapshot.model_index, baseline.model_index); assert.deepEqual(provider.models, baseline.providers[0].models);
  assert.deepEqual(provider.endpoints.find(row => row.id === "chat_completions"), baseline.providers[0].endpoints.find(row => row.id === "chat_completions"));
  const upstream = configuredUpstream(provider, null, { CHUTES_API_KEY: "synthetic-selected-key" });
  const request = chutesCatalogRequest(upstream.baseUrl, new AbortController().signal);
  assert.equal(request.url, "https://llm.chutes.ai/v1/models"); assert.equal(request.body, null);
  assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-selected-key");
  assert.deepEqual([...request.headers], [["accept", "application/json"]]);
  assert.equal(endpoint.auth, null);
  assert.equal(provider.auth.schemes[0].secretKind, "api_key");
  assert.equal(request.redirect, "manual"); assert.equal(request.credentials, "omit");
});

test("Chutes catalog rejects alternate methods, native format aliases, query/body features and duplicate discovery routes", () => {
  const changes = [
    m => { m.endpoints.models_list.method = "POST"; }, m => { delete m.endpoints.models_list.method; },
    m => { m.endpoints.models_list.path = "/v1/models"; }, m => { m.endpoints.models_list.path += "?limit=1"; },
    m => { m.endpoints.models_list.requestFormat = "chutes.models_v2"; },
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
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /chutes.models|invalid manifest/, String(change)); }
});

test("Chutes catalog rejects foreign origins, transport overrides and caller credential/header injection", () => {
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://api.chutes.ai/v1"; },
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
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /chutes.models|invalid manifest/, String(change)); }
});

const ids = ["deepseek-ai/DeepSeek-V3.2-TEE", "moonshotai/Kimi-K2.6-TEE", "zai-org/GLM-5.2-TEE",
  "Qwen/Qwen3.6-27B-TEE", "Qwen/Qwen3.5-397B-A17B-TEE"];
const row = id => ({ id, object: "model" });
const list = data => ({ object: "list", data });

test("Chutes public inventory still composes exact original-policy filtering without replacement aliases or seeded results", () => {
  const provider = compile(fixture()).providers[0], before = structuredClone(provider.models), payload = list(ids.map(row));
  for (const id of ids) {
    assert.deepEqual(filterChutesModels(payload, upstream => discoveryAllows({ models: [`chutes/${id}`] }, provider, upstream)), list([row(id)]));
  }
  assert.deepEqual(filterChutesModels(payload, upstream => discoveryAllows({ models: ["chutes/Qwen/Qwen3.6-27B-TEE"] }, provider, upstream)),
    list([row("Qwen/Qwen3.6-27B-TEE")]));
  assert.deepEqual(filterChutesModels(payload, id => discoveryAllows({ models: [] }, provider, id)), list([]));
  assert.deepEqual(filterChutesModels(list([]), () => true), list([]));
  assert.deepEqual(provider.models, before);
});

test("Chutes sparse TEE-named rows stay unknown while native flags and independent limits remain observations", () => {
  const provider = compile(fixture()).providers[0], allows = id => discoveryAllows({ models: null }, provider, id);
  assert.deepEqual(filterChutesModels(list([row(ids[0])]), allows), list([row(ids[0])]));
  const native = { ...row(ids[0]), confidential_compute: false, context_length: 4096, max_model_len: 2048,
    max_output_length: 8192, supported_features: [], supported_sampling_parameters: [] };
  assert.deepEqual(filterChutesModels(list([native]), allows), list([native]));
  const explicitNonText = { ...row(ids[1]), input_modalities: ["text"], output_modalities: ["image"] };
  assert.deepEqual(filterChutesModels(list([native, explicitNonText]), allows), list([native]));
  assert.equal(Object.hasOwn(provider.models[0], "nativeCapabilities"), false);
});

test("Chutes numeric prices retain native units and explicit zero without becoming inference tariffs", async () => {
  const provider = compile(fixture()).providers[0], before = structuredClone(provider.models), allows = id => discoveryAllows({ models: null }, provider, id);
  const native = { ...row(ids[0]), pricing: { prompt: 1, completion: 2, input_cache_read: 0 } };
  const payload = list([{ ...native, price: { usd: 900, tao: 700 }, chute_id: "synthetic-control-plane-id" }]);
  assert.deepEqual(await readChutesModels(Response.json(payload), new AbortController().signal, allows), list([native]));
  const absent = filterChutesModels(list([row(ids[0])]), allows).data[0];
  for (const key of ["pricing", "context_length", "max_output_length", "confidential_compute", "supported_features"]) assert.equal(Object.hasOwn(absent, key), false);
  assert.deepEqual(filterChutesModels(list([{ ...row(ids[0]), pricing: { prompt: "1", completion: 2 } }]), allows),
    list([{ ...row(ids[0]), pricing: { completion: 2 } }]));
  assert.deepEqual(provider.models, before);
});

test("Chutes registration requires its native strict envelope without broadening the OpenAI decoder", async () => {
  const provider = compile(fixture()).providers[0], payload = { data: [row(ids[0])] };
  assert.throws(() => filterChutesModels(payload, () => true), error => error.code === "invalid_model_discovery_response");
  const endpoint = { ...provider.endpoints.find(row => row.id === "models_list"), request_format: "openai.models", response_format: "openai.models" };
  await assert.rejects(modelDiscoveryResponse(Response.json(payload), provider, endpoint, { models: null }, {}, new HttpOperation(),
    async () => { throw new Error("OpenAI rejection cannot paginate or replay"); }), error => error.code === "invalid_model_discovery_response");
});
