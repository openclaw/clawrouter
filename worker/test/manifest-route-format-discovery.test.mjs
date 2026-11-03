import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const cases = [["cohere", "embed"], ["voyage", "embeddings"], ["google-gemini", "embed_content"], ["google-gemini", "batch_embed_contents"]];

async function setup(t, providerId, endpointId, { native = false, pooled = false } = {}) {
  const original = snapshot.providers, source = structuredClone(original.find(provider => provider.id === providerId));
  assert.ok(source); snapshot.providers = original.filter(provider => provider.id !== providerId);
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { providerId, pooled, configure(provider) {
    Object.assign(provider, source);
    provider.endpoints.find(endpoint => endpoint.id === endpointId).native_proxy = native;
  } });
  // The real compiled snapshot is immutable; use a new object for this test's
  // modified declaration so its cached static projection cannot predate it.
  const replacement = structuredClone(f.provider);
  snapshot.providers = snapshot.providers.map(provider => provider === f.provider ? replacement : provider);
  f.provider = replacement; f.endpoint = replacement.endpoints.find(endpoint => endpoint.id === endpointId);
  f.env[source.config_keys[0]] = "synthetic-catalog-environment";
  f.catalog = async () => {
    const response = await f.call("/v1/catalog", null); assert.equal(response.status, 200);
    return response.json();
  };
  t.after(f.drain); return f;
}

for (const [providerId, endpointId] of cases) for (const native of [false, true]) for (const pooled of [false, true]) {
  test(`${providerId}/${endpointId} ${native ? "native" : "manifest"} ${pooled ? "grant" : "environment"} catalog preserves exact payload formats`, { timeout: 10_000 }, async t => {
    const f = await setup(t, providerId, endpointId, { native, pooled }), catalog = await f.catalog();
    const provider = catalog.providers.find(provider => provider.id === providerId), route = provider.routes.find(route => route.endpoint === endpointId);
    assert.ok(route, "eligible manifest offers need their validated format metadata");
    assert.equal(route.requestFormat, f.endpoint.request_format); assert.equal(route.responseFormat, f.endpoint.response_format);
    assert.equal(route.path, f.endpoint.path); assert.deepEqual(route.methods, f.endpoint.methods);
    const offers = provider.offers.filter(offer => offer.endpoint === endpointId && offer.modelId);
    assert.ok(offers.length > 0);
    assert.ok(offers.every(offer => offer.eligible && offer.routeKind === (native ? "native" : "manifest")));
    assert.ok(offers.every(offer => offer.route === (native ? `/v1/native/${providerId}${f.endpoint.path}` : `/v1/proxy/${providerId}/${endpointId}`)));
    if (!native) {
      const rejected = await f.call(`/v1/native/${providerId}${f.endpoint.path.replace("${model}", "gemini-embedding-001")}`, {});
      assert.ok(rejected.status >= 400, "metadata must not enable the disabled native endpoint"); await rejected.arrayBuffer();
    }
    assert.equal(f.sent.length, 0); assert.ok(f.budgetCalls.every(call => call.path === "/status"));
    for (const { name } of f.budgetCalls) assert.deepEqual(f.budgets.get(name).reservations(), []);
    assert.doesNotMatch(JSON.stringify(catalog), /synthetic-catalog-environment|synthetic-original-key/);
  });
}

for (const [providerId, endpointId] of cases) test(`${providerId}/${endpointId} manifest metadata remains scoped to the current policy`, { timeout: 10_000 }, async t => {
  const f = await setup(t, providerId, endpointId);
  const first = await f.catalog(); assert.ok(first.providers.find(provider => provider.id === providerId).routes.some(route => route.endpoint === endpointId));
  f.policy.providers = ["openai"];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  const denied = await f.catalog(); assert.ok(!denied.providers.some(provider => provider.id === providerId));
  assert.equal(f.sent.length, 0); assert.ok(f.budgetCalls.every(call => call.path === "/status"));
});
