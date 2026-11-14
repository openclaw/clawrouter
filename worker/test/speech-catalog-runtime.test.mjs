import assert from "node:assert/strict";
import test from "node:test";
import { fixture, grantKey } from "./managed-runtime-fixture.mjs";
const { snapshot, providerById } = await import("../providers.ts");
const { revokeGrantCredentials } = await import("../grant-credentials.ts");

async function setup(t, id, native = true) {
  const source = structuredClone(providerById(id)), original = snapshot.providers;
  // Give the compiled projection a distinct provider identity, retaining the
  // shipped OpenAI controller and avoiding mutation of its static cache.
  snapshot.providers = original.filter(provider => provider.id !== id).map(provider => provider.id === "replicate" ? structuredClone(provider) : provider);
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { providerId: id, pooled: true, configure(provider) {
    Object.assign(provider, source);
    if (id === "xai") {
      provider.capabilities = provider.capabilities.filter(capability => capability.id !== "audio.speech");
      provider.capabilities.push({ id: "audio.speech", endpoint: "tts", methods: ["POST"] });
      const template = provider.endpoints.find(endpoint => endpoint.request_format === "openai.chat_completions");
      provider.endpoints = provider.endpoints.filter(endpoint => endpoint.id !== "tts");
      provider.endpoints.push({ ...template, id: "tts", method: "POST", methods: ["POST"], path: "/v1/tts", path_params: [],
        request_format: "xai.tts", response_format: "audio.binary", native_proxy: native, streaming: null, query: {}, modelPassthrough: undefined });
    }
  } });
  f.upstream = () => { throw new Error("discovery must not dispatch upstream"); };
  t.after(f.drain); return f;
}

for (const native of [false, true]) test(`actual ${native ? "native" : "manifest"} xAI discovery retains its model-less wire and original grant boundary`, { timeout: 10_000 }, async t => {
  const f = await setup(t, "xai", native);
  const routes = await (await f.call("/v1/routes", null)).json();
  const legacy = routes.openaiCompatible.find(provider => provider.provider === "xai");
  assert.ok(!legacy.endpoints.includes("/v1/audio/speech"));
  assert.ok(legacy.endpoints.includes("/v1/chat/completions"));
  const manifest = routes.manifestProxy.find(route => route.provider === "xai" && route.endpoint === "tts");
  assert.equal(manifest.requestFormat, "xai.tts"); assert.equal(manifest.responseFormat, "audio.binary"); assert.equal(manifest.sampleModel, null);
  const response = await f.call("/v1/catalog", null); assert.equal(response.status, 200);
  const catalog = await response.json(), provider = catalog.providers.find(provider => provider.id === "xai");
  const offers = provider.offers.filter(offer => offer.endpoint === "tts");
  assert.equal(offers.length, 1); assert.equal(offers[0].modelId, null); assert.equal(offers[0].eligible, true);
  assert.equal(offers[0].routeKind, native ? "native" : "manifest");
  assert.equal(offers[0].route, native ? "/v1/native/xai/v1/tts" : "/v1/proxy/xai/tts");
  assert.ok(provider.offers.every(offer => offer.route !== "/v1/audio/speech"));
  assert.doesNotMatch(JSON.stringify(catalog), /synthetic-original-key|synthetic-environment-key/);
  await revokeGrantCredentials(f.env, grantKey);
  const revoked = await (await f.call("/v1/catalog", null)).json();
  assert.ok(!revoked.providers.find(provider => provider.id === "xai")?.offers.some(offer => offer.eligible));
  assert.equal(f.sent.length, 0); assert.ok(f.budgetCalls.every(call => call.path === "/status"));
});

test("actual OpenAI catalog retains the controller-qualified speech offer under its original caller grant", { timeout: 10_000 }, async t => {
  const f = await setup(t, "openai");
  const routes = await (await f.call("/v1/routes", null)).json();
  assert.ok(routes.openaiCompatible.find(provider => provider.provider === "openai").endpoints.includes("/v1/audio/speech"));
  const response = await f.call("/v1/catalog", null); assert.equal(response.status, 200);
  const provider = (await response.json()).providers.find(provider => provider.id === "openai");
  const offer = provider.offers.find(offer => offer.routeKind === "unified" && offer.route === "/v1/audio/speech"
    && offer.modelId === "openai/tts-1");
  assert.ok(offer); assert.equal(offer.eligible, true);
  await revokeGrantCredentials(f.env, grantKey);
  const revoked = await (await f.call("/v1/catalog", null)).json();
  assert.ok(!revoked.providers.find(provider => provider.id === "openai")?.offers.some(offer => offer.eligible));
  assert.equal(f.sent.length, 0);
});
