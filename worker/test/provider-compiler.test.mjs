import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("TypeScript provider compiler is deterministic and preserves the catalog contract", () => {
  const files = readdirSync("providers").filter((file) => file.endsWith(".provider.yaml")).sort().map((file) => `providers/${file}`);
  const compiled = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", ...files], { encoding: "utf8" }));
  const generated = JSON.parse(readFileSync("worker/generated/provider-snapshot.json", "utf8"));
  assert.deepEqual(compiled, generated);
  assert.equal(compiled.providers.length, 21);
  assert.equal(compiled.model_index["openai/gpt-5.6"].provider, "openai");
  assert.equal(compiled.model_index["anthropic/claude-opus-4-8"].provider, "anthropic");
  assert.deepEqual(compiled.providers.find((provider) => provider.id === "aws-bedrock").optional_config_keys, ["AWS_SESSION_TOKEN"]);
  assert.deepEqual(compiled.providers.find((provider) => provider.id === "azure-openai").optional_config_keys, ["AZURE_OPENAI_COMPLETION_TOKEN_DEPLOYMENTS"]);
  const openai = compiled.providers.find((provider) => provider.id === "openai");
  const gpt56 = openai.models.find((model) => model.id === "openai/gpt-5.6");
  assert.equal(gpt56.upstream, "gpt-5.6");
  assert.deepEqual(gpt56.capabilities, ["llm.responses", "llm.chat"]);
  assert.deepEqual(gpt56.pricing, {
    effectiveAt: "2026-07-09",
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    inputMicrosPerMillion: 5000000,
    cachedInputMicrosPerMillion: 500000,
    cacheWriteInputMicrosPerMillion: 6250000,
    cacheWrite5mInputMicrosPerMillion: null,
    cacheWrite1hInputMicrosPerMillion: null,
    outputMicrosPerMillion: 30000000,
    maxInputTokens: 1050000,
    maxRequestInputTokens: null,
    defaultMaxOutputTokens: 128000,
    inputTokenOverhead: 1024,
    longContext: {
      thresholdInputTokens: 272000,
      inputMicrosPerMillion: 10000000,
      cachedInputMicrosPerMillion: 1000000,
      cacheWriteInputMicrosPerMillion: 12500000,
      cacheWrite5mInputMicrosPerMillion: null,
      cacheWrite1hInputMicrosPerMillion: null,
      outputMicrosPerMillion: 45000000,
    },
  });
  assert.ok(openai.adapter.requestTransforms.renameFields[0].upstreams.includes("gpt-5.6"));
  assert.deepEqual(openai.quota.responseHeaders.map((window) => window.id), ["rpm", "tpm", "subscription-primary", "subscription-secondary", "credits"]);
  assert.deepEqual(openai.quota.probes[0].grantKinds, ["subscription"]);
  assert.equal(openai.quota.probes[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(compiled.model_index["local/default"].provider, "local-openai");
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

test("quota header sources must retain their declared array shape", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-provider-"));
  const manifest = join(directory, "openai.provider.yaml");
  try {
    const invalid = readFileSync("providers/openai.provider.yaml", "utf8").replace("limitHeaders: [x-ratelimit-limit-requests]", "limitHeaders: x-ratelimit-limit-requests");
    writeFileSync(manifest, invalid);
    assert.throws(() => execFileSync(process.execPath, ["scripts/compile-providers.mjs", manifest], { encoding: "utf8", stdio: "pipe" }), /limitHeaders must be an array/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
