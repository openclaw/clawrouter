import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { estimateModelCost, actualModelCost } = await import("../pricing.ts");
const { providerModel } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");

const manifest = parse(readFileSync(new URL("../../providers/mistral.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([manifest]), provider = snapshot.providers[0];
const endpoint = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");
const ids = ["codestral-latest", "devstral-medium-latest", "mistral-large-latest", "mistral-medium-2508", "mistral-small-latest"];

test("the frozen Mistral identities remain exact Chat models without replacing defaults or granting embeddings", () => {
  assert.equal(provider.models[0].id, "mistral/mistral-medium-3-5");
  for (const upstream of ids) {
    const id = `mistral/${upstream}`, model = snapshot.model_index[id];
    assert.equal(model.upstream, upstream);
    assert.deepEqual(model.capabilities, ["llm.chat"]);
    const facts = model.nativeCapabilities.endpoints.chat_completions;
    assert.equal(facts.checkedAt, "2026-11-03");
    assert.equal(facts.maxOutputTokens, undefined, "a frozen client default is not a provider maximum");
    assert.deepEqual(facts.input, ["codestral-latest", "devstral-medium-latest"].includes(upstream) ? ["text"] : ["text", "image"]);
    const body = { model: id, messages: [{ role: "user", content: "fixture input" }], stream: true, max_tokens: 16 };
    assert.deepEqual(prepareManifestRequest(provider, endpoint, body, {}, {}).body, { ...body, model: upstream });
    assert.throws(() => prepareManifestRequest(provider, provider.endpoints.find(e => e.id === "embeddings"), { model: id, input: "fixture" }, {}, {}), /does not support/);
  }
  assert.deepEqual(snapshot.model_index["mistral/mistral-small-latest"].supportedReasoningEfforts, ["none", "high"]);
  assert.equal(snapshot.model_index["mistral/codestral-latest"].supportedReasoningEfforts, undefined);
});

test("current Codestral and Small prices reserve a full output ceiling and bill cached tokens explicitly", () => {
  for (const [name, bound, input, cached, output] of [
    ["codestral-latest", 131072, 300000, 30000, 900000],
    ["mistral-small-latest", 262144, 150000, 15000, 600000],
  ]) {
    const pricing = snapshot.model_index[`mistral/${name}`].pricing;
    assert.deepEqual([pricing.inputMicrosPerMillion, pricing.cachedInputMicrosPerMillion, pricing.outputMicrosPerMillion], [input, cached, output]);
    assert.equal(pricing.defaultMaxOutputTokens, bound);
    assert.equal(estimateModelCost(pricing, { messages: [] }, endpoint).outputTokens, bound);
    assert.equal(actualModelCost(pricing, { input: 1000, output: 100, cached: 500 }, "openai.chat_completions"), Math.ceil((500 * input + 500 * cached + 100 * output) / 1000000));
  }
  const small = snapshot.model_index["mistral/mistral-small-latest"].pricing;
  const image = estimateModelCost(small, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }] }], max_tokens: 16 }, endpoint);
  assert.equal(image.inputTokens, 262144);
  assert.equal(image.outputTokens, 16);
  assert.equal(estimateModelCost(small, { messages: [], service_tier: "priority" }, endpoint).pricingAvailable, false);
});

test("deprecated and dynamic identities cannot acquire a current replacement tariff", () => {
  for (const name of ["devstral-medium-latest", "mistral-large-latest", "mistral-medium-2508"]) {
    assert.equal(snapshot.model_index[`mistral/${name}`].pricing, null);
    assert.equal(snapshot.model_index[`mistral/${name}`].pricing_ref, null);
  }
  const unknown = providerModel(provider, "mistral-future", endpoint, true);
  assert.equal(unknown.pricing, null);
  assert.equal(unknown.nativeCapabilities, undefined);
});
