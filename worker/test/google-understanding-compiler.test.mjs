import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { googleUnderstandingModel, prepareGoogleUnderstanding } = await import("../google-media-understanding.ts");
const { prepareNativeGoogleMediaUnderstanding } = await import("../native-google-media-understanding.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { configuredUpstream } = await import("../providers.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const { actualModelCost } = await import("../pricing.ts");
const existing = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/media-understanding.json", import.meta.url), "utf8"));
const capabilities = { audio: "audio.transcription", video: "video.understanding" };
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture(modes = ["audio", "video"]) {
  const manifest = structuredClone(existing), model = manifest.models.entries.find(model => model.upstream === wire.model);
  assert.ok(model, "the qualified frozen card is already declared");
  for (const mode of modes) {
    const id = `inline_${mode}`;
    manifest.capabilities.push({ id: capabilities[mode], endpoint: id, methods: ["POST"] });
    manifest.endpoints[id] = { method: "POST", path: "/v1beta/models/${model}:generateContent", pathParams: ["model"], nativeProxy: false,
      requestFormat: `google.${mode}_understanding`, responseFormat: "google.generate_content" };
    model.capabilities.push(capabilities[mode]);
    model.endpointPricing = { ...model.endpointPricing, [id]: { pricingRef: `synthetic-unknown-${mode}`, pricing: null } };
  }
  return manifest;
}
function selection(provider, mode, body = structuredClone(wire[mode])) {
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === `inline_${mode}`);
  return { provider, endpoint, ...prepareManifestRequest(provider, endpoint, body, { model: wire.model }, {}), capability: capabilities[mode], method: "POST" };
}

test("inline understanding declarations compose both exact frozen codec formats without changing native inputs", () => {
  const manifest = fixture(), before = structuredClone(manifest), provider = compile(manifest).providers[0];
  assert.deepEqual(manifest, before); assert.equal(googleUnderstandingModel, "gemini-3-flash-preview");
  for (const mode of ["audio", "video"]) {
    const selected = selection(provider, mode), prepared = prepareGoogleUnderstanding(selected.model.upstream, mode, selected.body);
    assert.equal(selected.endpoint.native_proxy, false); assert.equal(selected.model.pricing, null);
    assert.equal(prepared.path, wire.path); assert.deepEqual(prepared.body, wire[mode]);
    assert.equal(selected.endpoint.response_format, "google.generate_content"); assert.equal(prepared.decodedBytes, 4);
    assert.equal(configuredUpstream(provider, null, { GOOGLE_API_KEY: "synthetic-original" }).headers.get("x-goog-api-key"), "synthetic-original");
    // These published samples prove wire identity only, never playable media.
    assert.throws(() => prepareNativeGoogleMediaUnderstanding(selected), error => error.code === "invalid_native_google_understanding_request");
  }
});

