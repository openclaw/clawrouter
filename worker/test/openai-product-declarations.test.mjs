import assert from "node:assert/strict";
import test from "node:test";
import snapshot from "../generated/provider-snapshot.json" with { type: "json" };
import { resolveProviderOffer } from "../provider-offers.ts";

const provider = snapshot.providers.find(provider => provider.id === "openai");
const api = { provider: "openai", kind: "api_key" };
const subscription = { provider: "openai", kind: "subscription", accountId: "fixture-account" };

test("bundled OpenAI product offers resolve only through their declared transport", () => {
  for (const offer of provider.offer_definitions) {
    const member = offer.productId === "chatgpt-subscription";
    const mode = offer.endpoint === "realtime" ? "websocket" : "http";
    const resolved = resolveProviderOffer(provider, offer.id, member ? subscription : api, { mode });
    assert.equal(resolved?.definition.id, offer.id, offer.id);
    assert.equal(resolveProviderOffer(provider, offer.id, member ? api : subscription, { mode }), null, offer.id);
  }
});

test("bundled subscription offers preserve lifecycle, WebSocket and capability exclusions", () => {
  const offers = provider.offer_definitions.filter(offer => offer.productId === "chatgpt-subscription");
  assert.ok(offers.length > 0);
  for (const offer of offers) {
    assert.equal(offer.endpoint, "responses");
    assert.equal(offer.capability, "llm.responses");
    assert.equal(resolveProviderOffer(provider, offer.id, subscription, { mode: "websocket" }), null);
    assert.equal(resolveProviderOffer(provider, offer.id, subscription, { mode: "http", responsesLifecycle: true }), null);
  }
  const response = provider.offer_definitions.find(offer => offer.productId === "platform-api" && offer.endpoint === "responses");
  assert.ok(resolveProviderOffer(provider, response.id, api, { mode: "http", responsesLifecycle: true }));
  const decision = provider.offer_definitions.filter(offer => offer.capability === "llm.decisions");
  assert.deepEqual(decision.map(offer => [offer.productId, offer.model.id]), [["platform-api", "openai/gpt-6-luna"]]);
});
