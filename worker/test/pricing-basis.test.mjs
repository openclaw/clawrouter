import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { validateBudgetReservation } = await import("../accounting.ts");
const { correlateIngressRequest } = await import("../correlation.ts");
const { createProxyAccounting, estimateCost } = await import("../proxy-accounting.ts");

const pricing = {
  effectiveAt: "2026-09-23", source: "https://example.com/pricing", settlementBasis: "published_upper_bound",
  inputMicrosPerMillion: 300_000, cachedInputMicrosPerMillion: 6_000, outputMicrosPerMillion: 1_200_000,
  cacheWriteInputMicrosPerMillion: null, cacheWrite5mInputMicrosPerMillion: null, cacheWrite1hInputMicrosPerMillion: null,
  maxInputTokens: 1_048_576, maxRequestInputTokens: null, defaultMaxOutputTokens: 393_216, inputTokenOverhead: 1_024, longContext: null,
};
const endpoint = { request_format: "openai.chat_completions", outputTokenLimit: { field: "max_tokens", minimum: 1, maximum: 393_216 } };
const tokens = { input: 1_000, output: 20, total: 1_020, cached: 800, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
const { settlementBasis, ...ordinary } = pricing;
const tiered = { ...pricing, serviceTiers: [{ ...ordinary, id: "default", aliases: [], maxInputTokens: null }] };
const free = { ...pricing, inputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, outputMicrosPerMillion: 0 };

for (const scenario of [
  { name: "measured upper bound", actual: 89, basis: "manifest_rate_upper_bound" },
  { name: "unannotated sibling", pricing: ordinary, actual: 89, basis: "manifest_pricing" },
  { name: "missing usage", tokens: null, basis: "manifest_reservation" },
  { name: "dispatched failure retains reservation", fail: true, basis: "manifest_reservation" },
  { name: "missing input", tokens: { ...tokens, input: null }, basis: "manifest_reservation" },
  { name: "missing output", tokens: { ...tokens, output: null }, basis: "manifest_reservation" },
  { name: "known served tier recovers request gap", pricing: tiered, body: { service_tier: "future" }, tokens: { ...tokens, serviceTier: "default" }, reserveBasis: "unpriced_service_tier", actual: 89, basis: "manifest_rate_upper_bound" },
  { name: "unknown served tier", pricing: tiered, body: { service_tier: "future" }, tokens: { ...tokens, serviceTier: "future" }, reserveBasis: "unpriced_service_tier", actual: 0, basis: "unpriced_usage" },
  { name: "unknown served tier without usage", pricing: tiered, body: { service_tier: "future" }, tokens: null, reserveBasis: "unpriced_service_tier", actual: 0, basis: "unpriced_usage" },
  { name: "unpriced request fee dominates annotation", pricing: { ...pricing, unpricedCosts: ["request_fee"] }, reserveBasis: "unpriced_request", actual: 0, basis: "unpriced_usage" },
  { name: "hosted fee dominates annotation", body: { web_search_options: {} }, reserveBasis: "unpriced_request", actual: 0, basis: "unpriced_usage" },
  { name: "fixed zero overrides fee gap", pricing: { ...pricing, unpricedCosts: ["request_fee"] }, fixed: 0, reserveBasis: "policy_fixed", actual: 0, basis: "policy_fixed" },
  { name: "positive fixed tariff", fixed: 7, reserveBasis: "policy_fixed", actual: 7, basis: "policy_fixed" },
  { name: "positive fixed tariff survives provider refusal", fixed: 7, tokens: { ...tokens, billable: false }, reserveBasis: "policy_fixed", actual: 7, basis: "policy_fixed" },
  { name: "known nonbillable", tokens: { ...tokens, billable: false }, actual: 0, basis: "none" },
  { name: "known nonbillable preserves fixed zero", fixed: 0, tokens: { ...tokens, billable: false }, reserveBasis: "policy_fixed", actual: 0, basis: "policy_fixed" },
  { name: "non-2xx", billable: false, actual: 0, basis: "none" },
  { name: "non-2xx precedes missing request price", pricing: { ...pricing, unpricedCosts: ["request_fee"] }, billable: false, reserveBasis: "unpriced_request", actual: 0, basis: "none" },
  { name: "free annotated rate", pricing: free, actual: 0, basis: "manifest_rate_upper_bound" },
  { name: "free counting", capability: "llm.count_tokens", tokens: null, reserveBasis: "none", actual: 0, basis: "none" },
  { name: "no-card fallback", pricing: null, reserveBasis: "flat_fallback", actual: 1, basis: "flat_fallback" },
]) {
  test(`pricing basis: ${scenario.name}`, async () => {
    const events = [], pending = [], model = { id: "fixture/model", pricing: Object.hasOwn(scenario, "pricing") ? scenario.pricing : pricing };
    const observed = Object.hasOwn(scenario, "tokens") ? scenario.tokens : tokens;
    const owner = createProxyAccounting({
      env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: { waitUntil: promise => pending.push(promise) },
      auth: { policyId: "fixture", policy: { requestCostMicros: scenario.fixed ?? null } },
      selection: { provider: { id: "fixture" }, model, endpoint, body: { max_tokens: 32, ...scenario.body }, capability: scenario.capability ?? "llm.chat" },
      request: correlateIngressRequest(new Request("https://router.example/v1/chat/completions")).request,
    });
    assert.equal(owner.cost.basis, scenario.reserveBasis ?? "manifest_pricing");
    const reservation = { reservations: [], reservedMicros: owner.cost.reserveMicros };
    if (scenario.fail) {
      owner.fail(502, "provider_error", reservation, null, true);
      assert.deepEqual(await Promise.all(pending), [true]);
    } else assert.equal(await owner.settle(scenario.billable === false ? 400 : 200, "success", scenario.billable !== false, observed, reservation, null), true);
    assert.equal(events.length, 1);
    assert.equal(events[0].cost_basis, scenario.basis);
    assert.equal(events[0].actual_cost_micros, scenario.actual ?? owner.cost.reserveMicros);
    assert.equal(events[0].reserved_cost_micros, reservation.reservedMicros);
  });
}

test("no-card passthrough stays unmetered-only unless an explicit tariff supplies the price", () => {
  const model = { pricing: null };
  for (const [policyLimit, providerLimit] of [[1_000, null], [null, 1_000]]) {
    const connection = { providerId: "fixture", monthlyBudgetMicros: providerLimit };
    const cost = estimateCost(model, {}, null, "llm.chat", endpoint);
    assert.deepEqual([cost.reserveMicros, cost.basis], [1, "flat_fallback"]);
    assert.throws(() => validateBudgetReservation("llm.chat", cost, policyLimit, connection), error => error.code === "pricing_required");
    assert.equal(validateBudgetReservation("llm.chat", estimateCost(model, {}, 0, "llm.chat", endpoint), policyLimit, connection), true);
  }
  assert.equal(validateBudgetReservation("llm.chat", estimateCost(model, {}, null, "llm.chat", endpoint), null, { monthlyBudgetMicros: null }), false);
});

test("inherited response gaps preserve tariffs, free counts, budget precedence and unmetered settlement", async () => {
  const endpoint = { request_format: "openai.responses" }, body = { previous_response_id: "parent", input: [] };
  for (const knowledge of [undefined, "unknown", "hosted_tool_fee", "hosted_tool_usage"]) {
    const model = { id: "fixture/model", pricing: tiered }, cost = estimateCost(model, body, null, "llm.responses", endpoint, knowledge);
    assert.equal(cost.pricingGap, knowledge === undefined || knowledge === "unknown" ? "retained_tool_unknown" : knowledge);
    for (const [policy, provider] of [[1_000, null], [null, 1_000], [1_000, 1_000]]) {
      assert.throws(() => validateBudgetReservation("llm.responses", cost, policy, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
      for (const fixed of [0, 7]) assert.equal(validateBudgetReservation("llm.responses", estimateCost(model, body, fixed, "llm.responses", endpoint, knowledge), policy, { monthlyBudgetMicros: provider }), true);
    }
    assert.throws(() => validateBudgetReservation("llm.responses", cost, 0), error => error.code === "budget_exhausted");
    assert.throws(() => validateBudgetReservation("llm.responses", cost, null, { monthlyBudgetMicros: 0 }), error => error.code === "provider_budget_exhausted");
    assert.equal(validateBudgetReservation("llm.responses", cost, null), false);
    assert.equal(estimateCost(model, body, 7, "llm.count_tokens", endpoint, knowledge).basis, "none");
    for (const billable of [true, false]) {
      const events = [];
      const owner = createProxyAccounting({ env: { USAGE_QUEUE: { send: async event => events.push(event) } }, context: { waitUntil() {} }, auth: { policyId: "fixture", policy: {} },
        selection: { provider: { id: "fixture" }, model, endpoint, body, capability: "llm.responses" }, cost,
        request: correlateIngressRequest(new Request("https://router.example/v1/responses")).request });
      await owner.settle(billable ? 200 : 400, "success", billable, { ...tokens, serviceTier: "default" }, { reservations: [], reservedMicros: 0 }, null);
      assert.equal(events.length, 1); assert.equal(events[0].actual_cost_micros, 0);
      assert.equal(events[0].cost_basis, billable ? "unpriced_usage" : "none", "known tokens and tier cannot clear inherited incompleteness");
    }
  }
  assert.equal(estimateCost({ pricing: null }, {}, null, "llm.responses", endpoint).basis, "flat_fallback");
  assert.equal(estimateCost({ pricing }, body, null, "llm.responses", endpoint, "token_only").basis, "manifest_pricing");
});
