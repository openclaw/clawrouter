import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
import { eventFrame } from "./bedrock-eventstream-fixture.mjs";
const { prepareBedrockConverseRequest, createBedrockConverseDecoder } = await import("../provider-bedrock-converse.ts");
const { decodeBedrockEventFrame } = await import("../bedrock-eventstream.ts");
const { prepareManifestRequest, prepareNativeRequest } = await import("../proxy-selection.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");
const { signSigV4 } = await import("../providers.ts");
const { sha256Hex } = await import("../utils.ts");
const { estimateCost } = await import("../proxy-accounting.ts");
const { validateBudgetReservation } = await import("../accounting.ts");
const source = parse(readFileSync(new URL("../../providers/aws-bedrock.provider.yaml", import.meta.url), "utf8"));
const requestFormat = "aws_bedrock.converse_stream", responseFormat = "aws_bedrock.converse_eventstream";
const body = { modelId: "unselected-body-alias", stream: true, messages: [{ role: "user", content: [{ text: "synthetic" }] }], inferenceConfig: { maxTokens: 12 } };
const compile = manifest => compileProviderSnapshot([manifest]);
function fixture(both = false) {
  const manifest = structuredClone(source);
  manifest.capabilities.push({ id: "llm.chat", endpoint: "converse_stream", methods: ["POST"] });
  manifest.endpoints.converse_stream = { method: "POST", path: "/model/${model}/converse-stream", pathParams: ["model"],
    pathParamStyles: { model: "opaque_segment" }, requestFormat, responseFormat,
    headers: { "content-type": "application/json", accept: "application/vnd.amazon.eventstream" } };
  manifest.models.entries[0].capabilities.push("llm.chat");
  if (both) {
    manifest.capabilities.push({ id: "llm.chat", endpoint: "converse", methods: ["POST"] });
    manifest.endpoints.converse = { ...structuredClone(manifest.endpoints.converse_stream), path: "/model/${model}/converse",
      requestFormat: "aws_bedrock.converse", responseFormat: "aws_bedrock.converse", headers: { "content-type": "application/json", accept: "application/json" } };
  }
  return manifest;
}
function selected(manifest = fixture()) {
  const provider = compile(manifest).providers[0];
  return { provider, endpoint: provider.endpoints.find(value => value.id === "converse_stream"), model: provider.models[0] };
}

test("buffered ConverseStream compiles its distinct pair beside unary without changing Invoke or OpenAI discovery", () => {
  const original = compile(source).providers[0];
  for (const both of [false, true]) {
    const { provider, endpoint, model } = selected(fixture(both));
    for (const before of original.endpoints) assert.deepEqual(provider.endpoints.find(value => value.id === before.id), before);
    assert.equal(endpoint.request_format, requestFormat); assert.equal(endpoint.response_format, responseFormat);
    assert.equal(endpoint.streaming, null); assert.equal(endpoint.native_proxy, true);
    assert.equal(endpoint.path, "/model/${model}/converse-stream"); assert.deepEqual(endpoint.path_param_styles, { model: "opaque_segment" });
    const catalog = createRouteCatalog([provider]); assert.deepEqual(catalog.openaiCompatible, []);
    assert.deepEqual(catalog.manifestProxy.find(value => value.endpoint === "converse_stream").models.map(value => value.id), [model.id]);
    if (both) assert.equal(provider.endpoints.find(value => value.id === "converse").response_format, "aws_bedrock.converse");
  }
});

test("native and manifest stream paths bind the selected model or declared opaque ARN before signing", async () => {
  for (const upstream of [source.models.entries[0].upstream, "arn:aws:bedrock:us-east-1:123456789012:inference-profile/synthetic"]) {
    const manifest = fixture(); manifest.models.entries[0].upstream = upstream;
    const { provider, endpoint, model } = selected(manifest), path = `/model/${encodeURIComponent(upstream)}/converse-stream`;
    for (const selection of [prepareNativeRequest(provider, endpoint, body, path, {}), prepareManifestRequest(provider, endpoint, body, { model: model.id }, {})]) {
      assert.equal(selection.model.upstream, upstream); assert.deepEqual(selection.pathParams, { model: upstream });
      const prepared = prepareBedrockConverseRequest(selection.body, selection.model.upstream, true), payload = JSON.stringify(prepared.body);
      assert.equal(prepared.path, path); assert.equal(prepared.body.stream, undefined); assert.equal(prepared.body.modelId, undefined);
      const headers = new Headers({ "content-type": "application/json", accept: "application/vnd.amazon.eventstream" });
      await signSigV4(provider, new URL(path, "https://bedrock-runtime.us-east-1.amazonaws.com"), "POST", payload, headers, { AWS_REGION: "us-east-1" },
        { credentials: { accessKeyId: "synthetic-selected-access", secretAccessKey: "synthetic-selected-secret", sessionToken: "synthetic-selected-session" } }, new Date("2026-11-04T00:00:00Z"));
      assert.equal(headers.get("x-amz-content-sha256"), await sha256Hex(payload));
      assert.notEqual(headers.get("x-amz-content-sha256"), await sha256Hex(JSON.stringify(body)));
      assert.match(headers.get("authorization"), /us-east-1\/bedrock\/aws4_request/);
    }
  }
});

