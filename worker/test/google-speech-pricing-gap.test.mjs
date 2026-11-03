import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const { actualModelCost, estimateModelCost, requestPricingGap } = await import("../pricing.ts");
const { estimateCost, createProxyAccounting } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { providerById } = await import("../providers.ts");
const { googleSpeechModels, googleSpeechPreviewCutoff, prepareGoogleSpeech } = await import("../google-speech.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/speech.json", import.meta.url), "utf8"));
const now = Date.parse("2026-11-03T00:00:00Z");
const ids = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts",
  "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
const rows = ids.map((upstream, index) => {
  const interactions = index >= 3, body = structuredClone(interactions ? wire.interactions.request : wire.generateContent.request);
  if (interactions) body.model = upstream;
  return { upstream, body, format: interactions ? "google.speech_interactions" : "google.speech_generate_content" };
});
const pricing = {
  effectiveAt: "2026-11-03", source: "https://example.com/synthetic-pricing",
  inputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 100_000, outputMicrosPerMillion: 2_000_000,
  cacheWriteInputMicrosPerMillion: null, cacheWrite5mInputMicrosPerMillion: null, cacheWrite1hInputMicrosPerMillion: null,
  maxInputTokens: 1_048_576, maxRequestInputTokens: null, defaultMaxOutputTokens: 65536, inputTokenOverhead: 1024, longContext: null,
};
const free = { ...pricing, inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, outputMicrosPerMillion: 0 };
const openaiImage = providerById("openai").models.find(model => model.id === "openai/gpt-image-2.5-sunburst").pricing;
const tokens = { input: 100, output: 10, total: 110, cached: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, serviceTier: "standard" };

test("both explicit Google speech formats use the actual five-model codec and cannot borrow token or image prices", () => {
  assert.deepEqual([...googleSpeechModels], ids);
  for (const { upstream, body, format } of rows) {
    const prepared = prepareGoogleSpeech(upstream, body, now);
    assert.equal(prepared.body, body);
    assert.equal(format, prepared.transport === "interactions" ? "google.speech_interactions" : "google.speech_generate_content");
    for (const card of [pricing, free, openaiImage]) {
      assert.equal(requestPricingGap(card, body, format), "opaque_input_bound");
      assert.deepEqual(estimateModelCost(card, body, { request_format: format }),
        { reserveMicros: 0, inputTokens: null, outputTokens: null, pricingAvailable: false });
    }
    assert.equal(requestPricingGap(null, body, format), "opaque_input_bound");
  }
});

test("Google speech requires known whole-request dollars for both caller and provider hard budgets", () => {
  for (const { upstream, body, format } of rows) for (const card of [null, pricing, free, openaiImage]) {
    const model = { id: `google/${upstream}`, upstream, pricing: card };
    for (const capability of ["audio.speech", "llm.generate", "llm.stream"]) {
      const cost = estimateCost(model, body, null, capability, { request_format: format });
      assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.pricingGap, "opaque_input_bound");
      assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
      for (const [caller, provider] of [[10000, null], [null, 10000], [10000, 10000]]) {
        assert.throws(() => validateBudgetReservation(capability, cost, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
      }
      assert.equal(validateBudgetReservation(capability, cost, null, { monthlyBudgetMicros: null }), false);
    }
  }
});

test("Google speech policy-fixed admission stays explicitly separate, including authorized zero", () => {
  for (const { upstream, body, format } of rows) for (const fixed of [0, 17]) {
    const cost = estimateCost({ id: `google/${upstream}`, upstream, pricing }, body, fixed, "audio.speech", { request_format: format });
    assert.deepEqual(cost, { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
    assert.equal(validateBudgetReservation("audio.speech", cost, 10000, { monthlyBudgetMicros: 10000 }), true);
  }
});

test("Google speech counters, nonbillable flags and zero metrics cannot fabricate a token invoice", () => {
  for (const format of new Set(rows.map(row => row.format))) for (const card of [pricing, free, openaiImage]) {
    for (const observed of [tokens, { ...tokens, billable: false }, { ...tokens, input: 0, output: 0 },
      { ...tokens, input: null, output: null }, { ...tokens, image: { textInput: 10, imageInput: 5, imageOutput: 100 } }]) {
      assert.equal(actualModelCost(card, observed, format), null);
    }
  }
});

test("ordinary Google text and existing image/music guards retain their independent pricing behavior", () => {
  const ordinary = { contents: [{ parts: [{ text: JSON.stringify({ requestFormat: "google.speech_interactions", responseModalities: ["AUDIO"] }) }] }] };
  assert.equal(requestPricingGap(pricing, ordinary, "google.generate_content"), null);
  assert.notEqual(estimateModelCost(pricing, ordinary, { request_format: "google.generate_content" }).pricingAvailable, false);
  assert.equal(actualModelCost(pricing, tokens, "google.generate_content"), 120);
  for (const format of ["google.image_generate", "google.music_generate"]) {
    assert.equal(requestPricingGap(pricing, ordinary, format), "opaque_input_bound");
    assert.equal(actualModelCost(pricing, tokens, format), null);
  }
  assert.notEqual(estimateModelCost(openaiImage, { prompt: "Synthetic image fixture" }, { request_format: "openai.images_generations" }).pricingAvailable, false);
});

test("speech price guards do not extend preview qualification or authorize a replacement model", () => {
  const cutoff = Date.parse(googleSpeechPreviewCutoff);
  for (const { upstream, body, format } of rows.slice(0, 3)) {
    assert.throws(() => prepareGoogleSpeech(upstream, body, cutoff), /qualification_expired/);
    assert.equal(requestPricingGap(pricing, body, format), "opaque_input_bound");
  }
  for (const { upstream, body } of rows.slice(3)) assert.equal(prepareGoogleSpeech(upstream, body, cutoff).model, upstream);
});

for (const row of [rows[0], rows[3]]) for (const fixed of [null, 0, 17]) {
  test(`${row.format} settlement keeps ${fixed == null ? "unknown usage" : `policy-fixed ${fixed}`} explicitly labeled`, async () => {
    const { upstream, body, format } = row, events = [], pending = [];
    const owner = createProxyAccounting({
      env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: { waitUntil: promise => pending.push(promise) },
      auth: { policyId: "fixture", policy: { requestCostMicros: fixed } },
      selection: { provider: { id: "google-gemini" }, model: { id: `google/${upstream}`, upstream, pricing },
        endpoint: { request_format: format }, body, capability: "audio.speech" },
      request: correlateIngressRequest(new Request("https://router.example/v1/proxy/google-gemini/speech")).request,
    });
    assert.equal(owner.cost.basis, fixed == null ? "unpriced_request" : "policy_fixed");
    assert.equal(await owner.settle(200, "success", true, null, { reservations: [], reservedMicros: owner.cost.reserveMicros }, null), true);
    await Promise.all(pending); assert.equal(events.length, 1);
    assert.equal(events[0].cost_basis, fixed == null ? "unpriced_usage" : "policy_fixed");
    assert.equal(events[0].input_tokens, null); assert.equal(events[0].output_tokens, null);
    if (fixed != null) assert.equal(events[0].actual_cost_micros, fixed);
  });
}
