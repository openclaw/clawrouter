import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const { requestPricingGap, estimateModelCost, actualModelCost } = await import("../pricing.ts");
const { estimateCost, createProxyAccounting } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { providerById } = await import("../providers.ts");
const { prepareXaiSpeech, readXaiSpeech, xaiSpeechFormats } = await import("../xai-speech.ts");
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/xai/speech.json", import.meta.url), "utf8"));
const pricing = providerById("xai").models.find(model => model.upstream === "grok-4.3").pricing;
const free = { ...pricing, inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, outputMicrosPerMillion: 0, longContext: undefined };
const foreign = providerById("openai").models.find(model => model.id === "openai/gpt-image-2.5-sunburst").pricing;
const endpoint = { request_format: "xai.tts" }, capability = "audio.speech";
const tokens = { input: 100, output: 10, total: 110, cached: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

test("native xAI speech text and codec settings have no token or image-price estimate regardless of a supplied card", () => {
  const native = prepareXaiSpeech(wire.request);
  assert.equal(Object.hasOwn(native.body, "model"), false); assert.equal(native.path, "/v1/tts");
  for (const card of [pricing, free, foreign]) {
    assert.equal(requestPricingGap(card, wire.request, endpoint.request_format), "opaque_input_bound");
    assert.deepEqual(estimateModelCost(card, wire.request, endpoint),
      { reserveMicros: 0, inputTokens: null, outputTokens: null, pricingAvailable: false });
  }
  assert.equal(requestPricingGap(null, wire.request, endpoint.request_format), "opaque_input_bound");
});

test("native TTS hard-dollar admission stays closed while explicit policy-fixed remains separate", () => {
  for (const model of [null, { upstream: "synthetic-unrelated-card", pricing }, { pricing: free }, { pricing: foreign }]) {
    for (const label of [capability, "llm.generate", "llm.stream"]) {
      const cost = estimateCost(model, wire.request, null, label, endpoint);
      assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.pricingGap, "opaque_input_bound");
      assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
      for (const [caller, provider] of [[10000, null], [null, 10000]]) {
        assert.throws(() => validateBudgetReservation(label, cost, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
        for (const fixed of [0, 17]) {
          const explicit = estimateCost(model, wire.request, fixed, label, endpoint);
          assert.deepEqual(explicit, { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
          assert.doesNotThrow(() => validateBudgetReservation(label, explicit, caller, { monthlyBudgetMicros: provider }));
        }
      }
    }
  }
});

test("complete native speech bytes and service defaults do not qualify an invoice or zero token settlement", async () => {
  for (const [codec, mime] of Object.entries(xaiSpeechFormats)) {
    const prepared = prepareXaiSpeech({ ...wire.request, output_format: { codec } });
    const result = await readXaiSpeech(new Response(Uint8Array.from(wire.audioBytes), { headers: { "content-type": mime } }), prepared, new AbortController().signal);
    assert.equal(result.upstreamCostMicros, null); assert.equal(result.sampleRateBasis, "service_default");
    for (const card of [pricing, free, foreign]) for (const usage of [tokens, { ...tokens, input: 0, output: 0 },
      { ...tokens, billable: false }, { ...tokens, input: null, output: null }]) assert.equal(actualModelCost(card, usage, endpoint.request_format), null);
  }
});

test("model-less native accounting labels unknown TTS cost and preserves separately authorized fixed charges", async () => {
  for (const fixed of [null, 0, 17]) {
    const events = [], pending = [], owner = createProxyAccounting({
      env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: { waitUntil: promise => pending.push(promise) },
      auth: { policyId: "fixture", policy: { requestCostMicros: fixed } },
      selection: { provider: { id: "xai" }, model: null, endpoint, body: wire.request, capability },
      request: correlateIngressRequest(new Request("https://router.example/v1/proxy/xai/tts")).request,
    });
    assert.equal(owner.cost.basis, fixed == null ? "unpriced_request" : "policy_fixed");
    assert.equal(await owner.settle(200, "success", true, null, { reservations: [], reservedMicros: owner.cost.reserveMicros }, null), true);
    await Promise.all(pending); assert.equal(events.length, 1);
    assert.equal(events[0].cost_basis, fixed == null ? "unpriced_usage" : "policy_fixed");
    assert.equal(events[0].input_tokens, null); assert.equal(events[0].output_tokens, null);
    if (fixed != null) assert.equal(events[0].actual_cost_micros, fixed);
  }
});

test("ordinary xAI Chat and client functions or JSON named xai.tts retain independent token pricing", () => {
  const body = { messages: [{ role: "user", content: JSON.stringify({ requestFormat: "xai.tts", duration: 0 }) }],
    tools: [{ type: "function", function: { name: "xai_tts", parameters: {} } }] };
  assert.equal(requestPricingGap(pricing, body, "openai.chat_completions"), null);
  assert.notEqual(estimateModelCost(pricing, body, { request_format: "openai.chat_completions" }).pricingAvailable, false);
  assert.equal(actualModelCost(pricing, tokens, "openai.chat_completions"), 150);
});
