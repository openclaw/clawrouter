import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const contracts = {
  cerebras: { endpoint: "public_models", format: "cerebras.public_catalog", native: false,
    urls: ["https://api.cerebras.ai/public/v1/models"] },
  nvidia: { endpoint: "public_models", format: "nvidia.public_catalog", native: false,
    urls: ["https://integrate.api.nvidia.com/v1/models", "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json"] },
  chutes: { endpoint: "models_list", format: "chutes.models", native: true,
    urls: ["https://llm.chutes.ai/v1/models"] },
  venice: { endpoint: "models_list", format: "venice.models", native: true,
    urls: ["https://api.venice.ai/api/v1/models?type=text"] },
};
const sources = Object.fromEntries(Object.keys(contracts).map(id => [id,
  parse(readFileSync(new URL(`../../providers/${id}.provider.yaml`, import.meta.url), "utf8"))]));
const compile = source => compileProviderSnapshot([source]);
const compiled = id => compile(sources[id]).providers[0];
const envelope = () => ({ method: "GET", body: {}, query: {}, pathParams: {} });
function payload(id, ids) {
  return { object: "list", ...(id === "venice" ? { type: "text" } : {}), data: ids.map(upstream => ({ id: upstream, object: "model",
    ...(id === "venice" ? { type: "text" } : {}),
    ...(id === "cerebras" ? { limits: { max_context_length: 4096, max_completion_tokens: 512 } } : {}) })) };
}
const rows = (id, body) => contracts[id].native ? body.data : body.catalog;
async function setup(t, id) {
  const original = snapshot.providers, provider = compiled(id);
  assert.ok(original.some(value => value.id === id));
  snapshot.providers = original.map(value => value.id === id ? provider : value);
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { pooled: true, providerId: id, compiledProvider: true });
  f.model = id === "chutes" ? provider.models.find(model => model.upstream === "deepseek-ai/DeepSeek-V3.2-TEE") : provider.models[0];
  assert.ok(f.model); f.policy.models = [f.model.id];
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  for (const key of provider.config_keys) f.env[key] = "synthetic-environment-cannot-replace-owner";
  f.empty = false;
  f.upstream = request => Response.json(request.url.includes("featured-models.json") ? { "featured-models": [] }
    : payload(id, f.empty ? [] : [...provider.models.map(model => model.upstream), "unqualified-upstream"]));
  f.manifest = (body = envelope(), suffix = "") => f.call(`/v1/proxy/${id}/${contracts[id].endpoint}${suffix}`, body);
  f.native = (suffix = "") => f.call(`/v1/native/${id}/models${suffix}`, null);
  t.after(f.drain); return f;
}

