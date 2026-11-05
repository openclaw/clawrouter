import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream, unifiedPathForEndpoint } = await import("../providers.ts");
const { prepareNativeRequest, prepareManifestRequest } = await import("../proxy-selection.ts");
const { prepareUpstreamRequest } = await import("../proxy-upstream-request.ts");
const { prepareNativeOpenRouterTranscription } = await import("../native-openrouter-transcription.ts");
const { createRouteCatalog, modelSupportsEndpoint } = await import("../../shared/route-catalog.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const manifest = parse(readFileSync(new URL("../../providers/openrouter.provider.yaml", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/openrouter/transcription.json", import.meta.url)));
const snapshot = compileProviderSnapshot([manifest]), provider = snapshot.providers[0];
const endpoint = provider.endpoints.find(value => value.id === "transcription");
const model = provider.models.find(value => value.upstream === "openai/whisper-large-v3-turbo");
const capability = "audio.transcription";

test("actual OpenRouter YAML exposes only the frozen transcription model on the qualified native JSON offer", () => {
  assert.equal(model.id, "openrouter/openai/whisper-large-v3-turbo"); assert.deepEqual(model.capabilities, [capability]);
  assert.equal(model.pricing, null); assert.equal(model.pricing_ref, null);
  assert.equal(endpoint.request_format, "openrouter.audio_transcription"); assert.equal(endpoint.response_format, endpoint.request_format);
  assert.equal(endpoint.path, "/v1/audio/transcriptions"); assert.equal(endpoint.native_proxy, true); assert.equal(endpoint.streaming, null);
  assert.equal(unifiedPathForEndpoint(provider, endpoint), null);
  assert.deepEqual(model.nativeCapabilities.endpoints.transcription.input, ["audio"]);
  assert.equal(model.nativeCapabilities.endpoints.transcription.contextWindow, undefined);
  const offer = createRouteCatalog([provider]).manifestProxy.find(row => row.endpoint === endpoint.id);
  assert.equal(offer.route, "/v1/proxy/openrouter/transcription"); assert.deepEqual(offer.models.map(row => row.id), [model.id]);
  assert.deepEqual(provider.endpoints.filter(value => modelSupportsEndpoint(provider, model, value)).map(value => value.id), [endpoint.id]);
});

test("actual declared native and manifest selections reach the single API prefix with unchanged audio and original key", async () => {
  const upstream = configuredUpstream(provider, null, { OPENROUTER_API_KEY: "synthetic-selected-key", OPENROUTER_SITE_URL: "https://example.com" });
  for (const native of [false, true]) {
    const body = { ...wire.request, model: native ? model.upstream : model.id };
    const selected = native ? prepareNativeRequest(provider, endpoint, body, endpoint.path, {}) : prepareManifestRequest(provider, endpoint, body, {}, {});
    const selection = { provider, endpoint, ...selected, capability, method: "POST" };
    const wrapper = prepareNativeOpenRouterTranscription(selection);
    const outbound = prepareUpstreamRequest(new Request("https://router.example/v1/native/openrouter/v1/audio/transcriptions", {
      method: "POST", headers: { "content-type": "application/json" },
    }), {}, selection, {}, upstream, "http");
    assert.equal(outbound.url.href, "https://openrouter.ai/api/v1/audio/transcriptions");
    assert.equal(outbound.url.href, `${wrapper.origin}${wrapper.path}`);
    assert.deepEqual(await new Response(outbound.requestBody).json(), wire.request);
    assert.equal(outbound.headers.get("authorization"), "Bearer synthetic-selected-key");
    assert.equal(outbound.headers.get("http-referer"), "https://example.com"); assert.equal(outbound.headers.get("x-title"), "ClawRouter");
    const observed = await wrapper.read(Response.json(wire.silent), new AbortController().signal);
    assert.deepEqual(await observed.response.json(), wire.silent); assert.equal(observed.usage.tokens, null);
    assert.equal(observed.usage.outcome, "success"); assert.equal(wrapper.tariff, undefined);
  }
});

test("actual transcription declaration cannot price duration, byte limits or diagnostic upstream cost as tokens", () => {
  const cost = estimateCost(model, wire.request, null, capability, endpoint);
  assert.equal(cost.inputTokens, null); assert.equal(cost.outputTokens, null); assert.equal(cost.requestTariff, undefined);
  for (const [caller, providerLimit] of [[10000, null], [null, 10000], [10000, 10000]]) {
    assert.throws(() => validateBudgetReservation(capability, cost, caller, { monthlyBudgetMicros: providerLimit }), error => error.code === "pricing_required");
  }
  for (const fixed of [0, 17]) assert.deepEqual(estimateCost(model, wire.request, fixed, capability, endpoint),
    { reserveMicros: fixed, basis: "policy_fixed", inputTokens: null, outputTokens: null });
});

test("transcription stays out of Chat and Responses without replacing the existing default or passthrough", () => {
  assert.equal(provider.models[0].id, "openrouter/auto");
  for (const id of ["chat_completions", "responses"]) {
    const existing = provider.endpoints.find(value => value.id === id);
    assert.equal(existing.path, id === "responses" ? "/v1/responses" : "/v1/chat/completions");
    assert.deepEqual(existing.modelPassthrough, { pricing_ref: null, pricing: null });
    assert.equal(modelSupportsEndpoint(provider, model, existing), false);
    assert.throws(() => prepareManifestRequest(provider, existing, { model: model.id, messages: [] }, {}, {}), error => error.code === "model_capability_unsupported");
  }
  assert.equal(modelSupportsEndpoint(provider, provider.models[0], endpoint), false);
  assert.equal(endpoint.modelPassthrough, undefined); assert.equal(endpoint.outputTokenLimit, undefined);
});
