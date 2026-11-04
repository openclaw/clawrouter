import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { compileProviderSnapshot } from "../scripts/compile-providers.mjs";

const source = id => parse(readFileSync(new URL(`../providers/${id}.provider.yaml`, import.meta.url), "utf8"));
const compile = manifest => compileProviderSnapshot([manifest]).providers[0];
function particle() {
  const manifest = source("particle");
  manifest.capabilities = manifest.capabilities.filter(capability => capability.endpoint !== "models_list");
  manifest.capabilities.push({ id: "models.list", endpoint: "models_list", methods: ["GET"] });
  manifest.endpoints.models_list = { method: "GET", path: "/models", requestFormat: "openai.models", responseFormat: "openai.models" };
  return manifest;
}
const endpoint = manifest => manifest.endpoints.models_list;
const capability = manifest => manifest.capabilities.find(capability => capability.endpoint === "models_list");

test("corrected Particle catalog keeps explicit GET and omitted streaming compiles to null", () => {
  const manifest = particle();
  assert.equal(Object.hasOwn(endpoint(manifest), "streaming"), false);
  for (const explicitMethods of [true, false]) {
    if (!explicitMethods) delete capability(manifest).methods;
    const result = compile(manifest), catalog = result.endpoints.find(endpoint => endpoint.id === "models_list");
    assert.equal(catalog.method, "GET"); assert.deepEqual(catalog.methods, ["GET"]); assert.equal(catalog.streaming, null);
    assert.equal(result.capabilities.find(capability => capability.endpoint === catalog.id).id, "models.list");
  }
});

test("Particle catalog cannot compile capability typos, POST defaults, mixed methods or streaming sentinels", () => {
  for (const change of [
    manifest => { capability(manifest).id = "llm.models.list"; },
    manifest => { capability(manifest).id = "llm.chat"; },
    manifest => { manifest.capabilities = manifest.capabilities.filter(capability => capability.endpoint !== "models_list"); },
    manifest => { delete endpoint(manifest).method; },
    manifest => { endpoint(manifest).method = "POST"; },
    manifest => { capability(manifest).methods = ["POST"]; },
    manifest => { capability(manifest).methods = ["GET", "POST"]; },
    manifest => { manifest.capabilities.push({ id: "llm.chat", endpoint: "models_list", methods: ["POST"] }); },
    ...["sse", "ndjson", "none", ""].map(streaming => manifest => { endpoint(manifest).streaming = streaming; }),
    manifest => { endpoint(manifest).websocket = "openai.responses"; },
  ]) { const manifest = particle(); change(manifest); assert.throws(() => compile(manifest), /catalog protocol/, String(change)); }
});

test("registered catalog request and response protocols must form an actual pair", () => {
  for (const [requestFormat, responseFormat] of [
    ["openai.models", "anthropic.models"], ["anthropic.models", "openai.models"],
    ["openai.models", "openai.chat_completions"], ["openai.chat_completions", "openai.models"],
    ["future.models", "openai.models"], ["openai.models", "future.model_rows"],
  ]) {
    const manifest = particle(); Object.assign(endpoint(manifest), { requestFormat, responseFormat });
    assert.throws(() => compile(manifest), /catalog protocol requires a registered request\/response pair/);
  }
});

for (const id of ["openai", "anthropic"]) test(`${id} keeps its actual list and opaque model_id retrieval contracts`, () => {
  const manifest = source(id), result = compile(manifest);
  for (const endpoint of result.endpoints.filter(endpoint => endpoint.request_format === `${id}.models`)) {
    assert.equal(endpoint.response_format, `${id}.models`); assert.equal(endpoint.method, "GET");
    assert.deepEqual(endpoint.methods, ["GET"]); assert.equal(endpoint.streaming, null);
    assert.equal(result.capabilities.find(capability => capability.endpoint === endpoint.id).id,
      endpoint.path_params.length ? "models.retrieve" : "models.list");
    if (endpoint.path_params.length) {
      assert.deepEqual(endpoint.path_params, ["model_id"]); assert.equal(endpoint.path_param_styles.model_id, "opaque_segment");
    }
  }
});

