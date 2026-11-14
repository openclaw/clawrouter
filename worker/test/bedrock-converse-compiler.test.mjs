import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { prepareBedrockConverseRequest, decodeBedrockConverseResponse } = await import("../provider-bedrock-converse.ts");
const { prepareManifestRequest, prepareNativeRequest } = await import("../proxy-selection.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { signSigV4 } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const source = parse(readFileSync(new URL("../../providers/aws-bedrock.provider.yaml", import.meta.url), "utf8"));
// Preserve the original Invoke-only fixture when bundled Converse declarations
// arrive; these existing protocol tests must not append duplicate native routes.
for (const [id, endpoint] of Object.entries(source.endpoints)) {
  if (!["aws_bedrock.converse", "aws_bedrock.converse_stream"].includes(endpoint.requestFormat)) continue;
  delete source.endpoints[id]; source.capabilities = source.capabilities.filter(capability => capability.endpoint !== id);
}
for (const model of source.models.entries) model.capabilities = model.capabilities.filter(capability => capability !== "llm.chat");
const format = "aws_bedrock.converse", origin = "https://bedrock-runtime.us-east-1.amazonaws.com";
const body = { messages: [{ role: "user", content: [{ text: "synthetic request" }] }], inferenceConfig: { maxTokens: 12 },
  additionalModelRequestFields: { thinking: { type: "adaptive" } }, modelId: "unselected-body-alias", stream: false };
const reply = { output: { message: { role: "assistant", content: [{ text: "synthetic answer" },
  { reasoningContent: { reasoningText: { text: "synthetic reasoning", signature: "synthetic-signature" } } },
  { toolUse: { toolUseId: "call-1", name: "inspect", input: { synthetic: true } } }] } }, stopReason: "tool_use",
  usage: { inputTokens: 50, outputTokens: 12, totalTokens: 62, cacheReadInputTokens: 10, cacheWriteInputTokens: 4,
    cacheDetails: [{ ttl: "5m", inputTokens: 2 }, { ttl: "1h", inputTokens: 2 }] } };
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture(upstream) {
  const manifest = structuredClone(source);
  manifest.capabilities.push({ id: "llm.chat", endpoint: "converse", methods: ["POST"] });
  manifest.endpoints.converse = { method: "POST", path: "/model/${model}/converse", pathParams: ["model"],
    pathParamStyles: { model: "opaque_segment" }, requestFormat: format, responseFormat: format,
    headers: { "content-type": "application/json", accept: "application/json" } };
  manifest.models.entries[0].capabilities.push("llm.chat");
  if (upstream) manifest.models.entries[0].upstream = upstream;
  return manifest;
}
function selected(manifest = fixture()) {
  const provider = compile(manifest).providers[0];
  return { provider, endpoint: provider.endpoints.find(endpoint => endpoint.id === "converse"), model: provider.models[0] };
}

test("unary Converse compiles exact native formats without modifying Invoke or claiming OpenAI compatibility", () => {
  const { provider, endpoint, model } = selected(), original = compile(source).providers[0];
  for (const before of original.endpoints) assert.deepEqual(provider.endpoints.find(item => item.id === before.id), before);
  assert.deepEqual(provider.adapter, original.adapter); assert.deepEqual(provider.auth, original.auth);
  assert.equal(endpoint.request_format, format); assert.equal(endpoint.response_format, format); assert.equal(endpoint.native_proxy, true);
  assert.equal(endpoint.path, "/model/${model}/converse"); assert.deepEqual(endpoint.path_params, ["model"]);
  assert.deepEqual(endpoint.path_param_styles, { model: "opaque_segment" }); assert.deepEqual(endpoint.query, {});
  assert.equal(endpoint.streaming, null); assert.equal(endpoint.modelPassthrough, undefined); assert.equal(endpoint.requestPricing, undefined);
  const catalog = createRouteCatalog([provider]); assert.deepEqual(catalog.openaiCompatible, []);
  assert.deepEqual(catalog.manifestProxy.find(offer => offer.endpoint === "converse").models.map(item => item.id), [model.id]);
  assert.equal(model.pricing, null);
});

test("compiled native and manifest selection bind the declared model including an opaque synthetic ARN", () => {
  for (const upstream of [source.models.entries[0].upstream, "arn:aws:bedrock:us-east-1:123456789012:inference-profile/synthetic"]) {
    const { provider, endpoint, model } = selected(fixture(upstream)), original = structuredClone(body);
    const path = `/model/${encodeURIComponent(upstream)}/converse`;
    for (const selection of [prepareManifestRequest(provider, endpoint, body, { model: model.id }, {}),
      prepareNativeRequest(provider, endpoint, body, path, {})]) {
      assert.equal(selection.model.upstream, upstream); assert.deepEqual(selection.pathParams, { model: upstream });
      const prepared = prepareBedrockConverseRequest(selection.body, selection.model.upstream, false);
      assert.equal(prepared.path, path); assert.equal(prepared.body.modelId, undefined); assert.equal(prepared.body.stream, undefined);
      assert.deepEqual(prepared.body.messages, body.messages); assert.deepEqual(prepared.body.inferenceConfig, body.inferenceConfig);
      assert.deepEqual(prepared.body.additionalModelRequestFields, body.additionalModelRequestFields);
    }
    assert.deepEqual(body, original);
    assert.throws(() => prepareManifestRequest(provider, endpoint, body, { model: "unregistered-model" }, {}), error => error.code === "model_capability_unsupported");
  }
});

test("the actual codec payload is finalized before exact-byte SigV4 hashing", async () => {
  const { provider, endpoint, model } = selected();
  const selection = prepareManifestRequest(provider, endpoint, body, { model: model.id }, {});
  const prepared = prepareBedrockConverseRequest(selection.body, selection.model.upstream, false);
  const payload = JSON.stringify(prepared.body), headers = new Headers({ "content-type": "application/json" });
  await signSigV4(provider, new URL(prepared.path, origin), "POST", payload, headers, { AWS_REGION: "us-east-1" },
    { credentials: { accessKeyId: "synthetic-selected-access", secretAccessKey: "synthetic-selected-secret", sessionToken: "synthetic-selected-session" } },
    new Date("2026-11-04T00:00:00Z"));
  assert.equal(headers.get("x-amz-content-sha256"), await sha256Hex(payload));
  assert.notEqual(headers.get("x-amz-content-sha256"), await sha256Hex(JSON.stringify(body)));
  assert.match(headers.get("authorization"), /^AWS4-HMAC-SHA256 Credential=synthetic-selected-access\/20261104\/us-east-1\/bedrock\/aws4_request,/);
  assert.equal(headers.get("x-amz-security-token"), "synthetic-selected-session");
});

test("actual unary decoding preserves atomic content and cache-inclusive usage without exposing refusal prose", () => {
  const decoded = decodeBedrockConverseResponse(reply);
  assert.deepEqual(decoded.content, reply.output.message.content); assert.equal(decoded.stop, "toolUse");
  assert.deepEqual(decoded.inspection.tokens, { input: 64, output: 12, total: 76, cached: 10, cacheWrite: 4, cacheWrite5m: 2, cacheWrite1h: 2 });
  assert.equal(decodeBedrockConverseResponse({ ...reply, usage: { inputTokens: 50 } }).inspection.tokens, null);
  const refused = decodeBedrockConverseResponse({ ...reply, stopReason: "refusal", additionalModelResponseFields: { stop_details: "synthetic-private-prose" } });
  assert.deepEqual(refused.content, []); assert.equal(refused.error, "bedrock_refusal"); assert.deepEqual(refused.inspection.tokens, decoded.inspection.tokens);
  assert.equal(JSON.stringify(refused).includes("synthetic-private-prose"), false);
  const malformed = structuredClone(reply); malformed.output.message.content[2].toolUse.input = "{partial";
  assert.throws(() => decodeBedrockConverseResponse(malformed), /invalid_bedrock_tool_use/);
});

test("unpriced Converse cards and observed cache counts never certify hard-dollar admission", () => {
  const { endpoint, model } = selected(), cost = estimateCost(model, body, null, "llm.chat", endpoint);
  for (const [caller, provider] of [[10000, null], [null, 10000]]) {
    assert.throws(() => validateBudgetReservation("llm.chat", cost, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
    for (const fixed of [0, 17]) {
      const explicit = estimateCost(model, body, fixed, "llm.chat", endpoint);
      assert.equal(explicit.basis, "policy_fixed"); assert.equal(explicit.reserveMicros, fixed);
      assert.doesNotThrow(() => validateBudgetReservation("llm.chat", explicit, caller, { monthlyBudgetMicros: provider }));
    }
  }
});

test("unary schema rejects stream aliases, path escapes, passthrough and unrelated operation capabilities", () => {
  for (const change of [
    m => { m.endpoints.converse.path = "/model/${model}/converse-stream"; },
    m => { m.endpoints.converse.requestFormat = "aws_bedrock.converse_stream"; },
    m => { m.endpoints.converse.responseFormat = "aws_bedrock.converse_eventstream"; },
    m => { m.endpoints.converse.requestFormat = "openai.chat_completions"; },
    m => { m.endpoints.converse.method = "GET"; }, m => { delete m.endpoints.converse.method; },
    m => { m.endpoints.converse.pathParams = ["model", "region"]; },
    m => { m.endpoints.converse.pathParamStyles.model = "segment"; },
    m => { m.endpoints.converse.upstreamPath = "/model/${model}/converse"; },
    m => { m.endpoints.converse.query = { region: "us-west-2" }; },
    m => { m.endpoints.converse.streaming = "aws_eventstream"; },
    m => { m.endpoints.converse.websocket = "openai.realtime"; },
    m => { m.endpoints.converse.nativeProxy = false; }, m => { m.endpoints.converse.modelPassthrough = {}; },
    m => { m.endpoints.converse.responsesLifecycle = { retrieve: "converse" }; },
    m => { m.endpoints.converse.outputTokenLimit = { field: "max_tokens", minimum: 1, maximum: 100 }; },
    m => { m.capabilities.at(-1).id = "llm.invoke"; }, m => { m.capabilities.at(-1).methods = ["POST", "GET"]; },
    m => { m.endpoints.other = structuredClone(m.endpoints.converse); },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /aws_bedrock.converse|invalid manifest/, String(change)); }
});

test("regional SigV4 and selected model authority cannot be replaced through manifest fields", () => {
  for (const change of [
    m => { m.id = "other"; }, m => { m.class = "openai_compatible"; },
    m => { m.baseUrls.default = "https://foreign.example"; }, m => { m.baseUrls.other = "https://foreign.example"; },
    m => { m.routing.baseUrlParam = "AWS_ORIGIN"; }, m => { m.routing.serviceParam = "AWS_SERVICE"; },
    m => { m.auth.schemes[0].service = "sagemaker"; }, m => { m.auth.schemes[0].regionParam = "caller_region"; },
    m => { m.auth.schemes[0].required = false; }, m => { m.auth.schemes.push({ type: "bearer", secretKind: "api_key" }); },
    m => { m.auth.grantTransports = { api_key: { baseUrl: "https://foreign.example" } }; },
    m => { m.endpoints.converse.auth = "none"; }, m => { m.endpoints.converse.requestHeaders = ["authorization"]; },
    m => { m.endpoints.converse.headers.authorization = "synthetic"; },
    m => { m.adapter.injectHeaders = { Authorization: "synthetic" }; }, m => { m.adapter.injectQuery = { region: "other" }; },
    m => { m.adapter.passthroughHeaders = ["authorization"]; },
    m => { m.adapter.requestTransforms = { renameFields: [{ from: "messages", to: "prompt" }] }; },
    m => { m.models.entries[0].capabilities = ["llm.invoke"]; }, m => { m.models.entries[0].upstream = "${model}"; },
    m => { m.models.entries[0].pricing = { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 }; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /aws_bedrock.converse|invalid manifest/, String(change)); }
});
