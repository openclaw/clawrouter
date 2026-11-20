import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const { actualModelCost, estimateModelCost, requestPricingGap } = await import("../pricing.ts");
const { estimateCost, createProxyAccounting } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { providerById } = await import("../providers.ts");
const { prepareGroqMistralAudio, observeGroqMistralAudio } = await import("../groq-mistral-audio.ts");
const fixtures = ["groq", "mistral"].map(id => ({ id, format: `${id}.transcription`,
  wire: JSON.parse(readFileSync(new URL(`../../providers/_fixtures/${id}/transcription.json`, import.meta.url), "utf8")) }));
const pricing = providerById("mistral").models.find(model => model.upstream === "mistral-medium-3-5").pricing;
const free = { ...pricing, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 };
const foreign = providerById("openai").models.find(model => model.id === "openai/gpt-image-2.5-sunburst").pricing;
const tokens = { input: 100, output: 10, total: 110, cached: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

test("landed native multipart contracts cannot be estimated with token, free or foreign image cards", () => {
  for (const { id, format, wire } of fixtures) {
    const file = new File([Buffer.from(wire.file.base64, "base64")], wire.file.name, { type: wire.file.type });
    assert.equal(prepareGroqMistralAudio(id, { file, fields: wire.fields }).model, wire.fields.model);
    for (const card of [pricing, free, foreign]) {
      assert.equal(requestPricingGap(card, wire.fields, format), "opaque_input_bound");
      assert.deepEqual(estimateModelCost(card, wire.fields, { request_format: format }),
        { reserveMicros: 0, inputTokens: null, outputTokens: null, pricingAvailable: false });
    }
    assert.equal(requestPricingGap(null, wire.fields, format), "opaque_input_bound");
  }
});

test("native transcription costs stay unknown under either hard-dollar budget regardless of generic capability labels", () => {
  for (const { id, format, wire } of fixtures) for (const card of [null, pricing, free, foreign]) {
    for (const capability of ["audio.transcription", "llm.generate", "llm.stream"]) {
      const cost = estimateCost({ id: `${id}/${wire.fields.model}`, upstream: wire.fields.model, pricing: card }, wire.fields, null, capability, { request_format: format });
      assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.pricingGap, "opaque_input_bound");
      assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
      for (const [caller, provider] of [[10000, null], [null, 10000], [10000, 10000]]) {
        assert.throws(() => validateBudgetReservation(capability, cost, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
      }
    }
  }
});

test("native diagnostic seconds, alias observations and token flags do not establish a tariff or a zero invoice", () => {
  for (const { id, format, wire } of fixtures) {
    const observed = observeGroqMistralAudio(id, wire.response, true);
    assert.equal(observed.requestedModel, wire.fields.model); assert.equal(observed.costMicros, undefined);
    assert.equal(observed.observedAudioSeconds, id === "mistral" ? 2 : null);
    for (const card of [pricing, free, foreign]) for (const usage of [tokens, { ...tokens, billable: false },
      { ...tokens, input: 0, output: 0 }, { ...tokens, input: null, output: null }]) {
      assert.equal(actualModelCost(card, usage, format), null);
    }
  }
});

test("actual accounting records unknown native audio cost and separately labeled policy-fixed charges", async () => {
  for (const { id, format, wire } of fixtures) for (const card of [null, pricing, free, foreign]) for (const fixed of [null, 0, 17]) {
    const events = [], pending = [], owner = createProxyAccounting({
      env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: { waitUntil: promise => pending.push(promise) },
      auth: { policyId: "fixture", policy: { requestCostMicros: fixed } },
      selection: { provider: { id }, model: { id: `${id}/${wire.fields.model}`, upstream: wire.fields.model, pricing: card },
        endpoint: { request_format: format }, body: wire.fields, capability: "audio.transcription" },
      request: correlateIngressRequest(new Request(`https://router.example/v1/proxy/${id}/transcription`)).request,
    });
    assert.equal(owner.cost.basis, fixed == null ? "unpriced_request" : "policy_fixed");
    assert.equal(await owner.settle(200, "success", true, tokens, { reservations: [], reservedMicros: owner.cost.reserveMicros }, null), true);
    await Promise.all(pending); assert.equal(events.length, 1);
    assert.equal(events[0].cost_basis, fixed == null ? "unpriced_usage" : "policy_fixed");
    if (fixed != null) assert.equal(events[0].actual_cost_micros, fixed);
  }
});

test("ordinary Chat, client functions and the existing OpenAI upload classification are unchanged", () => {
  const body = { messages: [{ role: "user", content: JSON.stringify({ requestFormat: "groq.transcription" }) }],
    tools: [{ type: "function", function: { name: "mistral_transcription", parameters: {} } }] };
  assert.equal(requestPricingGap(pricing, body, "openai.chat_completions"), null);
  assert.notEqual(estimateModelCost(pricing, body, { request_format: "openai.chat_completions" }).pricingAvailable, false);
  assert.equal(actualModelCost(pricing, tokens, "openai.chat_completions"), 225);
  assert.equal(requestPricingGap(pricing, { model: "gpt-4o-transcribe" }, "openai.audio_transcriptions"), "audio_upload_bound");
});
