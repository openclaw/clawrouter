import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream } = await import("../providers.ts");
const { copyRequestHeaders, upstreamPath } = await import("../provider-request.ts");
const { endpointForPath, providerModel, unifiedPathForEndpoint } = await import("../provider-catalog.ts");
const { nativeMatch } = await import("../native-route.ts");
const { PreparationAdmission } = await import("../provider-templates.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { prepareManifestRequest, prepareNativeRequest } = await import("../proxy-selection.ts");

const manifest = parse(readFileSync(new URL("../../providers/cloudflare-ai-gateway.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([manifest]), provider = snapshot.providers[0];
const env = { CLOUDFLARE_ACCOUNT_ID: "fixture-account", CLOUDFLARE_AI_GATEWAY_ID: "fixture-gateway", CLOUDFLARE_API_TOKEN: "fixture-gateway-token" };
const modelId = "cloudflare-ai-gateway/claude-sonnet-4-6";

test("Cloudflare native Messages uses the configured gateway token without copying caller or unrelated provider credentials", () => {
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "messages");
  assert.equal(endpoint.id, "messages");
  assert.equal(unifiedPathForEndpoint(provider, endpoint), null);
  const offer = createRouteCatalog([provider]).manifestProxy.find(route => route.endpoint === "messages");
  assert.equal(offer.route, "/v1/proxy/cloudflare-ai-gateway/messages");
  assert.equal(offer.sampleModel, modelId);
  assert.equal(endpoint.request_format, "anthropic.messages");
  assert.equal(endpoint.response_format, "anthropic.messages");
  assert.equal(endpoint.streaming, "sse");
  const auth = configuredUpstream(provider, null, { ...env, ANTHROPIC_API_KEY: "fixture-unrelated-key" });
  copyRequestHeaders(new Headers({ authorization: "Bearer fixture-caller", "x-api-key": "fixture-caller-key", "cf-aig-authorization": "Bearer fixture-other-gateway", "anthropic-beta": "fixture-beta", "anthropic-version": "fixture-version" }), provider, endpoint, auth.headers, env);
  assert.equal(auth.baseUrl + upstreamPath(provider, endpoint, {}, env, auth), "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/anthropic/v1/messages");
  assert.equal(auth.headers.get("cf-aig-authorization"), "Bearer fixture-gateway-token");
  assert.equal(auth.headers.get("authorization"), null);
  assert.equal(auth.headers.get("x-api-key"), null);
  assert.equal(auth.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(auth.headers.get("anthropic-beta"), "fixture-beta");
  for (const key of Object.keys(env)) {
    const missing = { ...env }; delete missing[key];
    assert.throws(() => configuredUpstream(provider, null, missing), error => error.code === "provider_not_configured");
  }
});

test("Cloudflare Sonnet preserves the Anthropic payload and has only Messages facts with no inherited price", () => {
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "messages");
  const body = { model: modelId, max_tokens: 1024, stream: true, thinking: { type: "adaptive" },
    messages: [{ role: "user", content: [{ type: "text", text: "fixture input" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "Zml4dHVyZQ==" } }] }],
    tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }] };
  const before = structuredClone(body), prepared = prepareManifestRequest(provider, endpoint, body, {}, env);
  assert.deepEqual(prepared.body, { ...body, model: "claude-sonnet-4-6" });
  assert.deepEqual(body, before);
  assert.equal(prepared.model.pricing, null);
  const facts = prepared.model.nativeCapabilities.endpoints.messages;
  assert.deepEqual(facts.input, ["text", "image"]);
  assert.equal(facts.contextWindow, 200000);
  assert.equal(facts.maxOutputTokens, undefined, "gateway facts do not inherit first-party output limits");
  assert.equal(facts.checkedAt, "2026-11-03");
  assert.deepEqual(prepared.model.capabilities, ["llm.messages"]);
  assert.equal(providerModel(provider, "claude-future", endpoint, true), null);
  assert.throws(() => prepareManifestRequest(provider, endpoint, { model: "cloudflare-ai-gateway/auto", messages: [] }, {}, env), /does not support/);
});

test("Cloudflare Universal keeps its native array and unpriced fallbacks after Messages is added", () => {
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "universal");
  const body = [{ provider: "anthropic", endpoint: "v1/messages", query: { model: "claude-sonnet-4-6", messages: [] } }];
  const prepared = prepareManifestRequest(provider, endpoint, body, {}, env);
  assert.deepEqual(prepared.body, body);
  assert.equal(prepared.model, null);
  assert.equal(endpoint.path, "/");
  assert.equal(endpointForPath(provider, "/v1/chat/completions").id, "universal");
  assert.equal(provider.models[0].id, "cloudflare-ai-gateway/auto");
  assert.equal(snapshot.model_index["cloudflare-ai-gateway/auto"].pricing, null);
});

