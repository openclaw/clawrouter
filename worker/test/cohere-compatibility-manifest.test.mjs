import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream, endpointForPath, unifiedPathForEndpoint, upstreamPath, providerModel } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");

const manifest = parse(readFileSync(new URL("../../providers/cohere.provider.yaml", import.meta.url), "utf8"));
const snapshot = compileProviderSnapshot([manifest]), provider = snapshot.providers[0];
const env = { COHERE_API_KEY: "fixture-cohere-key" };
const modelId = "cohere/command-a-plus-05-2026";

test("Cohere unified Chat selects its qualified compatibility URL without replacing native endpoints", () => {
  const endpoint = endpointForPath(provider, "/v1/chat/completions");
  assert.equal(endpoint.id, "chat_completions");
  assert.equal(unifiedPathForEndpoint(provider, endpoint), "/v1/chat/completions");
  assert.equal(endpoint.request_format, "openai.chat_completions");
  assert.equal(endpoint.response_format, "openai.chat_completions");
  assert.equal(endpoint.streaming, "sse");
  const auth = configuredUpstream(provider, null, env);
  assert.equal(auth.headers.get("authorization"), "Bearer fixture-cohere-key");
  assert.equal(auth.baseUrl + upstreamPath(provider, endpoint, {}, env, auth), "https://api.cohere.ai/compatibility/v1/chat/completions");
  for (const [id, path, format] of [["chat", "/v2/chat", "cohere.chat"], ["embed", "/v2/embed", "cohere.embed"]]) {
    const native = provider.endpoints.find(endpoint => endpoint.id === id);
    assert.equal(auth.baseUrl + upstreamPath(provider, native, {}, env, auth), "https://api.cohere.ai" + path);
    assert.equal(native.request_format, format);
    assert.equal(native.response_format, format);
    assert.equal(native.native_proxy, true);
    assert.equal(unifiedPathForEndpoint(provider, native), null);
  }
});

test("Cohere transport preparation preserves caller messages and tool declarations", () => {
  const endpoint = endpointForPath(provider, "/v1/chat/completions");
  const body = { model: modelId, messages: [{ role: "developer", content: "fixture instruction" }, { role: "user", content: "fixture input" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    stream: true, reasoning_effort: "high", max_tokens: 100 };
  const before = structuredClone(body);
  const prepared = prepareManifestRequest(provider, endpoint, body, {}, env);
  assert.deepEqual(prepared.body, { ...body, model: "command-a-plus-05-2026" });
  assert.deepEqual(body, before);
  assert.equal(prepared.model.id, modelId);
  assert.equal(prepared.model.pricing, null);
  const unknown = providerModel(provider, "future-command", endpoint, true);
  assert.equal(unknown.pricing, null);
  assert.equal(unknown.nativeCapabilities, undefined);
  assert.throws(() => prepareManifestRequest(provider, endpoint, { model: "cohere/embed-v4.0", messages: [] }, {}, env), /does not support/);
});

test("Command A+ publishes sourced model facts for both Chat transports without a tariff", () => {
  const model = snapshot.model_index[modelId];
  assert.deepEqual(model.supportedReasoningEfforts, ["none", "high"]);
  assert.equal(model.requestParameters.chat_completions.toolCalling, "supported");
  for (const id of ["chat", "chat_completions"]) {
    const facts = model.nativeCapabilities.endpoints[id];
    assert.deepEqual(facts.input, ["text", "image"]);
    assert.equal(facts.contextWindow, 128000);
    assert.equal(facts.maxOutputTokens, 64000);
    assert.equal(facts.checkedAt, "2026-11-03");
    assert.deepEqual(facts.sources, id === "chat" ? ["https://docs.cohere.com/docs/command-a-plus"]
      : ["https://docs.cohere.com/docs/compatibility-api", "https://docs.cohere.com/docs/command-a-plus"]);
  }
  assert.equal(model.pricing, null);
  assert.equal(snapshot.model_index["cohere/embed-v4.0"].nativeCapabilities, undefined);
  assert.equal(snapshot.model_index["cohere/embed-v4.0"].pricing, null);
});
