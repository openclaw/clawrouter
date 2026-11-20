import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");

// Synthetic future endpoint; no new bundled MiniMax route is activated.
function fixture() {
  const manifest = parse(readFileSync(new URL("../../providers/minimax.provider.yaml", import.meta.url), "utf8"));
  manifest.capabilities.push({ id: "llm.messages", endpoint: "messages", methods: ["POST"] });
  manifest.endpoints.messages = { path: "/anthropic/v1/messages", requestFormat: "anthropic.messages", responseFormat: "anthropic.messages", streaming: "sse" };
  const model = manifest.models.entries[0];
  model.capabilities.push("llm.messages");
  model.endpointPricing = { messages: { pricingRef: "native-messages-accounting-unqualified", pricing: null } };
  return manifest;
}
const compile = manifest => compileProviderSnapshot([manifest]);

test("explicit endpoint null survives compilation and selection without removing the priced Chat card", () => {
  const snapshot = compile(fixture()), provider = snapshot.providers[0], model = provider.models[0];
  const chat = provider.endpoints.find(endpoint => endpoint.id === "chat_completions"), messages = provider.endpoints.find(endpoint => endpoint.id === "messages");
  const native = prepareManifestRequest(provider, messages, { model: model.id, messages: [] }, {}, {});
  const ordinary = prepareManifestRequest(provider, chat, { model: model.id, messages: [] }, {}, {});
  assert.equal(native.model.pricing, null);
  assert.equal(native.model.pricing_ref, "native-messages-accounting-unqualified");
  assert.deepEqual(ordinary.model.pricing, model.pricing);
  assert.equal(model.pricing.inputMicrosPerMillion, 300000, "selected null cannot mutate the shared fallback card");
  assert.deepEqual(snapshot.model_index[model.id].endpointPricing, model.endpointPricing);
  assert.equal(snapshot.model_index[model.id].endpointPricing.messages.pricing, null);
  assert.equal(ordinary.body.model, "MiniMax-M2.7");
});

test("unknown endpoint cost denies hard budgets while explicit policy prices remain distinct", () => {
  const provider = compile(fixture()).providers[0], original = provider.models[0];
  const messages = provider.endpoints.find(endpoint => endpoint.id === "messages"), chat = provider.endpoints.find(endpoint => endpoint.id === "chat_completions");
  const body = { model: original.id, messages: [], max_tokens: 16 };
  const model = prepareManifestRequest(provider, messages, body, {}, {}).model;
  const unknown = estimateCost(model, body, null, "llm.messages", messages);
  assert.equal(unknown.basis, "flat_fallback");
  const priced = estimateCost(original, body, null, "llm.chat", chat);
  assert.equal(priced.basis, "manifest_pricing");
  for (const [policyLimit, providerLimit] of [[1000000, null], [null, 1000000]]) {
    const connection = { providerId: provider.id, monthlyBudgetMicros: providerLimit };
    assert.throws(() => validateBudgetReservation("llm.messages", unknown, policyLimit, connection), error => error.code === "pricing_required");
    assert.equal(validateBudgetReservation("llm.chat", priced, policyLimit, connection), true);
    for (const amount of [0, 25]) {
      const fixed = estimateCost(model, body, amount, "llm.messages", messages);
      assert.equal(fixed.basis, "policy_fixed");
      assert.equal(fixed.reserveMicros, amount);
      assert.equal(validateBudgetReservation("llm.messages", fixed, policyLimit, connection), true);
    }
  }
});

test("unpriced overrides still require a named supported endpoint and explicit nonempty provenance", () => {
  for (const mutate of [
    m => { delete m.models.entries[0].endpointPricing.messages.pricing; },
    m => { delete m.models.entries[0].endpointPricing.messages.pricingRef; },
    m => { m.models.entries[0].endpointPricing.messages.pricingRef = ""; },
    m => { m.models.entries[0].endpointPricing.messages.pricing = false; },
    m => { m.models.entries[0].endpointPricing.messages.pricing = 0; },
    m => { m.models.entries[0].endpointPricing.messages.pricing = {}; },
    m => { m.models.entries[0].endpointPricing.missing = m.models.entries[0].endpointPricing.messages; },
    m => { m.models.entries[0].capabilities = ["llm.chat"]; },
  ]) {
    const manifest = fixture(); mutate(manifest);
    assert.throws(() => compile(manifest), /invalid manifest|supported endpoint/);
  }
  const inherited = fixture(); delete inherited.models.entries[0].endpointPricing;
  const provider = compile(inherited).providers[0], endpoint = provider.endpoints.find(endpoint => endpoint.id === "messages");
  assert.equal(prepareManifestRequest(provider, endpoint, { model: provider.models[0].id, messages: [] }, {}, {}).model.pricing.inputMicrosPerMillion, 300000);
});
