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
    m => { m.endpoints.chat.requestFormat = m.endpoints.chat.responseFormat = "openai.responses"; },
    m => { m.endpoints.chat.requestFormat = m.endpoints.chat.responseFormat = "unknown.protocol"; },
    m => { m.endpoints.models.requestFormat = m.endpoints.models.responseFormat = "synthetic.models"; },
    m => { m.endpoints.chat.method = "DELETE"; }, m => { m.capabilities[0].methods.push("GET"); },
    m => { m.endpoints.chat.websocket = "openai.responses"; },
    m => { m.endpoints.chat.responsesLifecycle = { retrieve: "models", cancel: "messages" }; },
    m => { m.endpoints.models.streaming = "sse"; }, m => { m.endpoints.models.modelPassthrough = {}; },
    m => { m.endpoints.models.requestFormat = m.endpoints.models.responseFormat = "anthropic.models"; m.endpoints.models.streaming = "sse"; },
  ]) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /upstreamPath/, String(change)); }
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
