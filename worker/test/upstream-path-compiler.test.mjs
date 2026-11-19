import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream, unifiedPathForEndpoint } = await import("../providers.ts");
const { prepareManifestRequest } = await import("../proxy-selection.ts");
const { createRouteCatalog } = await import("../../shared/route-catalog.ts");

const contracts = [
  ["chat", "POST", "/v1/chat/completions", "/openai/v1/chat/completions", "openai.chat_completions", "llm.chat"],
  ["messages", "POST", "/v1/messages", "/anthropic/v1/messages", "anthropic.messages", "llm.messages"],
  ["models", "GET", "/v1/models", "/openai/v1/models", "openai.models", "models.list"],
];
function fixture(mapped = true) {
  return {
    schema: "clawrouter.service-provider.v1", id: "mapping-fixture", displayName: "Mapping fixture", class: "openai_compatible",
    service: { platform: "fixture", kind: "model_provider", configKeys: ["FIXTURE_API_KEY"] },
    auth: { schemes: [{ type: "bearer", header: "Authorization", format: "Bearer ${secret}", secretKind: "api_key" }] },
    baseUrls: { default: "https://provider.example" }, routing: { modelPrefixes: ["mapping-fixture/"] },
    capabilities: contracts.map(([id, method, , , , capability]) => ({ id: capability, endpoint: id, methods: [method] })),
    endpoints: Object.fromEntries(contracts.map(([id, method, path, upstreamPath, format]) => [id,
      { method, path, ...(mapped ? { upstreamPath } : {}), requestFormat: format, responseFormat: format, ...(id === "models" ? {} : { streaming: "sse" }) }])),
    models: { entries: [{ id: "mapping-fixture/model", upstream: "native-model", capabilities: ["llm.chat", "llm.messages"] }] },
  };
}
const compile = manifest => compileProviderSnapshot([manifest]);

test("literal upstream paths compile without changing caller routes, protocols, auth or catalog identities", () => {
  const manifest = fixture(), before = structuredClone(manifest), provider = compile(manifest).providers[0];
  const baseline = compile(fixture(false)).providers[0];
  assert.deepEqual(manifest, before);
  for (const [id, method, path, upstreamPath, format] of contracts) {
    const endpoint = provider.endpoints.find(row => row.id === id);
    assert.equal(endpoint.path, path); assert.equal(endpoint.upstreamPath, upstreamPath);
    assert.equal(endpoint.method, method); assert.deepEqual(endpoint.methods, [method]);
    assert.equal(endpoint.request_format, format); assert.equal(endpoint.response_format, format);
    assert.equal(endpoint.upstream_path, undefined);
    assert.equal(endpoint.requestPricing, undefined);
  }
  const stripped = structuredClone(provider); for (const endpoint of stripped.endpoints) delete endpoint.upstreamPath;
  assert.deepEqual(stripped, baseline);
  assert.deepEqual(createRouteCatalog([provider]), createRouteCatalog([baseline]));
  assert.equal(unifiedPathForEndpoint(provider, provider.endpoints[0]), "/v1/chat/completions");
  const auth = configuredUpstream(provider, null, { FIXTURE_API_KEY: "fixture-key" });
  assert.equal(auth.baseUrl, "https://provider.example");
  assert.equal(auth.headers.get("authorization"), "Bearer fixture-key");
});

test("mapped declarations preserve native request bodies and selected model identity", () => {
  const provider = compile(fixture()).providers[0];
  for (const id of ["chat", "messages"]) {
    const endpoint = provider.endpoints.find(row => row.id === id);
    const body = { model: "mapping-fixture/model", messages: [{ role: "user", content: "fixture" }], max_tokens: 10 };
    const before = structuredClone(body), prepared = prepareManifestRequest(provider, endpoint, body, {}, {});
    assert.equal(prepared.model.id, body.model);
    assert.deepEqual(prepared.body, { ...body, model: "native-model" });
    assert.deepEqual(body, before);
    assert.equal(prepared.model.pricing, null);
  }
  const discovery = prepareManifestRequest(provider, provider.endpoints.find(row => row.id === "models"), {}, {}, {});
  assert.equal(discovery.model, null); assert.deepEqual(discovery.body, {});
  const anthropic = fixture();
  anthropic.endpoints.models.requestFormat = anthropic.endpoints.models.responseFormat = "anthropic.models";
  anthropic.endpoints.models.upstreamPath = "/anthropic/v1/models";
  const compiled = compile(anthropic).providers[0];
  const endpoint = compiled.endpoints.find(row => row.id === "models");
  assert.equal(endpoint.upstreamPath, "/anthropic/v1/models");
  assert.equal(endpoint.request_format, "anthropic.models");
  assert.deepEqual(prepareManifestRequest(compiled, endpoint, {}, {}, {}).body, {});
});

