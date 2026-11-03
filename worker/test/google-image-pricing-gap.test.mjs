import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { actualModelCost, estimateModelCost, requestPricingGap } = await import("../pricing.ts");
const { estimateCost, createProxyAccounting } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { providerById } = await import("../providers.ts");
const format = "google.image_generate", endpoint = { request_format: format };
const body = { contents: [{ role: "user", parts: [{ text: "Synthetic image fixture" }] }] };
const pricing = {
  effectiveAt: "2026-11-03", source: "https://example.com/synthetic-pricing",
  inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 100_000, outputMicrosPerMillion: 2_000_000,
  cacheWriteInputMicrosPerMillion: null, cacheWrite5mInputMicrosPerMillion: null, cacheWrite1hInputMicrosPerMillion: null,
  maxInputTokens: 1_048_576, maxRequestInputTokens: null, defaultMaxOutputTokens: 65536, inputTokenOverhead: 1024, longContext: null,
};
const free = { ...pricing, inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, outputMicrosPerMillion: 0 };
const openaiImage = providerById("openai").models.find(model => model.id === "openai/gpt-image-2.5-sunburst").pricing;
const tokens = { input: 100, output: 10, total: 110, cached: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, serviceTier: "standard" };
const ids = ["gemini-3.1-flash-image", "gemini-3-pro-image"];

test("explicit native Google image format cannot borrow text, free text or OpenAI image pricing", () => {
  for (const card of [pricing, free, openaiImage]) {
    assert.equal(requestPricingGap(card, body, format), "opaque_input_bound");
    assert.deepEqual(estimateModelCost(card, body, endpoint), { reserveMicros: 0, inputTokens: null, outputTokens: null, pricingAvailable: false });
  }
  assert.equal(requestPricingGap(null, body, format), "opaque_input_bound");
});

test("explicit Google images deny both caller and provider hard-dollar budgets for both frozen IDs", () => {
  for (const upstream of ids) for (const card of [null, pricing, free, openaiImage]) {
    const model = { id: `google/${upstream}`, upstream, pricing: card };
    for (const capability of ["image.generate", "llm.generate", "llm.stream"]) {
      const cost = estimateCost(model, body, null, capability, endpoint);
      assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.pricingGap, "opaque_input_bound");
      assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
      for (const [caller, provider] of [[10000, null], [null, 10000], [10000, 10000]]) {
        assert.throws(() => validateBudgetReservation(capability, cost, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
      }
      assert.equal(validateBudgetReservation(capability, cost, null, { monthlyBudgetMicros: null }), false);
    }
  }
});

test("explicit policy-fixed Google image admission stays separate, including authorized fixed zero", () => {
  for (const fixed of [0, 17]) for (const upstream of ids) {
    const model = { id: `google/${upstream}`, upstream, pricing };
    const cost = estimateCost(model, body, fixed, "image.generate", endpoint);
    assert.deepEqual(cost, { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
    assert.equal(validateBudgetReservation("image.generate", cost, 10000, { monthlyBudgetMicros: 10000 }), true);
  }
});

test("Google image counters and nonbillable flags do not fabricate a token invoice or zero-cost receipt", () => {
  for (const card of [pricing, free, openaiImage]) for (const observed of [tokens, { ...tokens, billable: false },
    { ...tokens, input: 0, output: 0 }, { ...tokens, input: null, output: null },
    { ...tokens, image: { textInput: 10, imageInput: 5, imageOutput: 100 } }]) {
    assert.equal(actualModelCost(card, observed, format), null);
  }
});

test("ordinary Google text and qualified OpenAI images retain their independent pricing contracts", () => {
  const text = { request_format: "google.generate_content" };
  const ordinary = { contents: [{ parts: [{ text: JSON.stringify({ requestFormat: format, responseModalities: ["IMAGE"] }) }] }] };
  assert.equal(requestPricingGap(pricing, ordinary, text.request_format), null);
  assert.notEqual(estimateModelCost(pricing, ordinary, text).pricingAvailable, false);
  assert.equal(actualModelCost(pricing, tokens, text.request_format), 120);
  assert.notEqual(estimateModelCost(openaiImage, { prompt: "Synthetic image fixture" }, { request_format: "openai.images_generations" }).pricingAvailable, false);
  assert.ok(actualModelCost(openaiImage, { ...tokens, input: 15, output: 100, total: 115, image: { textInput: 10, imageInput: 5, imageOutput: 100 } }, "openai.images_generations") > 0);
});

for (const fixed of [null, 0, 17]) test(`Google image settlement keeps ${fixed == null ? "unmetered unknown usage" : `policy-fixed ${fixed}`} explicitly labeled`, async () => {
  const events = [], pending = [], model = { id: `google/${ids[0]}`, upstream: ids[0], pricing };
  const owner = createProxyAccounting({
    env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: { waitUntil: promise => pending.push(promise) },
    auth: { policyId: "fixture", policy: { requestCostMicros: fixed } },
    selection: { provider: { id: "google-gemini" }, model, endpoint, body, capability: "image.generate" },
    request: correlateIngressRequest(new Request("https://router.example/v1/proxy/google-gemini/image_generate")).request,
  });
  assert.equal(owner.cost.basis, fixed == null ? "unpriced_request" : "policy_fixed");
  assert.equal(await owner.settle(200, "success", true, null, { reservations: [], reservedMicros: owner.cost.reserveMicros }, null), true);
  await Promise.all(pending); assert.equal(events.length, 1);
  assert.equal(events[0].cost_basis, fixed == null ? "unpriced_usage" : "policy_fixed");
  assert.equal(events[0].input_tokens, null); assert.equal(events[0].output_tokens, null);
  if (fixed != null) assert.equal(events[0].actual_cost_micros, fixed);
});
