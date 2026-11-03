import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareGoogleGroundedSearch, googleGroundedSearchModel } = await import("../google-grounded-search.ts");
const { prepareNativeGoogleGroundedSearch } = await import("../native-google-grounded-search.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { configuredUpstream } = await import("../providers.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const existing = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/grounded-search.json", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities.push({ id: "search.web", endpoint: "grounded_search", methods: ["POST"] });
  manifest.endpoints.grounded_search = { method: "POST", path: "/v1beta/models/${model}:generateContent", pathParams: ["model"],
    nativeProxy: false, requestFormat: "google.grounded_search", responseFormat: "google.grounded_search" };
  let model = manifest.models.entries.find(model => model.upstream === googleGroundedSearchModel);
  if (!model) {
    // Synthetic existing Chat card exercises endpoint-specific unknown pricing;
    // it is not a model-price declaration or provider activation.
    model = { ...structuredClone(manifest.models.entries[0]), id: `google/${googleGroundedSearchModel}`, upstream: googleGroundedSearchModel };
    delete model.nativeCapabilities; delete model.availability;
    manifest.models.entries.push(model);
  }
  model.capabilities.push("search.web");
  model.endpointPricing = { ...model.endpointPricing, grounded_search: { pricingRef: "synthetic-unknown-grounding", pricing: null } };
  return manifest;
}
function selection(provider, body = structuredClone(wire.request.body)) {
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "grounded_search");
  const prepared = prepareManifestRequest(provider, endpoint, body, { model: googleGroundedSearchModel }, {});
  return { provider, endpoint, ...prepared, capability: "search.web", method: "POST" };
}

test("grounded search compiler binds the actual frozen codec, wrapper and original credential without rewriting Chat pricing", async () => {
  const manifest = fixture(), before = structuredClone(manifest), provider = compile(manifest).providers[0], selected = selection(provider);
  assert.deepEqual(manifest, before); assert.equal(googleGroundedSearchModel, "gemini-3.6-flash");
  assert.equal(selected.model.upstream, googleGroundedSearchModel); assert.equal(selected.model.pricing, null);
  assert.ok(provider.models.find(model => model.upstream === googleGroundedSearchModel).pricing);
  assert.equal(selected.endpoint.native_proxy, false); assert.deepEqual(selected.body, wire.request.body);
  const codec = prepareGoogleGroundedSearch(selected.model.upstream, selected.body), native = prepareNativeGoogleGroundedSearch(selected);
  assert.equal(native.path, codec.path); assert.equal(native.path, wire.request.path);
  assert.equal(native.origin, "https://generativelanguage.googleapis.com"); assert.equal(native.tariff, undefined);
  assert.equal(configuredUpstream(provider, null, { GOOGLE_API_KEY: "synthetic-original-key" }).headers.get("x-goog-api-key"), "synthetic-original-key");
  const lease = native.acquire();
  try {
    const result = await native.read(Response.json(wire.response), new AbortController().signal);
    assert.deepEqual(await result.response.json(), wire.response);
    assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
  } finally { lease.release(); }
});

test("explicit grounded-search manifest offer keeps shared-path intent independent of endpoint ordering", () => {
  for (const reverse of [false, true]) {
    const manifest = fixture(); if (reverse) manifest.endpoints = Object.fromEntries(Object.entries(manifest.endpoints).reverse());
    const provider = compile(manifest).providers[0], offer = createRouteCatalog([provider]).manifestProxy.find(offer => offer.endpoint === "grounded_search");
    assert.equal(offer.route, "/v1/proxy/google-gemini/grounded_search"); assert.equal(offer.requestFormat, "google.grounded_search");
    assert.deepEqual(offer.models.map(model => model.id), ["google/gemini-3.6-flash"]);
    assert.equal(selection(provider).endpoint.native_proxy, false);
    const generic = provider.endpoints.find(endpoint => endpoint.id === "generate_content");
    const ordinary = prepareManifestRequest(provider, generic, { contents: [{ parts: [{ text: "synthetic" }] }] }, { model: googleGroundedSearchModel }, {});
    assert.ok(ordinary.model.pricing);
  }
});