test("path mapping rejects URLs, normalization, queries, templates and caller path parameters", () => {
  for (const path of ["", "/", "v1/chat", "https://provider.example/v1/chat", "//provider.example/v1/chat",
    "/a/../b", "/a/./b", "/v1//messages", "/v1/messages/", "/v1\\messages", "/%2e%2e/messages", "/a%2fb",
    "/%252e/messages", "/v1/messages?target=/other", "/v1/messages#fragment", "/v1/${model}",
    "/v1/white space", "/v1/\nmessages", "/v1/messages\n", "/v1/messages\r\n", "/v1/\0messages", "/v1/模型", "/" + "a".repeat(2048)]) {
    for (const field of ["path", "upstreamPath"]) {
      const manifest = fixture(); manifest.endpoints.chat[field] = path;
      assert.throws(() => compile(manifest), /invalid manifest|upstreamPath/, JSON.stringify([field, path]));
    }
  }
  for (const extra of [{ pathParams: ["model"] }, { pathParamStyles: { model: "segment" } }]) {
    const manifest = fixture(); Object.assign(manifest.endpoints.chat, extra);
    assert.throws(() => compile(manifest), /upstreamPath/);
  }
  const manifest = fixture(); manifest.endpoints.models.upstreamPath = "/.well-known/model-list";
  assert.equal(compile(manifest).providers[0].endpoints[2].upstreamPath, "/.well-known/model-list");
});

