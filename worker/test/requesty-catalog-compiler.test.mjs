import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { prepareModelDiscovery, validateDiscoveryQuery, discoveryAllows } = await import("../model-discovery.ts");
const { REQUESTY_MODELS_FORMAT, requestyCatalogRequest, readRequestyModels } = await import("../requesty-model-catalog.ts");
const source = parse(readFileSync(new URL("../../providers/requesty.provider.yaml", import.meta.url), "utf8"));
const inference = structuredClone(source);
delete inference.endpoints.models_managed;
inference.capabilities = inference.capabilities.filter(value => !(value.id === "models.list" && value.endpoint === "models_managed"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(inference);
  manifest.capabilities.push({ id: "models.list", endpoint: "models_managed", methods: ["GET"] });
  manifest.endpoints.models_managed = { method: "GET", path: "/models/managed",
    requestFormat: REQUESTY_MODELS_FORMAT, responseFormat: REQUESTY_MODELS_FORMAT,
    headers: { accept: "application/json" } };
  return manifest;
}
const endpoint = manifest => manifest.endpoints.models_managed;
function selected() {
  const provider = compile(fixture()).providers[0];
  return { provider, endpoint: provider.endpoints.find(value => value.id === "models_managed") };
}

test("Requesty managed catalog preserves inference facts and compiles the exact native/manifest metadata selector", () => {
  const manifest = fixture(), before = structuredClone(manifest), snapshot = compile(manifest), provider = snapshot.providers[0];
  assert.deepEqual(manifest, before);
  const baseline = compile(inference), original = baseline.providers[0], route = provider.endpoints.find(value => value.id === "models_managed");
  assert.equal(REQUESTY_MODELS_FORMAT, "requesty.models_managed");
  assert.equal(route.method, "GET"); assert.deepEqual(route.methods, ["GET"]); assert.equal(route.path, "/models/managed");
  assert.equal(route.request_format, REQUESTY_MODELS_FORMAT); assert.equal(route.response_format, REQUESTY_MODELS_FORMAT);
  assert.equal(route.native_proxy, true); assert.equal(route.streaming, null); assert.equal(route.auth, null);
  assert.deepEqual(route.path_params, []); assert.deepEqual(route.query, {}); assert.deepEqual(route.request_headers, []);
  assert.equal(route.requestPricing, undefined); assert.equal(route.modelPassthrough, undefined); assert.equal(route.upstreamPath, undefined);
  assert.deepEqual(provider.models, original.models); assert.deepEqual(snapshot.model_index, baseline.model_index);
  for (const key of ["auth", "adapter", "base_urls", "routing", "billing"]) assert.deepEqual(provider[key], original[key]);
  assert.deepEqual(provider.endpoints.filter(value => value.id !== "models_managed"), original.endpoints);
  const catalog = createRouteCatalog([provider]), offer = catalog.manifestProxy.find(value => value.endpoint === "models_managed");
  assert.equal(offer.route, "/v1/proxy/requesty/models_managed"); assert.deepEqual(offer.methods, ["GET"]);
  assert.deepEqual(offer.models, []); assert.equal(offer.sampleModel, null);
  assert.deepEqual(catalog.openaiCompatible, createRouteCatalog([original]).openaiCompatible);
});

test("Requesty omitted or explicitly empty path parameters normalize identically without an invented streaming sentinel", () => {
  const implicit = compile(fixture());
  const explicit = fixture(); endpoint(explicit).pathParams = []; endpoint(explicit).pathParamStyles = {}; endpoint(explicit).nativeProxy = true;
  assert.deepEqual(compile(explicit), implicit);
});

test("Requesty managed catalog rejects mismatched pairs, aliases and caller-controlled transport fields", () => {
  for (const change of [
    m => { delete endpoint(m).method; }, m => { endpoint(m).method = "POST"; },
    m => { endpoint(m).path = "/models"; }, m => { endpoint(m).path = "/v1/models/managed"; },
    m => { endpoint(m).path += "?page=1"; }, m => { endpoint(m).nativeProxy = false; },
    m => { endpoint(m).requestFormat += "_future"; }, m => { endpoint(m).responseFormat = "openai.models"; },
    m => { endpoint(m).requestFormat = "openai.models"; },
    m => { endpoint(m).requestFormat = endpoint(m).responseFormat = "requesty.models"; },
    m => { endpoint(m).requestFormat = endpoint(m).responseFormat = "openai.models"; },
    m => { endpoint(m).upstreamPath = "/models/managed"; }, m => { endpoint(m).pathParams = ["model_id"]; },
    m => { endpoint(m).pathParamStyles = { model_id: "opaque_segment" }; }, m => { endpoint(m).query = { page: "1" }; },
    m => { endpoint(m).streaming = "sse"; }, m => { endpoint(m).streaming = "none"; },
    m => { endpoint(m).websocket = "openai.responses"; }, m => { endpoint(m).modelPassthrough = {}; },
    m => { endpoint(m).responsesLifecycle = { retrieve: "models_managed", cancel: "models_managed" }; },
    m => { endpoint(m).inputProfile = "clawrouter.pixverse-image-input.v1"; },
    m => { endpoint(m).outputTokenLimit = { field: "limit", minimum: 1, maximum: 10 }; },
    m => { endpoint(m).requestPricing = { unit: "request", successfulResponseMicros: 0 }; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /requesty.models_managed|invalid manifest/, String(change)); }
});

test("Requesty managed catalog requires its original canonical Bearer API-key binding", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://proxy.example/v1"; },
    m => { m.baseUrls.region = "https://eu.router.requesty.ai/v1"; },
    m => { m.auth.schemes[0].required = false; }, m => { m.auth.schemes[0].header = "x-api-key"; },
    m => { m.auth.schemes[0].format = "Token ${secret}"; }, m => { m.auth.schemes[0].secretKind = "oauth"; },
    m => { m.auth.grantTransports = { api_key: { endpointPaths: { models_managed: "/other" } } }; },
    m => { m.routing.baseUrlParam = "base_url"; }, m => { m.routing.serviceParam = "service"; },
    m => { endpoint(m).auth = "none"; }, m => { endpoint(m).requestHeaders = ["authorization"]; },
    m => { endpoint(m).headers = { authorization: "Bearer synthetic" }; },
    m => { m.adapter.injectHeaders = { authorization: "synthetic" }; }, m => { m.adapter.injectQuery = { key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["authorization"]; },
    m => { m.adapter.requestTransforms = { renameFields: [{ from: "model", to: "policy" }] }; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /requesty.models_managed|invalid manifest/, String(change)); }
});

test("Requesty managed catalog requires one model-less models.list operation and no retrieval or alternate selector", () => {
  for (const change of [
    m => { m.capabilities.at(-1).id = "models.retrieve"; }, m => { m.capabilities.at(-1).id = "llm.models.list"; },
    m => { m.capabilities.at(-1).methods.push("POST"); }, m => { m.capabilities.pop(); },
    m => { m.models.entries[0].capabilities.push("models.list"); },
    m => { m.endpoints.other = structuredClone(endpoint(m)); m.capabilities.push({ id: "models.list", endpoint: "other", methods: ["GET"] }); },
    m => { m.endpoints.models_list = endpoint(m); delete m.endpoints.models_managed; m.capabilities.at(-1).endpoint = "models_list"; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /requesty.models_managed|invalid manifest/, String(change)); }
});

test("Requesty compiled destination composes with the actual original-key bodyless query-free factory", () => {
  const { provider, endpoint } = selected(), controller = new AbortController();
  const request = requestyCatalogRequest(provider.base_urls.default, "synthetic-selected-key", controller.signal);
  assert.equal(request.url, provider.base_urls.default + endpoint.path);
  assert.equal(request.url, "https://router.requesty.ai/v1/models/managed"); assert.equal(request.method, "GET"); assert.equal(request.body, null);
  assert.deepEqual([...request.headers], [["accept", "application/json"], ["authorization", "Bearer synthetic-selected-key"]]);
  assert.equal(request.redirect, "manual"); assert.equal(request.credentials, "omit");
  controller.abort(); assert.equal(request.signal.aborted, true);
});

test("Requesty reader preserves native data, authoritative empty and unknown facts without changing inference prices", async () => {
  const { provider } = selected(), model = provider.models[0], before = structuredClone(provider.models), signal = new AbortController().signal;
  const allows = id => discoveryAllows({ models: [model.id] }, provider, id);
  const payload = { data: [{ id: model.upstream, api: "chat" }, { id: "unpermitted", api: "chat", input_price: 0 }] };
  assert.deepEqual(await readRequestyModels(Response.json(payload), signal, allows), { data: [payload.data[0]] });
  assert.deepEqual(await readRequestyModels(Response.json({ data: [] }), signal, allows), { data: [] });
  assert.deepEqual(await readRequestyModels(Response.json(payload), signal, () => false), { data: [] });
  assert.deepEqual(provider.models, before);
});

test("Requesty composes existing bodyless and query-free guards without claiming shared dispatch activation", () => {
  const { provider, endpoint } = selected();
  assert.deepEqual(prepareModelDiscovery(provider, endpoint, {}, {}), { model: null, body: {}, pathParams: {} });
  for (const body of [{ model: "caller-model" }, { url: "https://proxy.example" }, { api_key: "synthetic" }])
    assert.throws(() => prepareModelDiscovery(provider, endpoint, body, {}), error => error.code === "invalid_model_discovery");
  assert.throws(() => prepareModelDiscovery(provider, endpoint, {}, { model_id: "caller-model" }), error => error.code === "invalid_model_discovery");
  for (const query of [{ page: 1 }, { after_id: "caller-model" }, { limit: 1 }, { api_key: "synthetic" }])
    assert.throws(() => validateDiscoveryQuery(provider, endpoint, { models: null }, query), error => error.code === "invalid_model_discovery_query");
});
