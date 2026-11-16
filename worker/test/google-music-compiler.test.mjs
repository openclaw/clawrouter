import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { googleMusicModels, prepareGoogleMusic } = await import("../google-music.ts");
const { prepareNativeGoogleMusic } = await import("../native-google-music.ts");
const { configuredUpstream } = await import("../providers.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const existing = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
// Exercise the music contract independently of already-declared image routes.
existing.capabilities = existing.capabilities.filter(value => value.endpoint !== "image_generate");
delete existing.endpoints.image_generate;
existing.models.entries = existing.models.entries.filter(value => !value.capabilities.includes("image.generate"));
const compile = manifest => compileProviderSnapshot([manifest]);
const ids = ["lyria-3-clip-preview", "lyria-3-pro-preview"];
const body = () => ({ contents: [{ role: "user", parts: [{ text: "Synthetic music contract fixture" }] }],
  generationConfig: { responseModalities: ["AUDIO", "TEXT"] } });
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities = manifest.capabilities.filter(value => value.endpoint !== "music_generate");
  manifest.models.entries = manifest.models.entries.filter(value => !ids.includes(value.upstream));
  manifest.capabilities.push({ id: "audio.generate", endpoint: "music_generate", methods: ["POST"] });
  manifest.endpoints.music_generate = { method: "POST", path: "/v1beta/models/${model}:generateContent", pathParams: ["model"],
    requestFormat: "google.music_generate", responseFormat: "google.music", timeoutMs: 600000 };
  for (const upstream of ids) {
    // Rebuild the music contract without dropping declared model metadata.
    const declared = existing.models.entries.find(value => value.upstream === upstream);
    manifest.models.entries.push({ ...structuredClone(declared), id: `google/${upstream}`, upstream, capabilities: ["audio.generate"] });
  }
  return manifest;
}
function selection(provider, model, requestBody = body()) {
  return { provider, model, body: requestBody, endpoint: provider.endpoints.find(value => value.id === "music_generate"),
    capability: "audio.generate", method: "POST", pathParams: { model: model.upstream } };
}

test("Google music compiler pairs the actual wrapper and codec with both exact selected native models", () => {
  const manifest = fixture(), before = structuredClone(manifest), snapshot = compile(manifest), provider = snapshot.providers[0];
  assert.deepEqual(manifest, before); assert.deepEqual([...googleMusicModels], ids);
  for (const upstream of ids) {
    const model = provider.models.find(value => value.upstream === upstream), selected = selection(provider, model);
    const endpoint = selected.endpoint, prepared = prepareGoogleMusic(upstream, selected.body), native = prepareNativeGoogleMusic(selected);
    assert.equal(endpoint.method, "POST"); assert.deepEqual(endpoint.methods, ["POST"]); assert.equal(endpoint.native_proxy, true);
    assert.equal(endpoint.request_format, "google.music_generate"); assert.equal(endpoint.response_format, "google.music");
    assert.equal(endpoint.path.replace("${model}", upstream), prepared.path); assert.equal(native.path, prepared.path);
    assert.equal(native.origin, "https://generativelanguage.googleapis.com"); assert.equal(prepared.body, selected.body);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
    assert.equal(configuredUpstream(provider, null, { GOOGLE_API_KEY: "synthetic-selected-key" }).headers.get("x-goog-api-key"), "synthetic-selected-key");
    const other = ids.find(value => value !== upstream);
    assert.throws(() => prepareNativeGoogleMusic({ ...selected, pathParams: { model: other } }), error => error.code === "invalid_native_google_music_route");
  }
});