test("actual frame and Converse codecs require complete success evidence and preserve native usage", () => {
  const events = [{ messageStart: { role: "assistant" } }, { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "synthetic answer" } } },
    { contentBlockStop: { contentBlockIndex: 0 } }, { messageStop: { stopReason: "end_turn" } },
    { metadata: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadInputTokens: 3 } } }];
  const decoder = createBedrockConverseDecoder();
  for (const event of events) {
    const [kind, data] = Object.entries(event)[0];
    const frame = eventFrame(data, { ":message-type": "event", ":event-type": kind, ":content-type": "application/json" });
    const decoded = decodeBedrockEventFrame(frame);
    assert.equal(decoded.headers.get(":event-type"), kind);
    decoder.accept({ [kind]: JSON.parse(new TextDecoder().decode(decoded.payload)) });
    const broken = frame.slice(); broken[broken.length - 1] ^= 1;
    assert.throws(() => decodeBedrockEventFrame(broken));
  }
  const result = decoder.result(true); assert.equal(result.inspection.outcome, "success");
  assert.equal(result.inspection.tokens.output, 2); assert.equal(result.inspection.tokens.cached, 3);
  const incomplete = createBedrockConverseDecoder(); events.slice(0, -1).forEach(value => incomplete.accept(value));
  assert.notEqual(incomplete.result(false).inspection.outcome, "success");
});

test("unpriced stream cards cannot certify hard-dollar budgets and explicit fixed policy remains distinct", () => {
  const { endpoint, model } = selected();
  assert.equal(model.pricing, null); assert.equal(endpoint.requestPricing, undefined);
  const cost = estimateCost(model, body, null, "llm.chat", endpoint);
  for (const [caller, provider] of [[10000, null], [null, 10000]]) {
    assert.throws(() => validateBudgetReservation("llm.chat", cost, caller, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
    for (const fixed of [0, 17]) {
      const explicit = estimateCost(model, body, fixed, "llm.chat", endpoint);
      assert.equal(explicit.basis, "policy_fixed"); assert.equal(explicit.reserveMicros, fixed);
      assert.doesNotThrow(() => validateBudgetReservation("llm.chat", explicit, caller, { monthlyBudgetMicros: provider }));
    }
  }
});

test("stream declarations reject mixed unary pairs, aliases, duplicate routes and transport overrides", () => {
  for (const change of [
    m => { m.endpoints.converse_stream.requestFormat = "aws_bedrock.converse"; },
    m => { m.endpoints.converse_stream.responseFormat = "aws_bedrock.converse"; },
    m => { m.endpoints.converse_stream.requestFormat = responseFormat; },
    m => { m.endpoints.converse_stream.requestFormat = "aws_bedrock.converse_future"; },
    m => { m.endpoints.converse_stream.path = "/model/${model}/converse"; },
    m => { m.endpoints.converse_stream.method = "GET"; }, m => { delete m.endpoints.converse_stream.method; },
    m => { m.endpoints.converse_stream.streaming = "sse"; }, m => { m.endpoints.converse_stream.websocket = "openai.realtime"; },
    m => { m.endpoints.converse_stream.query = { region: "other" }; }, m => { m.endpoints.converse_stream.auth = "none"; },
    m => { m.endpoints.converse_stream.pathParamStyles.model = "segment"; }, m => { m.endpoints.converse_stream.pathParams.push("region"); },
    m => { m.endpoints.converse_stream.upstreamPath = "/model/${model}/converse-stream"; },
    m => { m.endpoints.converse_stream.headers.accept = "application/json"; },
    m => { m.endpoints.converse_stream.requestHeaders = ["authorization"]; },
    m => { m.endpoints.converse_stream.modelPassthrough = {}; }, m => { m.endpoints.converse_stream.nativeProxy = false; },
    m => { m.endpoints.other = structuredClone(m.endpoints.converse_stream); m.capabilities.push({ id: "llm.chat", endpoint: "other", methods: ["POST"] }); },
    m => { m.capabilities.at(-1).id = "llm.invoke"; },
    m => { m.endpoints.converse_stream.requestPricing = { unit: "request", version: "synthetic", effectiveAt: "2026-11-03", source: "https://example.com/rates", successfulResponseMicros: 0 }; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /aws_bedrock.converse|invalid manifest/, String(change)); }
});

test("both Converse transports preserve explicit Chat eligibility and original regional credential constraints", () => {
  for (const change of [
    m => { m.models.entries[0].capabilities = ["llm.invoke"]; }, m => { m.models.entries[0].pricing = { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 }; },
    m => { m.baseUrls.default = "https://foreign.example"; }, m => { m.auth.schemes[0].service = "sagemaker"; },
    m => { m.auth.schemes[0].regionParam = "caller_region"; }, m => { m.adapter.injectHeaders = { Authorization: "synthetic" }; },
    m => { m.adapter.injectQuery = { region: "other" }; }, m => { m.adapter.passthroughHeaders = ["authorization"]; },
    m => { m.routing.baseUrlParam = "AWS_ORIGIN"; },
  ]) {
    const manifest = fixture(true);
    // Exercise the Converse authority guard, not the earlier embedding guard.
    delete manifest.endpoints.embed_text;
    manifest.capabilities = manifest.capabilities.filter(value => value.endpoint !== "embed_text");
    manifest.models.entries = manifest.models.entries.filter(value => !value.capabilities.includes("llm.embeddings"));
    assert.doesNotThrow(() => compile(manifest));
    change(manifest); assert.throws(() => compile(manifest), /aws_bedrock.converse|invalid manifest/, String(change));
  }
});