test("catalog retrieval cannot borrow list capability, omit its selector or use an unregistered retrieval format", () => {
  for (const change of [
    manifest => { capability(manifest).id = "models.list"; },
    manifest => { endpoint(manifest).pathParams = []; },
    manifest => { endpoint(manifest).pathParams = ["model"]; },
    manifest => { endpoint(manifest).pathParams.push("account"); },
    manifest => { endpoint(manifest).path = "/models"; },
    manifest => { endpoint(manifest).path += "/${model_id}"; },
    manifest => { endpoint(manifest).requestFormat = endpoint(manifest).responseFormat = "ollama.models"; },
  ]) {
    const manifest = particle(); capability(manifest).id = "models.retrieve";
    Object.assign(endpoint(manifest), { path: "/models/${model_id}", pathParams: ["model_id"] });
    change(manifest); assert.throws(() => compile(manifest), /catalog protocol/);
  }
  const list = particle(); capability(list).id = "models.retrieve";
  assert.throws(() => compile(list), /canonical models.list/);
});

test("actual Ollama and Synthetic catalog declarations retain their distinct routes and formats", () => {
  for (const id of ["ollama", "synthetic"]) {
    const result = compile(source(id)), native = result.endpoints.find(endpoint => endpoint.request_format === `${id}.models`);
    assert.ok(native); assert.equal(native.response_format, `${id}.models`); assert.equal(native.streaming, null);
    assert.equal(native.path, id === "ollama" ? "/api/tags" : "/models");
    assert.equal(native.upstreamPath, id === "synthetic" ? "/openai/v1/models" : undefined);
  }
});

// Existing compiler contracts, including paired public fact projections and
// Featherless's separate paged codec. These fixtures do not activate providers.
for (const [id, format, endpointId, native] of [
  ["baseten", "baseten.models", "models_list", true], ["arcee", "arcee.models", "models_list", true],
  ["novita", "novita.models", "models_list", true], ["chutes", "chutes.models", "models_list", true],
  ["venice", "venice.models", "models_list", true], ["featherless", "featherless.models", "models_list", true],
  ["featherless", "featherless.catalog", "catalog", false],
  ["cerebras", "cerebras.public_catalog", "public_models", false], ["nvidia", "nvidia.public_catalog", "public_models", false],
]) test(`${format} preserves its registered pair and existing exposure restrictions`, () => {
  const manifest = source(id);
  manifest.capabilities = manifest.capabilities.filter(capability => !["models_list", "catalog", "public_models"].includes(capability.endpoint));
  for (const name of ["models_list", "catalog", "public_models"]) delete manifest.endpoints[name];
  manifest.capabilities.push({ id: "models.list", endpoint: endpointId, methods: ["GET"] });
  manifest.endpoints[endpointId] = { method: "GET", path: "/models", nativeProxy: native,
    requestFormat: format, responseFormat: format, headers: { accept: "application/json" }, timeoutMs: 10000 };
  const result = compile(manifest).endpoints.find(endpoint => endpoint.id === endpointId);
  assert.equal(result.request_format, format); assert.equal(result.response_format, format);
  assert.equal(result.method, "GET"); assert.deepEqual(result.methods, ["GET"]);
  assert.equal(result.streaming, null); assert.equal(result.native_proxy, native);
  if (!native) {
    manifest.endpoints[endpointId].nativeProxy = true;
    assert.throws(() => compile(manifest), /invalid manifest|catalog/);
  }
});

test("finite catalog validation leaves generic Chat defaults and unrelated capability/format names unchanged", () => {
  const manifest = source("particle"), baseline = compile(manifest);
  assert.equal(baseline.endpoints.find(endpoint => endpoint.id === "chat_completions").method, "POST");
  manifest.capabilities.push({ id: "llm.models.list", endpoint: "unregistered" });
  manifest.endpoints.unregistered = { path: "/fixture", requestFormat: "fixture.models", responseFormat: "fixture.model_rows", streaming: "sse" };
  const result = compile(manifest), endpoint = result.endpoints.find(endpoint => endpoint.id === "unregistered");
  assert.equal(endpoint.method, "POST"); assert.deepEqual(endpoint.methods, ["POST"]); assert.equal(endpoint.streaming, "sse");
  assert.deepEqual(result.models, baseline.models);
  assert.deepEqual(result.endpoints.filter(endpoint => endpoint.id !== "unregistered"), baseline.endpoints);
});
