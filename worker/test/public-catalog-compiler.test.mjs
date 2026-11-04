import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { prepareModelDiscovery, validateDiscoveryQuery, discoveryAllows } = await import("../model-discovery.ts");
const { cerebrasPublicCatalogRequest, readCerebrasPublicCatalog } = await import("../cerebras-model-catalog.ts");
const { nvidiaPublicCatalogRequests, readNvidiaPublicCatalog } = await import("../nvidia-model-catalog.ts");
const sources = Object.fromEntries(["cerebras", "nvidia"].map(id => [id,
  parse(readFileSync(new URL(`../../providers/${id}.provider.yaml`, import.meta.url), "utf8"))]));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture(id) {
  const manifest = structuredClone(sources[id]);
  manifest.capabilities.push({ id: "models.list", endpoint: "public_models", methods: ["GET"] });
  manifest.endpoints.public_models = { method: "GET", path: "/models", nativeProxy: false,
    requestFormat: `${id}.public_catalog`, responseFormat: `${id}.public_catalog`,
    headers: { accept: "application/json" }, timeoutMs: 10000 };
  return manifest;
}
function selected(id) {
  const provider = compile(fixture(id)).providers[0];
  return { provider, endpoint: provider.endpoints.find(endpoint => endpoint.id === "public_models") };
}

