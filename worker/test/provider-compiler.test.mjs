import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

test("TypeScript provider compiler is deterministic and preserves the catalog contract", () => {
  const files = readdirSync("providers").filter((file) => file.endsWith(".provider.yaml")).sort().map((file) => `providers/${file}`);
  const compiled = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", ...files], { encoding: "utf8" }));
  const generated = JSON.parse(readFileSync("worker/generated/provider-snapshot.json", "utf8"));
  assert.deepEqual(compiled, generated);
  assert.equal(compiled.providers.length, 22);
  assert.equal(compiled.model_index["lanseq/qwen3.8-27b-int4"].provider, "lanseq");
  assert.equal(compiled.model_index["openai/gpt-5.6"].provider, "openai");
  assert.equal(compiled.model_index["anthropic/claude-opus-4-8"].provider, "anthropic");
  assert.deepEqual(compiled.providers.find((provider) => provider.id === "aws-bedrock").optional_config_keys, ["AWS_SESSION_TOKEN"]);
  assert.deepEqual(compiled.providers.find((provider) => provider.id === "azure-openai").optional_config_keys, ["AZURE_OPENAI_COMPLETION_TOKEN_DEPLOYMENTS", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT"]);
  const openai = compiled.providers.find((provider) => provider.id === "openai");
  assert.equal(openai.endpoints.find((endpoint) => endpoint.id === "responses").websocket, "openai.responses");
  assert.equal(compiled.providers.find((provider) => provider.id === "azure-openai").endpoints.find((endpoint) => endpoint.id === "responses").websocket, undefined);
  const astra = openai.models.find((model) => model.id === "openai/gpt-6-astra");
  assert.equal(astra.upstream, "gpt-6-astra");
  assert.deepEqual(astra.capabilities, ["llm.responses", "llm.chat"]);
  assert.deepEqual(astra.supportedReasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(compiled.model_index[astra.id], { provider: "openai", ...Object.fromEntries(Object.entries(astra).filter(([key]) => key !== "id")) });
  assert.ok(openai.adapter.requestTransforms.renameFields[0].upstreams.includes(astra.upstream));
  const gpt56 = openai.models.find((model) => model.id === "openai/gpt-5.6");
  assert.equal(gpt56.upstream, "gpt-5.6");
  assert.equal(gpt56.codexModel, "gpt-5.6-sol");
  assert.equal(compiled.model_index[gpt56.id].codexModel, gpt56.codexModel);
  for (const name of ["sol", "terra", "luna"]) {
    const model = compiled.model_index[`openai/gpt-5.6-${name}`];
    assert.equal(model.upstream, `gpt-5.6-${name}`);
    assert.equal(model.pricing.maxInputTokens, 922000);
    assert.ok(openai.adapter.requestTransforms.renameFields[0].upstreams.includes(model.upstream));
    assert.deepEqual(model.supportedReasoningEfforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  }
  assert.deepEqual(gpt56.capabilities, ["llm.responses", "llm.chat"]);
  assert.deepEqual(gpt56.supportedReasoningEfforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(compiled.model_index["openai/gpt-5.6"].supportedReasoningEfforts, gpt56.supportedReasoningEfforts);
  assert.equal("supportedReasoningEfforts" in openai.models.find((model) => model.id === "openai/gpt-5.5"), false);
  const { serviceTiers, ...standard } = gpt56.pricing;
  assert.deepEqual(standard, {
    effectiveAt: "2026-09-22",
    source: "https://developers.openai.com/api/docs/pricing",
    inputMicrosPerMillion: 4000000,
    cachedInputMicrosPerMillion: 400000,
    cacheWriteInputMicrosPerMillion: 5000000,
    cacheWrite5mInputMicrosPerMillion: null,
    cacheWrite1hInputMicrosPerMillion: null,
    outputMicrosPerMillion: 20000000,
    maxInputTokens: 922000,
    maxRequestInputTokens: null,
    defaultMaxOutputTokens: 128000,
    inputTokenOverhead: 1024,
    longContext: {
      thresholdInputTokens: 272000,
      inputMicrosPerMillion: 8000000,
      cachedInputMicrosPerMillion: 800000,
      cacheWriteInputMicrosPerMillion: 10000000,
      cacheWrite5mInputMicrosPerMillion: null,
      cacheWrite1hInputMicrosPerMillion: null,
      outputMicrosPerMillion: 30000000,
    },
  });
  assert.deepEqual(serviceTiers.map(({ id, aliases }) => [id, aliases]), [["default", []], ["priority", ["fast"]], ["flex", []]]);
  assert.equal(serviceTiers[1].inputMicrosPerMillion, 8_000_000);
  assert.equal(serviceTiers[1].longContext.outputMicrosPerMillion, 60_000_000);
  assert.ok(openai.adapter.requestTransforms.renameFields[0].upstreams.includes("gpt-5.6"));
  assert.deepEqual(openai.quota.responseHeaders.map((window) => window.id), ["rpm", "tpm", "subscription-primary", "subscription-secondary", "credits"]);
  assert.deepEqual(openai.quota.probes[0].grantKinds, ["subscription"]);
  assert.equal(openai.quota.probes[0].url, "https://chatgpt.com/backend-api/wham/usage");
  const anthropic = compiled.providers.find((provider) => provider.id === "anthropic");
  const fable51 = anthropic.models.find((model) => model.id === "anthropic/claude-fable-5-1");
  assert.equal(fable51.upstream, "claude-fable-5-1");
  assert.equal(fable51.pricing.cachedInputMicrosPerMillion, 250000);
  assert.deepEqual(anthropic.quota.responseHeaders.filter((window) => window.kind === "subscription").map((window) => [window.id, window.metricScale]), [
    ["subscription-five-hour", 100],
    ["subscription-seven-day", 100],
  ]);
  assert.equal(anthropic.quota.probes[0].requiresRefreshToken, true);
  assert.equal(compiled.model_index["local/default"].provider, "local-openai");
  assert.ok(compiled.capability_index["llm.chat"].length >= 10);
});

test("provider schema bounds reasoning efforts to canonical wire values", () => {
  const schema = JSON.parse(readFileSync("providers/_schema/service-provider.schema.json", "utf8"));
  assert.deepEqual(schema.$defs.model.properties.supportedReasoningEfforts, {
    type: "array",
    items: { enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
    minItems: 1,
    maxItems: 7,
    uniqueItems: true,
  });
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
    assert.throws(() => execFileSync(process.execPath, ["scripts/compile-providers.mjs", manifest], { encoding: "utf8", stdio: "pipe" }), /invalid manifest:.*\/limitHeaders:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("quota metric scales and probe requirements reject invalid manifest values", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-provider-"));
  const manifest = join(directory, "anthropic.provider.yaml");
  const source = readFileSync("providers/anthropic.provider.yaml", "utf8");
  try {
    writeFileSync(manifest, source.replace("metricScale: 100", "metricScale: 0"));
    assert.throws(() => execFileSync(process.execPath, ["scripts/compile-providers.mjs", manifest], { encoding: "utf8", stdio: "pipe" }), /invalid manifest:.*\/metricScale:/);
    writeFileSync(manifest, source.replace("requiresRefreshToken: true", "requiresRefreshToken: refresh"));
    assert.throws(() => execFileSync(process.execPath, ["scripts/compile-providers.mjs", manifest], { encoding: "utf8", stdio: "pipe" }), /invalid manifest:.*\/requiresRefreshToken:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reasoning effort metadata rejects empty, duplicate, and unsupported values", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-provider-"));
  const manifest = join(directory, "openai.provider.yaml");
  const source = readFileSync("providers/openai.provider.yaml", "utf8");
  const cases = ["[]", "[none, low, low]", "[none, ultra]"];
  try {
    for (const value of cases) {
      writeFileSync(manifest, source.replace("[none, low, medium, high, xhigh, max]", value));
      assert.throws(() => execFileSync(process.execPath, ["scripts/compile-providers.mjs", manifest], { encoding: "utf8", stdio: "pipe" }), /invalid manifest:.*\/supportedReasoningEfforts/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service tier compilation rejects ambiguous, incomplete, and drifting rate cards", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-provider-"));
  const manifest = join(directory, "openai.provider.yaml");
  const source = readFileSync("providers/openai.provider.yaml", "utf8");
  const cases = [
    ["aliases: [fast]", "aliases: [default]", /ids and aliases must be unique/],
    ["aliases: [fast]", "aliases: [auto]", /ids and aliases must be unique/],
    ["- id: default\n            inputMicrosPerMillion: 4000000", "- id: default\n            inputMicrosPerMillion: 5000000", /default card must match/],
    ["- id: default", "- id: missing", /default card must match/],
    ["inputMicrosPerMillion: 8000000\n            cachedInputMicrosPerMillion", "inputMicrosPerMillion: -1\n            cachedInputMicrosPerMillion", /invalid manifest:.*\/inputMicrosPerMillion:/],
    ["maxInputTokens: 272000", "maxInputTokens: 0", /invalid manifest:.*\/maxInputTokens:/],
  ];
  try {
    for (const [from, to, expected] of cases) {
      assert.ok(source.includes(from));
      writeFileSync(manifest, source.replace(from, to));
      assert.throws(() => execFileSync(process.execPath, ["scripts/compile-providers.mjs", manifest], { encoding: "utf8", stdio: "pipe" }), expected);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("grant transport endpoint restrictions require unique own endpoint names", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-provider-"));
  const manifest = join(directory, "openai.provider.yaml");
  const source = readFileSync("providers/openai.provider.yaml", "utf8");
  const anchor = "allowedEndpoints: [responses]";
  assert.ok(source.includes(anchor));
  try {
    for (const value of ["responses", "[]", "[responses, responses]", "[missing_endpoint]", "[null]", "[1]", "[[responses]]", "[toString]", "[constructor]"]) {
      writeFileSync(manifest, source.replace(anchor, `allowedEndpoints: ${value}`));
      assert.throws(() => execFileSync(process.execPath, ["scripts/compile-providers.mjs", manifest], { encoding: "utf8", stdio: "pipe" }), /allowedEndpoints/);
    }
    writeFileSync(manifest, source);
    const compiled = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", manifest], { encoding: "utf8" }));
    assert.deepEqual(compiled.providers[0].auth.grantTransports.subscription.allowedEndpoints, ["responses"]);
    writeFileSync(manifest, source.replace(`      ${anchor}\n`, ""));
    const unrestricted = JSON.parse(execFileSync(process.execPath, ["scripts/compile-providers.mjs", manifest], { encoding: "utf8" }));
    assert.equal("allowedEndpoints" in unrestricted.providers[0].auth.grantTransports.subscription, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("Codex model aliases require an explicit nonempty native slug", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-provider-"));
  const manifest = join(directory, "openai.provider.yaml");
  const source = readFileSync("providers/openai.provider.yaml", "utf8");
  const anchor = "codexModel: gpt-5.6-sol";
  assert.ok(source.includes(anchor));
  try {
    for (const value of ['""', '" "', "null", "42", "[gpt-5.6-sol]"]) {
      writeFileSync(manifest, source.replace(anchor, `codexModel: ${value}`));
      assert.throws(() => execFileSync(process.execPath, ["scripts/compile-providers.mjs", manifest], { encoding: "utf8", stdio: "pipe" }), /codexModel/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("ordinary pricing cards reject invalid schema fields before emitting a snapshot", () => {
  const valid = parse(readFileSync("providers/deepseek.provider.yaml", "utf8"));
  const rateFields = ["inputMicrosPerMillion", "outputMicrosPerMillion", "cachedInputMicrosPerMillion", "cacheWriteInputMicrosPerMillion", "cacheWrite5mInputMicrosPerMillion", "cacheWrite1hInputMicrosPerMillion"];
  const cases = [
    ...rateFields.map((field) => [field, (pricing) => { pricing[field] = -1; }]),
    ["fractional rate", (pricing) => { pricing.inputMicrosPerMillion = 0.5; }],
    ["unsafe rate", (pricing) => { pricing.outputMicrosPerMillion = Number.MAX_SAFE_INTEGER + 1; }],
    ["missing rate", (pricing) => { delete pricing.outputMicrosPerMillion; }],
    ["invalid calendar date", (pricing) => { pricing.effectiveAt = "2026-02-29"; }],
    ["missing source", (pricing) => { delete pricing.source; }],
    ["insecure source", (pricing) => { pricing.source = "http://example.com/pricing"; }],
    ["zero input limit", (pricing) => { pricing.maxInputTokens = 0; }],
    ["unsafe input limit", (pricing) => { pricing.maxInputTokens = Number.MAX_SAFE_INTEGER + 1; }],
    ["negative output limit", (pricing) => { pricing.defaultMaxOutputTokens = -1; }],
    ["negative overhead", (pricing) => { pricing.inputTokenOverhead = -1; }],
    ["unknown field", (pricing) => { pricing.inputMicrosPerToken = 1; }],
    ["partial long-context card", (pricing) => { pricing.longContext = { thresholdInputTokens: 100, inputMicrosPerMillion: 1 }; }],
    ["unsafe long-context rate", (pricing) => { pricing.longContext = { thresholdInputTokens: 100, inputMicrosPerMillion: Number.MAX_SAFE_INTEGER + 1, outputMicrosPerMillion: 1 }; }],
  ];
  withManifest((path) => {
    for (const [name, mutate] of cases) {
      const manifest = structuredClone(valid);
      mutate(manifest.models.entries[0].pricing);
      writeFileSync(path, JSON.stringify(manifest));
      assert.throws(() => compile(path), (error) => {
        assert.equal(error.stdout, "", name);
        assert.match(error.stderr, /provider deepseek invalid manifest:.*#\/models\/entries\/0\/pricing/);
        return true;
      }, name);
    }
    for (const value of [".inf", ".nan"]) {
      writeFileSync(path, readFileSync("providers/deepseek.provider.yaml", "utf8").replace("inputMicrosPerMillion: 435000", `inputMicrosPerMillion: ${value}`));
      assert.throws(() => compile(path), /invalid manifest:.*\/inputMicrosPerMillion:/);
    }
    const pricing = valid.models.entries[0].pricing;
    Object.assign(pricing, { effectiveAt: "2028-02-29", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, defaultMaxOutputTokens: 0 });
    writeFileSync(path, JSON.stringify(valid));
    assert.equal(JSON.parse(compile(path)).providers[0].models[0].pricing.outputMicrosPerMillion, 0);
  });
});

test("canonical schema validates root, endpoint and auth shapes without hiding reference errors", () => {
  const valid = parse(readFileSync("providers/deepseek.provider.yaml", "utf8"));
  const cases = [
    ["null root", () => null, /invalid manifest: #:/],
    ["unknown root field", (manifest) => ({ ...manifest, display_name: "wrong field" }), /invalid manifest: #:/],
    ["missing endpoint format", (manifest) => { delete manifest.endpoints.chat_completions.requestFormat; return manifest; }, /invalid manifest:.*\/endpoints\/chat_completions:/],
    ["missing bearer header", (manifest) => { delete manifest.auth.schemes[0].header; return manifest; }, /invalid manifest:.*\/auth\/schemes\/0/],
    ["unknown auth field", (manifest) => { manifest.auth.schemes[0].token = "fixture"; return manifest; }, /invalid manifest:.*\/auth\/schemes\/0/],
    ["missing capability endpoint", (manifest) => { manifest.capabilities[0].endpoint = "missing"; return manifest; }, /references missing endpoint missing/],
    ["inherited capability endpoint", (manifest) => { manifest.capabilities[0].endpoint = "constructor"; return manifest; }, /references missing endpoint constructor/],
    ["undeclared path parameter", (manifest) => { manifest.endpoints.chat_completions.path = "/${missing}"; return manifest; }, /path parameter missing is not declared/],
    ["ordinary long-context boundary", (manifest) => { const pricing = manifest.models.entries[0].pricing; pricing.longContext = { thresholdInputTokens: pricing.maxInputTokens, inputMicrosPerMillion: 1, outputMicrosPerMillion: 1 }; return manifest; }, /invalid long-context threshold/],
  ];
  withManifest((path) => {
    for (const [name, mutate, expected] of cases) {
      writeFileSync(path, JSON.stringify(mutate(structuredClone(valid))));
      assert.throws(() => compile(path), expected, name);
    }
  });
});

function compile(path) {
  return execFileSync(process.execPath, ["scripts/compile-providers.mjs", path], { encoding: "utf8", stdio: "pipe" });
}

function withManifest(run) {
  const directory = mkdtempSync(join(tmpdir(), "clawrouter-provider-"));
  try { run(join(directory, "provider.yaml")); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
