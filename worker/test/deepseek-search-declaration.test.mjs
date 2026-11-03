import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture } from "./managed-runtime-fixture.mjs";
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { observeDeepSeekSearch, prepareDeepSeekSearch } = await import("../deepseek-search.ts");
const source = parse(readFileSync(new URL("../../providers/deepseek.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/deepseek/search.json", import.meta.url), "utf8"));
const compiled = () => compileProviderSnapshot([source]).providers[0];
const nativePath = "/v1/native/deepseek/v1/tools/search", manifestPath = "/v1/proxy/deepseek/search";
async function setup(t, options = {}) {
  const f = await fixture(t, { ...options, providerId: "deepseek", compiledProvider: true,
    configure: provider => Object.assign(provider, compiled()) });
  f.env.DEEPSEEK_API_KEY = "synthetic-deepseek-original-key";
  if (options.pooled) {
    f.policy.grantRouting = { eligibleGrants: { deepseek: ["replicate"] }, environmentFallback: false };
    await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  }
  f.search = (body = wire.request.body, manifest = false) => f.call(manifest ? manifestPath : nativePath, manifest ? { body } : body);
  f.rows = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  f.upstream = () => Response.json(wire.response); t.after(f.drain); return f;
}

test("bundled DeepSeek Search is model-less and preserves the Chat catalog and prices", () => {
  const before = structuredClone(source); delete before.endpoints.search;
  before.capabilities = before.capabilities.filter(item => item.endpoint !== "search");
  const provider = compiled(), original = compileProviderSnapshot([before]).providers[0];
  const endpoint = provider.endpoints.find(item => item.id === "search");
  assert.equal(endpoint.request_format, "deepseek.search"); assert.equal(endpoint.response_format, "deepseek.search");
  assert.equal(endpoint.path, "/v1/tools/search"); assert.equal(endpoint.method, "POST"); assert.equal(endpoint.native_proxy, true);
  assert.deepEqual(endpoint.path_params, []); assert.deepEqual(endpoint.query, {}); assert.equal(endpoint.timeout_ms, 120000);
  assert.equal(endpoint.requestPricing, undefined); assert.equal(endpoint.modelPassthrough, undefined);
  assert.deepEqual(provider.models, original.models); assert.deepEqual(provider.adapter, original.adapter);
  assert.ok(provider.models.every(model => !model.capabilities.includes("search.web")));
  const catalog = createRouteCatalog([provider]), offer = catalog.manifestProxy.find(item => item.endpoint === "search");
  assert.equal(offer.sampleModel, null); assert.deepEqual(offer.models, []);
  assert.deepEqual(catalog.openaiCompatible, createRouteCatalog([original]).openaiCompatible);
});

test("bundled Search offers expose the exact native route without a synthetic model", async t => {
  const f = await setup(t), response = await f.call("/v1/catalog", null), catalog = await response.json();
  assert.equal(response.status, 200);
  const provider = catalog.providers.find(item => item.id === "deepseek");
  const offers = provider.offers.filter(item => item.endpoint === "search");
  assert.ok(offers.length > 0);
  assert.ok(offers.every(offer => offer.eligible && offer.modelId === null && offer.routeKind === "native" && offer.route === nativePath));
  const route = provider.routes.find(item => item.endpoint === "search");
  assert.equal(route.requestFormat, "deepseek.search"); assert.equal(route.responseFormat, "deepseek.search");
  assert.equal(f.sent.length, 0);
});

for (const pooled of [false, true]) test("bundled Search native/manifest dispatch preserves " + (pooled ? "selected grant" : "environment") + " credentials and fixed settlement", async t => {
  const f = await setup(t, { pooled });
  for (const manifest of [false, true]) for (const empty of [false, true]) {
    const body = { ...wire.request.body, count: empty ? 1 : 10 }, reply = empty ? wire.empty : wire.response;
    f.upstream = async request => {
      assert.equal(request.url, "https://api.deepseek.com/v1/tools/search"); assert.equal(request.method, "POST"); assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("authorization"), pooled ? "Bearer synthetic-original-key" : "Bearer synthetic-deepseek-original-key");
      assert.deepEqual(await request.json(), body); return Response.json(reply);
    };
    const response = await f.search(body, manifest); assert.equal(response.status, 200); assert.deepEqual(await response.json(), reply); await f.drain();
    assert.equal(observeDeepSeekSearch(reply, prepareDeepSeekSearch(body), true).billableRequests, empty ? 0 : 1);
  }
  assert.equal(f.sent.length, 4, "result and icon URLs are never fetched");
  const events = await f.events(); assert.equal(events.length, 4);
  assert.ok(events.every(event => event.model === null && event.capability === "search.web" && event.total_tokens === null
    && event.actual_cost_micros === 700 && event.cost_basis === "policy_fixed" && event.pricing_ref === null));
  assert.equal(f.rows().length, 8); assert.ok(f.rows().every(row => row.settled === 1 && row.reserved_micros === 700));
});

test("bundled Search unknown fee denies both routes and catalog before egress under hard dollars", async t => {
  const f = await setup(t, { fixed: null });
  for (const manifest of [false, true]) {
    const response = await f.search(wire.request.body, manifest); assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "pricing_required");
  }
  const response = await f.call("/v1/catalog", null), catalog = await response.json(); assert.equal(response.status, 200);
  const offers = catalog.providers.find(provider => provider.id === "deepseek").offers.filter(offer => offer.endpoint === "search");
  assert.ok(offers.length > 0); assert.ok(offers.every(offer => !offer.eligible && offer.reasonCode === "pricing_required"));
  assert.equal(f.sent.length, 0); assert.equal(f.rows().length, 0);
});
