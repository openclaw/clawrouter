import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { createRouteCatalog, modelSupportsEndpoint } = await import("../../shared/route-catalog.ts");
const { managedCreateAdapter } = await import("../managed-lifecycle-adapters.ts");
const { authenticateProxyKey } = await import("../proxy-auth.ts");
const { upstreamAuth } = await import("../providers.ts");
const { inputRouteDigest } = await import("../pixverse-input-dispatch.ts");
const source = parse(readFileSync(new URL("../../providers/pixverse.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/pixverse/lifecycle.json", import.meta.url)));
const profile = "clawrouter.pixverse-image-input.v1", path = "/v1/native/pixverse/openapi/v2/video/img/generate";
const headers = { authorization: "Bearer clawrouter-live-fixture-fixture-secret" };
const compiled = () => compileProviderSnapshot([source]).providers[0];
async function setup(t, { fixed = null, pooled = true, costs, retention = false } = {}) {
  const f = await fixture(t, { fixed, pooled, providerId: "pixverse", compiledProvider: true,
    configure: provider => Object.assign(provider, compiled()) });
  f.env.PIXVERSE_API_KEY = "synthetic-nonselected-key";
  if (costs) f.policy.requestCostsMicros = costs;
  if (retention) f.policy.upstreamRetention = { version: "clawrouter.upstream-retention.v1", allow: [{ providerId: "pixverse", protocol: "pixverse.video" }] };
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  f.image = f.provider.endpoints.find(endpoint => endpoint.id === "image_video");
  if (pooled && retention) {
    const auth = await authenticateProxyKey(new Headers(headers), f.env, [{ id: "pixverse", tokenRef: "pixverse" }]); assert.ok(!(auth instanceof Response));
    const upstream = await upstreamAuth(f.provider, auth, f.env), destination = await inputRouteDigest(f.provider, f.image, upstream.grant, f.env);
    f.env.CLAWROUTER_UPSTREAM_RETENTION_BINDINGS = JSON.stringify({ version: "clawrouter.upstream-retention-bindings.v1", bindings: [{
      providerId: "pixverse", protocol: "pixverse.video", grantKey, routeSha256: destination.digest,
      retention: "allow", expiresAt: new Date(Date.now() + 120000).toISOString() }] });
  }
  f.offers = async () => {
    const response = await f.call("/v1/catalog", null); assert.equal(response.status, 200);
    const catalog = await response.json(); return catalog.providers.find(provider => provider.id === "pixverse").offers.filter(offer => offer.endpoint === "image_video");
  };
  t.after(f.drain); return f;
}

test("bundled image metadata preserves both original text models and the same scoped GET", () => {
  const before = structuredClone(source); delete before.endpoints.image_video;
  before.capabilities = before.capabilities.filter(capability => capability.endpoint !== "image_video");
  for (const model of before.models.entries) model.capabilities = model.capabilities.filter(capability => capability !== "video.generate");
  const original = compileProviderSnapshot([before]).providers[0], provider = compiled();
  for (const endpoint of original.endpoints) assert.deepEqual(provider.endpoints.find(value => value.id === endpoint.id), endpoint);
  assert.deepEqual(provider.auth, original.auth); assert.deepEqual(provider.base_urls, original.base_urls); assert.deepEqual(provider.adapter, original.adapter);
  const image = provider.endpoints.find(endpoint => endpoint.id === "image_video");
  assert.equal(image.inputProfile, profile); assert.equal(image.request_format, "pixverse.image_video"); assert.equal(image.response_format, "pixverse.video");
  assert.equal(image.method, "POST"); assert.equal(image.path, "/openapi/v2/video/img/generate");
  assert.deepEqual(image.lifecycle, { protocol: "pixverse.video", retrieve: "video" });
  assert.equal(image.requestPricing, undefined); assert.equal(image.toolPricing, undefined);
  assert.deepEqual(provider.models.map(model => [model.id, model.upstream, model.pricing]), [["pixverse/v6", "v6", null], ["pixverse/c1", "c1", null]]);
  assert.ok(provider.models.every(model => modelSupportsEndpoint(provider, model, image)));
  const catalog = createRouteCatalog([provider]);
  assert.ok(!catalog.manifestProxy.some(offer => offer.endpoint === "image_video"));
  assert.deepEqual(catalog.openaiCompatible, []);
});

test("actual image registry recognizes the declaration but never mints authority from a caller image ID", () => {
  const image = compiled().endpoints.find(endpoint => endpoint.id === "image_video");
  const adapter = managedCreateAdapter(image.lifecycle.protocol, image.request_format); assert.ok(adapter);
  assert.equal(adapter.supportsCancel, false); assert.equal(adapter.supportsResult, false);
  assert.throws(() => adapter.prepare(wire.image.body, new Headers(), {}, new URLSearchParams()), /upload_scope_required/);
});

for (const fixed of [null, 700]) test("unknown image dollars remain closed despite a policy-wide fee: " + fixed, async t => {
  const f = await setup(t, { fixed, retention: true }), offers = await f.offers();
  assert.ok(offers.length); assert.ok(offers.every(offer => !offer.eligible && offer.reasonCode === "pricing_required"));
  assert.equal(f.sent.length, 0);
});

for (const missing of ["pixverse.image_upload", "video.generate"]) test("each image operation needs its own explicit policy price: " + missing, async t => {
  const costs = { "pixverse.image_upload": 13, "video.generate": 700 }; delete costs[missing];
  const f = await setup(t, { costs, retention: true }), offers = await f.offers();
  assert.ok(offers.length); assert.ok(offers.every(offer => !offer.eligible && offer.reasonCode === "pricing_required"));
  assert.equal(f.sent.length, 0);
});

for (const options of [{ pooled: false, retention: true }, { pooled: true, retention: false }]) test("image declarations cannot replace original-owner retention qualification: " + JSON.stringify(options), async t => {
  const f = await setup(t, { ...options, costs: { "pixverse.image_upload": 13, "video.generate": 700 } }), offers = await f.offers();
  assert.ok(offers.length); assert.ok(offers.every(offer => !offer.eligible)); assert.equal(f.sent.length, 0);
});

test("only qualified native image offers expose the multipart profile; manifest JSON remains closed", async t => {
  const f = await setup(t, { costs: { "pixverse.image_upload": 13, "video.generate": 700 }, retention: true }), offers = await f.offers();
  for (const id of ["pixverse/v6", "pixverse/c1"]) {
    const offer = offers.find(value => value.modelId === id); assert.ok(offer?.eligible);
    assert.equal(offer.routeKind, "native"); assert.equal(offer.route, path); assert.equal(offer.inputProfile, profile);
  }
  const response = await f.call("/v1/proxy/pixverse/image_video", { body: wire.image.body });
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "managed_input_profile_required");
  assert.equal(f.sent.length, 0);
});