for (const id of ["cerebras", "nvidia"]) {
  test(`${id} normalized public facts compile only as a model-less manifest operation`, () => {
    const manifest = fixture(id), before = structuredClone(manifest), snapshot = compile(manifest), provider = snapshot.providers[0];
    assert.deepEqual(manifest, before);
    const original = compile(sources[id]), endpoint = provider.endpoints.find(endpoint => endpoint.id === "public_models");
    assert.equal(endpoint.native_proxy, false); assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]);
    assert.equal(endpoint.path, "/models"); assert.equal(endpoint.upstreamPath, undefined);
    assert.equal(endpoint.request_format, `${id}.public_catalog`); assert.equal(endpoint.response_format, `${id}.public_catalog`);
    assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.path_params, []); assert.equal(endpoint.requestPricing, undefined);
    assert.deepEqual(provider.models, original.providers[0].models); assert.deepEqual(snapshot.model_index, original.model_index);
    assert.deepEqual(provider.auth, original.providers[0].auth); assert.deepEqual(provider.adapter, original.providers[0].adapter);
    const catalog = createRouteCatalog([provider]), route = catalog.manifestProxy.find(route => route.endpoint === "public_models");
    assert.equal(route.route, `/v1/proxy/${id}/public_models`); assert.deepEqual(route.methods, ["GET"]);
    assert.equal(route.sampleModel, null); assert.deepEqual(route.models, []);
    assert.deepEqual(catalog.openaiCompatible, createRouteCatalog(original.providers).openaiCompatible);
  });

  test(`${id} public projection rejects native aliases, mismatched formats, inferred prices and caller selectors`, () => {
    for (const change of [
      m => { delete m.endpoints.public_models.nativeProxy; }, m => { m.endpoints.public_models.nativeProxy = true; },
      m => { m.endpoints.public_models.method = "POST"; }, m => { delete m.endpoints.public_models.method; },
      m => { m.endpoints.public_models.path = "/public/v1/models"; }, m => { m.endpoints.public_models.path += "?limit=1"; },
      m => { m.endpoints.public_models.requestFormat += "_future"; },
      m => { m.endpoints.public_models.responseFormat = "openai.models"; },
      m => { m.endpoints.public_models.requestFormat = m.endpoints.public_models.responseFormat = `${id}.models`; },
      m => { m.endpoints.public_models.requestFormat = m.endpoints.public_models.responseFormat = `${id === "cerebras" ? "nvidia" : "cerebras"}.public_catalog`; },
      m => { m.endpoints.public_models.upstreamPath = "/models"; },
      m => { m.endpoints.public_models.pathParams = ["model"]; }, m => { m.endpoints.public_models.query = { page: "1" }; },
      m => { m.endpoints.public_models.streaming = "sse"; }, m => { m.endpoints.public_models.modelPassthrough = {}; },
      m => { m.endpoints.public_models.outputTokenLimit = { field: "limit", minimum: 1, maximum: 10 }; },
      m => { m.endpoints.public_models.requestPricing = { unit: "request", successfulResponseMicros: 0 }; },
      m => { m.capabilities.at(-1).methods.push("POST"); }, m => { m.capabilities.at(-1).id = "llm.chat"; },
      m => { m.capabilities.pop(); }, m => { m.models.entries[0].capabilities.push("models.list"); },
      m => { m.endpoints.other = structuredClone(m.endpoints.public_models); m.capabilities.push({ id: "models.list", endpoint: "other", methods: ["GET"] }); },
    ]) { const manifest = fixture(id); change(manifest); assert.throws(() => compile(manifest), /public_catalog|invalid manifest/, String(change)); }
  });

  test(`${id} public metadata cannot borrow a proxy origin or inference credential injection`, () => {
    for (const change of [
      m => { m.id = "other"; }, m => { m.baseUrls.default += "?key=synthetic"; }, m => { m.baseUrls.other = "https://proxy.example/v1"; },
      m => { m.routing.baseUrlParam = "base_url"; }, m => { m.routing.serviceParam = "service"; },
      m => { m.auth.schemes[0].required = false; }, m => { m.auth.schemes[0].header = "x-api-key"; },
      m => { m.auth.schemes[0].format = "Token ${secret}"; }, m => { m.auth.schemes[0].secretKind = "oauth"; },
      m => { m.auth.grantTransports = { api_key: { baseUrl: "https://proxy.example/v1" } }; },
      m => { m.endpoints.public_models.auth = "none"; }, m => { m.endpoints.public_models.requestHeaders = ["authorization"]; },
      m => { m.endpoints.public_models.headers = { authorization: "synthetic" }; },
      m => { m.adapter.injectHeaders = { authorization: "synthetic" }; }, m => { m.adapter.injectQuery = { api_key: "synthetic" }; },
      m => { m.adapter.passthroughHeaders = ["authorization"]; },
    ]) { const manifest = fixture(id); change(manifest); assert.throws(() => compile(manifest), /public_catalog|invalid manifest/, String(change)); }
  });

  test(`${id} existing metadata input guards deny every supplied body, path selector and query`, () => {
    const { provider, endpoint } = selected(id);
    assert.deepEqual(prepareModelDiscovery(provider, endpoint, {}, {}), { model: null, body: {}, pathParams: {} });
    for (const body of [{ model: "caller-model" }, { url: "https://proxy.example" }, { limit: 1 }])
      assert.throws(() => prepareModelDiscovery(provider, endpoint, body, {}), error => error.code === "invalid_model_discovery");
    assert.throws(() => prepareModelDiscovery(provider, endpoint, {}, { model_id: "caller-model" }), error => error.code === "invalid_model_discovery");
    for (const query of [{ limit: 1 }, { page: 1 }, { after_id: "caller-model" }, { api_key: "synthetic" }])
      assert.throws(() => validateDiscoveryQuery(provider, endpoint, { models: null }, query), error => error.code === "invalid_model_discovery_query");
    // Common runtime must register the exact formats and apply these guards;
    // direct guard composition is not an activated HTTP route proof.
  });
}

test("published factories select one Cerebras URL and both NVIDIA URLs without inference credentials", () => {
  const signal = new AbortController().signal;
  const cerebras = selected("cerebras").provider, nvidia = selected("nvidia").provider;
  const single = cerebrasPublicCatalogRequest(cerebras.base_urls.default, signal), pair = nvidiaPublicCatalogRequests(nvidia.base_urls.default, signal);
  assert.equal(single.url, "https://api.cerebras.ai/public/v1/models");
  assert.equal(pair.inventory.url, "https://integrate.api.nvidia.com/v1/models");
  assert.equal(pair.featured.url, "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json");
  for (const request of [single, pair.inventory, pair.featured]) {
    assert.equal(request.method, "GET"); assert.equal(request.body, null);
    assert.deepEqual([...request.headers], [["accept", "application/json"]]);
    assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "manual");
  }
});

