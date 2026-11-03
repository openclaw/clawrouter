import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { bedrockEmbeddingModels, isBedrockEmbeddingModel, prepareBedrockEmbedding } = await import("../provider-bedrock-embeddings.ts");
const { prepareNativeBedrockEmbedding } = await import("../native-bedrock-embeddings.ts");
const { prepareManifestRequest, prepareNativeRequest, nativeMatch, nativeModelEndpoint, validateSelectedInput } = await import("../proxy-selection.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const existing = parse(readFileSync(new URL("../../providers/aws-bedrock.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/amazon-bedrock/embeddings.json", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]);
const origin = "https://bedrock-runtime.us-east-1.amazonaws.com";
function fixture() {
  const manifest = structuredClone(existing);
  manifest.capabilities.push({ id: "llm.embeddings", endpoint: "embed_text", methods: ["POST"] });
  manifest.endpoints.embed_text = { method: "POST", path: "/model/${model}/invoke", pathParams: ["model"], pathParamStyles: { model: "opaque_segment" },
    headers: { "content-type": "application/json", accept: "application/json" }, requestFormat: "aws_bedrock.invoke", responseFormat: "aws_bedrock.invoke" };
  manifest.models.entries.push(...wire.cases.map(item => ({ id: `bedrock/${item.model}`, upstream: item.model, capabilities: ["llm.embeddings"] })));
  return manifest;
}
function select(provider, item, native = false) {
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "embed_text");
  const prepared = native ? prepareNativeRequest(provider, endpoint, item.body, `/model/${encodeURIComponent(item.model)}/invoke`, {})
    : prepareManifestRequest(provider, endpoint, item.body, { model: `bedrock/${item.model}` }, {});
  return { provider, endpoint, ...prepared, method: "POST", capability: "llm.embeddings" };
}

test("Bedrock compiler preserves all ten actual family contracts and native response wrapper observations", async () => {
  const provider = compile(fixture()).providers[0];
  assert.deepEqual(wire.cases.map(item => item.model.replace(/^us\./, "")).sort(), [...bedrockEmbeddingModels].sort());
  for (const item of wire.cases) for (const native of [false, true]) {
    assert.equal(isBedrockEmbeddingModel(item.model), true);
    const selection = select(provider, item, native), before = structuredClone(item.body);
    assert.equal(selection.model.id, `bedrock/${item.model}`); assert.equal(selection.model.upstream, item.model);
    assert.equal(selection.model.pricing, null); assert.equal(selection.model.pricing_ref, null);
    assert.deepEqual(selection.pathParams, { model: item.model }); assert.deepEqual(selection.body, before);
    const codec = prepareBedrockEmbedding(selection.model.upstream, selection.body);
    // Common dispatch supplies this trusted origin after original credential selection and signing.
    const prepared = prepareNativeBedrockEmbedding(selection, { origin });
    assert.equal(prepared.path, codec.path); assert.equal(prepared.origin, origin);
    const lease = prepared.acquire();
    try {
      const result = await prepared.read(Response.json(item.response), new AbortController().signal);
      assert.deepEqual(await result.response.json(), item.response); assert.equal(result.usage.requestCostReceipt, undefined);
      if (item.inputTokens === null) assert.equal(result.usage.tokens, null);
      else { assert.equal(result.usage.tokens.input, item.inputTokens); assert.equal(result.usage.tokens.output, null); assert.equal(result.usage.tokens.total, null); }
    } finally { lease.release(); }
    assert.deepEqual(item.body, before);
  }
});

test("compiled native model capability resolves the shared Invoke path without YAML ordering or generic-model exposure", () => {
  for (const reverse of [false, true]) {
    const manifest = fixture(); if (reverse) manifest.endpoints = Object.fromEntries(Object.entries(manifest.endpoints).reverse());
    const provider = compile(manifest).providers[0], catalog = createRouteCatalog([provider]);
    const offer = catalog.manifestProxy.find(offer => offer.endpoint === "embed_text");
    assert.equal(offer.requestFormat, "aws_bedrock.invoke"); assert.equal(offer.responseFormat, "aws_bedrock.invoke");
    assert.deepEqual(offer.models.map(model => model.id), wire.cases.map(item => `bedrock/${item.model}`));
    for (const item of wire.cases) {
      const path = `/model/${encodeURIComponent(item.model)}/invoke`, matching = provider.endpoints.filter(endpoint => nativeMatch(endpoint, path));
      assert.equal(nativeModelEndpoint(provider, matching, path, "POST").id, "embed_text");
    }
    assert.equal(catalog.manifestProxy.find(offer => offer.endpoint === "invoke_model").models.some(model => model.capabilities.includes("llm.embeddings")), false);
    assert.deepEqual(catalog.openaiCompatible, []);
  }
});

test("Bedrock compilation preserves existing Invoke and eventstream declarations while unregistered embedding passthrough remains denied", () => {
  const before = compile(existing), after = compile(fixture()), provider = after.providers[0];
  for (const endpoint of before.providers[0].endpoints) assert.deepEqual(provider.endpoints.find(value => value.id === endpoint.id), endpoint);
  for (const [id, model] of Object.entries(before.model_index)) assert.deepEqual(after.model_index[id], model);
  const generic = provider.endpoints.find(endpoint => endpoint.id === "invoke_model");
  for (const model of [wire.cases[0].model, "us.amazon.titan-embed-text-v2:0:2:8k"]) {
    const selection = { provider, endpoint: generic, model: { id: `bedrock/${model}`, upstream: model, capabilities: ["llm.invoke"] },
      method: "POST", capability: "llm.invoke", pathParams: { model }, body: wire.cases[0].body };
    assert.throws(() => validateSelectedInput(selection), error => error.code === "native_embedding_route_required");
  }
});

