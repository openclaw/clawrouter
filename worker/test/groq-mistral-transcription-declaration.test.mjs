import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareGroqMistralAudio, readGroqMistralAudio } = await import("../groq-mistral-audio.ts");
const { prepareManifestRequest, prepareNativeRequest } = await import("../proxy-selection.ts");
const { configuredUpstream, modelSupportsEndpoint } = await import("../providers.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const contracts = {
  groq: { model: "whisper-large-v3-turbo", base: "https://api.groq.com/openai", format: "groq.transcription" },
  mistral: { model: "voxtral-mini-latest", base: "https://api.mistral.ai", format: "mistral.transcription" },
};
const sources = Object.fromEntries(Object.keys(contracts).map(id => [id,
  parse(readFileSync(new URL(`../../providers/${id}.provider.yaml`, import.meta.url), "utf8"))]));
const wires = Object.fromEntries(Object.keys(contracts).map(id => [id,
  JSON.parse(readFileSync(new URL(`../../providers/_fixtures/${id}/transcription.json`, import.meta.url), "utf8"))]));
const compile = source => compileProviderSnapshot([source]);
function selected(id) {
  const provider = compile(sources[id]).providers[0], endpoint = provider.endpoints.find(value => value.id === "transcription");
  return { provider, endpoint, model: provider.models.find(value => value.upstream === contracts[id].model) };
}
function upload(id, fields) {
  const file = wires[id].file;
  return { fields, file: new File([Buffer.from(file.base64, "base64")], file.name, { type: file.type }) };
}

