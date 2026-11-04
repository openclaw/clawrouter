import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { prepareModelDiscovery, validateDiscoveryQuery } = await import("../model-discovery.ts");
const { FEATHERLESS_MODELS_FORMAT, featherlessCatalogRequest, readFeatherlessModels } = await import("../featherless-model-catalog.ts");
const source = parse(readFileSync(new URL("../../providers/featherless.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(source);
  manifest.capabilities = manifest.capabilities.filter(capability => capability.endpoint !== "catalog");
  manifest.capabilities.push({ id: "models.list", endpoint: "catalog", methods: ["GET"] });
  manifest.endpoints.catalog = { method: "GET", path: "/models", nativeProxy: false,
    requestFormat: "featherless.catalog", responseFormat: "featherless.catalog", headers: { accept: "application/json" }, timeoutMs: 10000 };
  return manifest;
}
function selected() {
  const provider = compile(fixture()).providers[0];
  return { provider, endpoint: provider.endpoints.find(endpoint => endpoint.id === "catalog") };
}

test("Featherless complete projection compiles as a model-less manifest GET without changing inference facts", () => {
  const manifest = fixture(), before = structuredClone(manifest), result = compile(manifest), provider = result.providers[0];
  assert.deepEqual(manifest, before);
  const baseline = compile(source), original = baseline.providers[0], endpoint = provider.endpoints.find(endpoint => endpoint.id === "catalog");
  assert.equal(endpoint.native_proxy, false); assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]);
  assert.equal(endpoint.path, "/models"); assert.equal(endpoint.request_format, "featherless.catalog"); assert.equal(endpoint.response_format, "featherless.catalog");
  assert.deepEqual(endpoint.path_params, []); assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.request_headers, []);
  assert.equal(endpoint.auth, null); assert.equal(endpoint.upstreamPath, undefined); assert.equal(endpoint.requestPricing, undefined);
  assert.deepEqual(provider.models, original.models); assert.deepEqual(result.model_index, baseline.model_index);
  assert.deepEqual(provider.auth, original.auth); assert.deepEqual(provider.adapter, original.adapter); assert.deepEqual(provider.base_urls, original.base_urls);
  assert.deepEqual(provider.endpoints.filter(value => value.id !== "catalog"), original.endpoints);
  const catalog = createRouteCatalog([provider]), route = catalog.manifestProxy.find(value => value.endpoint === "catalog");
  assert.equal(route.route, "/v1/proxy/featherless/catalog"); assert.deepEqual(route.methods, ["GET"]);
  assert.deepEqual(route.models, []); assert.equal(route.sampleModel, null);
  assert.deepEqual(catalog.openaiCompatible, createRouteCatalog([original]).openaiCompatible);
});

test("Featherless projection rejects native exposure, page-format aliases and caller-controlled wire fields", () => {
  for (const change of [
    m => { delete m.endpoints.catalog.nativeProxy; }, m => { m.endpoints.catalog.nativeProxy = true; },
    m => { m.endpoints.catalog.method = "POST"; }, m => { delete m.endpoints.catalog.method; },
    m => { m.endpoints.catalog.path = "/v1/models"; }, m => { m.endpoints.catalog.path += "?page=1"; },
    m => { m.endpoints.catalog.requestFormat += "_future"; }, m => { m.endpoints.catalog.responseFormat = "featherless.models"; },
    m => { m.endpoints.catalog.requestFormat = m.endpoints.catalog.responseFormat = "featherless.models"; },
    m => { m.endpoints.catalog.requestFormat = m.endpoints.catalog.responseFormat = "openai.models"; },
    m => { m.endpoints.catalog.upstreamPath = "/models"; }, m => { m.endpoints.catalog.pathParams = ["page"]; },
    m => { m.endpoints.catalog.query = { page: "1" }; }, m => { m.endpoints.catalog.query = { capabilities: "chat" }; },
    m => { m.endpoints.catalog.streaming = "sse"; }, m => { m.endpoints.catalog.modelPassthrough = {}; },
    m => { m.endpoints.catalog.requestPricing = { unit: "request", successfulResponseMicros: 0 }; },
    m => { m.endpoints.catalog.outputTokenLimit = { field: "limit", minimum: 1, maximum: 100 }; },
    m => { m.endpoints.catalog.inputProfile = "clawrouter.pixverse-image-input.v1"; },
    m => { m.endpoints.models_list = m.endpoints.catalog; delete m.endpoints.catalog; m.capabilities.at(-1).endpoint = "models_list"; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /featherless\.(?:catalog|models)|invalid manifest/, String(change)); }
});

test("Featherless projection requires the original canonical Bearer API-key binding", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://proxy.example/v1"; }, m => { m.baseUrls.other = "https://proxy.example/v1"; },
    m => { m.auth.schemes[0].required = false; }, m => { m.auth.schemes[0].header = "x-api-key"; },
    m => { m.auth.schemes[0].format = "Token ${secret}"; }, m => { m.auth.schemes[0].secretKind = "oauth"; },
    m => { m.auth.grantTransports = { api_key: { endpointPaths: { catalog: "/other" } } }; },
    m => { m.routing.baseUrlParam = "base_url"; }, m => { m.routing.serviceParam = "service"; },
    m => { m.endpoints.catalog.auth = "none"; }, m => { m.endpoints.catalog.requestHeaders = ["authorization"]; },
    m => { m.endpoints.catalog.headers = { authorization: "Bearer synthetic" }; },
    m => { m.adapter.injectHeaders = { authorization: "synthetic" }; }, m => { m.adapter.injectQuery = { api_key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["authorization"]; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /featherless\.(?:catalog|models)|invalid manifest/, String(change)); }
});

