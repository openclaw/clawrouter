import assert from "node:assert/strict";
import test from "node:test";
import { fusionReadiness } from "../fusion-readiness.ts";
import { buildAdviserBody, DEFAULT_FUSION_CONFIG } from "../fusion.ts";
import { estimateModelCost } from "../pricing.ts";

const baseReadiness = {
  displayName: "Provider",
  class: "openai_compatible",
  serviceKind: "model_api",
  requiredConfig: [],
  optionalConfig: [],
  missingConfig: [],
  configPresent: true,
  connectionEnabled: true,
  oauthGrantRequired: false,
  oauthGrantCount: 0,
  upstreamGrantCount: 1,
  openaiCompatible: true,
  manifestRoutes: 1,
  executableEndpoints: ["chat_completions"],
  modelCount: 1,
  executable: true,
  verified: true,
  lastCheckedAt: "2026-07-06T00:00:00.000Z",
  latencyMs: 10,
  status: "verified",
  reasons: [],
};

const routes = [
  { modelId: "local/qwen3:8b", providerId: "local-openai", providerDisplayName: "Local OpenAI-compatible", endpointId: "chat_completions", model: { id: "local/qwen3:8b", upstream: "qwen3:8b", capabilities: ["llm.chat"], pricing_ref: null, pricing: null } },
  { modelId: "openai/gpt-4.1-mini", providerId: "openai", providerDisplayName: "OpenAI", endpointId: "chat_completions", model: { id: "openai/gpt-4.1-mini", upstream: "gpt-4.1-mini", capabilities: ["llm.chat"], pricing_ref: null, pricing: null } },
];

test("fusion readiness reports policy-scoped execution and exact fixed-price call envelope", () => {
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: ["local/qwen3:8b", "openai/gpt-4.1-mini"] };
  const entry = { policyId: "fusion_policy", policy: { enabled: true, generation: "1", providers: [], tenantId: "default", requestCostMicros: 7, retainRequestContent: false } };
  const readiness = fusionReadiness(config, entry, [
    { ...baseReadiness, id: "local-openai" },
    { ...baseReadiness, id: "openai" },
  ], routes, { configured: true, ledger: "durable_object", remainingMicros: 100 });

  assert.equal(readiness.executable, true);
  assert.equal(readiness.advertisable, true);
  assert.equal(readiness.readyAdviserCount, 2);
  assert.equal(readiness.callCount, 3);
  assert.equal(readiness.estimatedReservationMicros, 21);
  assert.deepEqual(readiness.calls.map((call) => call.stage), ["adviser", "adviser", "synthesizer"]);
  assert.ok(readiness.calls.every((call) => call.estimateBasis === "policy_fixed"));
});

test("fusion readiness prevents adviser fan-out when the policy blocks its synthesizer", () => {
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: ["local/qwen3:8b"] };
  const entry = { policyId: "local_only", policy: { enabled: true, generation: "1", providers: ["local-openai"], tenantId: "default", retainRequestContent: false } };
  const readiness = fusionReadiness(config, entry, [
    { ...baseReadiness, id: "local-openai", verified: false, status: "unverified", reasons: ["Configured but not recently verified by a live smoke test."] },
    { ...baseReadiness, id: "openai" },
  ], routes, { configured: false, ledger: "unmetered", remainingMicros: null });

  assert.equal(readiness.readyAdviserCount, 0);
  assert.equal(readiness.calls[0].status, "blocked");
  assert.equal(readiness.calls[0].executable, false);
  assert.ok(readiness.calls[0].reasons.some((reason) => /preflight prevents/.test(reason)));
  assert.equal(readiness.calls[1].executable, false);
  assert.equal(readiness.calls[1].policyAllowed, false);
  assert.match(readiness.calls[1].reasons[0], /does not allow OpenAI/i);
  assert.equal(readiness.executable, false);
  assert.equal(readiness.advertisable, false);
});

test("fusion readiness blocks deterministic pricing and budget failures before fan-out", () => {
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: ["local/qwen3:8b"], aggregatorModel: "local/qwen3:8b" };
  const entry = { policyId: "budgeted", policy: { enabled: true, generation: "1", providers: ["local-openai"], tenantId: "default", monthlyBudgetMicros: 100, retainRequestContent: false } };
  const readiness = fusionReadiness(config, entry, [{ ...baseReadiness, id: "local-openai" }], routes, { configured: true, ledger: "durable_object", remainingMicros: 100 });

  assert.equal(readiness.executable, false);
  assert.equal(readiness.estimatedReservationMicros, 0);
  assert.ok(readiness.calls.at(-1).reasons.some((reason) => /manifest pricing/.test(reason)));
  assert.ok(readiness.calls[0].reasons.some((reason) => /preflight prevents/.test(reason)));
});

test("fusion readiness allows zero-cost calls with an exhausted positive budget", () => {
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: ["local/qwen3:8b"], aggregatorModel: "local/qwen3:8b" };
  const entry = { policyId: "free", policy: { enabled: true, generation: "1", providers: ["local-openai"], tenantId: "default", monthlyBudgetMicros: 100, requestCostMicros: 0, retainRequestContent: false } };
  const readiness = fusionReadiness(config, entry, [{ ...baseReadiness, id: "local-openai" }], routes, { configured: true, ledger: "durable_object", remainingMicros: 0 });

  assert.equal(readiness.executable, true);
  assert.equal(readiness.estimatedReservationMicros, 0);
  assert.ok(readiness.calls.every((call) => call.executable));
});

test("fusion readiness prices the worst-case JSON expansion within the adviser character bound", () => {
  const pricing = { effectiveAt: "2026-07-01", source: "test", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 0, cachedInputMicrosPerMillion: null, cacheWriteInputMicrosPerMillion: null, cacheWrite5mInputMicrosPerMillion: null, cacheWrite1hInputMicrosPerMillion: null, maxInputTokens: 100_000, maxRequestInputTokens: null, defaultMaxOutputTokens: 64, inputTokenOverhead: 0, longContext: null };
  const pricedRoutes = routes.map((route) => route.modelId === "local/qwen3:8b" ? { ...route, model: { ...route.model, pricing } } : route);
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: ["local/qwen3:8b"], maxInputChars: 1_000 };
  const entry = { policyId: "unmetered", policy: { enabled: true, generation: "1", providers: [], tenantId: "default", retainRequestContent: false } };
  const readiness = fusionReadiness(config, entry, [{ ...baseReadiness, id: "local-openai" }, { ...baseReadiness, id: "openai" }], pricedRoutes, { configured: false, ledger: "unmetered", remainingMicros: null });
  const worstCase = estimateModelCost(pricing, buildAdviserBody({ messages: [{ role: "user", content: "\0".repeat(config.maxInputChars) }] }, "local/qwen3:8b", config, 0));

  assert.equal(readiness.calls[0].estimatedReservationMicros, worstCase.reserveMicros);
});
