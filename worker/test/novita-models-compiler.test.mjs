import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream } = await import("../providers.ts");
const { NOVITA_MODELS_FORMAT, novitaCatalogRequest, filterNovitaModels, readNovitaModels } = await import("../novita-model-catalog.ts");
const { discoveryAllows, modelDiscoveryResponse } = await import("../model-discovery.ts");
const { HttpOperation } = await import("../http-operation.ts");
const existing = parse(readFileSync(new URL("../../providers/novita.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities = manifest.capabilities.filter(row => row.endpoint !== "models_list");
  manifest.capabilities.push({ id: "models.list", endpoint: "models_list", methods: ["GET"] });
  manifest.endpoints.models_list = { method: "GET", path: "/models", requestFormat: NOVITA_MODELS_FORMAT,
    responseFormat: NOVITA_MODELS_FORMAT, headers: { accept: "application/json" }, timeoutMs: 10000 };
  return manifest;
}

test("Novita native catalog compiles one bodyless GET without remapping, model changes or credential substitution", () => {
  const manifest = fixture(), before = structuredClone(manifest), snapshot = compile(manifest), provider = snapshot.providers[0];
  const endpoint = provider.endpoints.find(row => row.id === "models_list");
  assert.deepEqual(manifest, before); assert.equal(endpoint.path, "/models"); assert.equal(endpoint.upstreamPath, undefined);
  assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]); assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.request_format, "novita.models"); assert.equal(endpoint.response_format, "novita.models");
  assert.equal(endpoint.requestPricing, undefined); assert.equal(endpoint.modelPassthrough, undefined);
  const baseline = compile(existing);
  assert.deepEqual(snapshot.model_index, baseline.model_index); assert.deepEqual(provider.models, baseline.providers[0].models);
  assert.deepEqual(provider.endpoints.find(row => row.id === "chat_completions"), baseline.providers[0].endpoints.find(row => row.id === "chat_completions"));
  const upstream = configuredUpstream(provider, null, { NOVITA_API_KEY: "synthetic-selected-key" });
  const request = novitaCatalogRequest(upstream.baseUrl, "synthetic-selected-key", new AbortController().signal);
  assert.equal(request.url, "https://api.novita.ai/openai/v1/models"); assert.equal(request.body, null);
  assert.equal(request.headers.get("authorization"), upstream.headers.get("authorization"));
  assert.equal(request.headers.get("authorization"), "Bearer synthetic-selected-key");
  assert.equal(request.redirect, "manual"); assert.equal(request.credentials, "omit");
});

test("Novita catalog rejects alternate methods, native format aliases, query/body features and duplicate discovery routes", () => {
  const changes = [
    m => { m.endpoints.models_list.method = "POST"; }, m => { delete m.endpoints.models_list.method; },
    m => { m.endpoints.models_list.path = "/v1/models"; }, m => { m.endpoints.models_list.path += "?limit=1"; },
    m => { m.endpoints.models_list.requestFormat = "novita.models_v2"; },
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
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /novita.models|invalid manifest/, String(change)); }
});

test("Novita catalog rejects foreign origins, transport overrides and caller credential/header injection", () => {
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://api.novita.ai/v3/openai"; },
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
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /novita.models|invalid manifest/, String(change)); }
});

const ids = ["moonshotai/kimi-k3", "moonshotai/kimi-k2.7-code", "minimax/minimax-m3", "zai-org/glm-5.2",
  "deepseek/deepseek-v4-pro", "qwen/qwen3.7-max", "minimax/minimax-m2.7"];
const row = id => ({ id, object: "model", created: 1730000000, context_size: 4096 });

test("Novita discovery filters all seven frozen native identities through the original policy without seed refill", () => {
  const provider = compile(fixture()).providers[0], before = structuredClone(provider.models);
  const payload = { data: ids.map(id => ({ ...row(id), name: "Synthetic display alias", replacement: "unqualified" })) };
  for (const id of ids) {
    assert.deepEqual(filterNovitaModels(payload, upstream => discoveryAllows({ models: [`novita/${id}`] }, provider, upstream)), { data: [row(id)] });
    assert.deepEqual(filterNovitaModels(payload, upstream => discoveryAllows({ models: [`other/${id}`] }, provider, upstream)), { data: [] });
  }
  assert.deepEqual(filterNovitaModels(payload, id => discoveryAllows({ models: [] }, provider, id)), { data: [] });
  assert.deepEqual(filterNovitaModels({ data: [] }, () => true), { data: [] });
  assert.deepEqual(provider.models, before);
});

test("Novita required native timestamp and context stay observations without invented capabilities or output limits", () => {
  const provider = compile(fixture()).providers[0], allows = id => discoveryAllows({ models: null }, provider, id);
  for (const field of ["object", "created", "context_size"]) {
    const native = row(ids[0]); delete native[field];
    assert.throws(() => filterNovitaModels({ data: [native] }, allows), error => error.code === "invalid_model_discovery_response");
  }
  const native = { ...row(ids[0]), context_size: 8192, reasoning: true, modalities: ["image"], max_output_tokens: 1024 };
  assert.deepEqual(filterNovitaModels({ data: [native] }, allows), { data: [{ ...row(ids[0]), context_size: 8192 }] });
  assert.equal(provider.models[0].contextWindow, undefined);
  assert.equal(provider.models[0].pricing, null);
});

test("Novita native integer price observations never become USD conversions, cache defaults or compiled tariffs", async () => {
  const provider = compile(fixture()).providers[0], before = structuredClone(provider.models), allows = id => discoveryAllows({ models: null }, provider, id);
  const native = { ...row(ids[0]), input_token_price_per_m: 3900, output_token_price_per_m: 7800 };
  assert.deepEqual(await readNovitaModels(Response.json({ data: [native] }), new AbortController().signal, allows), { data: [native] });
  const absent = filterNovitaModels({ data: [row(ids[0])] }, allows).data[0];
  for (const key of ["input_token_price_per_m", "output_token_price_per_m", "pricing", "cached_input_token_price_per_m"]) assert.equal(Object.hasOwn(absent, key), false);
  for (const [input, output, expected] of [
    [3900, undefined, { input_token_price_per_m: 3900 }],
    [undefined, 0, { output_token_price_per_m: 0 }],
    [0.0039, -1, {}], ["3900", null, {}],
  ]) {
    const payload = { data: [{ ...row(ids[0]), input_token_price_per_m: input, output_token_price_per_m: output }] };
    assert.deepEqual(filterNovitaModels(payload, allows), { data: [{ ...row(ids[0]), ...expected }] });
  }
  assert.deepEqual(provider.models, before);
  assert.equal(provider.models[0].pricing, null);
});

test("Novita native data-only decoding remains bounded and does not relax the strict OpenAI decoder", async () => {
  const provider = compile(fixture()).providers[0], payload = { data: [row(ids[0])] };
  const endpoint = { ...provider.endpoints.find(row => row.id === "models_list"), request_format: "openai.models", response_format: "openai.models" };
  assert.deepEqual(filterNovitaModels(payload, () => true), payload);
  assert.throws(() => filterNovitaModels({ object: "list", ...payload }, () => true), error => error.code === "invalid_model_discovery_response");
  await assert.rejects(modelDiscoveryResponse(Response.json(payload), provider, endpoint, { models: null }, {}, new HttpOperation(),
    async () => { throw new Error("OpenAI rejection cannot paginate or replay"); }), error => error.code === "invalid_model_discovery_response");
});
