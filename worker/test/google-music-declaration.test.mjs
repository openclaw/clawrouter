import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { nativeMatch, nativeModelEndpoint, prepareNativeRequest } = await import("../proxy-selection.ts");
const { prepareNativeGoogleMusic } = await import("../native-google-music.ts");
const { createRouteCatalog, modelSupportsEndpoint } = await import("../../shared/route-catalog.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const manifest = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/music.json", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([manifest]).providers[0];
const ids = ["lyria-3-clip-preview", "lyria-3-pro-preview"];

test("bundled Lyria rows expose only the two frozen music identities with unknown prices", () => {
  const models = provider.models.filter(model => model.capabilities.includes("audio.generate"));
  assert.deepEqual(models.map(model => model.upstream).sort(), [...ids].sort());
  for (const model of models) {
    assert.equal(model.id, `google/${model.upstream}`); assert.deepEqual(model.capabilities, ["audio.generate"]);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null); assert.equal(model.availability, undefined);
  }
  const offer = createRouteCatalog([provider]).manifestProxy.find(value => value.endpoint === "music_generate");
  assert.equal(offer.requestFormat, "google.music_generate"); assert.equal(offer.responseFormat, "google.music");
  assert.deepEqual(offer.models.map(model => model.id).sort(), ids.map(id => `google/${id}`).sort());
  assert.equal(offer.route, "/v1/proxy/google-gemini/music_generate"); assert.deepEqual(offer.pathParams, ["model"]);
});

test("actual bundled native music paths select the landed Lyria operation independently of endpoint order", () => {
  for (const upstream of ids) for (const reverse of [false, true]) {
    const path = `/v1beta/models/${upstream}:generateContent`;
    const matching = provider.endpoints.filter(endpoint => nativeMatch(endpoint, path));
    if (reverse) matching.reverse();
    assert.ok(matching.some(endpoint => endpoint.id === "generate_content"));
    assert.ok(matching.some(endpoint => endpoint.id === "music_generate"));
    const endpoint = nativeModelEndpoint(provider, matching, path, "POST"); assert.equal(endpoint.id, "music_generate");
    const body = structuredClone(wire.request.body), prepared = prepareNativeRequest(provider, endpoint, body, path, {});
    assert.equal(prepared.model.upstream, upstream); assert.deepEqual(prepared.body, body);
    const native = prepareNativeGoogleMusic({ ...prepared, provider, endpoint, method: "POST", capability: "audio.generate" });
    assert.equal(native.origin, "https://generativelanguage.googleapis.com"); assert.equal(native.path, path);
    assert.equal(native.tariff, undefined);
    assert.equal(modelSupportsEndpoint(provider, prepared.model, provider.endpoints.find(value => value.id === "generate_content")), false);
  }
});

test("bundled Lyria declaration preserves ordinary text matching and denies mixed-capability ambiguity", () => {
  const text = provider.models.find(model => model.upstream === "gemini-3.5-flash");
  const path = `/v1beta/models/${text.upstream}:generateContent`;
  assert.equal(nativeModelEndpoint(provider, provider.endpoints.filter(endpoint => nativeMatch(endpoint, path)), path, "POST").id, "generate_content");
  const ambiguous = structuredClone(provider), model = ambiguous.models.find(value => value.upstream === ids[0]);
  model.capabilities.push("llm.generate");
  const musicPath = `/v1beta/models/${ids[0]}:generateContent`;
  assert.throws(() => nativeModelEndpoint(ambiguous, ambiguous.endpoints.filter(endpoint => nativeMatch(endpoint, musicPath)), musicPath, "POST"), error => error.code === "native_route_ambiguous");
});

test("bundled music offers deny unknown upstream dollars and separate explicit policy charges", () => {
  const endpoint = provider.endpoints.find(value => value.id === "music_generate");
  for (const upstream of ids) {
    const model = provider.models.find(value => value.upstream === upstream), body = structuredClone(wire.request.body);
    const cost = estimateCost(model, body, null, "audio.generate", endpoint);
    assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.pricingGap, "opaque_input_bound");
    assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
    for (const [caller, providerLimit] of [[10000, null], [null, 10000], [10000, 10000]]) {
      assert.throws(() => validateBudgetReservation("audio.generate", cost, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
    }
    for (const fixed of [0, 17]) assert.deepEqual(estimateCost(model, body, fixed, "audio.generate", endpoint),
      { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
  }
});