for (const [id, contract] of Object.entries(contracts)) {
  test(`${id} bundled catalog preserves every Chat card, tariff and credential declaration`, () => {
    const source = sources[id], before = structuredClone(source);
    delete before.endpoints[contract.endpoint];
    before.capabilities = before.capabilities.filter(capability => capability.endpoint !== contract.endpoint);
    const result = compile(source), baseline = compile(before), provider = result.providers[0], original = baseline.providers[0];
    assert.deepEqual(provider.models, original.models); assert.deepEqual(result.model_index, baseline.model_index);
    assert.deepEqual(provider.auth, original.auth); assert.deepEqual(provider.adapter, original.adapter);
    assert.deepEqual(provider.routing, original.routing); assert.deepEqual(provider.base_urls, original.base_urls);
    assert.deepEqual(provider.endpoints.filter(endpoint => endpoint.id !== contract.endpoint), original.endpoints);
    assert.deepEqual(provider.capabilities.filter(capability => capability.endpoint !== contract.endpoint), original.capabilities);
    const endpoint = provider.endpoints.find(value => value.id === contract.endpoint);
    assert.equal(endpoint.native_proxy, contract.native); assert.equal(endpoint.path, "/models");
    assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]);
    assert.equal(endpoint.request_format, contract.format); assert.equal(endpoint.response_format, contract.format);
    assert.equal(endpoint.timeout_ms, 10000); assert.deepEqual(endpoint.headers, { accept: "application/json" });
    assert.deepEqual(endpoint.query, {}); assert.deepEqual(endpoint.path_params, []); assert.deepEqual(endpoint.request_headers, []);
    for (const field of ["upstreamPath", "requestPricing", "toolPricing", "modelPassthrough", "inputProfile"]) assert.equal(endpoint[field], undefined);
    assert.equal(endpoint.auth, null);
    const route = createRouteCatalog([provider]).manifestProxy.find(value => value.endpoint === contract.endpoint);
    assert.equal(route.route, `/v1/proxy/${id}/${contract.endpoint}`); assert.deepEqual(route.models, []); assert.equal(route.sampleModel, null);
    assert.deepEqual(createRouteCatalog([provider]).openaiCompatible, createRouteCatalog([original]).openaiCompatible);
  });

  test(`${id} actual compiled manifest dispatch preserves public result shape and authoritative empty inventory`, async t => {
    const f = await setup(t, id), originalModels = structuredClone(f.provider.models);
    const first = await f.manifest(), body = await first.json(); assert.equal(first.status, 200, JSON.stringify(body));
    assert.deepEqual(rows(id, body).map(row => row.id), [f.model.upstream]);
    assert.match(first.headers.get("cache-control"), /private, no-store/);
    if (contract.native) {
      assert.deepEqual(Object.keys(body).sort(), id === "venice" ? ["data", "object", "type"] : ["data", "object"]);
      assert.equal(body.object, "list"); if (id === "venice") assert.equal(body.type, "text");
      assert.equal(Object.hasOwn(body, "catalog"), false);
    } else {
      assert.deepEqual(Object.keys(body).sort(), ["catalog", "providerId"]); assert.equal(body.providerId, id);
      assert.ok(Array.isArray(body.catalog)); assert.equal(body.catalog[0].pricing, null);
    }
    assert.deepEqual(f.sent.map(request => request.url), contract.urls);
    for (const request of f.sent) {
      assert.equal(request.method, "GET"); assert.equal(request.body, null); assert.equal(request.credentials, "omit");
      assert.equal(request.redirect, "error"); assert.deepEqual([...request.headers], [["accept", "application/json"]]);
    }
    f.empty = true; const empty = await f.manifest(), emptyBody = await empty.json(); assert.equal(empty.status, 200, JSON.stringify(emptyBody));
    assert.deepEqual(rows(id, emptyBody), []); assert.deepEqual(f.sent.map(request => request.url), [...contract.urls, ...contract.urls]);
    assert.deepEqual(f.provider.models, originalModels);
    await f.drain(); const events = await f.events(); assert.equal(events.length, 2);
    for (const event of events) { assert.equal(event.grant_key, grantKey); assert.equal(event.model, null); assert.equal(event.actual_cost_micros, 0); }
  });

  test(`${id} actual catalog exposes only its qualified routes and denies caller overrides before public egress`, async t => {
    const f = await setup(t, id), catalogResponse = await f.call("/v1/catalog", null), catalog = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200, JSON.stringify(catalog));
    const provider = catalog.providers.find(value => value.id === id); assert.ok(provider);
    const offers = provider.offers.filter(offer => offer.endpoint === contract.endpoint); assert.ok(offers.length);
    // The caller catalog selects the native offer when available; the manifest
    // route is independently exercised above, without inventing a second offer.
    assert.deepEqual([...new Set(offers.map(offer => offer.routeKind))], [contract.native ? "native" : "manifest"]);
    assert.ok(offers.every(offer => offer.route === (contract.native ? `/v1/native/${id}/models` : `/v1/proxy/${id}/${contract.endpoint}`)));
    assert.equal(f.sent.length, 0);
    for (const change of [
      value => { value.query = { limit: 1 }; }, value => { value.body = { model: f.model.upstream }; },
      value => { value.pathParams = { model_id: f.model.upstream }; }, value => { value.headers = { authorization: "Bearer synthetic-caller-key" }; },
      value => { value.transport = "oauth"; }, value => { value.model = f.model.upstream; },
    ]) {
      const input = envelope(); change(input); const response = await f.manifest(input);
      assert.equal(response.status, 400, await response.text()); assert.equal(f.sent.length, 0);
    }
    const query = await f.manifest(envelope(), "?type=text"); assert.equal(query.status, 400, await query.text()); assert.equal(f.sent.length, 0);
    const native = await f.native(), body = await native.json();
    assert.equal(native.status, contract.native ? 200 : 404, JSON.stringify(body));
    if (contract.native) { assert.deepEqual(rows(id, body).map(row => row.id), [f.model.upstream]); assert.deepEqual(f.sent.map(request => request.url), contract.urls); }
    else assert.equal(f.sent.length, 0);
    const sent = f.sent.length, nativeQuery = await f.native("?type=text");
    assert.equal(nativeQuery.status, contract.native ? 400 : 404, await nativeQuery.text()); assert.equal(f.sent.length, sent);
  });
}
