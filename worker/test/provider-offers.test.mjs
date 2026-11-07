import assert from "node:assert/strict";
import test from "node:test";
import snapshot from "../generated/provider-snapshot.json" with { type: "json" };
import { resolveProviderOffer } from "../provider-offers.ts";
import { bindingSupportsOperation, productSupportsBinding, transportForGrant } from "../../shared/provider-bindings.ts";

function fixture() {
  const provider = structuredClone(snapshot.providers.find(provider => provider.id === "openai"));
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "responses");
  const model = provider.models.find(model => model.capabilities.includes("llm.responses") && !model.availability);
  assert.ok(endpoint && model);
  const controls = Object.values(endpoint.responsesLifecycle ?? {});
  provider.products = [
    { id: "api", displayName: "API", commercialModel: "metered", authenticationMethod: "api-key",
      binding: { type: "provider-default" }, endpoints: [endpoint.id, ...controls],
      offers: [{ endpoint: endpoint.id, capability: "llm.responses", models: [model.id] }] },
    { id: "membership", displayName: "Membership", commercialModel: "subscription", authenticationMethod: "oauth2",
      binding: { type: "grant-transport", grantKind: "subscription" }, endpoints: [endpoint.id],
      offers: [{ endpoint: endpoint.id, capability: "llm.responses", models: [model.id] }] },
  ];
  provider.offer_definitions = provider.products.map(product => ({ id: product.id, providerId: provider.id,
    productId: product.id, endpoint: endpoint.id, capability: "llm.responses", model: { id: model.id, upstream: model.upstream },
    qualification: "declared" }));
  return { provider, endpoint, model };
}

const api = { provider: "openai", kind: "api_key" };
const subscription = { provider: "openai", kind: "subscription" };
const http = { mode: "http" };

test("one model resolves to separate API and subscription products without auth inference or I/O", t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network call"); });
  const { provider } = fixture();
  const before = structuredClone(provider);
  assert.equal(resolveProviderOffer(provider, "api", api, http)?.product.id, "api");
  assert.equal(resolveProviderOffer(provider, "api", null, http)?.product.id, "api");
  assert.equal(resolveProviderOffer(provider, "api", { provider: "openai", kind: "oauth" }, http)?.product.id, "api");
  assert.equal(resolveProviderOffer(provider, "api", subscription, http), null);
  const member = resolveProviderOffer(provider, "membership", subscription, http);
  assert.equal(member?.product.id, "membership");
  assert.equal(member.status, "compatible");
  assert.equal(member.transport, transportForGrant(provider, subscription));
  assert.equal(resolveProviderOffer(provider, "membership", api, http), null);
  assert.equal(resolveProviderOffer(provider, "membership", null, http), null);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(provider, before);
});

test("product and grant transport allowlists both retain lifecycle recovery boundaries", () => {
  const { provider, endpoint } = fixture();
  assert.ok(endpoint.responsesLifecycle);
  const background = { mode: "http", responsesLifecycle: true };
  assert.ok(resolveProviderOffer(provider, "api", api, background));
  assert.equal(resolveProviderOffer(provider, "membership", subscription, background), null);
  provider.products[0].endpoints = [endpoint.id];
  assert.equal(resolveProviderOffer(provider, "api", api, background), null);
  assert.ok(bindingSupportsOperation({ ...background, provider, endpoint }, api));
  assert.equal(productSupportsBinding({ ...background, provider, endpoint }, provider.products[0], api), false);
  assert.ok(resolveProviderOffer(provider, "api", api, http));
});

test("managed result and file controls must belong to the selected product", () => {
  const { provider, endpoint } = fixture();
  endpoint.request_format = "fixture.create";
  endpoint.response_format = "fixture.create";
  endpoint.lifecycle = { protocol: "replicate.predictions", retrieve: "inspect", cancel: "stop", result: "result",
    files: { metadata: "metadata", download: "download" } };
  delete endpoint.responsesLifecycle;
  const controls = ["inspect", "stop", "result", "metadata", "download"];
  provider.endpoints.push(...controls.map(id => ({ ...endpoint, id, lifecycle: undefined })));
  provider.products[0].endpoints = [endpoint.id, ...controls];
  const operation = { mode: "http", managedLifecycle: true };
  assert.ok(resolveProviderOffer(provider, "api", api, operation));
  for (const omitted of controls) {
    provider.products[0].endpoints = [endpoint.id, ...controls.filter(id => id !== omitted)];
    assert.equal(resolveProviderOffer(provider, "api", api, operation), null, omitted);
  }
});

test("websocket compatibility retains the existing default-transport restriction", () => {
  const { provider, endpoint } = fixture();
  endpoint.websocket = "openai.responses";
  assert.ok(resolveProviderOffer(provider, "api", api, { mode: "websocket" }));
  assert.equal(resolveProviderOffer(provider, "membership", subscription, { mode: "websocket" }), null);
  endpoint.websocket = "openai.realtime";
  assert.equal(resolveProviderOffer(provider, "api", api, http), null);
  assert.equal(resolveProviderOffer(provider, "api", { ...api, kind: "oauth" }, { mode: "websocket" }), null);
});

test("unknown, disabled, foreign and stale references cannot resolve", () => {
  const { provider, model } = fixture();
  assert.equal(resolveProviderOffer(provider, "missing", api, http), null);
  assert.equal(resolveProviderOffer(provider, "api", { ...api, enabled: false }, http), null);
  assert.equal(resolveProviderOffer(provider, "api", { ...api, provider: "other" }, http), null);
  assert.equal(resolveProviderOffer(provider, "api", { kind: "api_key" }, http), null);
  for (const mutate of [
    p => p.offer_definitions[0].providerId = "other",
    p => p.offer_definitions[0].qualification = "eligible",
    p => p.offer_definitions[0].model.upstream = "different/alias",
    p => p.products[0].offers = [],
    p => p.models.find(row => row.id === model.id).capabilities = [],
    p => p.models.find(row => row.id === model.id).availability = { version: "clawrouter.model-availability.v1", status: "stopped" },
    p => delete p.auth.grantTransports.subscription,
  ]) {
    const changed = structuredClone(provider);
    mutate(changed);
    const id = changed.auth.grantTransports.subscription ? "api" : "membership";
    assert.equal(resolveProviderOffer(changed, id, id === "api" ? api : subscription, http), null);
  }
});

test("endpoint pricing is preserved, including an explicitly unpriced card", () => {
  const { provider, model, endpoint } = fixture();
  model.endpointPricing = { [endpoint.id]: { pricing_ref: "fixture-unpriced", pricing: null } };
  const result = resolveProviderOffer(provider, "api", api, http);
  assert.equal(result.model.pricing_ref, "fixture-unpriced");
  assert.equal(result.model.pricing, null);
  assert.notEqual(result.model, model);
});

test("model-free declarations still pass through provider-specific grant qualification", () => {
  const { provider } = fixture();
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "models_list");
  assert.ok(endpoint);
  provider.products[0].endpoints = [endpoint.id];
  provider.products[0].offers = [{ endpoint: endpoint.id, capability: "models.list", models: null }];
  Object.assign(provider.offer_definitions[0], { endpoint: endpoint.id, capability: "models.list", model: null });
  assert.equal(resolveProviderOffer(provider, "api", null, http), null);
  assert.equal(resolveProviderOffer(provider, "api", api, http)?.model, null);
});