test("unpriced compiled embeddings cannot turn byte, batch, dimension or observed Titan counts into hard-dollar authority", () => {
  const provider = compile(fixture()).providers[0];
  for (const item of wire.cases) {
    const selection = select(provider, item), { model, endpoint, body, capability } = selection;
    const cost = estimateCost(model, body, null, capability, endpoint);
    assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
    for (const [caller, providerLimit] of [[10000, null], [null, 10000], [10000, 10000]]) {
      assert.throws(() => validateBudgetReservation(capability, cost, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
      for (const fixed of [0, 17]) {
        const explicit = estimateCost(model, body, fixed, capability, endpoint);
        assert.deepEqual(explicit, { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
        assert.doesNotThrow(() => validateBudgetReservation(capability, explicit, caller, { monthlyBudgetMicros: providerLimit }));
      }
    }
  }
});

test("finite registration rejects new profile grammars, ARNs, embedding aliases and fabricated pricing", () => {
  for (const change of [
    m => { m.models.entries.at(-1).upstream = "us.amazon.titan-embed-text-v2:0:2:8k"; },
    m => { m.models.entries.at(-1).upstream = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/synthetic"; },
    m => { m.models.entries.at(-1).upstream = "amazon.titan-embed-text-v9"; },
    m => { m.models.entries.at(-1).id = "bedrock/synthetic-alias"; },
    m => { m.models.entries.at(-1).capabilities.push("llm.invoke"); },
    m => { m.models.entries = m.models.entries.filter(model => !model.capabilities.includes("llm.embeddings")); },
    m => { m.models.entries.at(-1).pricingRef = "synthetic-token-card"; },
    m => { m.models.entries.at(-1).endpointPricing = { embed_text: { pricingRef: "synthetic", pricing: null } }; },
    m => { m.models.entries.at(-1).nativeCapabilities = { version: "clawrouter.native-capabilities.v1", endpoints: { embed_text: {
      sources: ["https://docs.aws.amazon.com/bedrock/latest/userguide/embeddings.html"], checkedAt: "2026-11-03", input: ["text"], contextWindow: 2097152,
    } } }; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Bedrock embeddings|invalid manifest/, String(change)); }
});

test("native embedding declarations reject alternate signing transports, paths, transforms and unqualified headers", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { m.baseUrls.default = "https://bedrock-runtime.us-east-1.amazonaws.com"; },
    m => { m.auth.schemes[0].service = "sagemaker"; }, m => { m.auth.schemes[0].regionParam = "caller_region"; },
    m => { m.auth.grantTransports = { api_key: { baseUrl: "https://other.example" } }; },
    m => { m.routing.baseUrlParam = "base_url"; }, m => { m.adapter.request = "openai"; },
    m => { m.adapter.injectHeaders = { "x-amz-security-token": "synthetic" }; },
    m => { m.adapter.requestTransforms = { renameFields: [{ from: "input", to: "inputText" }] }; },
    m => { m.endpoints.embed_text.pathParamStyles.model = "segment"; }, m => { m.endpoints.embed_text.pathParams = ["region", "model"]; },
    m => { m.endpoints.embed_text.upstreamPath = "/model/${model}/invoke"; }, m => { m.endpoints.embed_text.method = "GET"; },
    m => { m.endpoints.embed_text.requestFormat = "openai.embeddings"; }, m => { m.endpoints.embed_text.responseFormat = "aws_bedrock.eventstream"; },
    m => { m.endpoints.embed_text.query = { trace: "ENABLED" }; }, m => { m.endpoints.embed_text.requestHeaders = ["x-amzn-bedrock-service-tier"]; },
    m => { m.endpoints.embed_text.headers.accept = "application/vnd.amazon.eventstream"; },
    m => { m.endpoints.embed_text.modelPassthrough = {}; }, m => { m.endpoints.embed_text.streaming = "aws_eventstream"; },
    m => { m.capabilities.at(-1).methods = ["POST", "GET"]; },
    m => { m.capabilities.push({ id: "llm.invoke", endpoint: "embed_text", methods: ["POST"] }); },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /Bedrock embeddings|invalid manifest/, String(change)); }
});

test("compiled Cohere v4 and Marengo 2.7 selections consume the corrected native codecs without a cross-family rewrite", () => {
  const provider = compile(fixture()).providers[0], marengo = wire.cases.find(item => item.model.includes("marengo-embed-2-7"));
  const cohere = wire.cases.find(item => item.model === "cohere.embed-v4:0");
  assert.doesNotThrow(() => prepareNativeBedrockEmbedding(select(provider, marengo), { origin }));
  assert.throws(() => prepareNativeBedrockEmbedding(select(provider, { ...marengo, body: { inputType: "text", text: { inputText: "synthetic" } } }), { origin }));
  assert.doesNotThrow(() => prepareNativeBedrockEmbedding(select(provider, cohere), { origin }));
  for (const body of [{ ...cohere.body, output_dimension: 384 }, { ...cohere.body, truncate: "END" }])
    assert.throws(() => prepareNativeBedrockEmbedding(select(provider, { ...cohere, body }), { origin }));
});
