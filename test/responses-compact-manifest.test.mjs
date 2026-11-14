import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";

const source = parse(readFileSync(new URL("../providers/openai.provider.yaml", import.meta.url), "utf8"));
function compile(mutate = () => {}) {
  const manifest = structuredClone(source); mutate(manifest);
  return compileProviderSnapshot([manifest]);
}
test("compiled compact is a distinct unary registered-model contract", () => {
  const snapshot = compile(), provider = snapshot.providers[0], compact = provider.endpoints.find(endpoint => endpoint.id === "responses_compact");
  assert.equal(compact.path, "/v1/responses/compact"); assert.deepEqual(compact.methods, ["POST"]);
  assert.equal(compact.request_format, "openai.responses_compact"); assert.equal(compact.response_format, "openai.responses_compact");
  assert.ok(!compact.streaming); assert.ok(!compact.websocket); assert.ok(!compact.modelPassthrough); assert.ok(!compact.outputTokenLimit); assert.ok(!compact.responsesLifecycle);
  assert.deepEqual(provider.models.filter(model => model.capabilities.includes("llm.responses.compact")).map(model => model.id), ["openai/gpt-6-astra", "openai/gpt-6.1-sol", "openai/gpt-6.1-terra"]);
  assert.deepEqual(snapshot.capability_index["llm.responses.compact"], [{ provider: "openai", endpoint: "responses_compact", methods: ["POST"] }]);
});
function removePricing(manifest) {
  const model = manifest.models.entries.find(model => model.id === "openai/gpt-6-astra");
  delete model.pricing;
  // Isolate compact pricing from the independent native tier-pricing constraint.
  delete model.nativeCapabilities;
  return model;
}
test("ordinary unpriced models remain supported without compact capability", () => {
  const snapshot = compile(manifest => {
    const model = removePricing(manifest);
    model.capabilities = model.capabilities.filter(capability => capability !== "llm.responses.compact");
    for (const product of manifest.products) for (const offer of product.offers) {
      if (offer.capability === "llm.responses.compact") offer.models = offer.models.filter(id => id !== model.id);
    }
  });
  const model = snapshot.providers[0].models.find(model => model.id === "openai/gpt-6-astra");
  assert.ok(model.capabilities.includes("llm.responses"));
  assert.ok(!model.capabilities.includes("llm.responses.compact"));
  assert.equal(model.pricing, null);
  assert.ok(snapshot.providers[0].offer_definitions.some(offer => offer.model?.id === model.id && offer.capability === "llm.responses"));
});
const mutations = {
  wrong_response: manifest => { manifest.endpoints.responses_compact.responseFormat = "openai.responses"; },
  wrong_method: manifest => { manifest.endpoints.responses_compact.method = "GET"; },
  extra_method: manifest => { manifest.capabilities.find(capability => capability.id === "llm.responses.compact").methods.push("GET"); },
  streaming: manifest => { manifest.endpoints.responses_compact.streaming = "sse"; },
  websocket: manifest => { manifest.endpoints.responses_compact.websocket = "openai.responses"; },
  passthrough: manifest => { manifest.endpoints.responses_compact.modelPassthrough = {}; },
  caller_limit: manifest => { manifest.endpoints.responses_compact.outputTokenLimit = { field: "max_output_tokens", minimum: 1, maximum: 128_000 }; },
  lifecycle: manifest => { manifest.endpoints.responses_compact.responsesLifecycle = { retrieve: "responses_retrieve", cancel: "responses_cancel" }; },
  unpriced_model: removePricing,
  missing_bound: manifest => { delete manifest.models.entries.find(model => model.id === "openai/gpt-6-astra").pricing.defaultMaxOutputTokens; },
  no_registered_model: manifest => { for (const model of manifest.models.entries) model.capabilities = model.capabilities.filter(capability => capability !== "llm.responses.compact"); },
};
for (const [name, mutate] of Object.entries(mutations)) test("compiler refuses unqualified compact " + name, () => {
  const expected = name === "extra_method" ? /^provider openai endpoint responses_compact compact is POST-only$/
    : ["unpriced_model", "no_registered_model"].includes(name) ? /^provider openai endpoint responses_compact compact requires registered token-priced models with authoritative output bounds$/
    : /^provider openai invalid manifest:/;
  assert.throws(() => compile(mutate), { message: expected });
});
