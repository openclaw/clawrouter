import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { googleImageModels, prepareGoogleImage } = await import("../google-images.ts");
const { prepareNativeGoogleImage } = await import("../native-google-images.ts");
const { configuredUpstream } = await import("../providers.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const existing = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
existing.capabilities = existing.capabilities.filter(value => value.endpoint !== "image_generate");
delete existing.endpoints.image_generate;
existing.models.entries = existing.models.entries.filter(value => !value.capabilities.includes("image.generate"));
const compile = manifest => compileProviderSnapshot([manifest]);
const ids = ["gemini-3.1-flash-image", "gemini-3-pro-image"];
const body = () => ({ contents: [{ role: "user", parts: [{ text: "Synthetic image contract fixture" }] }],
  generationConfig: { responseModalities: ["TEXT", "IMAGE"] } });
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities.push({ id: "image.generate", endpoint: "image_generate", methods: ["POST"] });
  manifest.endpoints.image_generate = { method: "POST", path: "/v1beta/models/${model}:generateContent", pathParams: ["model"],
    requestFormat: "google.image_generate", responseFormat: "google.image", timeoutMs: 600000 };
  for (const upstream of ids) manifest.models.entries.push({ id: `google/${upstream}`, upstream, capabilities: ["image.generate"] });
  return manifest;
}
function selection(provider, model, requestBody = body()) {
  return { provider, model, body: requestBody, endpoint: provider.endpoints.find(value => value.id === "image_generate"),
    capability: "image.generate", method: "POST", pathParams: { model: model.upstream } };
}

test("Google image compiler pairs the actual wrapper and codec with both exact selected native models", () => {
  const manifest = fixture(), before = structuredClone(manifest), snapshot = compile(manifest), provider = snapshot.providers[0];
  assert.deepEqual(manifest, before); assert.deepEqual([...googleImageModels], ids);
  for (const upstream of ids) {
    const model = provider.models.find(value => value.upstream === upstream), selected = selection(provider, model);
    const endpoint = selected.endpoint, prepared = prepareGoogleImage(upstream, selected.body), native = prepareNativeGoogleImage(selected);
    assert.equal(endpoint.method, "POST"); assert.deepEqual(endpoint.methods, ["POST"]); assert.equal(endpoint.native_proxy, true);
    assert.equal(endpoint.request_format, "google.image_generate"); assert.equal(endpoint.response_format, "google.image");
    assert.equal(endpoint.path.replace("${model}", upstream), prepared.path); assert.equal(native.path, prepared.path);
    assert.equal(native.origin, "https://generativelanguage.googleapis.com"); assert.equal(prepared.body, selected.body);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
    assert.equal(configuredUpstream(provider, null, { GOOGLE_API_KEY: "synthetic-selected-key" }).headers.get("x-goog-api-key"), "synthetic-selected-key");
    const other = ids.find(value => value !== upstream);
    assert.throws(() => prepareNativeGoogleImage({ ...selected, pathParams: { model: other } }), error => error.code === "invalid_native_google_image_route");
  }
});

test("Google image declaration preserves generic and embedding routes independently of YAML endpoint order", () => {
  const original = compile(existing), manifest = fixture();
  for (const endpoints of [manifest.endpoints, Object.fromEntries(Object.entries(manifest.endpoints).reverse())]) {
    const snapshot = compile({ ...manifest, endpoints });
    for (const endpoint of original.providers[0].endpoints) {
      assert.deepEqual(snapshot.providers[0].endpoints.find(value => value.id === endpoint.id), endpoint);
    }
    for (const [id, model] of Object.entries(original.model_index)) assert.deepEqual(snapshot.model_index[id], model);
    assert.deepEqual(snapshot.capability_index["llm.generate"], original.capability_index["llm.generate"]);
    assert.deepEqual(snapshot.capability_index["llm.stream"], original.capability_index["llm.stream"]);
  }
  // Matching these overlapping native paths is runtime-owned, not a YAML-order contract.
});

