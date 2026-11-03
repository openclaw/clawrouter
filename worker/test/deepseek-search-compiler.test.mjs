import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareDeepSeekSearch, observeDeepSeekSearch, readDeepSeekSearch } = await import("../deepseek-search.ts");
const { configuredUpstream } = await import("../providers.ts");
const { prepareManifestRequest, prepareNativeRequest } = await import("../proxy-selection.ts");
const { prepareUpstreamRequest } = await import("../proxy-upstream-request.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const existing = parse(readFileSync(new URL("../../providers/deepseek.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/deepseek/search.json", import.meta.url)));
const format = "deepseek.search", capability = "search.web";
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(existing);
  if (!manifest.capabilities.some(item => item.id === capability && item.endpoint === "search"))
    manifest.capabilities.push({ id: capability, endpoint: "search", methods: ["POST"] });
  manifest.endpoints.search ??= { method: "POST", path: "/v1/tools/search", requestFormat: format, responseFormat: format };
  return manifest;
}
function selected() {
  const snapshot = compile(fixture()), provider = snapshot.providers[0];
  return { snapshot, provider, endpoint: provider.endpoints.find(value => value.id === "search") };
}

test("DeepSeek Search compiles a model-less native offer alongside unchanged Chat cards", () => {
  const { snapshot, provider, endpoint } = selected();
  const before = compile(existing);
  assert.deepEqual(snapshot.model_index, before.model_index);
  assert.deepEqual(snapshot.capability_index[capability], [{ provider: "deepseek", endpoint: "search", methods: ["POST"] }]);
  assert.equal(endpoint.request_format, format); assert.equal(endpoint.response_format, format);
  assert.equal(endpoint.native_proxy, true); assert.equal(endpoint.method, "POST");
  assert.equal(endpoint.streaming, null); assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.path_params, []);
  assert.equal(endpoint.requestPricing, undefined); assert.equal(endpoint.modelPassthrough, undefined);
  const catalog = createRouteCatalog([provider]), offer = catalog.manifestProxy.find(row => row.endpoint === "search");
  assert.equal(offer.sampleModel, null); assert.deepEqual(offer.models, []); assert.equal(offer.requestFormat, format);
  assert.deepEqual(catalog.openaiCompatible, createRouteCatalog(before.providers).openaiCompatible);
});

test("compiled native and manifest Search preserve explicit options and selected original Bearer credentials", async () => {
  const { provider, endpoint } = selected();
  const auth = configuredUpstream(provider, null, { DEEPSEEK_API_KEY: "synthetic-selected-key" });
  for (const count of [1, 5, 10]) {
    const body = { ...wire.request.body, count }, original = structuredClone(body);
    const prepared = prepareDeepSeekSearch(body);
    for (const result of [prepareNativeRequest(provider, endpoint, body, endpoint.path, {}), prepareManifestRequest(provider, endpoint, body, {}, {})]) {
      assert.equal(result.model, null); assert.deepEqual(result.body, original); assert.deepEqual(result.pathParams, {});
      const outbound = prepareUpstreamRequest(new Request("https://router.example/v1/native/deepseek/v1/tools/search", {
        method: "POST", headers: { "content-type": "application/json" },
      }), {}, { provider, endpoint, ...result, capability, method: "POST" }, {}, auth, "http");
      assert.equal(outbound.url.href, `https://api.deepseek.com${prepared.path}`);
      assert.deepEqual(await new Response(outbound.requestBody).json(), original);
      assert.equal(outbound.headers.get("authorization"), "Bearer synthetic-selected-key");
    }
    assert.deepEqual(body, original); assert.deepEqual(prepared.body, original);
    assert.equal(prepared.headers.has("authorization"), false);
  }
  // Codec default 5 differs from upstream default 10. The native wrapper must
  // require explicit count/need_content; compilation injects neither default.
  assert.equal(prepareDeepSeekSearch({ query: "synthetic" }).body.count, 5);
  assert.deepEqual(provider.adapter.injectQuery, {});
});

test("Search cannot select a priced Chat card or create a synthetic model identity", () => {
  const { provider, endpoint } = selected(), chat = provider.models[0];
  for (const value of [chat.id, chat.upstream, "deepseek/search"]) {
    assert.throws(() => prepareManifestRequest(provider, endpoint, { ...wire.request.body, model: value }, {}, {}), error => error.code === "model_capability_unsupported");
    assert.throws(() => prepareNativeRequest(provider, endpoint, { ...wire.request.body, model: value }, endpoint.path, {}), error => error.code === "model_capability_unsupported");
    assert.throws(() => prepareManifestRequest(provider, endpoint, wire.request.body, { model: value }, {}), error => error.code === "model_capability_unsupported");
  }
});

