import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { anthropicPricing } = await import("../anthropic-pricing.ts");
const { actualModelCost } = await import("../pricing.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");

const manifest = parse(readFileSync(new URL("../../providers/anthropic.provider.yaml", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([manifest]).providers[0];
const model = provider.models.find(model => model.upstream === "claude-mythos-5");
const messages = provider.endpoints.find(endpoint => endpoint.id === "messages");
const count = provider.endpoints.find(endpoint => endpoint.id === "count_tokens");

test("Mythos 5 adds exact Messages/count facts without replacing defaults or rewriting native thinking", () => {
  assert.equal(provider.models[0].id, "anthropic/claude-sonnet-5-5");
  assert.deepEqual(model.capabilities, ["llm.messages", "llm.count_tokens"]);
  const body = { model: model.id, messages: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
    max_tokens: 32, thinking: { type: "adaptive" }, output_config: { effort: "high" }, stream: true };
  const before = structuredClone(body);
  assert.deepEqual(prepareManifestRequest(provider, messages, body, {}, {}).body, { ...body, model: "claude-mythos-5" });
  assert.deepEqual(body, before);
  for (const endpoint of [messages, count]) {
    const facts = model.nativeCapabilities.endpoints[endpoint.id];
    assert.deepEqual(facts.input, ["text", "image"]);
    assert.equal(facts.contextWindow, 1000000);
    assert.equal(facts.maxOutputTokens, endpoint === messages ? 128000 : undefined);
  }
  const prepared = prepareManifestRequest(provider, count, { model: model.id, messages: [] }, {}, {});
  assert.equal(prepared.body.model, "claude-mythos-5");
  assert.deepEqual(estimateCost(model, prepared.body, 999, "llm.count_tokens", count), { reserveMicros: 0, basis: "none", inputTokens: 0, outputTokens: 0 });
});

test("Mythos 5 keeps its own cache tariff and scales every category for US geography", () => {
  const pricing = model.pricing, tokens = { input: 1000, cached: 100, cacheWrite: 500, cacheWrite5m: 200, cacheWrite1h: 300, output: 10 };
  assert.deepEqual([pricing.inputMicrosPerMillion, pricing.cachedInputMicrosPerMillion, pricing.cacheWrite5mInputMicrosPerMillion, pricing.cacheWrite1hInputMicrosPerMillion, pricing.outputMicrosPerMillion], [10000000, 1000000, 12500000, 20000000, 50000000]);
  const global = anthropicPricing(pricing, model.upstream, { inferenceGeo: "global" }, { inferenceGeo: "global", serviceTier: "standard" });
  const us = anthropicPricing(pricing, model.upstream, { inferenceGeo: "us" }, { inferenceGeo: "us", serviceTier: "standard" });
  assert.equal(actualModelCost(global, tokens, messages.request_format), 13100);
  assert.equal(actualModelCost(us, tokens, messages.request_format), 14410);
  assert.equal(anthropicPricing(pricing, model.upstream, {}, {}).inputMicrosPerMillion, 11000000);
  assert.equal(pricing.inputMicrosPerMillion, 10000000, "native modifier qualification cannot mutate the shared base card");
});

test("Mythos 5 standard calls remain priced while unsupported premium modifiers fail before dispatch", () => {
  const body = { messages: [], max_tokens: 16 }, connection = { providerId: "anthropic", monthlyBudgetMicros: 10000000 };
  for (const service_tier of [undefined, "auto", "standard_only"]) {
    const cost = estimateCost(model, { ...body, ...(service_tier ? { service_tier } : {}) }, null, "llm.messages", messages);
    assert.equal(cost.basis, "manifest_pricing");
    assert.equal(validateBudgetReservation("llm.messages", cost, null, connection), true);
  }
  for (const modifier of [{ speed: "fast" }, { inference_geo: "future" }, { service_tier: "priority" }]) {
    const cost = estimateCost(model, { ...body, ...modifier }, null, "llm.messages", messages);
    assert.equal(cost.basis, "unpriced_modifier");
    assert.throws(() => validateBudgetReservation("llm.messages", cost, null, connection), error => error.code === "pricing_required");
  }
});
