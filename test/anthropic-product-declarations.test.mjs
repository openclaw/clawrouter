import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";

const manifest = parse(readFileSync(new URL("../providers/anthropic.provider.yaml", import.meta.url), "utf8"));

test("Anthropic products cover API operations and the existing subscription transport", () => {
  const api = manifest.products.find(product => product.id === "platform-api");
  const subscription = manifest.products.find(product => product.id === "claude-subscription");
  assert.deepEqual(manifest.products.map(product => product.id).sort(), ["claude-subscription", "platform-api"]);
  assert.deepEqual(api.binding, { type: "provider-default" });
  assert.deepEqual(subscription.binding, { type: "grant-transport", grantKind: "subscription" });
  assert.deepEqual([...api.endpoints].sort(), Object.keys(manifest.endpoints).sort());
  assert.equal(api.offers.length, manifest.capabilities.length);
  for (const capability of manifest.capabilities) {
    const offer = api.offers.find(offer => offer.endpoint === capability.endpoint && offer.capability === capability.id);
    assert.ok(offer, capability.id);
    const models = capability.id.startsWith("models.") ? null
      : manifest.models.entries.filter(model => model.capabilities.includes(capability.id)).map(model => model.id).sort();
    assert.deepEqual(offer.models?.slice().sort() ?? null, models, capability.id);
  }
  assert.deepEqual(subscription.endpoints, ["messages", "count_tokens"]);
  const subscriptionModels = ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-2", "claude-fable-5-1", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"].map(id => "anthropic/" + id);
  assert.deepEqual(subscription.offers, [
    { endpoint: "messages", capability: "llm.messages", models: subscriptionModels },
    { endpoint: "count_tokens", capability: "llm.count_tokens", models: subscriptionModels },
  ]);
  assert.ok(!subscriptionModels.includes("anthropic/claude-mythos-5"), "API membership grants no subscription entitlement");
});

test("Anthropic product declarations preserve the entire legacy execution snapshot", () => {
  const compiled = compileProviderSnapshot([manifest]);
  const legacy = structuredClone(manifest);
  delete legacy.products;
  const { products, offer_definitions, ...execution } = compiled.providers[0];
  assert.equal(products.length, 2);
  const declaredOffers = manifest.products.flatMap(product => product.offers.flatMap(offer => (offer.models ?? [null]).map(model => [product.id, offer.endpoint, offer.capability, model])));
  assert.equal(new Set(declaredOffers.map(row => JSON.stringify(row))).size, declaredOffers.length);
  assert.equal(offer_definitions.length, declaredOffers.length);
  assert.deepEqual({ ...compiled, providers: [execution] }, compileProviderSnapshot([legacy]));
  const bundled = JSON.parse(readFileSync(new URL("../worker/generated/provider-snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(compiled.providers[0], bundled.providers.find(provider => provider.id === "anthropic"));
});
