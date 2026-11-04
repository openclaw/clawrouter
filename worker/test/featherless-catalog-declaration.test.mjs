import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { putGrantCredentials } = await import("../grant-credentials.ts");
const source = parse(readFileSync(new URL("../../providers/featherless.provider.yaml", import.meta.url), "utf8"));
const route = "/v1/proxy/featherless/catalog", upstream = "Qwen/Qwen3-32B", modelId = `featherless/${upstream}`;
const compiled = () => compileProviderSnapshot([source]).providers[0];
const page = (number, total, data) => ({ data, pagination: {
  current_page: number, per_page: 100, total_items: total, total_pages: Math.ceil(total / 100),
}, total });
const excluded = count => Array.from({ length: count }, (_, index) => ({ id: `synthetic-excluded-${index}` }));
async function setup(t) {
  const original = snapshot.providers, provider = compiled();
  assert.ok(original.some(value => value.id === "featherless"));
  snapshot.providers = original.map(value => value.id === "featherless" ? provider : value);
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { pooled: true, providerId: "featherless", compiledProvider: true });
  f.policy.models = [modelId];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.env.FEATHERLESS_API_KEY = "synthetic-environment-cannot-replace-owner";
  f.pages = [page(1, 1, [{ id: upstream }])];
  f.upstream = request => {
    const number = Number(new URL(request.url).searchParams.get("page"));
    assert.ok(Number.isInteger(number) && number >= 1 && number <= f.pages.length);
    return Response.json(f.pages[number - 1]);
  };
  f.scan = (query = "") => f.call(route + query, null);
  f.disable = () => putGrantCredentials(f.env, grantKey, {
    provider: "featherless", kind: "api_key", enabled: false, credential: "synthetic-original-key",
  });
  t.after(f.drain); return f;
}
function assertPageRequests(sent, pages) {
  assert.equal(sent.length, pages.length);
  for (const [index, request] of sent.entries()) {
    assert.equal(request.url, `https://api.featherless.ai/v1/models?capabilities=chat&page=${pages[index]}&per_page=100`);
    assert.equal(request.method, "GET"); assert.equal(request.body, null); assert.equal(request.redirect, "manual");
    assert.equal(request.credentials, "omit");
    assert.deepEqual([...request.headers], [["accept", "application/json"], ["authorization", "Bearer synthetic-original-key"]]);
  }
}

test("bundled Featherless catalog preserves every original Chat, model, pricing and compatibility fact", () => {
  const before = structuredClone(source); delete before.endpoints.catalog;
  before.capabilities = before.capabilities.filter(capability => capability.endpoint !== "catalog");
  const result = compileProviderSnapshot([source]), baseline = compileProviderSnapshot([before]);
  const provider = result.providers[0], original = baseline.providers[0], endpoint = provider.endpoints.find(value => value.id === "catalog");
  assert.deepEqual(provider.models, original.models); assert.deepEqual(result.model_index, baseline.model_index);
  assert.deepEqual(provider.auth, original.auth); assert.deepEqual(provider.base_urls, original.base_urls);
  assert.deepEqual(provider.routing, original.routing); assert.deepEqual(provider.adapter, original.adapter);
  assert.deepEqual(provider.endpoints.filter(value => value.id !== "catalog"), original.endpoints);
  assert.deepEqual(provider.capabilities.filter(value => value.endpoint !== "catalog"), original.capabilities);
  assert.equal(endpoint.native_proxy, false); assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]);
  assert.equal(endpoint.path, "/models"); assert.equal(endpoint.request_format, "featherless.catalog"); assert.equal(endpoint.response_format, "featherless.catalog");
  assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.path_params, []); assert.deepEqual(endpoint.request_headers, []);
  assert.equal(endpoint.timeout_ms, 10000); assert.equal(endpoint.auth, null); assert.equal(endpoint.upstreamPath, undefined);
  assert.equal(endpoint.requestPricing, undefined); assert.equal(endpoint.modelPassthrough, undefined);
  const catalog = createRouteCatalog([provider]), projection = catalog.manifestProxy.find(value => value.endpoint === "catalog");
  assert.equal(projection.route, route); assert.deepEqual(projection.methods, ["GET"]); assert.deepEqual(projection.models, []); assert.equal(projection.sampleModel, null);
  assert.deepEqual(catalog.openaiCompatible, createRouteCatalog([original]).openaiCompatible);
});

