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
const mutations = {
  wrong_response: manifest => { manifest.endpoints.responses_compact.responseFormat = "openai.responses"; },
  wrong_method: manifest => { manifest.endpoints.responses_compact.method = "GET"; },
  extra_method: manifest => { manifest.capabilities.find(capability => capability.id === "llm.responses.compact").methods.push("GET"); },
  streaming: manifest => { manifest.endpoints.responses_compact.streaming = "sse"; },
  websocket: manifest => { manifest.endpoints.responses_compact.websocket = "openai.responses"; },
  passthrough: manifest => { manifest.endpoints.responses_compact.modelPassthrough = {}; },
  caller_limit: manifest => { manifest.endpoints.responses_compact.outputTokenLimit = { field: "max_output_tokens", minimum: 1, maximum: 128_000 }; },
  lifecycle: manifest => { manifest.endpoints.responses_compact.responsesLifecycle = { retrieve: "responses_retrieve", cancel: "responses_cancel" }; },
  unpriced_model: manifest => { delete manifest.models.entries.find(model => model.id === "openai/gpt-6-astra").pricing; },
  missing_bound: manifest => { delete manifest.models.entries.find(model => model.id === "openai/gpt-6-astra").pricing.defaultMaxOutputTokens; },
  no_registered_model: manifest => { for (const model of manifest.models.entries) model.capabilities = model.capabilities.filter(capability => capability !== "llm.responses.compact"); },
};
for (const [name, mutate] of Object.entries(mutations)) test("compiler refuses unqualified compact " + name, t => {
  const result = compile(t, mutate); assert.notEqual(result.status, 0); assert.match(result.stderr, /invalid manifest|compact/); assert.equal(result.stdout, "");
});
