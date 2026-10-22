import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { actualModelCost, estimateModelCost } from "../pricing.ts";
import { modelRoute, providerById } from "../providers.ts";
import { extractUsageTokens } from "../token-usage.ts";

const sonnet = "anthropic/claude-sonnet-5-5", haiku = "anthropic/claude-haiku-5-5";
const source = "https://platform.claude.com/docs/en/about-claude/pricing";
const usage = (input = 70_000) => ({ input_tokens: input, cache_read_input_tokens: 10_000,
  cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 10_000 }, output_tokens: 1_000 });
const message = counts => ({ id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "text", text: "synthetic reply" }], stop_reason: "end_turn", usage: counts });
const card = id => modelRoute(id, "llm.messages")?.model;

for (const [id, release, rates] of [
  [sonnet, "2026-09-28", [2_000_000, 100_000, 2_500_000, 4_000_000, 10_000_000]],
  [haiku, "2026-10-07", [100_000, 10_000, 125_000, 200_000, 500_000]],
]) test(id + " has the official versioned standard card and both existing capabilities", () => {
  const model = card(id);
  assert.ok(model?.pricing, "model must be priced, not merely unknown-model passthrough");
  assert.equal(model.upstream, id.slice("anthropic/".length));
  assert.deepEqual(model.capabilities, ["llm.messages", "llm.count_tokens"]);
  assert.equal(modelRoute(id, "llm.count_tokens").model, model);
  assert.equal(model.pricing_ref, id.replaceAll("/", "-") + "-standard-" + release);
  assert.equal(model.pricing.effectiveAt, release);
  assert.equal(model.pricing.source, source);
  assert.deepEqual([model.pricing.inputMicrosPerMillion, model.pricing.cachedInputMicrosPerMillion,
    model.pricing.cacheWrite5mInputMicrosPerMillion, model.pricing.cacheWrite1hInputMicrosPerMillion,
    model.pricing.outputMicrosPerMillion], rates);
  assert.equal(model.pricing.maxInputTokens, 1_000_000);
  assert.equal(model.pricing.defaultMaxOutputTokens, 128_000);
});

test("Haiku prices the entire input and output only above 100k, including disjoint cache buckets", () => {
  const pricing = card(haiku)?.pricing;
  assert.ok(pricing);
  for (const [input, expected] of [[69_999, 10_850], [70_000, 10_850], [70_001, 54_251]]) {
    assert.equal(actualModelCost(pricing, extractUsageTokens(message(usage(input)))), expected);
  }
  for (const [counts, expected] of [
    [{ input_tokens: 0, cache_read_input_tokens: 100_001, cache_creation_input_tokens: 0, output_tokens: 1_000 }, 7_501],
    [{ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100_001, cache_creation: { ephemeral_5m_input_tokens: 100_001, ephemeral_1h_input_tokens: 0 }, output_tokens: 1_000 }, 65_001],
    [{ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100_001, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_001 }, output_tokens: 1_000 }, 102_501],
  ]) assert.equal(actualModelCost(pricing, extractUsageTokens(message(counts))), expected);
  assert.equal(actualModelCost(pricing, extractUsageTokens(message({ output_tokens: 1_000 }))), null, "missing input cannot select a cheap tier");
  assert.equal(actualModelCost(pricing, extractUsageTokens(message({ input_tokens: 100_001 }))), null, "missing output cannot certify settlement");
  assert.equal(actualModelCost(pricing, extractUsageTokens(message({ input_tokens: 70_001, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 20_000, output_tokens: 1_000 }))), 58_001, "unknown cache TTL uses the dearer one-hour rate");
});

test("Sonnet keeps standard prices across 100k and full-window cache reservations cover both new cards", () => {
  const pricing = card(sonnet)?.pricing;
  assert.ok(pricing);
  assert.equal(pricing.longContext, null);
  for (const [input, expected] of [[70_000, 216_000], [70_001, 216_002]]) {
    assert.equal(actualModelCost(pricing, extractUsageTokens(message(usage(input)))), expected);
  }
  const endpoint = providerById("anthropic").endpoints.find(endpoint => endpoint.id === "messages");
  for (const [id, reserves] of [[haiku, [820_000, 945_000, 1_320_000]], [sonnet, [3_280_000, 3_780_000, 5_280_000]]]) {
    const pricing = card(id).pricing;
    for (const [index, cache_control] of [undefined, { type: "ephemeral" }, { type: "ephemeral", ttl: "1h" }].entries()) {
      const body = { model: id, messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(1_000_000), ...(cache_control ? { cache_control } : {}) }] }] };
      const estimate = estimateModelCost(pricing, body, endpoint);
      assert.deepEqual(estimate, { inputTokens: 1_000_000, outputTokens: 128_000, reserveMicros: reserves[index] });
      const tokens = { input: 1_000_000, output: 128_000, cached: 0, cacheWrite: cache_control ? 1_000_000 : 0,
        cacheWrite5m: index === 1 ? 1_000_000 : 0, cacheWrite1h: index === 2 ? 1_000_000 : 0 };
      assert.equal(actualModelCost(pricing, tokens), estimate.reserveMicros);
    }
  }
});