for (const [id, contract] of Object.entries(contracts)) {
  test(`${id} declaration preserves existing cards, prices, auth and endpoints while adding one unpriced audio card`, () => {
    const source = sources[id], before = structuredClone(source);
    delete before.endpoints.transcription;
    before.capabilities = before.capabilities.filter(value => value.endpoint !== "transcription");
    before.models.entries = before.models.entries.filter(value => value.upstream !== contract.model);
    const result = compile(source), baseline = compile(before), provider = result.providers[0], original = baseline.providers[0];
    for (const key of ["auth", "adapter", "routing", "base_urls", "billing", "config_keys", "optional_config_keys"])
      assert.deepEqual(provider[key], original[key]);
    assert.deepEqual(provider.models.filter(value => value.upstream !== contract.model), original.models);
    assert.deepEqual(provider.endpoints.filter(value => value.id !== "transcription"), original.endpoints);
    assert.deepEqual(provider.capabilities.filter(value => value.endpoint !== "transcription"), original.capabilities);
    for (const [modelId, model] of Object.entries(baseline.model_index)) assert.deepEqual(result.model_index[modelId], model);
    const { endpoint, model } = selected(id);
    assert.equal(endpoint.path, "/v1/audio/transcriptions"); assert.equal(endpoint.method, "POST");
    assert.deepEqual(endpoint.methods, ["POST"]); assert.equal(endpoint.native_proxy, true); assert.equal(endpoint.streaming, null);
    assert.equal(endpoint.request_format, contract.format); assert.equal(endpoint.response_format, contract.format);
    assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.path_params, []);
    assert.equal(endpoint.upstreamPath, undefined); assert.equal(endpoint.modelPassthrough, undefined);
    assert.equal(endpoint.requestPricing, undefined); assert.deepEqual(endpoint.headers, { Accept: "application/json" });
    assert.deepEqual(provider.models.filter(value => value.capabilities.includes("audio.transcription")), [model]);
    assert.equal(model.id, `${id}/${contract.model}`); assert.deepEqual(model.capabilities, ["audio.transcription"]);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null); assert.equal(model.endpointPricing, undefined);
    const facts = model.nativeCapabilities.endpoints.transcription;
    assert.deepEqual(facts.input, ["audio"]); assert.deepEqual(Object.keys(facts).sort(), ["checkedAt", "input", "sources"]);
  });

  test(`${id} actual declaration composes both parsed-field selectors with the landed byte-preserving multipart codec`, async () => {
    const { provider, endpoint, model } = selected(id), wire = wires[id];
    const auth = configuredUpstream(provider, null, { [`${id.toUpperCase()}_API_KEY`]: "synthetic-original-key" });
    assert.equal(auth.baseUrl, contract.base); assert.equal(auth.headers.get("authorization"), "Bearer synthetic-original-key");
    for (const native of [false, true]) {
      // Parsed fields only; HTTP intake and owner admission have separate runtime fixtures.
      const fields = { ...wire.fields, model: native ? model.upstream : model.id }, original = { ...fields };
      const selection = native ? prepareNativeRequest(provider, endpoint, fields, endpoint.path, {})
        : prepareManifestRequest(provider, endpoint, fields, {}, {});
      assert.deepEqual(fields, original); assert.equal(selection.model.id, model.id);
      const prepared = prepareGroqMistralAudio(id, upload(id, selection.body));
      assert.equal(prepared.model, contract.model);
      assert.equal(auth.baseUrl + endpoint.path, new URL(prepared.path, contract.base).href);
      assert.deepEqual([...prepared.body.keys()], [...Object.keys(wire.fields), "file"]);
      const file = prepared.body.get("file"); assert.equal(file.name, wire.file.name); assert.equal(file.type, wire.file.type);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(wire.file.base64, "base64"));
      assert.equal(prepared.headers.has("authorization"), false); assert.equal(prepared.headers.has("content-type"), false);
    }
  });

  test(`${id} declared model remains transcription-only independent of endpoint ordering`, () => {
    for (const source of [sources[id], { ...sources[id], endpoints: Object.fromEntries(Object.entries(sources[id].endpoints).reverse()) }]) {
      const provider = compile(source).providers[0], model = provider.models.find(value => value.upstream === contract.model);
      const offer = createRouteCatalog([provider]).manifestProxy.find(value => value.endpoint === "transcription");
      assert.equal(offer.requestFormat, contract.format); assert.deepEqual(offer.models.map(value => value.id), [model.id]);
      for (const endpoint of provider.endpoints) {
        assert.equal(modelSupportsEndpoint(provider, model, endpoint), endpoint.id === "transcription");
        if (endpoint.id !== "transcription") assert.throws(() => prepareManifestRequest(provider, endpoint, { model: model.id }, {}, {}),
          error => error.code === "model_capability_unsupported");
      }
    }
  });

  test(`${id} declared unpriced upload denies either hard-dollar budget and keeps explicit policy-fixed accounting separate`, () => {
    const { model, endpoint } = selected(id), capability = "audio.transcription";
    const cost = estimateCost(model, wires[id].fields, null, capability, endpoint);
    assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.pricingGap, "opaque_input_bound");
    assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
    for (const [caller, provider] of [[10000, null], [null, 10000], [10000, 10000]]) {
      assert.throws(() => validateBudgetReservation(capability, cost, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
      const fixed = estimateCost(model, wires[id].fields, 17, capability, endpoint);
      assert.deepEqual(fixed, { reserveMicros: 17, basis: "policy_fixed", inputTokens: null, outputTokens: null });
      assert.doesNotThrow(() => validateBudgetReservation(capability, fixed, caller, { monthlyBudgetMicros: provider }));
    }
  });

  test(`${id} complete native observations do not rewrite the declared selector, price or prompt contract`, async () => {
    const { model } = selected(id), wire = wires[id];
    const result = await readGroqMistralAudio(Response.json(wire.response), id, new AbortController().signal);
    assert.deepEqual(result.body, wire.response); assert.equal(result.requestedModel, model.upstream);
    assert.equal(result.observedModel, id === "mistral" ? "voxtral-mini-2602" : null);
    assert.equal(result.observedAudioSeconds, id === "mistral" ? 2 : null);
    assert.equal(result.costMicros, undefined); assert.equal(result.tokens, undefined);
    assert.equal(model.upstream, contract.model); assert.equal(model.pricing, null);
    const fields = { ...wire.fields, prompt: "Synthetic context" };
    if (id === "mistral") assert.throws(() => prepareGroqMistralAudio(id, upload(id, fields)), /mistral_prompt_unqualified/);
    else assert.equal(prepareGroqMistralAudio(id, upload(id, fields)).body.get("prompt"), fields.prompt);
  });
}
