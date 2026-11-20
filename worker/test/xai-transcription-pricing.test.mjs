import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const { requestPricingGap, estimateModelCost, actualModelCost } = await import("../pricing.ts");
const { estimateCost, createProxyAccounting } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { providerById } = await import("../providers.ts");
const { prepareXaiTranscription, observeXaiTranscription } = await import("../xai-transcription.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/transcription.json", import.meta.url), "utf8"));
const pricing = providerById("xai").models.find(model => model.upstream === "grok-4.3").pricing;
const free = { ...pricing, inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, outputMicrosPerMillion: 0, longContext: undefined };
const foreign = providerById("openai").models.find(model => model.id === "openai/gpt-image-2.5-sunburst").pricing;
const endpoint = { request_format: "xai.stt" }, capability = "audio.transcription";
const tokens = { input: 100, output: 10, total: 110, cached: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

test("actual model-less xAI STT has no token or image-price estimate regardless of a supplied card", () => {
  const native = prepareXaiTranscription({ fields: wire.request.fields,
    file: new File([Uint8Array.from(wire.audioBytes)], wire.request.filename, { type: wire.request.mime }) });
  assert.equal(native.body.has("model"), false); assert.equal(native.path, "/v1/stt");
  for (const card of [pricing, free, foreign]) {
    assert.equal(requestPricingGap(card, wire.request.fields, endpoint.request_format), "opaque_input_bound");
    assert.deepEqual(estimateModelCost(card, wire.request.fields, endpoint),
      { reserveMicros: 0, inputTokens: null, outputTokens: null, pricingAvailable: false });
  }
  assert.equal(requestPricingGap(null, wire.request.fields, endpoint.request_format), "opaque_input_bound");
});

test("native STT hard-dollar admission stays closed while explicit policy-fixed remains separate", () => {
  for (const model of [null, { upstream: "synthetic-unrelated-card", pricing }, { pricing: free }, { pricing: foreign }]) {
    for (const label of [capability, "llm.generate", "llm.stream"]) {
      const cost = estimateCost(model, wire.request.fields, null, label, endpoint);
      assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.pricingGap, "opaque_input_bound");
      assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
      for (const [caller, provider] of [[10000, null], [null, 10000]]) {
        assert.throws(() => validateBudgetReservation(label, cost, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
        for (const fixed of [0, 17]) {
          const explicit = estimateCost(model, wire.request.fields, fixed, label, endpoint);
          assert.deepEqual(explicit, { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
          assert.doesNotThrow(() => validateBudgetReservation(label, explicit, caller, { monthlyBudgetMicros: provider }));
        }
      }
    }
  }
});

test("valid silence, native seconds and zero or nonbillable token flags do not qualify an STT invoice", () => {
  for (const body of [wire.result, wire.silence, { text: "" }]) {
    const result = observeXaiTranscription(body, true);
    assert.equal(result.text, body.text.trim()); assert.equal(result.upstreamCostMicros, null);
    for (const card of [pricing, free, foreign]) for (const usage of [tokens, { ...tokens, input: 0, output: 0 },
      { ...tokens, billable: false }, { ...tokens, input: null, output: null }]) assert.equal(actualModelCost(card, usage, endpoint.request_format), null);
  }
});

test("model-less native accounting labels unknown STT cost and preserves separately authorized fixed charges", async () => {
  for (const fixed of [null, 0, 17]) {
    const events = [], pending = [], owner = createProxyAccounting({
      env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: { waitUntil: promise => pending.push(promise) },
      auth: { policyId: "fixture", policy: { requestCostMicros: fixed } },
      selection: { provider: { id: "xai" }, model: null, endpoint, body: wire.request.fields, capability },
      request: correlateIngressRequest(new Request("https://router.example/v1/proxy/xai/stt")).request,
    });
    assert.equal(owner.cost.basis, fixed == null ? "unpriced_request" : "policy_fixed");
    assert.equal(await owner.settle(200, "success", true, null, { reservations: [], reservedMicros: owner.cost.reserveMicros }, null), true);
    await Promise.all(pending); assert.equal(events.length, 1);
    assert.equal(events[0].cost_basis, fixed == null ? "unpriced_usage" : "policy_fixed");
    assert.equal(events[0].input_tokens, null); assert.equal(events[0].output_tokens, null);
    if (fixed != null) assert.equal(events[0].actual_cost_micros, fixed);
  }
});

test("ordinary xAI Chat and client functions or JSON named xai.stt retain independent token pricing", () => {
  const body = { messages: [{ role: "user", content: JSON.stringify({ requestFormat: "xai.stt", duration: 0 }) }],
    tools: [{ type: "function", function: { name: "xai_stt", parameters: {} } }] };
  assert.equal(requestPricingGap(pricing, body, "openai.chat_completions"), null);
  assert.notEqual(estimateModelCost(pricing, body, { request_format: "openai.chat_completions" }).pricingAvailable, false);
  assert.equal(actualModelCost(pricing, tokens, "openai.chat_completions"), 150);
});
