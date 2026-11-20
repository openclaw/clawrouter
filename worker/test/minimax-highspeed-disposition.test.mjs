import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream, providerModel } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const manifest = parse(readFileSync(new URL("../../providers/minimax.provider.yaml", import.meta.url), "utf8"));
const compiled = compileProviderSnapshot([manifest]), provider = compiled.providers[0];
const endpoint = provider.endpoints.find(row => row.id === "chat_completions");
const model = provider.models.find(row => row.upstream === "MiniMax-M2.7-highspeed");
const messages = [{ role: "user", content: "Synthetic disposition fixture" }];

test("the dated highspeed PAYG restriction remains deprecated without a plan alias or invented facts", () => {
  assert.equal(model.id, "minimax/MiniMax-M2.7-highspeed");
  assert.deepEqual(model.capabilities, ["llm.chat"]);
  assert.deepEqual(model.availability, {
    version: "clawrouter.model-availability.v1", status: "deprecated",
    effectiveAt: "2026-10-19", checkedAt: "2026-11-04",
    sources: ["https://platform.minimax.io/docs/faq/models", "https://platform.minimax.io/docs/release-notes/models"],
  });
  assert.deepEqual(compiled.model_index[model.id].availability, model.availability);
  assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
  assert.equal(model.nativeCapabilities, undefined); assert.equal(model.endpointPricing, undefined);
  const offer = createRouteCatalog([provider]).manifestProxy.find(row => row.endpoint === endpoint.id);
  assert.deepEqual(offer.models.find(row => row.id === model.id).availability, model.availability);
});

test("highspeed native and manifest selection preserve the PAYG identity and selected original key", () => {
  for (const native of [false, true]) for (const id of [model.id, model.upstream]) {
    const body = { model: id, messages, stream: true };
    const selected = prepareManifestRequest(provider, endpoint, body, {}, {}, native);
    assert.equal(selected.model.id, model.id); assert.equal(selected.body.model, model.upstream);
    assert.deepEqual(selected.body.messages, messages); assert.equal(selected.body.stream, true);
    assert.equal(selected.model.availability.servingModel, undefined);
  }
  const upstream = configuredUpstream(provider, null, { MINIMAX_API_KEY: "synthetic-selected-key" });
  assert.equal(upstream.baseUrl, "https://api.minimax.io");
  assert.equal(upstream.headers.get("Authorization"), "Bearer synthetic-selected-key");
  assert.equal(endpoint.path, "/v1/chat/completions");
  assert.equal(endpoint.request_format, "openai.chat_completions");
  assert.equal(endpoint.response_format, "openai.chat_completions");
});

test("highspeed unknown prices deny both upstream-dollar budgets without inheriting the ordinary M2.7 rate", () => {
  for (const extra of [{}, { service_tier: "priority", max_completion_tokens: 16 }, { max_tokens: 0 }]) {
    const body = { model: model.upstream, messages, ...extra };
    const cost = estimateCost(model, body, null, "llm.chat", endpoint);
    assert.equal(cost.basis, "flat_fallback"); assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
    for (const [caller, providerLimit] of [[10000, null], [null, 10000], [10000, 10000]]) {
      assert.throws(() => validateBudgetReservation("llm.chat", cost, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
    }
    for (const fixed of [0, 17]) assert.deepEqual(estimateCost(model, body, fixed, "llm.chat", endpoint),
      { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
  }
});

test("the highspeed disposition preserves the default, existing price card and unknown-model passthrough", () => {
  assert.equal(provider.models[0].upstream, "MiniMax-M2.7");
  assert.equal(provider.models[0].pricing_ref, "minimax-m2-7-standard-2026-06-22");
  assert.equal(provider.models[0].pricing.inputMicrosPerMillion, 300000);
  assert.equal(provider.models[0].pricing.outputMicrosPerMillion, 1200000);
  assert.equal(provider.endpoints.length, 1);
  assert.deepEqual(endpoint.modelPassthrough, { pricing_ref: null, pricing: null });
  const unknown = providerModel(provider, "synthetic-unknown-model", endpoint);
  assert.equal(unknown.pricing, null); assert.equal(unknown.availability, undefined);
});