test("Google compiled image model costs stay unknown under caller and provider hard budgets with explicit policy charges separate", () => {
  const provider = compile(fixture()).providers[0];
  for (const upstream of ids) {
    const model = provider.models.find(value => value.upstream === upstream), selected = selection(provider, model);
    const cost = estimateCost(model, selected.body, null, selected.capability, selected.endpoint);
    assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.pricingGap, "opaque_input_bound");
    assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
    for (const [caller, providerLimit] of [[10000, null], [null, 10000], [10000, 10000]]) {
      assert.throws(() => validateBudgetReservation(selected.capability, cost, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
    }
    for (const fixed of [0, 17]) {
      const fixedCost = estimateCost(model, selected.body, fixed, selected.capability, selected.endpoint);
      assert.deepEqual(fixedCost, { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
    }
  }
});

test("Google image declarations reject format aliases, stream/query bypasses and alternate model selectors", () => {
  const changes = [
    m => { m.endpoints.image_generate.requestFormat = "google.images"; },
    m => { m.endpoints.image_generate.responseFormat = "google.generate_content"; },
    m => { m.endpoints.image_generate.requestFormat = m.endpoints.image_generate.responseFormat = "google.generate_content"; },
    m => { m.endpoints.image_generate.method = "GET"; }, m => { delete m.endpoints.image_generate.method; },
    m => { m.endpoints.image_generate.path = "/v1beta/models/${model}:streamGenerateContent"; },
    m => { m.endpoints.image_generate.upstreamPath = "/v1beta/models/model"; },
    m => { m.endpoints.image_generate.pathParams = []; }, m => { m.endpoints.image_generate.pathParamStyles = { model: "relative_path" }; },
    m => { m.endpoints.image_generate.query = { alt: "sse" }; }, m => { m.endpoints.image_generate.streaming = "sse"; },
    m => { m.endpoints.image_generate.nativeProxy = false; }, m => { m.endpoints.image_generate.modelPassthrough = {}; },
    m => { m.endpoints.image_generate.outputTokenLimit = { field: "maxOutputTokens", minimum: 1, maximum: 100 }; },
    m => { m.capabilities.find(value => value.endpoint === "image_generate").id = "llm.generate"; },
    m => { m.capabilities.find(value => value.endpoint === "image_generate").methods = ["POST", "GET"]; },
    m => { m.endpoints.other_image = structuredClone(m.endpoints.image_generate); m.capabilities.push({ id: "image.generate", endpoint: "other_image", methods: ["POST"] }); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google images|invalid manifest/, String(change)); }
});

test("Google image declarations reject noncanonical origins and all credential or transport overrides", () => {
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default += "/v1beta"; }, m => { m.baseUrls.other = "https://other.example"; },
    m => { m.routing.baseUrlParam = "base_url"; }, m => { m.routing.serviceParam = "service"; },
    m => { m.auth.schemes[0].header = "Authorization"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.grantTransports = { api_key: { headers: { "x-goog-api-key": "synthetic" } } }; },
    m => { m.endpoints.image_generate.auth = "none"; }, m => { m.endpoints.image_generate.requestHeaders = ["x-goog-api-key"]; },
    m => { m.endpoints.image_generate.headers = { "x-goog-api-key": "synthetic" }; },
    m => { m.adapter.injectHeaders = { "x-goog-api-key": "synthetic" }; }, m => { m.adapter.injectQuery = { key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["x-goog-api-key"]; },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google images|Google embeddings|invalid manifest/, String(change)); }
});

test("Google image declarations reject preview identities, implicit aliases, Chat capabilities and borrowed prices", () => {
  const changes = [
    m => { m.models.entries.at(-1).upstream += "-preview"; }, m => { m.models.entries.at(-1).id = "google/image-alias"; },
    m => { m.models.entries.at(-1).capabilities.push("llm.generate"); },
    m => { m.models.entries.at(-1).pricing = structuredClone(m.models.entries[0].pricing); },
    m => { m.models.entries.at(-1).pricingRef = "unqualified"; },
    m => { m.models.entries.at(-1).endpointPricing = { image_generate: { pricingRef: "unqualified", pricing: null } }; },
    m => { m.models.entries.at(-1).availability = { version: "clawrouter.model-availability.v1", status: "upstream_alias", effectiveAt: "2026-11-03", checkedAt: "2026-11-03", servingModel: "gemini-nano-banana-2.1", sources: ["https://example.com/synthetic-evidence"] }; },
    m => { m.models.entries = m.models.entries.filter(value => !value.capabilities.includes("image.generate")); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google images|invalid manifest/, String(change)); }
});

test("Google image declaration does not broaden the actual wrapper to missing MIME, remote references or unknown native fields", () => {
  const provider = compile(fixture()).providers[0], model = provider.models.find(value => value.upstream === ids[0]);
  for (const mutate of [
    b => { b.contents[0].parts.push({ inlineData: { data: "AA==" } }); },
    b => { b.contents[0].parts.push({ fileData: { fileUri: "https://untrusted.example/image.png" } }); },
    b => { b.generationConfig.candidateCount = 4; },
    b => { b.continuationToken = "synthetic-unowned-token"; },
  ]) {
    const requestBody = body(); mutate(requestBody);
    assert.throws(() => prepareNativeGoogleImage(selection(provider, model, requestBody)), error => error.code === "invalid_native_google_image_request");
  }
});