test("upstream path metadata cannot bypass qualified protocols, methods or lifecycle dispatch", () => {
  for (const change of [
    m => { m.endpoints.chat.responseFormat = "anthropic.messages"; },
    m => { m.endpoints.chat.requestFormat = m.endpoints.chat.responseFormat = "openai.responses"; }, // Only the exact Responses create caller path qualifies.
    m => { m.endpoints.chat.requestFormat = m.endpoints.chat.responseFormat = "unknown.protocol"; },
    m => { m.endpoints.models.requestFormat = m.endpoints.models.responseFormat = "synthetic.models"; },
    m => { m.endpoints.chat.method = "DELETE"; }, m => { m.capabilities[0].methods.push("GET"); },
    m => { m.endpoints.chat.websocket = "openai.responses"; },
    m => { m.endpoints.chat.responsesLifecycle = { retrieve: "models", cancel: "messages" }; },
    m => { m.endpoints.models.streaming = "sse"; }, m => { m.endpoints.models.modelPassthrough = {}; },
    m => { m.endpoints.models.requestFormat = m.endpoints.models.responseFormat = "anthropic.models"; m.endpoints.models.streaming = "sse"; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /upstreamPath|invalid manifest/, String(change)); }
});

test("grant transport paths must agree with the declared dispatch path", () => {
  const manifest = fixture();
  manifest.auth.grantTransports = { api_key: { endpointPaths: { chat: "/other/chat" } } };
  assert.throws(() => compile(manifest), /upstreamPath/);
  manifest.auth.grantTransports.api_key.endpointPaths.chat = manifest.endpoints.chat.upstreamPath;
  const provider = compile(manifest).providers[0];
  assert.equal(provider.auth.grantTransports.api_key.endpointPaths.chat, provider.endpoints[0].upstreamPath);
  assert.equal(provider.endpoints[0].path, "/v1/chat/completions");
});

test("the mapping has one spelling and absent metadata preserves the existing contract", () => {
  const baseline = compile(fixture(false));
  assert.ok(baseline.providers[0].endpoints.every(endpoint => !Object.hasOwn(endpoint, "upstreamPath")));
  for (const field of ["upstream_path", "upstreamUrl", "upstreamOrigin"]) {
    const manifest = fixture(false); manifest.endpoints.chat[field] = "/openai/v1/chat/completions";
    assert.throws(() => compile(manifest), /invalid manifest/);
  }
});

function responsesFixture(product = "go") {
  const manifest = fixture();
  manifest.baseUrls.default = "https://opencode.ai";
  manifest.capabilities = [{ id: "llm.responses", endpoint: "responses", methods: ["POST"] }];
  manifest.endpoints = { responses: { method: "POST", path: "/v1/responses",
    upstreamPath: `/inference/${product === "go" ? "go/" : ""}openai/v1/responses`,
    requestFormat: "openai.responses", responseFormat: "openai.responses", streaming: "sse" } };
  manifest.models.entries[0].capabilities = ["llm.responses"];
  return manifest;
}

test("literal Responses create mapping preserves the caller route, catalog, model and original account configuration", () => {
  for (const product of ["go", "console"]) {
    const manifest = responsesFixture(product), provider = compile(manifest).providers[0], endpoint = provider.endpoints[0];
    const unmapped = structuredClone(manifest); delete unmapped.endpoints.responses.upstreamPath;
    const baseline = compile(unmapped).providers[0];
    assert.equal(endpoint.path, "/v1/responses"); assert.equal(endpoint.method, "POST");
    assert.equal(endpoint.upstreamPath, `/inference/${product === "go" ? "go/" : ""}openai/v1/responses`);
    assert.equal(endpoint.request_format, "openai.responses"); assert.equal(endpoint.response_format, "openai.responses");
    assert.equal(endpoint.streaming, "sse"); assert.equal(endpoint.upstream_path, undefined);
    assert.deepEqual(createRouteCatalog([provider]), createRouteCatalog([baseline]));
    assert.equal(unifiedPathForEndpoint(provider, endpoint), "/v1/responses");
    const auth = configuredUpstream(provider, null, { FIXTURE_API_KEY: `synthetic-${product}-key` });
    assert.equal(auth.baseUrl, "https://opencode.ai"); assert.equal(auth.headers.get("authorization"), `Bearer synthetic-${product}-key`);
    assert.deepEqual(provider.models, baseline.models);
  }
});

test("mapped Responses preparation preserves native input and tool declarations without a body transform", () => {
  const provider = compile(responsesFixture()).providers[0], endpoint = provider.endpoints[0];
  const body = { model: "mapping-fixture/model", input: [{ role: "user", content: "synthetic response fixture" }],
    tools: [{ type: "function", name: "synthetic_client_tool", parameters: { type: "object", properties: {} } }],
    stream: true, max_output_tokens: 64 };
  const original = structuredClone(body), selected = prepareManifestRequest(provider, endpoint, body, {}, {});
  assert.deepEqual(body, original); assert.deepEqual(selected.body, { ...original, model: "native-model" });
  assert.equal(selected.model.id, original.model); assert.equal(selected.model.pricing, null);
  assert.deepEqual(selected.pathParams, {});
});

test("Responses mappings qualify only literal POST create and reject retrieval, WebSocket, template and query expansion", () => {
  for (const change of [
    m => { m.endpoints.responses.method = "GET"; }, m => { m.capabilities[0].methods = ["POST", "GET"]; },
    m => { m.endpoints.responses.path = "/v1/responses/synthetic-id"; },
    m => { m.endpoints.responses.path = "/v1/chat/completions"; },
    m => { m.endpoints.responses.upstreamPath = "https://other.example/v1/responses"; },
    m => { m.endpoints.responses.upstreamPath = "/inference/${product}/openai/v1/responses"; },
    m => { m.endpoints.responses.upstreamPath += "?product=go"; },
    m => { m.endpoints.responses.upstreamPath += "#fragment"; },
    m => { m.endpoints.responses.upstreamPath = "/inference/%2e%2e/responses"; },
    m => { m.endpoints.responses.pathParams = ["product"]; },
    m => { m.endpoints.responses.query = { product: "go" }; },
    m => { m.endpoints.responses.websocket = "openai.responses"; },
    m => { m.endpoints.responses.responsesLifecycle = { retrieve: "responses", cancel: "responses" }; },
    m => { m.endpoints.responses.responseFormat = "openai.chat_completions"; },
    m => { m.endpoints.responses.requestFormat = m.endpoints.responses.responseFormat = "google.interactions"; },
  ]) { const manifest = responsesFixture(); change(manifest); assert.throws(() => compile(manifest), /upstreamPath|invalid manifest/, String(change)); }
});

test("Responses dispatch declarations reject conflicting product paths and preserve absent mappings", () => {
  const manifest = responsesFixture();
  manifest.auth.grantTransports = { api_key: { endpointPaths: { responses: "/inference/openai/v1/responses" } } };
  assert.throws(() => compile(manifest), /upstreamPath/);
  manifest.auth.grantTransports.api_key.endpointPaths.responses = manifest.endpoints.responses.upstreamPath;
  const provider = compile(manifest).providers[0];
  assert.equal(provider.auth.grantTransports.api_key.endpointPaths.responses, provider.endpoints[0].upstreamPath);
  const unmapped = responsesFixture(); delete unmapped.endpoints.responses.upstreamPath;
  assert.equal(compile(unmapped).providers[0].endpoints[0].upstreamPath, undefined);
  for (const field of ["upstream_path", "upstreamUrl", "upstreamOrigin"]) {
    const alias = structuredClone(unmapped); alias.endpoints.responses[field] = "https://other.example";
    assert.throws(() => compile(alias), /invalid manifest/);
  }
});
