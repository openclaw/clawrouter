import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream, providerModel } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const manifest = parse(readFileSync(new URL("../../providers/minimax.provider.yaml", import.meta.url), "utf8"));
const compiled = compileProviderSnapshot([manifest]), provider = compiled.providers[0];
const endpoint = provider.endpoints.find(value => value.id === "chat_completions");
const model = provider.models.find(value => value.upstream === "MiniMax-M3");
const plain = () => ({ model: model.id, messages: [{ role: "user", content: "Synthetic frozen model fixture" }] });

test("MiniMax M3 preserves exact identity and decimal context facts without manufacturing output or price bounds", () => {
  assert.equal(model.id, "minimax/MiniMax-M3"); assert.deepEqual(model.capabilities, ["llm.chat"]);
  assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
  const facts = model.nativeCapabilities.endpoints.chat_completions;
  assert.equal(facts.contextWindow, 1_000_000); assert.equal(facts.maxOutputTokens, undefined);
  assert.equal(facts.contextTokens, undefined); assert.deepEqual(facts.input, ["text", "image", "video"]);
  assert.equal(facts.supportedServiceTiers, undefined); assert.deepEqual(facts.inference, { chat: true });
  assert.deepEqual(compiled.model_index[model.id].nativeCapabilities, model.nativeCapabilities);
  assert.equal(model.availability, undefined); assert.equal(model.endpointPricing, undefined);
});

test("MiniMax M3 uses the existing selected-key Chat transport and preserves explicit priority requests", () => {
  for (const service_tier of [undefined, "standard", "priority"]) {
    const body = { ...plain(), ...(service_tier ? { service_tier } : {}) };
    const prepared = prepareManifestRequest(provider, endpoint, body, {}, {});
    assert.equal(prepared.model.upstream, "MiniMax-M3"); assert.equal(prepared.body.model, "MiniMax-M3");
    assert.equal(prepared.body.service_tier, service_tier); assert.deepEqual(prepared.body.messages, body.messages);
  }
  const upstream = configuredUpstream(provider, null, { MINIMAX_API_KEY: "synthetic-selected-key" });
  assert.equal(upstream.baseUrl, "https://api.minimax.io"); assert.equal(endpoint.path, "/v1/chat/completions");
  assert.equal(endpoint.request_format, "openai.chat_completions"); assert.equal(endpoint.response_format, "openai.chat_completions");
  assert.equal(upstream.headers.get("Authorization"), "Bearer synthetic-selected-key");
});

test("MiniMax M3 context and tier observations cannot certify unknown hard-dollar costs", () => {
  for (const body of [plain(), { ...plain(), service_tier: "priority", max_completion_tokens: 16 },
    { ...plain(), service_tier: "standard", max_tokens: 0 }]) {
    const cost = estimateCost(model, body, null, "llm.chat", endpoint);
    assert.equal(cost.basis, "flat_fallback"); assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
    for (const [caller, providerLimit] of [[10000, null], [null, 10000], [10000, 10000]]) {
      assert.throws(() => validateBudgetReservation("llm.chat", cost, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
    }
    for (const fixed of [0, 17]) assert.deepEqual(estimateCost(model, body, fixed, "llm.chat", endpoint),
      { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
  }
});

test("MiniMax M3 does not change the existing M2.7 card, route, default order or unknown model passthrough", () => {
  assert.equal(provider.models[0].upstream, "MiniMax-M2.7");
  assert.equal(provider.models[0].pricing_ref, "minimax-m2-7-standard-2026-06-22");
  assert.equal(provider.models[0].pricing.inputMicrosPerMillion, 300000);
  assert.equal(provider.models[0].pricing.outputMicrosPerMillion, 1200000);
  assert.equal(provider.endpoints.length, 1); assert.deepEqual(endpoint.modelPassthrough, { pricing_ref: null, pricing: null });
  const unknown = providerModel(provider, "synthetic-unknown-model", endpoint);
  assert.equal(unknown.pricing, null); assert.equal(unknown.nativeCapabilities, undefined);
});