test("compiled Featherless manifest scans through an empty intermediate page using only the original selected key", async t => {
  const f = await setup(t), originalModels = structuredClone(f.provider.models);
  f.pages = [page(1, 201, excluded(100)), page(2, 201, []), page(3, 201, [{ id: upstream }])];
  const response = await f.scan(), body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { providerId: "featherless", catalog: [{ id: upstream }] });
  assert.match(response.headers.get("cache-control"), /private, no-store/); assertPageRequests(f.sent, [1, 2, 3]);
  assert.deepEqual(f.provider.models, originalModels);
  await f.drain(); const events = await f.events(); assert.equal(events.length, 1);
  assert.equal(events[0].grant_key, grantKey); assert.equal(events[0].model, null); assert.equal(events[0].actual_cost_micros, 0);
});

test("compiled Featherless completed empty scan does not restore static seeds or invent pagination", async t => {
  const f = await setup(t), originalModels = structuredClone(f.provider.models);
  const first = await f.scan(); assert.equal(first.status, 200); assert.deepEqual((await first.json()).catalog, [{ id: upstream }]);
  f.pages = [page(1, 0, [])]; const second = await f.scan(), body = await second.json(); assert.equal(second.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { providerId: "featherless", catalog: [] }); assert.deepEqual(f.provider.models, originalModels);
  assertPageRequests(f.sent, [1, 1]);
});

test("compiled Featherless caller catalog exposes only the manifest operation and denies a native alias", async t => {
  const f = await setup(t), response = await f.call("/v1/catalog", null), body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  const provider = body.providers.find(value => value.id === "featherless"); assert.ok(provider);
  const offers = provider.offers.filter(offer => offer.endpoint === "catalog"); assert.ok(offers.length);
  assert.ok(offers.every(offer => offer.routeKind === "manifest" && offer.route === route && offer.modelId === null));
  assert.equal(f.sent.length, 0);
  const native = await f.call("/v1/native/featherless/models", null); assert.equal(native.status, 404, await native.text()); assert.equal(f.sent.length, 0);
});

test("compiled Featherless catalog rejects caller pagination, body and authority overrides before egress", async t => {
  const f = await setup(t);
  for (const query of ["?page=2", "?per_page=100", "?capabilities=chat", "?url=https%3A%2F%2Fother.example%2Fmodels"]) {
    const response = await f.scan(query); assert.ok(response.status >= 400, await response.text()); assert.equal(f.sent.length, 0);
  }
  for (const extra of [{ body: { model: upstream } }, { query: { page: 1 } }, { pathParams: { page: "1" } },
    { headers: { authorization: "Bearer synthetic-caller-key" } }, { transport: "oauth" }]) {
    const response = await f.call(route, { method: "GET", body: {}, query: {}, pathParams: {}, ...extra });
    assert.ok(response.status >= 400, await response.text()); assert.equal(f.sent.length, 0);
  }
});

test("compiled Featherless catalog cannot replace a disabled original owner with an environment key", async t => {
  const f = await setup(t); await f.disable();
  const response = await f.scan(); assert.ok(response.status >= 400); await response.text(); assert.equal(f.sent.length, 0);
});

test("compiled Featherless catalog rechecks the original owner between physical pages", async t => {
  const f = await setup(t);
  f.upstream = async () => { await f.disable(); return Response.json(page(1, 101, [{ id: upstream }])); };
  const response = await f.scan(), body = await response.json(); assert.ok(response.status >= 400, JSON.stringify(body));
  assert.equal(body.catalog, undefined); assertPageRequests(f.sent, [1]);
  assert.doesNotMatch(JSON.stringify(body), /synthetic-original-key|synthetic-environment-cannot-replace-owner/);
});

test("compiled Featherless incomplete scan never publishes already observed rows or retries another credential", async t => {
  const f = await setup(t);
  f.upstream = request => new URL(request.url).searchParams.get("page") === "1"
    ? Response.json(page(1, 101, [{ id: upstream }])) : Response.json({ error: "synthetic unavailable page" }, { status: 503 });
  const response = await f.scan(), body = await response.json(); assert.ok(response.status >= 400, JSON.stringify(body));
  assert.equal(body.catalog, undefined); assertPageRequests(f.sent, [1, 2]);
});
