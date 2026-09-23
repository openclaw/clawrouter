import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { buildAdviserBody, DEFAULT_FUSION_CONFIG } from "../fusion.ts";
import { estimateModelCost } from "../pricing.ts";
import { providerById } from "../providers.ts";
import { fixture, policy } from "./credential-fixture.mjs";

const { fusionReadiness } = await import("../fusion-readiness.ts");

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
  { modelId: "local/qwen3:8b", providerId: "local-openai", providerDisplayName: "Local OpenAI-compatible", endpoint: { id: "chat_completions", request_format: "openai.chat_completions" }, model: { id: "local/qwen3:8b", upstream: "qwen3:8b", capabilities: ["llm.chat"], pricing_ref: null, pricing: null } },
  { modelId: "openai/gpt-4.1-mini", providerId: "openai", providerDisplayName: "OpenAI", endpoint: { id: "chat_completions", request_format: "openai.chat_completions" }, model: { id: "openai/gpt-4.1-mini", upstream: "gpt-4.1-mini", capabilities: ["llm.chat"], pricing_ref: null, pricing: null } },
];

test("Fusion preflight uses request completeness for both budgets and preserves fixed zero", () => {
  const provider = providerById("perplexity");
  const model = provider.models.find((model) => model.id === "perplexity/sonar-pro");
  const endpoint = provider.endpoints.find((endpoint) => endpoint.id === "chat_completions");
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: [model.id], aggregatorModel: model.id };
  for (const [policyLimit, providerLimit, fixed, executable, basis] of [
    [100_000_000, null, null, false, "unpriced_request"],
    [null, 100_000_000, null, false, "unpriced_request"],
    [null, null, null, true, "unpriced_request"],
    [100_000_000, 100_000_000, 0, true, "policy_fixed"],
  ]) {
    const entry = { policyId: "request-fees", policy: { enabled: true, providers: [], monthlyBudgetMicros: policyLimit, requestCostMicros: fixed } };
    const route = { modelId: model.id, providerId: provider.id, providerDisplayName: provider.display_name, endpoint, model, connection: { providerId: provider.id, enabled: true, monthlyBudgetMicros: providerLimit } };
    const result = fusionReadiness(config, entry, [{ ...baseReadiness, id: provider.id }], [route], { configured: policyLimit != null, ledger: policyLimit == null ? "unmetered" : "durable_object", remainingMicros: policyLimit });
    assert.equal(result.executable, executable);
    assert.equal(result.advertisable, executable);
    assert.ok(result.calls.every((call) => call.executable === executable && call.estimateBasis === basis));
    if (!executable) assert.ok(result.calls.at(-1).reasons.some((reason) => /model request fees/.test(reason)));
    if (executable && basis === "unpriced_request") assert.match(result.estimateNote, /unavailable/);
  }
});

test("admin Fusion preview reads the stored provider limit and selected policy tariff", async (t) => {
  const env = await fixture(t);
  env.PERPLEXITY_API_KEY = "fixture-perplexity-key";
  t.mock.method(globalThis, "fetch", () => { throw new Error("preview must not contact upstream"); });
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: ["perplexity/sonar-pro"], aggregatorModel: "perplexity/sonar-pro" };
  for (const fixed of [null, 0]) {
    assert.equal((await env.http("/v1/admin/policies/maintainer_access", "PUT", { ...policy, providers: ["perplexity"], monthlyBudgetMicros: null, requestCostMicros: fixed })).status, 200);
    assert.equal((await env.http("/v1/admin/connections/perplexity", "PUT", { enabled: true, monthlyBudgetMicros: 100_000_000 })).status, 200);
    const response = await env.http("/v1/admin/fusion/preview", "POST", { policyId: "maintainer_access", config });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.executable, fixed === 0);
    assert.ok(preview.calls.every((call) => call.estimateBasis === (fixed === 0 ? "policy_fixed" : "unpriced_request")));
  }
});

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
  assert.match(readiness.calls[0].reasons.join(" "), /temperature preference omitted/);
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
  assert.equal(readiness.calls[0].executable, false);
  assert.ok(readiness.calls[0].reasons.some((reason) => /manifest pricing/.test(reason)));
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

test("fusion readiness carries endpoint-owned limits into adviser and synthesizer reservations", () => {
  const pricing = { inputMicrosPerMillion: 0, outputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: null, cacheWriteInputMicrosPerMillion: null, cacheWrite5mInputMicrosPerMillion: null, cacheWrite1hInputMicrosPerMillion: null, maxInputTokens: 1_048_576, maxRequestInputTokens: null, defaultMaxOutputTokens: 1, inputTokenOverhead: 0, longContext: null };
  const route = { ...routes[0], endpoint: { ...routes[0].endpoint, outputTokenLimit: { field: "max_tokens", minimum: 1, maximum: 393_216 } }, model: { ...routes[0].model, pricing } };
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: [route.modelId], aggregatorModel: route.modelId };
  const entry = { policyId: "fixture", policy: { enabled: true, providers: [] } };
  const readiness = fusionReadiness(config, entry, [{ ...baseReadiness, id: route.providerId }], [route], { configured: false, ledger: "unmetered", remainingMicros: null });
  assert.deepEqual(readiness.calls.map(call => call.estimatedReservationMicros), [config.maxOutputTokens, 393_216]);
});
