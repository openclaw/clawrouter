import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { requestPricingGap, estimateModelCost } = await import("../pricing.ts");
const { providerById } = await import("../providers.ts");
const pricing = providerById("google-gemini").models.find(model => model.upstream === "gemini-3.5-flash").pricing;
const free = { ...pricing, inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, outputMicrosPerMillion: 0 };
const foreignImage = providerById("openai").models.find(model => model.id === "openai/gpt-image-2.5-sunburst").pricing;
const format = "google.generate_content";
const plain = () => ({ contents: [{ role: "user", parts: [{ text: "Synthetic pricing context" }] }] });
const unknown = { reserveMicros: 0, inputTokens: null, outputTokens: null, pricingAvailable: false };

test("Google direct pricing consumes trusted selected image models before text, zero-rate or foreign image cards", () => {
  for (const selectedUpstreamModel of ["gemini-3.1-flash-image", "gemini-3-pro-image"]) for (const card of [pricing, free, foreignImage]) {
    assert.equal(requestPricingGap(card, plain(), format, undefined, selectedUpstreamModel), "opaque_input_bound");
    assert.deepEqual(estimateModelCost(card, plain(), { request_format: format, selectedUpstreamModel }), unknown);
  }
});

test("Google direct pricing uses the shared ProtoJSON output-modality classifier with no model context", () => {
  for (const generation of [
    { generationConfig: { responseModalities: ["TEXT", "IMAGE"] } },
    { generation_config: { response_modalities: [1, 2] } },
    { generationConfig: { responseModalities: ["2"] } },
  ]) {
    const body = { ...plain(), ...generation };
    assert.equal(requestPricingGap(pricing, body, format), "opaque_input_bound");
    assert.deepEqual(estimateModelCost(pricing, body, { request_format: format }), unknown);
  }
});

test("Google direct pricing preserves shared last-wins alias semantics rather than maintaining a second classifier", () => {
  const unset = { ...plain(), generationConfig: { responseModalities: ["IMAGE"] }, generation_config: null };
  assert.equal(requestPricingGap(pricing, unset, format), null);
  assert.notEqual(estimateModelCost(pricing, unset, { request_format: format }).pricingAvailable, false);
  const selectedUpstreamModel = "gemini-3-pro-image";
  assert.equal(requestPricingGap(pricing, unset, format, undefined, selectedUpstreamModel), "opaque_input_bound");
  assert.deepEqual(estimateModelCost(pricing, unset, { request_format: format, selectedUpstreamModel }), unknown);
});

test("Caller model fields, prompt JSON and unrelated formats cannot impersonate trusted Google image context", () => {
  const body = { ...plain(), model: "gemini-3-pro-image", metadata: { generationConfig: { responseModalities: ["IMAGE"] } } };
  body.contents[0].parts[0].text = JSON.stringify({ model: "gemini-3-pro-image", responseModalities: ["IMAGE"] });
  assert.equal(requestPricingGap(pricing, body, format), null);
  assert.notEqual(estimateModelCost(pricing, body, { request_format: format, selectedUpstreamModel: "gemini-3.5-flash" }).pricingAvailable, false);
  assert.equal(requestPricingGap(pricing, { messages: [{ role: "user", content: body.contents[0].parts[0].text }] }, "openai.chat_completions", undefined, "gemini-3-pro-image"), null);
});

test("Explicit native Google image format retains the landed guard without selected context or a token tariff", () => {
  assert.equal(requestPricingGap(null, plain(), "google.image_generate"), "opaque_input_bound");
  assert.deepEqual(estimateModelCost(pricing, plain(), { request_format: "google.image_generate" }), unknown);
});