test("actual Search codec observations retain native count and complete response evidence without token prices", async () => {
  const request = prepareDeepSeekSearch(wire.request.body);
  for (const [body, count] of [[wire.response, 1], [wire.empty, 0], [wire.filtered, 1]]) {
    const result = await readDeepSeekSearch(Response.json(body), request);
    assert.deepEqual(result.body, body); assert.equal(result.billableRequests, count);
    assert.equal(result.nativeResultCount, body.results.length); assert.equal(result.tokens, undefined);
  }
  assert.equal(observeDeepSeekSearch(wire.filtered, request, true).omittedResults, true);
  assert.throws(() => observeDeepSeekSearch(wire.response, request, false));
  await assert.rejects(() => readDeepSeekSearch(Response.json(wire.response, { status: 202 }), request));
  for (const body of [{ ...wire.request.body, count: 11 }, { ...wire.request.body, need_content: true },
    { ...wire.request.body, model: "deepseek-v4-pro" }, { ...wire.request.body, api_key: "synthetic" }]) assert.throws(() => prepareDeepSeekSearch(body));
});

test("unqualified Search request fees deny caller and provider hard budgets while explicit fixed policy remains distinct", () => {
  const { endpoint } = selected();
  for (const count of [1, 5, 10]) {
    const body = { ...wire.request.body, count }, cost = estimateCost(null, body, null, capability, endpoint);
    assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null); assert.equal(cost.requestTariff, undefined);
    for (const [caller, provider] of [[10000, null], [null, 10000], [10000, 10000]]) {
      assert.throws(() => validateBudgetReservation(capability, cost, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
    }
    for (const fixed of [0, 17]) {
      const priced = estimateCost(null, body, fixed, capability, endpoint);
      assert.deepEqual(priced, { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
      assert.doesNotThrow(() => validateBudgetReservation(capability, priced, 10000));
    }
  }
});

test("DeepSeek Search declaration order preserves existing Chat models, pricing and adapters", () => {
  const before = compile(existing).providers[0], manifest = fixture();
  for (const endpoints of [manifest.endpoints, Object.fromEntries(Object.entries(manifest.endpoints).reverse())]) {
    const after = compile({ ...manifest, endpoints }).providers[0];
    for (const endpoint of before.endpoints) assert.deepEqual(after.endpoints.find(value => value.id === endpoint.id), endpoint);
    assert.deepEqual(after.models, before.models); assert.deepEqual(after.adapter, before.adapter);
  }
});

test("DeepSeek Search schema rejects alternate operations, streaming, templates and fabricated tariffs", () => {
  for (const change of [
    m => { m.endpoints.search.path = "/v1/tools/fetch"; }, m => { m.endpoints.search.path = "/tools/search"; },
    m => { m.endpoints.search.requestFormat = "deepseek.search_future"; }, m => { m.endpoints.search.requestFormat = "openai.chat_completions"; },
    m => { m.endpoints.search.responseFormat = "rest_json"; }, m => { m.endpoints.search.method = "GET"; },
    m => { m.endpoints.search.upstreamPath = "/v1/tools/search"; }, m => { m.endpoints.search.nativeProxy = false; },
    m => { m.endpoints.search.query = { count: "5" }; }, m => { m.endpoints.search.pathParams = ["model"]; },
    m => { m.endpoints.search.pathParamStyles = { model: "segment" }; }, m => { m.endpoints.search.modelPassthrough = {}; },
    m => { m.endpoints.search.streaming = "sse"; }, m => { m.endpoints.search.websocket = "openai.realtime"; },
    m => { m.endpoints.search.responsesLifecycle = { retrieve: "search", cancel: "search" }; },
    m => { m.endpoints.search.outputTokenLimit = { field: "max_tokens", minimum: 1, maximum: 100 }; },
    m => { m.endpoints.search.requestPricing = { unit: "request", version: "synthetic", effectiveAt: "2026-11-03",
      source: "https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee", outcome: "xai.responses_violation",
      maximumAdditionalMicros: 50000, receipt: "xai.usage.cost_in_usd_ticks" }; },
    m => { m.capabilities.at(-1).id = "llm.chat"; }, m => { m.capabilities.at(-1).methods = ["POST", "GET"]; },
    m => { m.endpoints.other = structuredClone(m.endpoints.search); },
    m => { m.models.entries[0].capabilities.push(capability); },
    m => { m.models.entries.push({ id: "deepseek/search", upstream: "search", capabilities: [capability] }); },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /deepseek.search|invalid manifest/, String(change)); }
});

test("DeepSeek Search compilation pins original auth and origin without body or credential injection", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { m.baseUrls.default += "/v1"; }, m => { m.baseUrls.other = "https://other.example"; },
    m => { m.routing.baseUrlParam = "base_url"; }, m => { m.routing.serviceParam = "service"; },
    m => { m.auth.schemes[0].header = "x-api-key"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.schemes[0].format = "Token ${secret}"; }, m => { m.auth.schemes.push(structuredClone(m.auth.schemes[0])); },
    m => { m.auth.grantTransports = { api_key: { baseUrl: "https://other.example" } }; },
    m => { m.endpoints.search.auth = "none"; }, m => { m.endpoints.search.requestHeaders = ["authorization"]; },
    m => { m.endpoints.search.headers = { authorization: "synthetic" }; },
    m => { m.adapter.injectHeaders = { Authorization: "synthetic" }; }, m => { m.adapter.injectQuery = { api_key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["authorization"]; },
    m => { m.adapter.requestTransforms = { renameFields: [{ from: "query", to: "messages" }] }; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /deepseek.search|invalid manifest/, String(change)); }
});
