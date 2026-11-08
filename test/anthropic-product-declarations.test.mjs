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
  assert.deepEqual(subscription.offers, api.offers.filter(offer => subscription.endpoints.includes(offer.endpoint)));
});

test("Anthropic product declarations preserve the entire legacy execution snapshot", () => {
  const compiled = compileProviderSnapshot([manifest]);
  const legacy = structuredClone(manifest);
  delete legacy.products;
  const { products, offer_definitions, ...execution } = compiled.providers[0];
  assert.equal(products.length, 2);
  assert.equal(offer_definitions.length, 42);
  assert.deepEqual({ ...compiled, providers: [execution] }, compileProviderSnapshot([legacy]));
  const bundled = JSON.parse(readFileSync(new URL("../worker/generated/provider-snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(compiled.providers[0], bundled.providers.find(provider => provider.id === "anthropic"));
});
