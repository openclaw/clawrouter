import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const { actualModelCost, estimateModelCost, requestPricingGap } = await import("../pricing.ts");
const { estimateCost, createProxyAccounting } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { providerById } = await import("../providers.ts");
const { googleRequestServiceTier, googleResponseServiceTier } = await import("../google-protocol.ts");
const { prepareGoogleGroundedSearch, observeGoogleGroundedSearch } = await import("../google-grounded-search.ts");
const { prepareGoogleUnderstanding } = await import("../google-media-understanding.ts");
const read = name => JSON.parse(readFileSync(new URL(`../../providers/_fixtures/google/${name}.json`, import.meta.url), "utf8"));
const search = read("grounded-search"), media = read("media-understanding");
const rows = [
  { upstream: search.request.model, body: search.request.body, format: "google.grounded_search", capability: "search.web", gap: "hosted_tool_fee" },
  ...["audio", "video"].map(mode => ({ upstream: media.model, body: media[mode], format: `google.${mode}_understanding`,
    capability: mode === "audio" ? "audio.transcription" : "video.understanding", gap: "opaque_input_bound" })),
];
const pricing = providerById("google-gemini").models.find(model => model.upstream === "gemini-3.5-flash").pricing;
const free = { ...pricing, inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, outputMicrosPerMillion: 0 };
const foreign = providerById("openai").models.find(model => model.id === "openai/gpt-image-2.5-sunburst").pricing;
const unknown = { reserveMicros: 0, inputTokens: null, outputTokens: null, pricingAvailable: false };
const tokens = { input: 100, output: 10, total: 110, cached: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

test("actual frozen Google search/media wire contracts remain explicitly unpriced before token or foreign image cards", () => {
  assert.equal(prepareGoogleGroundedSearch(rows[0].upstream, rows[0].body).body, rows[0].body);
  for (const mode of ["audio", "video"]) assert.equal(prepareGoogleUnderstanding(media.model, mode, media[mode]).body, media[mode]);
  for (const { body, format, gap } of rows) {
    for (const card of [pricing, free, foreign]) {
      assert.equal(requestPricingGap(card, body, format), gap);
      assert.deepEqual(estimateModelCost(card, body, { request_format: format }), unknown);
    }
    assert.equal(requestPricingGap(null, body, format), gap);
  }
});

test("explicit Google search/media formats cannot use generic capability labels to admit unknown hard dollars", () => {
  for (const { upstream, body, format, capability, gap } of rows) for (const card of [null, pricing, free, foreign]) {
    for (const label of [capability, "llm.generate", "llm.stream"]) {
      const cost = estimateCost({ id: `google/${upstream}`, upstream, pricing: card }, body, null, label, { request_format: format });
      assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.pricingGap, gap);
      assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
      for (const [caller, provider] of [[10000, null], [null, 10000], [10000, 10000]]) {
        assert.throws(() => validateBudgetReservation(label, cost, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
      }
    }
  }
});

test("Google search/media keeps explicit policy-fixed admission separate, including authorized zero", () => {
  for (const { upstream, body, format, capability } of rows) for (const fixed of [0, 17]) {
    const cost = estimateCost({ id: `google/${upstream}`, upstream, pricing }, body, fixed, capability, { request_format: format });
    assert.deepEqual(cost, { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
    assert.equal(validateBudgetReservation(capability, cost, 10000, { monthlyBudgetMicros: 10000 }), true);
  }
});

test("Google search/media token counters, zero usage and nonbillable flags do not establish whole-request invoices", () => {
  for (const { format } of rows) for (const card of [pricing, free, foreign]) {
    for (const observed of [tokens, { ...tokens, billable: false }, { ...tokens, input: 0, output: 0 }, { ...tokens, input: null, output: null }]) {
      assert.equal(actualModelCost(card, observed, format), null);
    }
  }
});

test("Google grounded-search native query/citation observations cannot make a request free", () => {
  for (const metadata of [{ webSearchQueries: [] }, { webSearchQueries: ["synthetic"] }]) {
    const payload = structuredClone(search.response); payload.candidates[0].groundingMetadata = metadata;
    const observed = observeGoogleGroundedSearch(payload, true);
    assert.equal(observed.observedQueryCount, metadata.webSearchQueries.length);
    assert.equal(requestPricingGap(pricing, rows[0].body, rows[0].format), "hosted_tool_fee");
    assert.equal(actualModelCost(pricing, { ...tokens, input: 0, output: 0 }, rows[0].format), null);
  }
});

test("ordinary Google text and client functions named after hosted tools retain their independent pricing behavior", () => {
  const body = { contents: [{ parts: [{ text: JSON.stringify({ requestFormat: "google.grounded_search", google_search: {} }) }] }],
    tools: [{ functionDeclarations: [{ name: "google_search", description: "Synthetic client function" }] }] };
  assert.equal(requestPricingGap(pricing, body, "google.generate_content"), null);
  assert.notEqual(estimateModelCost(pricing, body, { request_format: "google.generate_content" }).pricingAvailable, false);
  const serviceTier = googleResponseServiceTier(googleRequestServiceTier(body), undefined, null);
  assert.equal(serviceTier, "standard");
  assert.equal(actualModelCost(pricing, { ...tokens, serviceTier }, "google.generate_content"), 240);
  assert.equal(actualModelCost(pricing, tokens, "google.generate_content"), null);
  assert.equal(requestPricingGap(pricing, search.request.body, "google.generate_content"), "hosted_tool_fee");
});

test("actual native search/media accounting preserves unknown usage and separately labeled fixed charges", async () => {
  for (const { upstream, body, format, capability } of rows) for (const fixed of [null, 0, 17]) {
    const events = [], pending = [], owner = createProxyAccounting({
      env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: { waitUntil: promise => pending.push(promise) },
      auth: { policyId: "fixture", policy: { requestCostMicros: fixed } },
      selection: { provider: { id: "google-gemini" }, model: { id: `google/${upstream}`, upstream, pricing },
        endpoint: { request_format: format }, body, capability },
      request: correlateIngressRequest(new Request("https://router.example/v1/proxy/google-gemini/native")).request,
    });
    assert.equal(owner.cost.basis, fixed == null ? "unpriced_request" : "policy_fixed");
    assert.equal(await owner.settle(200, "success", true, null, { reservations: [], reservedMicros: owner.cost.reserveMicros }, null), true);
    await Promise.all(pending); assert.equal(events.length, 1);
    assert.equal(events[0].cost_basis, fixed == null ? "unpriced_usage" : "policy_fixed");
    assert.equal(events[0].input_tokens, null); assert.equal(events[0].output_tokens, null);
    if (fixed != null) assert.equal(events[0].actual_cost_micros, fixed);
  }
});
