import assert from "node:assert/strict";
import test from "node:test";
import { googleContinuationFixture } from "./google-continuation-fixture.mjs";
const { snapshot } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { googleSpeechModels, googleSpeechPreviewCutoff } = await import("../google-speech.ts");
const { overrideHotCacheConfig, HOT_CACHE_DISABLED, clearHotCaches, pendingBackgroundWork } = await import("../hot-cache.ts");
const cutoff = Date.parse(googleSpeechPreviewCutoff);
const formats = ["google.speech_generate_content", "google.speech_interactions"];

async function setup(t, { native = false, pooled = false } = {}) {
  const f = await googleContinuationFixture(t, { pooled });
  const template = structuredClone(f.provider.endpoints.find(endpoint => endpoint.id === "generate_content"));
  // Candidate declarations exercise shared runtime eligibility only. Shipping
  // speech declarations and activating their response wrappers are separate.
  f.provider.endpoints = formats.map((request_format, index) => ({ ...structuredClone(template), id: `speech_${index}`, request_format,
    response_format: "google.speech", streaming: null, native_proxy: native, modelPassthrough: false,
    path: index ? "/v1beta/interactions" : "/v1beta/models/${model}:generateContent", path_params: index ? [] : ["model"] }));
  f.provider.capabilities = f.provider.endpoints.map(endpoint => ({ id: "audio.speech", endpoint: endpoint.id }));
  f.provider.models = googleSpeechModels.map(upstream => ({ ...structuredClone(f.model), id: `google-gemini/${upstream}`, upstream, capabilities: ["audio.speech"], pricing: null, pricing_ref: null }));
  const replacement = structuredClone(f.provider);
  snapshot.providers = snapshot.providers.map(provider => provider === f.provider ? replacement : provider); f.provider = replacement;
  f.advance(cutoff - Date.now() - 1);
  f.catalog = async () => {
    const response = await f.call("/v1/catalog", null); assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).providers.find(provider => provider.id === "google-gemini");
  };
  f.speech = (index, model) => {
    const body = index ? { model, store: false } : { contents: [] };
    const path = index ? "/v1beta/interactions" : `/v1beta/models/${model}:generateContent`;
    return f.call(native ? `/v1/native/google-gemini${path}` : `/v1/proxy/google-gemini/speech_${index}`,
      native ? body : { body, pathParams: index ? {} : { model } });
  };
  return f;
}

for (const native of [false, true]) for (const pooled of [false, true]) {
  test(`speech ${native ? "native" : "manifest"}/${pooled ? "grant" : "environment"} discovery and selection bind all five models to actual transports`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { native, pooled }), catalog = await f.catalog();
    const offers = catalog.offers.filter(offer => offer.eligible && offer.modelId);
    assert.equal(offers.length, 5);
    for (const [index, endpoint] of f.provider.endpoints.entries()) {
      const expected = f.provider.models.slice(index ? 3 : 0, index ? 5 : 3).map(model => model.id);
      assert.deepEqual(offers.filter(offer => offer.endpoint === endpoint.id).map(offer => offer.modelId).sort(), expected.sort());
      assert.ok(offers.filter(offer => offer.endpoint === endpoint.id).every(offer => offer.routeKind === (native ? "native" : "manifest")));
      assert.ok(!catalog.offers.some(offer => offer.endpoint === endpoint.id && !offer.modelId && offer.eligible));
      for (const model of f.provider.models) {
        const allowed = expected.includes(model.id), body = index ? { model: native ? model.upstream : model.id, store: false } : {};
        const params = index ? {} : { model: native ? model.upstream : model.id };
        if (allowed) assert.equal(prepareManifestRequest(f.provider, endpoint, body, params, f.env, native).model.id, model.id);
        else {
          const response = await f.speech(index, model.upstream), result = await response.json();
          assert.equal(response.status, 400); assert.equal(result.error.code, "model_capability_unsupported");
        }
      }
    }
    assert.equal(f.sent.length, 0); assert.equal(f.reservations().length, 0);
    assert.doesNotMatch(JSON.stringify(catalog), /synthetic-google-environment|synthetic-original-key/);
  });

  test(`speech ${native ? "native" : "manifest"}/${pooled ? "grant" : "environment"} expiration removes previews and denies dispatch at the exact cutoff`, { timeout: 10_000 }, async t => {
    const f = await setup(t, { native, pooled }); f.advance(1);
    const catalog = await f.catalog();
    assert.deepEqual(catalog.models.map(model => model.upstream).sort(), [...googleSpeechModels.slice(3)].sort());
    assert.ok(!catalog.routes.some(route => route.endpoint === "speech_0"));
    for (const model of googleSpeechModels.slice(0, 3)) {
      const response = await f.speech(0, model); assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "model_capability_unsupported");
    }
    assert.equal(f.sent.length, 0); assert.equal(f.reservations().length, 0);
  });
}

test("warm isolate and colo discovery cannot carry speech preview offers across their cutoff", { timeout: 10_000 }, async t => {
  const f = await setup(t, { native: true });
  overrideHotCacheConfig({ maxAgeMs: 60_000, freshMs: 10_000 }); t.after(() => overrideHotCacheConfig(HOT_CACHE_DISABLED));
  const entries = new Map();
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  t.after(() => { if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches); else delete globalThis.caches; });
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
    async match(url) { return entries.get(String(url))?.clone(); },
    async put(url, response) { entries.set(String(url), response.clone()); },
  } } });
  assert.equal((await f.catalog()).models.length, 5); await pendingBackgroundWork();
  assert.ok(entries.size > 0, "a real rendered colo entry was populated");
  f.advance(1);
  assert.equal((await f.catalog()).models.length, 2, "warm entry must not survive the cutoff");
  clearHotCaches();
  assert.equal((await f.catalog()).models.length, 2, "cold isolate must not adopt the pre-cutoff colo entry");
  assert.equal(f.sent.length, 0); assert.equal(f.reservations().length, 0);
});