test("Cerebras output remains a normalized fact array with exact observed decimal prices and unknown flags", async () => {
  const provider = selected("cerebras").provider, model = provider.models[0], before = structuredClone(provider.models);
  const permitted = new Set(provider.models.map(row => row.upstream).filter(id => discoveryAllows({ models: [model.id] }, provider, id)));
  const native = { object: "list", data: [{ id: model.upstream, limits: { max_context_length: 4096, max_completion_tokens: 512 },
    pricing: { prompt: "0.000001", completion: "0.000002" } }] };
  const catalog = await readCerebrasPublicCatalog(Response.json(native), new AbortController().signal, permitted);
  const projection = { providerId: "cerebras", catalog };
  assert.ok(Array.isArray(projection.catalog)); assert.equal(projection.catalog.length, 1);
  assert.equal(catalog[0].id, model.upstream); assert.equal(catalog[0].contextWindow, 4096); assert.equal(catalog[0].maxOutputTokens, 512);
  assert.deepEqual(catalog[0].pricing, { currency: "USD", inputPerToken: "0.000001", outputPerToken: "0.000002" });
  assert.equal(catalog[0].reasoning, null); assert.equal(catalog[0].tools, null); assert.equal(catalog[0].vision, null);
  assert.equal(Object.hasOwn(catalog, "data"), false); assert.deepEqual(provider.models, before);
  delete native.data[0].pricing;
  assert.equal((await readCerebrasPublicCatalog(Response.json(native), new AbortController().signal, permitted))[0].pricing, null);
  assert.deepEqual(await readCerebrasPublicCatalog(Response.json(native), new AbortController().signal, new Set()), []);
  assert.deepEqual(await readCerebrasPublicCatalog(Response.json({ object: "list", data: [] }), new AbortController().signal, permitted), []);
});

test("NVIDIA output intersects fresh inventory and featured metadata as normalized facts, not a native list envelope", async () => {
  const provider = selected("nvidia").provider, model = provider.models[0], before = structuredClone(provider.models);
  const permitted = new Set(provider.models.map(row => row.upstream).filter(id => discoveryAllows({ models: [model.id] }, provider, id)));
  const inventory = { object: "list", data: [{ id: model.upstream, object: "model" }] };
  const featured = { "featured-models": [{ model: model.upstream, "model-name": "Synthetic observation", context: 4096, "max-output": 512 }] };
  const read = (a, b) => readNvidiaPublicCatalog(Response.json(a), Response.json(b), new AbortController().signal, permitted);
  const projection = { providerId: "nvidia", catalog: await read(inventory, featured) };
  assert.ok(Array.isArray(projection.catalog)); assert.equal(projection.catalog.length, 1);
  const row = projection.catalog[0]; assert.equal(row.id, model.upstream); assert.equal(row.contextWindow, 4096);
  assert.equal(row.outputTokenBudget, 512); assert.equal(row.metadataSource, "featured"); assert.equal(row.pricing, null);
  assert.equal(Object.hasOwn(projection.catalog, "data"), false); assert.deepEqual(provider.models, before);
  assert.deepEqual(await read({ object: "list", data: [] }, featured), []);
  assert.deepEqual(await readNvidiaPublicCatalog(Response.json({ object: "list", data: [] }), Response.json({}, { status: 500 }),
    new AbortController().signal, permitted), []);
  await assert.rejects(() => readNvidiaPublicCatalog(Response.json(inventory), Response.json({}, { status: 500 }),
    new AbortController().signal, permitted), error => error.code === "provider_catalog_invalid");
});