test("Featherless projection rejects inferred model capability and ambiguous discovery operations", () => {
  for (const change of [
    m => { m.capabilities.at(-1).id = "llm.chat"; }, m => { m.capabilities.at(-1).methods.push("POST"); },
    m => { m.capabilities.pop(); }, m => { m.models.entries[0].capabilities.push("models.list"); },
    m => { m.endpoints.other = structuredClone(m.endpoints.catalog); m.capabilities.push({ id: "models.list", endpoint: "other", methods: ["GET"] }); },
    m => { m.endpoints.models_list = { method: "GET", path: "/models", requestFormat: "featherless.models", responseFormat: "featherless.models" };
      m.capabilities.push({ id: "models.list", endpoint: "models_list", methods: ["GET"] }); },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /featherless\.(?:catalog|models)|invalid manifest/, String(change)); }
});

test("Featherless native page format remains a separate unchanged compiler contract", () => {
  const manifest = structuredClone(source);
  manifest.capabilities.push({ id: "models.list", endpoint: "models_list", methods: ["GET"] });
  manifest.endpoints.models_list = { method: "GET", path: "/models", requestFormat: FEATHERLESS_MODELS_FORMAT, responseFormat: FEATHERLESS_MODELS_FORMAT };
  const provider = compile(manifest).providers[0], endpoint = provider.endpoints.find(value => value.id === "models_list");
  assert.equal(FEATHERLESS_MODELS_FORMAT, "featherless.models"); assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.request_format, "featherless.models"); assert.equal(endpoint.response_format, "featherless.models");
  assert.deepEqual(provider.models, compile(source).providers[0].models);
});

test("Featherless projection reuses the original-key page factory and does not relabel its pagination", async () => {
  const { provider } = selected(), signal = new AbortController().signal, key = "synthetic-selected-key";
  for (const page of [1, 9]) {
    const request = featherlessCatalogRequest(provider.base_urls.default, key, page, signal);
    assert.equal(request.url, `https://api.featherless.ai/v1/models?capabilities=chat&page=${page}&per_page=100`);
    assert.equal(request.method, "GET"); assert.equal(request.body, null); assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "manual");
    assert.deepEqual([...request.headers], [["accept", "application/json"], ["authorization", `Bearer ${key}`]]);
  }
  const page = { data: [], pagination: { current_page: 2, per_page: 100, total_items: 844, total_pages: 9 }, total: 844 };
  assert.deepEqual(await readFeatherlessModels(Response.json(page), signal, () => false, 2), page);
  // The real page stays nonterminal. Only qualified common runtime may publish
  // the complete { providerId, catalog } projection; no scan is simulated here.
});

test("Featherless projection composes existing bodyless and query-free guards without a runtime activation claim", () => {
  const { provider, endpoint } = selected();
  assert.deepEqual(prepareModelDiscovery(provider, endpoint, {}, {}), { model: null, body: {}, pathParams: {} });
  for (const body of [{ model: "Qwen/Qwen3-32B" }, { page: 1 }, { api_key: "synthetic" }])
    assert.throws(() => prepareModelDiscovery(provider, endpoint, body, {}), error => error.code === "invalid_model_discovery");
  assert.throws(() => prepareModelDiscovery(provider, endpoint, {}, { page: "1" }), error => error.code === "invalid_model_discovery");
  for (const query of [{ page: 1 }, { per_page: 100 }, { capabilities: "chat" }, { api_key: "synthetic" }])
    assert.throws(() => validateDiscoveryQuery(provider, endpoint, { models: null }, query), error => error.code === "invalid_model_discovery_query");
});
