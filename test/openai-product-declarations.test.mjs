import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";

const manifest = parse(readFileSync(new URL("../providers/openai.provider.yaml", import.meta.url), "utf8"));

test("OpenAI products explicitly cover the registered API and existing subscription transport", () => {
  const api = manifest.products.find(product => product.id === "platform-api");
  const subscription = manifest.products.find(product => product.id === "chatgpt-subscription");
  assert.deepEqual(manifest.products.map(product => product.id).sort(), ["chatgpt-subscription", "platform-api"]);
  assert.deepEqual(api.binding, { type: "provider-default" });
  assert.deepEqual(subscription.binding, { type: "grant-transport", grantKind: "subscription" });
  assert.deepEqual([...api.endpoints].sort(), Object.keys(manifest.endpoints).sort());
  assert.deepEqual(subscription.endpoints, manifest.auth.grantTransports.subscription.allowedEndpoints);
  assert.equal(api.offers.length, manifest.capabilities.length);
  const modelFree = new Set(["models_list", "models_retrieve", "standalone_search"]);
  for (const capability of manifest.capabilities) {
    const offer = api.offers.find(offer => offer.endpoint === capability.endpoint && offer.capability === capability.id);
    assert.ok(offer, capability.id);
    const models = modelFree.has(capability.endpoint) ? null
      : manifest.models.entries.filter(model => model.capabilities.includes(capability.id)).map(model => model.id).sort();
    assert.deepEqual(offer.models?.slice().sort() ?? null, models, capability.id);
  }
  assert.deepEqual(subscription.offers, [api.offers.find(offer => offer.endpoint === "responses")]);
  assert.ok(api.endpoints.includes("responses_retrieve") && api.endpoints.includes("responses_cancel"));
  assert.ok(!subscription.endpoints.includes("responses_retrieve"));
});

test("OpenAI product declarations preserve the entire legacy execution snapshot", () => {
  const compiled = compileProviderSnapshot([manifest]);
  const legacy = structuredClone(manifest);
  delete legacy.products;
  const { products, offer_definitions, ...execution } = compiled.providers[0];
  assert.ok(products.length === 2 && offer_definitions.length > 0);
  assert.deepEqual({ ...compiled, providers: [execution] }, compileProviderSnapshot([legacy]));
  const bundled = JSON.parse(readFileSync(new URL("../worker/generated/provider-snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(compiled.providers[0], bundled.providers.find(provider => provider.id === "openai"));
});
