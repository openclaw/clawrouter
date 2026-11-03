import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../../scripts/compile-providers.mjs";
const { configuredUpstream } = await import("../providers.ts");
const { filterSyntheticModels } = await import("../synthetic-model-catalog.ts");
const { discoveryAllows, modelDiscoveryResponse } = await import("../model-discovery.ts");
const { HttpOperation } = await import("../http-operation.ts");
const existing = parse(readFileSync(new URL("../../providers/synthetic.provider.yaml", import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]).providers[0];
function fixture() {
  const manifest = structuredClone(existing);
  manifest.baseUrls.default = "https://api.synthetic.new";
  manifest.endpoints.chat_completions.upstreamPath = "/openai/v1/chat/completions";
  manifest.capabilities = manifest.capabilities.filter(row => row.endpoint !== "models_list");
  manifest.capabilities.push({ id: "models.list", endpoint: "models_list", methods: ["GET"] });
  manifest.endpoints.models_list = { method: "GET", path: "/models", upstreamPath: "/openai/v1/models",
    requestFormat: "synthetic.models", responseFormat: "synthetic.models", timeoutMs: 30000 };
  return manifest;
}
const row = id => ({ id, name: "Synthetic fixture", context_length: 131072, input_modalities: ["text"], output_modalities: ["text"] });

test("Synthetic native metadata compiles one mapped GET route without changing caller identity or original key", () => {
  const manifest = fixture(), before = structuredClone(manifest), provider = compile(manifest);
  const endpoint = provider.endpoints.find(row => row.id === "models_list");
  assert.deepEqual(manifest, before); assert.equal(endpoint.path, "/models"); assert.equal(endpoint.upstreamPath, "/openai/v1/models");
  assert.equal(endpoint.upstream_path, undefined); assert.equal(endpoint.method, "GET"); assert.deepEqual(endpoint.methods, ["GET"]);
  assert.equal(endpoint.request_format, "synthetic.models"); assert.equal(endpoint.response_format, "synthetic.models");
  assert.equal(endpoint.native_proxy, true); assert.equal(endpoint.requestPricing, undefined); assert.equal(endpoint.toolPricing, undefined);
  assert.equal(provider.endpoints.find(row => row.id === "chat_completions").path, "/chat/completions");
  const upstream = configuredUpstream(provider, null, { SYNTHETIC_API_KEY: "synthetic-fixture-key" });
  assert.equal(upstream.baseUrl, "https://api.synthetic.new"); assert.equal(upstream.headers.get("authorization"), "Bearer synthetic-fixture-key");
});

test("Synthetic metadata rejects unqualified formats, mappings, inference features and capability substitutions", () => {
  const changes = [
    m => { m.endpoints.models_list.requestFormat = "synthetic.other"; },
    m => { m.endpoints.models_list.responseFormat = "openai.models"; },
    m => { m.endpoints.models_list.requestFormat = "openai.models"; },
    m => { m.endpoints.models_list.method = "POST"; }, m => { delete m.endpoints.models_list.method; },
    m => { delete m.endpoints.models_list.upstreamPath; },
    m => { m.endpoints.models_list.path = "/v1/models"; },
    m => { m.endpoints.models_list.upstreamPath = "/models"; },
    m => { m.endpoints.models_list.upstreamPath = "https://api.synthetic.new/openai/v1/models"; },
    m => { m.endpoints.models_list.upstreamPath += "?key=synthetic"; },
    m => { m.endpoints.models_list.pathParams = ["model"]; },
    m => { m.endpoints.models_list.pathParamStyles = { model: "segment" }; },
    m => { m.endpoints.models_list.streaming = "sse"; },
    m => { m.endpoints.models_list.modelPassthrough = {}; },
    m => { m.endpoints.models_list.nativeProxy = false; },
    m => { m.capabilities.find(row => row.endpoint === "models_list").id = "llm.chat"; },
    m => { m.capabilities.find(row => row.endpoint === "models_list").methods = ["GET", "POST"]; },
    m => { m.capabilities = m.capabilities.filter(row => row.endpoint !== "models_list"); },
    m => { m.endpoints.second_models = structuredClone(m.endpoints.models_list); m.capabilities.push({ id: "models.list", endpoint: "second_models", methods: ["GET"] }); },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /synthetic.models|invalid manifest/, String(change)); }
});

test("Synthetic metadata rejects origin, auth, injected headers and query substitutions", () => {
  const changes = [
    m => { m.id = "other"; }, m => { m.baseUrls.default += "/openai/v1"; },
    m => { m.baseUrls.default = "https://untrusted.example"; }, m => { m.baseUrls.extra = "https://untrusted.example"; },
    m => { m.auth.schemes[0].header = "x-api-key"; }, m => { m.auth.schemes[0].format = "Token ${secret}"; },
    m => { m.auth.schemes[0].secretKind = "oauth"; }, m => { m.auth.schemes[0].required = false; },
    m => { m.auth.grantTransports = { api_key: { endpointPaths: { models_list: "/other" } } }; },
    m => { m.endpoints.models_list.auth = "none"; }, m => { m.endpoints.models_list.requestHeaders = ["authorization"]; },
    m => { m.endpoints.models_list.headers = { authorization: "Bearer synthetic" }; },
    m => { m.endpoints.models_list.query = { key: "synthetic" }; },
    m => { m.adapter.injectHeaders = { authorization: "Bearer synthetic" }; },
    m => { m.adapter.injectQuery = { key: "synthetic" }; }, m => { m.adapter.passthroughHeaders = ["authorization"]; },
  ];
  for (const change of changes) { const manifest = fixture(); change(manifest); assert.throws(() => compile(manifest), /synthetic.models|invalid manifest/, String(change)); }
});

test("Synthetic compiled identity composes with the landed codec and original policy without fabricated prices", () => {
  const provider = compile(fixture()), upstream = "syn:large:text", permitted = provider.models.find(model => model.upstream === upstream);
  const payload = { data: [row(upstream), row("hf:other/hidden")] };
  const result = filterSyntheticModels(payload, id => discoveryAllows({ models: [permitted.id] }, provider, id));
  assert.deepEqual(result, { data: [row(upstream)] }); assert.equal(result.object, undefined);
  assert.equal(permitted.pricing, null); assert.equal(permitted.pricing_ref, null); assert.equal(result.data[0].pricing, undefined);
  assert.deepEqual(filterSyntheticModels(payload, id => discoveryAllows({ models: [] }, provider, id)), { data: [] });
  const unknown = "hf:openai/gpt-oss-120b";
  assert.deepEqual(filterSyntheticModels({ data: [row(unknown)] }, id => discoveryAllows({ models: [`synthetic/${unknown}`] }, provider, id)), { data: [row(unknown)] });
});

test("Synthetic data-only codec qualification leaves strict OpenAI model discovery unchanged", async () => {
  const provider = compile(fixture()), endpoint = { ...provider.endpoints.find(row => row.id === "models_list"), request_format: "openai.models", response_format: "openai.models" };
  const operation = new HttpOperation();
  const payload = { data: [row("syn:large:text")] };
  assert.deepEqual(filterSyntheticModels(payload, () => true), payload);
  await assert.rejects(modelDiscoveryResponse(Response.json(payload), provider, endpoint, { models: null }, {}, operation,
    async () => { throw new Error("OpenAI rejection cannot paginate or replay"); }), error => error.code === "invalid_model_discovery_response");
});