test("compiled unknown grounding price denies both hard-dollar budgets while policy-fixed remains explicit", () => {
  const selected = selection(compile(fixture()).providers[0]);
  const unknown = estimateCost(selected.model, selected.body, null, selected.capability, selected.endpoint);
  for (const [caller, provider] of [[10000, null], [null, 10000]]) {
    assert.throws(() => validateBudgetReservation(selected.capability, unknown, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
    for (const fixed of [0, 17]) {
      const cost = estimateCost(selected.model, selected.body, fixed, selected.capability, selected.endpoint);
      assert.equal(cost.basis, "policy_fixed"); assert.equal(cost.reserveMicros, fixed);
      assert.equal(validateBudgetReservation(selected.capability, cost, caller, { monthlyBudgetMicros: provider }), true);
    }
  }
});

test("grounded search rejects native ambiguity, alternate wire formats, path/query changes and lifecycle bypasses", () => {
  const changes = [
    m => { delete m.endpoints.grounded_search.nativeProxy; }, m => { m.endpoints.grounded_search.nativeProxy = true; },
    m => { m.endpoints.grounded_search.path = "/v1beta/interactions"; }, m => { m.endpoints.grounded_search.pathParams = []; },
    m => { m.endpoints.grounded_search.requestFormat = "google.generate_content"; }, m => { m.endpoints.grounded_search.responseFormat = "google.generate_content"; },
    m => { m.endpoints.grounded_search.requestFormat = m.endpoints.grounded_search.responseFormat = "google.generate_content"; },
    m => { m.endpoints.grounded_search.method = "GET"; }, m => { m.endpoints.grounded_search.query = { alt: "sse" }; },
    m => { m.endpoints.grounded_search.streaming = "sse"; }, m => { m.endpoints.grounded_search.upstreamPath = "/v1beta/interactions"; },
    m => { m.endpoints.grounded_search.modelPassthrough = {}; }, m => { m.endpoints.grounded_search.pathParamStyles = { model: "relative_path" }; },
    m => { m.capabilities.at(-1).methods.push("GET"); }, m => { m.capabilities.at(-1).id = "llm.generate"; },
    m => { m.endpoints.duplicate_search = structuredClone(m.endpoints.grounded_search); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google grounded search|invalid manifest/, String(change)); }
});

test("grounded search rejects credential/origin overrides, aliases, unsupported models and invented tariffs", () => {
  const searchModel = m => m.models.entries.find(model => model.capabilities.includes("search.web"));
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default += "/v1beta"; }, m => { m.baseUrls.other = "https://other.example"; },
    m => { m.auth.schemes[0].required = false; }, m => { m.auth.schemes[0].header = "Authorization"; },
    m => { m.endpoints.grounded_search.auth = "none"; }, m => { m.endpoints.grounded_search.requestHeaders = ["x-goog-api-key"]; },
    m => { m.endpoints.grounded_search.headers = { "x-goog-api-key": "synthetic" }; },
    m => { m.adapter.injectQuery = { key: "synthetic" }; }, m => { m.adapter.passthroughHeaders = ["x-goog-api-key"]; },
    m => { searchModel(m).upstream = "gemini-3.8-flash"; }, m => { searchModel(m).id = "google/alias"; },
    m => { delete searchModel(m).endpointPricing; },
    m => { searchModel(m).endpointPricing.grounded_search.pricing = structuredClone(m.models.entries[0].pricing); },
    m => { searchModel(m).capabilities = searchModel(m).capabilities.filter(id => id !== "search.web"); },
    m => { m.models.entries[0].capabilities.push("search.web"); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google grounded search|Google embeddings|invalid manifest/, String(change)); }
});

test("compiled grounded-search selection retains actual tool and stateless-input validation", () => {
  const provider = compile(fixture()).providers[0];
  for (const change of [b => { b.tools = [{ functionDeclarations: [{ name: "google_search" }] }]; },
    b => { b.tools.push({ code_execution: {} }); }, b => { b.cachedContent = "synthetic-unowned"; }, b => { b.stream = true; }]) {
    const body = structuredClone(wire.request.body); change(body);
    assert.throws(() => prepareNativeGoogleGroundedSearch(selection(provider, body)), error => error.code === "invalid_native_google_search_request");
  }
});