test("compiled audio selection reaches the actual bounded wrapper with complete PCM WAV and native usage", async () => {
  const selected = selection(compile(fixture()).providers[0], "audio");
  // One PCM16 mono sample at 24 kHz; valid silence, not duration/price evidence.
  const wav = Buffer.alloc(46); wav.write("RIFF"); wav.writeUInt32LE(38, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(2, 40);
  selected.body.contents[0].parts[1].inline_data.data = wav.toString("base64");
  const native = prepareNativeGoogleMediaUnderstanding(selected), lease = native.acquire();
  assert.equal(native.origin, "https://generativelanguage.googleapis.com"); assert.equal(native.path, wire.path); assert.equal(native.tariff, undefined);
  try {
    const result = await native.read(Response.json(wire.response), new AbortController().signal);
    assert.deepEqual(await result.response.json(), wire.response); assert.deepEqual(result.usage, { tokens: null, outcome: "success" });
    assert.equal(result.usage.requestCostReceipt, undefined);
  } finally { lease.release(); }
});

test("inline manifest catalog distinguishes each operation without ordering or a new model selector", () => {
  for (const modes of [["audio"], ["video"], ["audio", "video"]]) for (const reverse of [false, true]) {
    const manifest = fixture(modes); if (reverse) manifest.endpoints = Object.fromEntries(Object.entries(manifest.endpoints).reverse());
    const provider = compile(manifest).providers[0], catalog = createRouteCatalog([provider]);
    for (const mode of modes) {
      const offer = catalog.manifestProxy.find(offer => offer.endpoint === `inline_${mode}`);
      assert.equal(offer.route, `/v1/proxy/google-gemini/inline_${mode}`); assert.equal(offer.requestFormat, `google.${mode}_understanding`);
      assert.deepEqual(offer.models.map(model => model.id), ["google/gemini-3-flash-preview"]);
    }
    const generic = provider.endpoints.find(endpoint => endpoint.id === "generate_content");
    const ordinary = prepareManifestRequest(provider, generic, { contents: [{ parts: [{ text: "synthetic" }] }] }, { model: wire.model }, {});
    assert.deepEqual(ordinary.model.pricing, compile(existing).model_index[`google/${wire.model}`].pricing);
    assert.deepEqual(ordinary.model.nativeCapabilities, compile(existing).model_index[`google/${wire.model}`].nativeCapabilities);
  }
});

test("inline endpoint unknown prices and the landed format guard deny hard dollars without borrowing the shared text card", () => {
  const provider = compile(fixture()).providers[0], shared = provider.models.find(model => model.upstream === wire.model);
  for (const mode of ["audio", "video"]) {
    const selected = selection(provider, mode);
    for (const model of [selected.model, shared]) {
      const cost = estimateCost(model, selected.body, null, selected.capability, selected.endpoint);
      assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.pricingGap, "opaque_input_bound");
      for (const [caller, providerLimit] of [[10000, null], [null, 10000]]) {
        assert.throws(() => validateBudgetReservation(selected.capability, cost, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
        for (const fixed of [0, 17]) {
          const known = estimateCost(model, selected.body, fixed, selected.capability, selected.endpoint);
          assert.equal(known.basis, "policy_fixed"); assert.equal(known.reserveMicros, fixed);
          assert.equal(validateBudgetReservation(selected.capability, known, caller, { monthlyBudgetMicros: providerLimit }), true);
        }
      }
      assert.equal(actualModelCost(model.pricing, { input: 44, output: 8, cached: 0, billable: false }, selected.endpoint.request_format), null);
    }
  }
});

test("inline declarations reject native ambiguity, protocol/capability swaps, path expansion and request tariffs", () => {
  const changes = [
    m => { delete m.endpoints.inline_audio.nativeProxy; }, m => { m.endpoints.inline_video.nativeProxy = true; },
    m => { m.endpoints.inline_audio.path = "/v1beta/interactions"; }, m => { m.endpoints.inline_video.pathParams = []; },
    m => { m.endpoints.inline_audio.method = "GET"; }, m => { m.endpoints.inline_video.query = { alt: "sse" }; },
    m => { m.endpoints.inline_audio.streaming = "sse"; }, m => { m.endpoints.inline_audio.upstreamPath = "/v1beta/interactions"; },
    m => { m.endpoints.inline_audio.modelPassthrough = {}; }, m => { m.endpoints.inline_video.pathParamStyles = { model: "relative_path" }; },
    m => { m.endpoints.inline_audio.requestFormat = "google.generate_content"; },
    m => { m.endpoints.inline_video.requestFormat = "google.audio_understanding"; },
    m => { m.endpoints.inline_video.responseFormat = "google.video_understanding"; },
    m => { m.endpoints.inline_audio.outputTokenLimit = { field: "max_tokens", minimum: 1, maximum: 100 }; },
    m => { m.capabilities.find(cap => cap.endpoint === "inline_audio").id = "video.understanding"; },
    m => { m.endpoints.duplicate_inline = structuredClone(m.endpoints.inline_audio); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google inline understanding|invalid manifest/, String(change)); }
});

test("inline declarations reject origin/auth changes, model aliases and shared token-price inheritance", () => {
  const model = manifest => manifest.models.entries.find(model => model.upstream === wire.model);
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://other.example"; }, m => { m.routing.baseUrlParam = "base_url"; },
    m => { m.auth.schemes[0].required = false; }, m => { m.auth.schemes[0].header = "Authorization"; },
    m => { m.endpoints.inline_audio.auth = "none"; }, m => { m.endpoints.inline_audio.requestHeaders = ["x-goog-api-key"]; },
    m => { m.endpoints.inline_audio.headers = { "x-goog-api-key": "synthetic" }; }, m => { m.adapter.injectQuery = { key: "synthetic" }; },
    m => { model(m).upstream = "gemini-3.8-flash"; }, m => { model(m).id = "google/media-alias"; },
    m => { delete model(m).endpointPricing.inline_video; },
    m => { model(m).endpointPricing.inline_audio.pricing = structuredClone(model(m).pricing); },
    m => { m.models.entries[0].capabilities.push("audio.transcription"); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Google inline understanding|Google embeddings|invalid manifest/, String(change)); }
});

test("compiled inline contracts keep raw files, remote input and generated audio outside the actual codec", () => {
  const provider = compile(fixture()).providers[0];
  for (const mode of ["audio", "video"]) for (const mutate of [
    body => { body.contents[0].parts[1] = { file_data: { file_uri: "files/synthetic-unowned" } }; },
    body => { body.contents[0].parts[1].inline_data.data = "https://assets.example/media"; },
    body => { body.tools = [{ google_search: {} }]; }, body => { body.generationConfig = { responseModalities: ["AUDIO"] }; },
  ]) {
    const selected = selection(provider, mode); mutate(selected.body);
    assert.throws(() => prepareGoogleUnderstanding(selected.model.upstream, mode, selected.body));
    assert.throws(() => prepareNativeGoogleMediaUnderstanding(selected), error => error.code === "invalid_native_google_understanding_request");
  }
});
