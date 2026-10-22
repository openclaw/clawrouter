import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { anthropicModifiers, anthropicPricing } from "../anthropic-pricing.ts";
import { actualModelCost, estimateModelCost } from "../pricing.ts";
import { guardAnthropicPrice } from "../anthropic-price-response.ts";
import { HttpOperation } from "../http-operation.ts";
import { providerById } from "../providers.ts";

const model = providerById("anthropic").models.find(model => model.upstream === "claude-opus-5-5");
const request = { speed: "fast", inferenceGeo: "us", serviceTier: "standard_only" };
const served = { speed: "fast", inferenceGeo: "us", serviceTier: "standard" };

test("modifiers compose with a context tariff after inclusive cache input chooses the tier", () => {
  // Synthetic future context card, not a claim that current Opus has a premium.
  const pricing = { ...model.pricing, longContext: { ...model.pricing, thresholdInputTokens: 1000, inputMicrosPerMillion: 8_000_000, outputMicrosPerMillion: 40_000_000, cachedInputMicrosPerMillion: 400_000, cacheWrite5mInputMicrosPerMillion: 10_000_000, cacheWrite1hInputMicrosPerMillion: 16_000_000 } };
  const card = anthropicPricing(pricing, model.upstream, request, served);
  assert.equal(actualModelCost(card, { input: 1400, output: 20, cached: 1000, cacheWrite: 300, cacheWrite5m: 200, cacheWrite1h: 100 }), 12320);
  const estimate = estimateModelCost(anthropicPricing(pricing, model.upstream, request), { messages: [{ role: "user", content: "x".repeat(1100) }], max_tokens: 20 }, { request_format: "anthropic.messages" });
  assert.ok(estimate.reserveMicros > 12320);
  assert.equal(pricing.longContext.inputMicrosPerMillion, 8_000_000, "qualification does not mutate the frozen base card");
});

test("invalid modifier evidence stays distinct from omitted fields", () => {
  for (const value of [1, {}, [], "x".repeat(65)]) {
    assert.deepEqual(anthropicModifiers({ speed: value }), { speed: "invalid" });
    assert.equal(anthropicPricing(model.pricing, model.upstream, request, anthropicModifiers({ speed: value, inference_geo: "us", service_tier: "standard" })), null);
  }
  assert.equal(anthropicPricing(model.pricing, "claude-future", request), null);
  assert.equal(anthropicPricing(model.pricing, model.upstream, {}, {}).inputMicrosPerMillion, 4_400_000, "unknown workspace geography settles at the reserved US bound");
  assert.deepEqual(anthropicModifiers({ speed: null }), { speed: null });
  assert.equal(anthropicPricing(model.pricing, model.upstream, request, { speed: null, inferenceGeo: null, serviceTier: null }).inputMicrosPerMillion, 8_800_000);
  assert.equal(anthropicPricing(model.pricing, model.upstream, { speed: null, inferenceGeo: null, serviceTier: null }).inputMicrosPerMillion, 4_400_000);
});

test("hard-budget SSE guard preserves backpressure, exact UTF-8 frames and upstream cancellation", async () => {
  const text = 'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\r\n\r\n';
  const content = 'event: content_block_delta\n' + 'data: {"type":"content_block_delta","delta":{"text":"é🐾"}}\n\n';
  let pulls = 0, canceled = false;
  const chunks = [text, content].map(value => new TextEncoder().encode(value));
  const response = new Response(new ReadableStream({ pull(controller) { if (pulls < chunks.length) controller.enqueue(chunks[pulls++]); }, cancel() { canceled = true; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const guard = await guardAnthropicPrice(response, () => true, new HttpOperation());
  assert.equal(pulls, 0);
  const reader = guard.response.body.getReader();
  assert.deepEqual((await reader.read()).value, chunks[0]);
  assert.equal(pulls, 1);
  assert.deepEqual((await reader.read()).value, chunks[1]);
  assert.equal(pulls, 2);
  await reader.cancel(); assert.equal(canceled, true); assert.equal(guard.failure(), undefined);
});