test("Google music declaration preserves generic and embedding routes independently of YAML endpoint order", () => {
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

test("Google compiled music model costs stay unknown under caller and provider hard budgets with explicit policy charges separate", () => {
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

test("Google music declarations reject format aliases, stream/query bypasses and alternate model selectors", () => {
  const changes = [
    m => { m.endpoints.music_generate.requestFormat = "google.musics"; },
    m => { m.endpoints.music_generate.responseFormat = "google.generate_content"; },
    m => { m.endpoints.music_generate.requestFormat = m.endpoints.music_generate.responseFormat = "google.generate_content"; },
    m => { m.endpoints.music_generate.method = "GET"; }, m => { delete m.endpoints.music_generate.method; },
    m => { m.endpoints.music_generate.path = "/v1beta/models/${model}:streamGenerateContent"; },
    m => { m.endpoints.music_generate.upstreamPath = "/v1beta/models/model"; },
    m => { m.endpoints.music_generate.pathParams = []; }, m => { m.endpoints.music_generate.pathParamStyles = { model: "relative_path" }; },
    m => { m.endpoints.music_generate.query = { alt: "sse" }; }, m => { m.endpoints.music_generate.streaming = "sse"; },
    m => { m.endpoints.music_generate.nativeProxy = false; }, m => { m.endpoints.music_generate.modelPassthrough = {}; },
    m => { m.endpoints.music_generate.outputTokenLimit = { field: "maxOutputTokens", minimum: 1, maximum: 100 }; },
    m => { m.capabilities.find(value => value.endpoint === "music_generate").id = "llm.generate"; },
    m => { m.capabilities.find(value => value.endpoint === "music_generate").methods = ["POST", "GET"]; },
    m => { m.endpoints.other_music = structuredClone(m.endpoints.music_generate); m.capabilities.push({ id: "audio.generate", endpoint: "other_music", methods: ["POST"] }); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google music|invalid manifest/, String(change)); }
});

test("Google music declarations reject noncanonical origins and all credential or transport overrides", () => {
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default += "/v1beta"; }, m => { m.baseUrls.other = "https://other.example"; },
    m => { m.routing.baseUrlParam = "base_url"; }, m => { m.routing.serviceParam = "service"; },
    m => { m.auth.schemes[0].header = "Authorization"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.grantTransports = { api_key: { headers: { "x-goog-api-key": "synthetic" } } }; },
    m => { m.endpoints.music_generate.auth = "none"; }, m => { m.endpoints.music_generate.requestHeaders = ["x-goog-api-key"]; },
    m => { m.endpoints.music_generate.headers = { "x-goog-api-key": "synthetic" }; },
    m => { m.adapter.injectHeaders = { "x-goog-api-key": "synthetic" }; }, m => { m.adapter.injectQuery = { key: "synthetic" }; },
    m => { m.adapter.passthroughHeaders = ["x-goog-api-key"]; },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google music|Google embeddings|invalid manifest/, String(change)); }
});

test("Google music declarations reject newer identities, implicit aliases, Chat capabilities and borrowed prices", () => {
  const changes = [
    m => { m.models.entries.at(-1).upstream = "lyria-4"; }, m => { m.models.entries.at(-1).id = "google/music-alias"; },
    m => { m.models.entries.at(-1).capabilities.push("llm.generate"); },
    m => { m.models.entries.at(-1).pricing = structuredClone(m.models.entries[0].pricing); },
    m => { m.models.entries.at(-1).pricingRef = "unqualified"; },
    m => { m.models.entries.at(-1).endpointPricing = { music_generate: { pricingRef: "unqualified", pricing: null } }; },
    m => { m.models.entries.at(-1).availability = { version: "clawrouter.model-availability.v1", status: "upstream_alias", effectiveAt: "2026-11-03", checkedAt: "2026-11-03", servingModel: "lyria-4", sources: ["https://example.com/synthetic-evidence"] }; },
    m => { m.models.entries = m.models.entries.filter(value => !value.capabilities.includes("audio.generate")); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google music|invalid manifest/, String(change)); }
});

test("Google music declaration does not broaden the actual wrapper to missing MIME, remote references or unqualified native fields", () => {
  const provider = compile(fixture()).providers[0], model = provider.models.find(value => value.upstream === ids[0]);
  for (const mutate of [
    b => { b.contents[0].parts.push({ inlineData: { data: "AA==" } }); },
    b => { b.contents[0].parts.push({ fileData: { fileUri: "https://untrusted.example/image.png" } }); },
    b => { b.generationConfig.candidateCount = 4; },
    b => { b.continuationToken = "synthetic-unowned-token"; },
  ]) {
    const requestBody = body(); mutate(requestBody);
    assert.throws(() => prepareNativeGoogleMusic(selection(provider, model, requestBody)), error => error.code === "invalid_native_google_music_request");
  }
});


test("Google music and image declarations retain separate native formats and reject mixed model capabilities", () => {
  const manifest = fixture();
  manifest.capabilities = manifest.capabilities.filter(value => value.endpoint !== "image_generate");
  manifest.models.entries = manifest.models.entries.filter(value => !value.capabilities.includes("image.generate"));
  manifest.capabilities.push({ id: "image.generate", endpoint: "image_generate", methods: ["POST"] });
  manifest.endpoints.image_generate = { method: "POST", path: "/v1beta/models/${model}:generateContent", pathParams: ["model"],
    requestFormat: "google.image_generate", responseFormat: "google.image" };
  manifest.models.entries.push({ id: "google/gemini-3.1-flash-image", upstream: "gemini-3.1-flash-image", capabilities: ["image.generate"] });
  const provider = compile(manifest).providers[0];
  assert.equal(provider.endpoints.find(value => value.id === "image_generate").request_format, "google.image_generate");
  assert.equal(provider.endpoints.find(value => value.id === "music_generate").request_format, "google.music_generate");
  assert.deepEqual(provider.models.find(value => value.upstream === ids[0]).capabilities, ["audio.generate"]);
  assert.deepEqual(provider.models.find(value => value.upstream === "gemini-3.1-flash-image").capabilities, ["image.generate"]);
  for (const capability of ["llm.generate", "image.generate", "audio.speech"]) {
    const mixed = structuredClone(manifest);
    mixed.models.entries.find(value => value.upstream === ids[0]).capabilities.push(capability);
    assert.throws(() => compile(mixed), /Google music|Google images|invalid manifest/);
  }
});
