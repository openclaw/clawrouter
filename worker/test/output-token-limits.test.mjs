import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { estimateModelCost } from "../pricing.ts";

const pricing = {
  inputMicrosPerMillion: 300_000, outputMicrosPerMillion: 1_200_000,
  cachedInputMicrosPerMillion: 6_000, cacheWriteInputMicrosPerMillion: null,
  cacheWrite5mInputMicrosPerMillion: null, cacheWrite1hInputMicrosPerMillion: null,
  maxInputTokens: 1_048_576, maxRequestInputTokens: null, defaultMaxOutputTokens: 393_216,
  inputTokenOverhead: 1_024, longContext: null,
};
const endpoint = { request_format: "openai.chat_completions", outputTokenLimit: { field: "max_tokens", minimum: 1, maximum: 393_216 } };

test("only a declared positive output limit can lower the endpoint reservation", () => {
  for (const value of [1, 8_192, 393_216]) {
    const body = Object.freeze({ max_tokens: value, max_output_tokens: 1, max_completion_tokens: 1 });
    assert.equal(estimateModelCost(pricing, body, endpoint).outputTokens, value);
  }
  for (const value of [undefined, null, 0, -1, 1.5, 393_217, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "8192", true, {}, []]) {
    const body = Object.freeze({ max_tokens: value, max_output_tokens: 1, max_completion_tokens: 1 });
    assert.equal(estimateModelCost(pricing, body, endpoint).outputTokens, 393_216, String(value));
  }
  assert.equal(estimateModelCost(pricing, {}, endpoint).outputTokens, 393_216, "catalog completeness probes need no invented input");
});

test("endpoint bounds preserve sibling formats and conservative input and choice envelopes", () => {
  const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image" } }] }], max_tokens: 8, n: 2 };
  assert.equal(estimateModelCost(pricing, body, endpoint).inputTokens, 1_048_576);
  assert.equal(estimateModelCost(pricing, body, endpoint).outputTokens, 16);
  assert.equal(estimateModelCost(pricing, { max_output_tokens: 0 }, { request_format: "openai.responses" }).outputTokens, 0);
  assert.equal(estimateModelCost(pricing, { generationConfig: { maxOutputTokens: 7 } }, { request_format: "google.generate_content" }).outputTokens, 7);
  assert.equal(estimateModelCost(pricing, { max_completion_tokens: 9 }, { ...endpoint, outputTokenLimit: { ...endpoint.outputTokenLimit, field: "max_completion_tokens" } }).outputTokens, 9);
});

test("endpoint bounds preserve pricing gaps, fixed zero and free counting at canonical admission", async () => {
  const { estimateCost } = await import("../proxy-accounting.ts");
  const { validateBudgetReservation } = await import("../accounting.ts");
  const model = { pricing }, body = Object.freeze({ max_tokens: 0, max_output_tokens: 1, web_search_options: {} });
  const cost = estimateCost(model, body, null, "llm.chat", endpoint);
  assert.equal(cost.pricingGap, "hosted_tool_fee");
  for (const [policyLimit, providerLimit] of [[1_000, null], [null, 1_000]]) {
    assert.throws(() => validateBudgetReservation("llm.chat", cost, policyLimit, { providerId: "fixture", monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
  }
  assert.equal(estimateCost(model, body, 0, "llm.chat", endpoint).basis, "policy_fixed");
  assert.equal(estimateCost(model, body, 7, "llm.count_tokens", endpoint).basis, "none");
  const mandatoryFee = { pricing: { ...pricing, unpricedCosts: ["request_fee"] } };
  assert.equal(estimateCost(mandatoryFee, {}, null, "llm.chat", endpoint).pricingGap, "model_request_fee");
  assert.equal(estimateCost(model, {}, null, "llm.chat", endpoint).outputTokens, 393_216);
  assert.deepEqual(body, { max_tokens: 0, max_output_tokens: 1, web_search_options: {} });
});
