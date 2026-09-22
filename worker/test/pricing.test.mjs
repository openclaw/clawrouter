import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { actualModelCost, estimateModelCost } from "../pricing.ts";

const pricing = {
  effectiveAt: "2026-06-19", source: "https://example.com", inputMicrosPerMillion: 2_500_000,
  outputMicrosPerMillion: 15_000_000, cachedInputMicrosPerMillion: 250_000,
  cacheWriteInputMicrosPerMillion: null,
  cacheWrite5mInputMicrosPerMillion: 3_125_000, cacheWrite1hInputMicrosPerMillion: 5_000_000,
  maxInputTokens: 1_050_000, maxRequestInputTokens: null, defaultMaxOutputTokens: 128_000,
  inputTokenOverhead: 1_024, longContext: null,
};

test("pricing reserves serialized text plus overhead and every requested choice", () => {
  const body = { messages: [{ role: "user", content: "hello" }], max_completion_tokens: 1_000, n: 4 };
  const estimate = estimateModelCost(pricing, body);
  assert.equal(estimate.inputTokens, new TextEncoder().encode(JSON.stringify(body)).byteLength + 1_024);
  assert.equal(estimate.outputTokens, 4_000);
});

test("opaque inputs and provider-added tools reserve the full input window", () => {
  assert.equal(estimateModelCost(pricing, { input: [{ type: "input_image", image_url: "https://example.com/a.png" }] }).inputTokens, pricing.maxInputTokens);
  assert.equal(estimateModelCost(pricing, { tools: [{ type: "computer_20250124" }] }).inputTokens, pricing.maxInputTokens);
});

test("cache and long-context rates keep settlement within reservation", () => {
  const tiered = { ...pricing, longContext: { thresholdInputTokens: 10, inputMicrosPerMillion: 5_000_000, outputMicrosPerMillion: 22_500_000, cachedInputMicrosPerMillion: 500_000, cacheWriteInputMicrosPerMillion: null, cacheWrite5mInputMicrosPerMillion: null, cacheWrite1hInputMicrosPerMillion: null } };
  const estimate = estimateModelCost(tiered, { input: "hello", max_output_tokens: 1_000, cache_control: { type: "ephemeral", ttl: "1h" } });
  const actual = actualModelCost(tiered, { input: estimate.inputTokens, output: 1_000, cached: 100, cacheWrite: 100, cacheWrite5m: 50, cacheWrite1h: 50 });
  assert.ok(actual != null && actual <= estimate.reserveMicros);
});

test("generic cache-write pricing reserves and settles reported writes", () => {
  const cachePricing = { ...pricing, inputMicrosPerMillion: 5_000_000, outputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 500_000, cacheWriteInputMicrosPerMillion: 6_250_000, inputTokenOverhead: 0 };
  const estimate = estimateModelCost(cachePricing, { messages: [{ role: "user", content: "hello" }], max_tokens: 0 });
  const actual = actualModelCost(cachePricing, { input: estimate.inputTokens, output: 0, cached: 10, cacheWrite: 20, cacheWrite5m: null, cacheWrite1h: null });
  assert.ok(actual != null && actual <= estimate.reserveMicros);
  assert.equal(actual, Math.ceil(((estimate.inputTokens - 30) * 5_000_000 + 10 * 500_000 + 20 * 6_250_000) / 1_000_000));
  assert.equal(actualModelCost(cachePricing, { input: estimate.inputTokens, output: 0, cached: 10, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null }), null);
});

test("bundled Astra standard pricing applies cache writes and the full-request long-context boundary", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../generated/provider-snapshot.json", import.meta.url), "utf8"));
  const astra = snapshot.model_index["openai/gpt-6-astra"].pricing;
  const tokens = { serviceTier: "default", input: 272_000, output: 1_000, cached: 100_000, cacheWrite: 100_000, cacheWrite5m: null, cacheWrite1h: null };
  assert.equal(actualModelCost(astra, tokens), 2_120_000);
  assert.equal(actualModelCost(astra, { ...tokens, input: 272_001 }), 4_215_020);
  assert.equal(actualModelCost(astra, { ...tokens, cacheWrite: null }), null);
  assert.deepEqual(estimateModelCost(astra, { previous_response_id: "resp_example", service_tier: "default" }), {
    inputTokens: 922_000,
    outputTokens: 128_000,
    reserveMicros: 32_650_000,
  });
});

const catalog = JSON.parse(readFileSync(new URL("../generated/provider-snapshot.json", import.meta.url), "utf8")).model_index;
const counts = { input: 272_000, output: 1_000, cached: 100_000, cacheWrite: 100_000, cacheWrite5m: null, cacheWrite1h: null };

test("Astra uses actual served tier, aliases, and exact long-context prices", () => {
  const astra = catalog["openai/gpt-6-astra"].pricing;
  for (const [serviceTier, short, long] of [["default", 2_120_000, 4_215_020], ["priority", 4_240_000, 8_430_040], ["fast", 4_240_000, 8_430_040], ["flex", 1_060_000, 2_107_510]]) {
    assert.equal(actualModelCost(astra, { ...counts, serviceTier }), short);
    assert.equal(actualModelCost(astra, { ...counts, serviceTier, input: 272_001 }), long);
  }
  for (const serviceTier of [undefined, "auto", "unknown"]) assert.equal(actualModelCost(astra, { ...counts, serviceTier }), null);
});

test("auto and omitted tiers reserve all supported rates without changing the request", () => {
  const astra = catalog["openai/gpt-6-astra"].pricing;
  for (const service_tier of [undefined, "auto", "priority", "fast"]) {
    const body = { previous_response_id: "opaque", service_tier };
    const before = structuredClone(body);
    assert.equal(estimateModelCost(astra, body).reserveMicros, 65_300_000);
    assert.deepEqual(body, before);
  }
  assert.equal(estimateModelCost(astra, { service_tier: "scale" }).pricingAvailable, false);
  assert.equal(estimateModelCost(pricing, { service_tier: "standard_only" }).pricingAvailable, undefined);
});

test("model-specific prices and short-only cards do not inherit an Astra multiplier", () => {
  const shortTokens = { input: 100_000, output: 1_000, cached: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, serviceTier: "priority" };
  assert.equal(actualModelCost(catalog["openai/gpt-5.5"].pricing, shortTokens), 1_325_000);
  assert.equal(actualModelCost(catalog["openai/gpt-4.1-mini"].pricing, shortTokens), 72_800);
  assert.equal(actualModelCost(catalog["openai/gpt-5.6"].pricing, { ...shortTokens, serviceTier: "default" }), 420_000);
  assert.equal(actualModelCost(catalog["openai/gpt-5.4"].pricing, { ...shortTokens, input: 100_000, cached: 100_000, output: 0, serviceTier: "flex" }), 13_000);
  for (const id of ["openai/gpt-5.4", "openai/gpt-5.5"]) {
    const model = catalog[id].pricing;
    assert.equal(actualModelCost(model, { ...shortTokens, input: 272_001 }), null);
    const estimate = estimateModelCost(model, { previous_response_id: "opaque" });
    assert.ok(estimate.reserveMicros >= actualModelCost(model, { ...shortTokens, input: 272_000 }));
    assert.ok(estimate.reserveMicros >= actualModelCost(model, { ...shortTokens, input: model.maxInputTokens, serviceTier: "default" }));
  }
  assert.equal(estimateModelCost(catalog["openai/gpt-4.1-mini"].pricing, { service_tier: "flex" }).pricingAvailable, false);
});