test("Cloudflare Messages retains its exact native prefix and finite model identity", () => {
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "messages");
  assert.equal(endpoint.method, "POST");
  assert.deepEqual(endpoint.methods, ["POST"]);
  assert.deepEqual(endpoint.path_params, []);
  assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.modelPassthrough, undefined);
  assert.equal(nativeMatch(endpoint, "/anthropic/v1/messages"), true);
  for (const path of ["/v1/messages", "/anthropic/messages", "/anthropic/v1/messages/", "/openai/v1/messages"])
    assert.equal(nativeMatch(endpoint, path), false);
  const body = { model: "claude-sonnet-4-6", max_tokens: 128, messages: [{ role: "user", content: "fixture" }] };
  const native = prepareNativeRequest(provider, endpoint, body, endpoint.path, env);
  const manifest = prepareManifestRequest(provider, endpoint, { ...body, model: modelId }, {}, env);
  const { preparation: nativePreparation, ...nativeContract } = native;
  const { preparation: manifestPreparation, ...manifestContract } = manifest;
  assert.ok(nativePreparation instanceof PreparationAdmission);
  assert.ok(manifestPreparation instanceof PreparationAdmission);
  assert.notEqual(nativePreparation, manifestPreparation);
  assert.deepEqual(nativeContract, manifestContract);
  assert.deepEqual(native.body, body);
  assert.equal(native.model.id, modelId);
  for (const model of ["anthropic/claude-sonnet-4.6", "cloudflare-ai-gateway/claude-future", "claude-future", "auto"])
    assert.throws(() => prepareNativeRequest(provider, endpoint, { ...body, model }, endpoint.path, env), error => error.code === "model_capability_unsupported");
  assert.throws(() => prepareManifestRequest(provider, endpoint, { ...body, model: "anthropic/claude-sonnet-4-6" }, {}, env), error => error.code === "model_provider_mismatch");
});

test("Cloudflare selected gateway credential never borrows environment or caller Anthropic authority", () => {
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "messages");
  const grant = { providerId: provider.id, kind: "api_key", credential: "fixture-selected-gateway" };
  const configured = { ...env, ANTHROPIC_API_KEY: "fixture-unrelated-anthropic" };
  const auth = configuredUpstream(provider, grant, configured);
  copyRequestHeaders(new Headers({ authorization: "Bearer fixture-caller", "x-api-key": "fixture-caller-anthropic",
    "cf-aig-authorization": "Bearer fixture-caller-gateway" }), provider, endpoint, auth.headers, configured);
  assert.equal(auth.headers.get("cf-aig-authorization"), "Bearer fixture-selected-gateway");
  assert.equal(auth.headers.get("authorization"), null);
  assert.equal(auth.headers.get("x-api-key"), null);
  assert.equal(auth.query.size, 0);
  const noEnvironmentToken = { ...configured }; delete noEnvironmentToken.CLOUDFLARE_API_TOKEN;
  assert.equal(configuredUpstream(provider, grant, noEnvironmentToken).headers.get("cf-aig-authorization"), "Bearer fixture-selected-gateway");
  assert.throws(() => configuredUpstream(provider, { ...grant, credential: undefined }, configured), error => error.code === "provider_not_configured");
  assert.throws(() => configuredUpstream(provider, null, noEnvironmentToken), error => error.code === "provider_not_configured");
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_GATEWAY_ID"]) {
    const missing = { ...configured }; delete missing[key];
    assert.throws(() => configuredUpstream(provider, grant, missing), error => error.code === "provider_not_configured");
  }
});

test("Cloudflare native declaration remains additive to every compiled Universal field", () => {
  const legacy = structuredClone(manifest);
  delete legacy.endpoints.messages;
  legacy.capabilities = legacy.capabilities.filter(capability => capability.endpoint !== "messages");
  legacy.models.entries = legacy.models.entries.filter(model => model.id !== modelId);
  const expected = compileProviderSnapshot([legacy]).providers[0];
  const restored = structuredClone(provider);
  restored.endpoints = restored.endpoints.filter(endpoint => endpoint.id !== "messages");
  restored.capabilities = restored.capabilities.filter(capability => capability.endpoint !== "messages");
  restored.models = restored.models.filter(model => model.id !== modelId);
  assert.deepEqual(restored, expected);
  assert.deepEqual(provider.models.map(model => model.id), ["cloudflare-ai-gateway/auto", modelId]);
  const card = snapshot.model_index[modelId];
  assert.equal(card.pricing, null);
  assert.equal(card.pricing_ref, null);
  assert.equal(card.endpointPricing, undefined);
  assert.deepEqual(Object.keys(card.nativeCapabilities.endpoints), ["messages"]);
});

test("Cloudflare declaration uses closed facts and supported endpoint references", () => {
  const invalid = [
    value => { value.models.entries[1].nativeCapabilities.endpoints.messages.inventedLimit = 64000; },
    value => { value.models.entries[1].nativeCapabilities.endpoints.unregistered = value.models.entries[1].nativeCapabilities.endpoints.messages; },
    value => { value.models.entries[1].capabilities = ["llm.unregistered"]; },
  ];
  for (const change of invalid) {
    const candidate = structuredClone(manifest); change(candidate);
    assert.throws(() => compileProviderSnapshot([candidate]));
  }
});
