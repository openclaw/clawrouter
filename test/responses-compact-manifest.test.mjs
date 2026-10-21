import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const source = parse(readFileSync(new URL("../providers/openai.provider.yaml", import.meta.url), "utf8"));
function compile(t, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "responses-compact-manifest-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = structuredClone(source); mutate(manifest);
  const path = join(directory, "openai.provider.yaml"); writeFileSync(path, JSON.stringify(manifest));
  return spawnSync(process.execPath, ["scripts/compile-providers.mjs", path], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
}
test("compiled compact is a distinct unary registered-model contract", t => {
  const result = compile(t); assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout), provider = snapshot.providers[0], compact = provider.endpoints.find(endpoint => endpoint.id === "responses_compact");
  assert.equal(compact.path, "/v1/responses/compact"); assert.deepEqual(compact.methods, ["POST"]);
  assert.equal(compact.request_format, "openai.responses_compact"); assert.equal(compact.response_format, "openai.responses_compact");
  assert.ok(!compact.streaming); assert.ok(!compact.websocket); assert.ok(!compact.modelPassthrough); assert.ok(!compact.outputTokenLimit); assert.ok(!compact.responsesLifecycle);
  assert.deepEqual(provider.models.filter(model => model.capabilities.includes("llm.responses.compact")).map(model => model.id), ["openai/gpt-6-astra", "openai/gpt-6.1-sol"]);
  assert.deepEqual(snapshot.capability_index["llm.responses.compact"], [{ provider: "openai", endpoint: "responses_compact", methods: ["POST"] }]);
});
function removePricing(manifest) {
  const model = manifest.models.entries.find(model => model.id === "openai/gpt-6-astra");
  delete model.pricing;
  // Isolate compact pricing from the independent native tier-pricing constraint.
  delete model.nativeCapabilities;
  return model;
}
test("ordinary unpriced models remain supported without compact capability", t => {
  const result = compile(t, manifest => {
    const model = removePricing(manifest);
    model.capabilities = model.capabilities.filter(capability => capability !== "llm.responses.compact");
  });
  assert.equal(result.status, 0, result.stderr);
  const model = JSON.parse(result.stdout).providers[0].models.find(model => model.id === "openai/gpt-6-astra");
  assert.ok(model.capabilities.includes("llm.responses"));
  assert.ok(!model.capabilities.includes("llm.responses.compact"));
  assert.equal(model.pricing, null);
});
const mutations = {
  wrong_response: manifest => { manifest.endpoints.responses_compact.responseFormat = "openai.responses"; },
  wrong_method: manifest => { manifest.endpoints.responses_compact.method = "GET"; },
  extra_method: manifest => { manifest.capabilities.find(capability => capability.id === "llm.responses.compact").methods.push("GET"); },
  streaming: manifest => { manifest.endpoints.responses_compact.streaming = "sse"; },
  websocket: manifest => { manifest.endpoints.responses_compact.websocket = "openai.responses"; },
  passthrough: manifest => { manifest.endpoints.responses_compact.modelPassthrough = {}; },
  caller_limit: manifest => { manifest.endpoints.responses_compact.outputTokenLimit = { field: "max_output_tokens", minimum: 1, maximum: 128_000 }; },
  lifecycle: manifest => { manifest.endpoints.responses_compact.responsesLifecycle = { retrieve: "responses_retrieve", cancel: "responses_cancel" }; },
  unpriced_model: removePricing,
  missing_bound: manifest => { delete manifest.models.entries.find(model => model.id === "openai/gpt-6-astra").pricing.defaultMaxOutputTokens; },
  no_registered_model: manifest => { for (const model of manifest.models.entries) model.capabilities = model.capabilities.filter(capability => capability !== "llm.responses.compact"); },
};
for (const [name, mutate] of Object.entries(mutations)) test("compiler refuses unqualified compact " + name, t => {
  const result = compile(t, mutate); assert.notEqual(result.status, 0);
  const diagnostic = result.stderr.match(/^Error: (.*)$/m)?.[1];
  assert.ok(diagnostic, result.stderr);
  const expected = name === "extra_method" ? /^provider openai endpoint responses_compact compact is POST-only$/
    : ["unpriced_model", "no_registered_model"].includes(name) ? /^provider openai endpoint responses_compact compact requires registered token-priced models with authoritative output bounds$/
    : /^provider openai invalid manifest:/;
  assert.match(diagnostic, expected); assert.equal(result.stdout, "");
});
