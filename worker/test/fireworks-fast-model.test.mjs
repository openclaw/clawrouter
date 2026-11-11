import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { providerModel } = await import("../providers.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const { estimateModelCost, actualModelCost } = await import("../pricing.ts");

const manifest = parse(readFileSync(new URL("../../providers/fireworks.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([manifest]), provider = snapshot.providers[0];
const endpoint = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");
const model = provider.models.find(model => model.id === "fireworks/glm-5.3-fast");

test("Fireworks Fast preserves the frozen router ID, native payload and existing defaults", () => {
  assert.equal(provider.models[0].id, "fireworks/glm-5.2");
  const body = { model: model.id, messages: [{ role: "user", content: "fixture" }], stream: true,
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] };
  const before = structuredClone(body), prepared = prepareManifestRequest(provider, endpoint, body, {}, {});
  assert.deepEqual(prepared.body, { ...body, model: "accounts/fireworks/routers/glm-5p3-fast" });
  assert.deepEqual(body, before);
  assert.deepEqual(model.capabilities, ["llm.chat"]);
  assert.equal(model.nativeCapabilities.endpoints.chat_completions.contextWindow, 1048576);
  assert.equal(model.nativeCapabilities.endpoints.chat_completions.maxOutputTokens, undefined);
  assert.deepEqual(model.nativeCapabilities.endpoints.chat_completions.input, ["text"]);
  assert.equal(model.requestParameters.chat_completions.toolCalling, "supported");
  assert.equal(providerModel(provider, "accounts/fireworks/routers/future-fast", endpoint, true).pricing, null);
});

test("Fireworks Fast uses its own cached tariff and conservative full-context output ceiling", () => {
  const pricing = model.pricing;
  assert.deepEqual([pricing.inputMicrosPerMillion, pricing.cachedInputMicrosPerMillion, pricing.outputMicrosPerMillion], [2100000, 390000, 6600000]);
  assert.equal(pricing.checkedAt, "2026-11-03");
  assert.equal(estimateModelCost(pricing, { messages: [] }, endpoint).outputTokens, 1048576);
  assert.equal(estimateModelCost(pricing, { messages: [], max_tokens: 16 }, endpoint).outputTokens, 16);
  assert.equal(actualModelCost(pricing, { input: 1000, cached: 500, output: 100, serviceTier: "default" }, endpoint.request_format), 1905);
  assert.equal(actualModelCost(pricing, { input: 1000, cached: 500, output: 100 }, endpoint.request_format), null);
  assert.equal(snapshot.model_index[model.id].pricing_ref, "fireworks-glm-5p3-fast-2026-11-03");
});

test("Fireworks Fast admits only qualified standard aliases and denies priority pricing before dispatch", () => {
  const plain = { messages: [], max_tokens: 16 }, connection = { providerId: provider.id, monthlyBudgetMicros: 10000000 };
  const expected = estimateCost(model, plain, null, "llm.chat", endpoint);
  for (const service_tier of [undefined, "default", "auto", "flex"]) {
    const cost = estimateCost(model, { ...plain, ...(service_tier === undefined ? {} : { service_tier }) }, null, "llm.chat", endpoint);
    assert.equal(cost.basis, "manifest_pricing");
    assert.equal(validateBudgetReservation("llm.chat", cost, null, connection), true);
    assert.equal(estimateModelCost(model.pricing, { ...plain, service_tier }, endpoint).pricingAvailable, undefined);
  }
  assert.ok(expected.reserveMicros > 0);
  for (const service_tier of ["priority", "fast", "future"]) {
    const cost = estimateCost(model, { ...plain, service_tier }, null, "llm.chat", endpoint);
    assert.equal(cost.basis, "unpriced_service_tier");
    assert.throws(() => validateBudgetReservation("llm.chat", cost, null, connection), error => error.code === "pricing_required");
  }
});
