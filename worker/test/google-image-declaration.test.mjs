import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { nativeMatch, nativeModelEndpoint, prepareNativeRequest } = await import("../proxy-selection.ts");
const { prepareNativeGoogleImage } = await import("../native-google-images.ts");
const { createRouteCatalog, modelSupportsEndpoint } = await import("../../shared/route-catalog.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const manifest = parse(readFileSync(new URL("../../providers/google-gemini.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/google/images.json", import.meta.url), "utf8"));
const provider = compileProviderSnapshot([manifest]).providers[0];
const ids = ["gemini-3.1-flash-image", "gemini-3-pro-image"];

test("bundled Google image rows expose only the two frozen native identities with unknown prices", () => {
  const models = provider.models.filter(model => model.capabilities.includes("image.generate"));
  assert.deepEqual(models.map(model => model.upstream).sort(), [...ids].sort());
  for (const model of models) {
    assert.equal(model.id, `google/${model.upstream}`); assert.deepEqual(model.capabilities, ["image.generate"]);
    assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null); assert.equal(model.availability, undefined);
  }
  const offer = createRouteCatalog([provider]).manifestProxy.find(value => value.endpoint === "image_generate");
  assert.equal(offer.requestFormat, "google.image_generate"); assert.equal(offer.responseFormat, "google.image");
  assert.deepEqual(offer.models.map(model => model.id).sort(), ids.map(id => `google/${id}`).sort());
  assert.equal(offer.route, "/v1/proxy/google-gemini/image_generate"); assert.deepEqual(offer.pathParams, ["model"]);
});

test("actual bundled native image paths select the landed image operation regardless of endpoint order", () => {
  for (const upstream of ids) for (const reverse of [false, true]) {
    const path = `/v1beta/models/${upstream}:generateContent`;
    const matching = provider.endpoints.filter(endpoint => nativeMatch(endpoint, path));
    if (reverse) matching.reverse();
    assert.ok(matching.some(endpoint => endpoint.id === "generate_content"));
    assert.ok(matching.some(endpoint => endpoint.id === "image_generate"));
    const endpoint = nativeModelEndpoint(provider, matching, path, "POST"); assert.equal(endpoint.id, "image_generate");
    const body = structuredClone(wire.request.body), prepared = prepareNativeRequest(provider, endpoint, body, path, {});
    assert.equal(prepared.model.upstream, upstream); assert.deepEqual(prepared.body, body);
    const native = prepareNativeGoogleImage({ ...prepared, provider, endpoint, method: "POST", capability: "image.generate" });
    assert.equal(native.origin, "https://generativelanguage.googleapis.com"); assert.equal(native.path, path);
    assert.equal(native.tariff, undefined);
    const generic = provider.endpoints.find(value => value.id === "generate_content");
    assert.equal(modelSupportsEndpoint(provider, prepared.model, generic), false);
  }
});

test("bundled image declaration preserves ordinary text matching and denies mixed-capability ambiguity", () => {
  const text = provider.models.find(model => model.upstream === "gemini-3.5-flash");
  const path = `/v1beta/models/${text.upstream}:generateContent`;
  assert.equal(nativeModelEndpoint(provider, provider.endpoints.filter(endpoint => nativeMatch(endpoint, path)), path, "POST").id, "generate_content");
  const ambiguous = structuredClone(provider), model = ambiguous.models.find(value => value.upstream === ids[0]);
  model.capabilities.push("llm.generate");
  const imagePath = `/v1beta/models/${ids[0]}:generateContent`;
  assert.throws(() => nativeModelEndpoint(ambiguous, ambiguous.endpoints.filter(endpoint => nativeMatch(endpoint, imagePath)), imagePath, "POST"), error => error.code === "native_route_ambiguous");
});

test("bundled Google image offers cannot admit unknown upstream dollars or borrow text inference prices", () => {
  const endpoint = provider.endpoints.find(value => value.id === "image_generate");
  for (const upstream of ids) {
    const model = provider.models.find(value => value.upstream === upstream), body = structuredClone(wire.request.body);
    const cost = estimateCost(model, body, null, "image.generate", endpoint);
    assert.equal(cost.basis, "unpriced_request"); assert.equal(cost.pricingGap, "opaque_input_bound");
    assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null);
    for (const [caller, providerLimit] of [[10000, null], [null, 10000], [10000, 10000]]) {
      assert.throws(() => validateBudgetReservation("image.generate", cost, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
    }
    for (const fixed of [0, 17]) assert.deepEqual(estimateCost(model, body, fixed, "image.generate", endpoint),
      { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
  }
});
