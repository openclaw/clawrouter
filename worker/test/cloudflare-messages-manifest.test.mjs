import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream, copyRequestHeaders, endpointForPath, upstreamPath, providerModel, unifiedPathForEndpoint } = await import("../providers.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");

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
