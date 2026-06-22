import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

test("TypeScript provider compiler is deterministic and preserves the catalog contract", () => {
  const files = readdirSync("providers").filter((file) => file.endsWith(".provider.yaml")).sort().map((file) => `providers/${file}`);
  const compiled = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", ...files], { encoding: "utf8" }));
  const generated = JSON.parse(readFileSync("worker/generated/provider-snapshot.json", "utf8"));
  assert.deepEqual(compiled, generated);
  assert.equal(compiled.providers.length, 20);
  assert.equal(compiled.model_index["openai/gpt-5.5"].provider, "openai");
  assert.equal(compiled.model_index["anthropic/claude-opus-4-8"].provider, "anthropic");
  assert.ok(compiled.capability_index["llm.chat"].length >= 10);
});

test("compiled providers have unique ids, models, capabilities, and executable endpoint references", () => {
  const snapshot = JSON.parse(readFileSync("worker/generated/provider-snapshot.json", "utf8"));
  assert.equal(new Set(snapshot.providers.map((provider) => provider.id)).size, snapshot.providers.length);
  assert.equal(new Set(Object.keys(snapshot.model_index)).size, Object.keys(snapshot.model_index).length);
  for (const provider of snapshot.providers) {
    const endpoints = new Set(provider.endpoints.map((endpoint) => endpoint.id));
    assert.ok(provider.endpoints.length > 0, provider.id);
    for (const capability of provider.capabilities) assert.ok(endpoints.has(capability.endpoint), `${provider.id}:${capability.id}`);
  }
});

test("declared provider models retain distinct public and native upstream ids", () => {
  const snapshot = JSON.parse(readFileSync("worker/generated/provider-snapshot.json", "utf8"));
  const anthropic = snapshot.providers.find((provider) => provider.id === "anthropic");
  assert.ok(anthropic.models.some((model) => model.id === "anthropic/claude-sonnet-4-6" && model.upstream === "claude-sonnet-4-6" && model.pricing));
});

test("capabilities can share a non-literal endpoint without losing unified routes", () => {
  const snapshot = JSON.parse(readFileSync("worker/generated/provider-snapshot.json", "utf8"));
  const gateway = snapshot.providers.find((provider) => provider.id === "cloudflare-ai-gateway");
  assert.deepEqual(gateway.capabilities.map(({ id, endpoint }) => [id, endpoint]), [["llm.chat", "universal"], ["llm.responses", "universal"]]);
  assert.deepEqual(gateway.models[0].capabilities, ["llm.chat", "llm.responses"]);
});
