import assert from "node:assert/strict";
import test from "node:test";
import { googleRequestServiceTier, googleResponseServiceTier } from "../google-protocol.ts";
import { actualModelCost, estimateModelCost } from "../pricing.ts";
import { extractSseUsageTokens, extractUsageTokens } from "../token-usage.ts";

const format = "google.generate_content";
const rates = (input, cached, output) => ({ inputMicrosPerMillion: input, cachedInputMicrosPerMillion: cached, outputMicrosPerMillion: output,
  cacheWriteInputMicrosPerMillion: null, cacheWrite5mInputMicrosPerMillion: null, cacheWrite1hInputMicrosPerMillion: null, longContext: null });
const pricing = { ...rates(1_500_000, 150_000, 9_000_000), maxInputTokens: 1_048_576, maxRequestInputTokens: null, defaultMaxOutputTokens: 65_536, inputTokenOverhead: 1_024,
  serviceTiers: [
    { ...rates(1_500_000, 150_000, 9_000_000), id: "default", aliases: ["standard"], maxInputTokens: null },
    { ...rates(750_000, 80_000, 4_500_000), id: "flex", aliases: [], maxInputTokens: null },
    { ...rates(2_700_000, 270_000, 16_200_000), id: "priority", aliases: [], maxInputTokens: null },
  ] };

test("native tier aliases are last-wins and never borrow OpenAI wire values", () => {
  for (const [body, expected] of [
    [{}, "standard"], [{ serviceTier: null }, "standard"], [{ service_tier: "unspecified" }, "standard"],
    [{ serviceTier: "priority", service_tier: "flex" }, "flex"],
    [{ service_tier: "flex", serviceTier: "priority" }, "priority"],
    [{ serviceTier: "priority", service_tier: null }, "standard"],
    [{ service_tier: null, serviceTier: "priority" }, "priority"],
    ...["default", "auto", "fast", "future", "", " priority ", 0, 1, true, {}].map(value => [{ serviceTier: value }, null]),
  ]) {
    const before = structuredClone(body);
    assert.equal(googleRequestServiceTier(body), expected);
    assert.deepEqual(body, before);
  }
});

test("native reservation uses exact tier cards, including Flex without Standard fallback", () => {
  const body = { contents: [{ parts: [{ text: "x".repeat(1_100_000) }] }], generationConfig: { maxOutputTokens: 1_000 } };
  for (const [tier, expected] of [[undefined, 1_581_864], ["unspecified", 1_581_864], ["standard", 1_581_864], ["flex", 790_932], ["priority", 2_847_356]]) {
    assert.equal(estimateModelCost(pricing, { ...body, serviceTier: tier }, { request_format: format }).reserveMicros, expected);
  }
  for (const serviceTier of ["auto", "default", "fast", "future", 0, {}]) {
    assert.equal(estimateModelCost(pricing, { ...body, serviceTier }, { request_format: format }).pricingAvailable, false);
  }
  const standardOnly = { ...pricing, serviceTiers: undefined };
  assert.equal(estimateModelCost(standardOnly, body, { request_format: format }).reserveMicros, 1_581_864);
  assert.equal(estimateModelCost(standardOnly, { ...body, serviceTier: "priority" }, { request_format: format }).pricingAvailable, false);
  // The shared resolver still permits OpenAI defaults and Standard fallback.
  assert.equal(estimateModelCost(pricing, { previous_response_id: "fixture", max_output_tokens: 1_000 }).reserveMicros, 2_847_356);
  assert.equal(estimateModelCost(pricing, { previous_response_id: "fixture", max_output_tokens: 1_000, service_tier: "flex" }).reserveMicros, 1_581_864);
});

test("returned native tier evidence must agree; only Standard and Flex have a fixed missing-tier outcome", () => {
  for (const [requested, metadata, header, expected] of [
    ["standard", undefined, null, "standard"], ["flex", undefined, null, "flex"], ["priority", undefined, null, null],
    [null, "priority", null, "priority"], ["priority", "standard", null, "standard"],
    ["priority", undefined, "standard", "standard"], ["priority", "standard", "standard", "standard"],
    ["priority", "priority", "standard", null], ["priority", "standard", "priority", null],
    ["standard", null, "standard", null], ["standard", "future", "standard", null],
    ["standard", "standard", "future", null], ["standard", undefined, "", null],
    ["priority", "unspecified", "standard", "standard"],
  ]) assert.equal(googleResponseServiceTier(requested, metadata, header), expected);
});

test("native JSON and final SSE snapshots preserve invalid tiers without changing token accounting", () => {
  const usage = { promptTokenCount: 1_000, cachedContentTokenCount: 900, candidatesTokenCount: 100, thoughtsTokenCount: 1_000, totalTokenCount: 2_100 };
  const sse = (...metadata) => metadata.map(usageMetadata => `data: ${JSON.stringify({ usageMetadata })}\n\n`).join("");
  for (const [fields, tier] of [
    [{}, undefined], [{ serviceTier: null }, undefined], [{ serviceTier: "priority" }, "priority"],
    [{ serviceTier: "priority", service_tier: "flex" }, "flex"], [{ service_tier: "flex", serviceTier: "priority" }, "priority"],
    [{ serviceTier: "priority", service_tier: null }, undefined],
    ...["future", "default", 0, {}].map(value => [{ serviceTier: value }, null]),
  ]) for (const tokens of [extractUsageTokens({ usage_metadata: { ...usage, ...fields } }), extractSseUsageTokens(sse({ ...usage, serviceTier: "priority" }, { ...usage, ...fields }))]) {
    assert.equal(tokens.serviceTier, tier);
    assert.deepEqual([tokens.input, tokens.cached, tokens.output, tokens.total], [1_000, 900, 1_100, 2_100]);
    const expected = tier === "priority" ? 18_333 : tier === "flex" ? 5_097 : null;
    assert.equal(actualModelCost(pricing, tokens, format), expected);
  }
  const tokens = extractUsageTokens({ usageMetadata: { ...usage, serviceTier: "standard" } });
  assert.equal(actualModelCost(pricing, tokens, format), 10_185);
  assert.equal(actualModelCost({ ...pricing, serviceTiers: undefined }, { ...tokens, serviceTier: "priority" }, format), null);
  assert.equal(extractUsageTokens({ candidates: [] }), null, "a header cannot fabricate absent usage");
});
