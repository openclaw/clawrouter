import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { markBudgetDispatched, planBudgetReservation, reserveLedgerIntent } from "../accounting.ts";
import { settleLedger } from "../ledgers.ts";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";

const { accountingReceipt, createProxyAccounting } = await import("../proxy-accounting.ts");

const cost = { reserveMicros: 100, basis: "manifest_pricing", inputTokens: 30, outputTokens: 70 };
const auth = { policyId: "fixture", credentialId: "key", principalId: "member", authType: "proxy_key", policy: { tenantId: "tenant", monthlyBudgetMicros: 500, budgetScope: "principal" } };
const connection = { providerId: "fixture", monthlyBudgetMicros: 500 };

test("persisted reservation intent survives a lost ACK, restart and month boundary without a second hold", async (t) => {
  let now = Date.parse("2026-09-30T23:59:59Z");
  t.mock.method(Date, "now", () => now);
  const original = planBudgetReservation(auth, "llm.responses", cost, connection, now);
  const persisted = JSON.stringify(original);
  assert.deepEqual(original.legs.map(leg => leg.kind), ["policy", "provider"]);
  assert.deepEqual(original.legs.map(leg => leg.request.windowKey), ["tenant/fixture/member/2026-09", "provider/fixture/2026-09"]);
  assert.deepEqual(original.legs.map(leg => JSON.parse(leg.request.scopeKey)), [["principal", "tenant", "fixture", "member"], ["provider", "fixture"]]);
  assert.equal(new Set(original.legs.map(leg => leg.request.reservationId)).size, 2);
  const namespace = sqlBudgetNamespace(t), sends = [];
  let loseAck = true;
  const env = { BUDGET_LEDGER: { idFromName: name => name, get: name => ({ fetch: async (url, init) => {
    sends.push({ name, body: JSON.parse(init.body) });
    const response = await namespace.get(name).fetch(url, init);
    if (loseAck) { loseAck = false; throw new Error("synthetic lost reserve ACK"); }
    return response;
  } }) } };
  await assert.rejects(reserveLedgerIntent(env, original.legs[0]), /lost reserve ACK/);
  namespace.get(original.legs[0].objectName).restart();
  now += 2_000;
  const recovered = JSON.parse(persisted), reservations = [];
  for (const leg of recovered.legs) reservations.push(await reserveLedgerIntent(env, leg));
  assert.deepEqual(sends.slice(0, 2), [sends[0], sends[0]], "admission reconciliation resends the exact original request");
  for (const leg of recovered.legs) {
    const rows = namespace.get(leg.objectName).reservations();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].window_key, leg.request.windowKey);
    assert.equal(rows[0].reservation_id, leg.request.reservationId);
    assert.equal(rows[0].reserved_micros, 100);
  }
  await markBudgetDispatched(env, { reservations, reservedMicros: 100 });
  for (const leg of recovered.legs) await settleLedger(env, leg.objectName, { reservationId: leg.request.reservationId, actualCostMicros: 25 });
  assert.deepEqual(recovered.legs.map(leg => namespace.get(leg.objectName).reservations()[0].reserved_micros), [25, 25]);
  assert.equal(JSON.stringify(original), persisted);
});

test("reservation plans retain distinct typed legs when physical policy and provider names collide", () => {
  const plan = planBudgetReservation({ ...auth, policy: { tenantId: "provider", monthlyBudgetMicros: 500 } }, "llm.responses", cost, connection);
  assert.equal(plan.legs.length, 2);
  assert.equal(plan.legs[0].objectName, plan.legs[1].objectName);
  assert.equal(plan.legs[0].request.windowKey, plan.legs[1].request.windowKey);
  assert.notEqual(plan.legs[0].request.scopeKey, plan.legs[1].request.scopeKey);
  assert.notEqual(plan.legs[0].request.reservationId, plan.legs[1].request.reservationId);
});

test("intent construction preserves unmetered, count-only, fixed-zero and pricing-gap admission", () => {
  assert.deepEqual(planBudgetReservation({ ...auth, policy: {} }, "llm.responses", cost), { reservedMicros: 0, legs: [] });
  assert.deepEqual(planBudgetReservation(auth, "llm.count_tokens", cost, connection), { reservedMicros: 0, legs: [] });
  const zero = planBudgetReservation(auth, "llm.responses", { ...cost, reserveMicros: 0, basis: "policy_fixed" }, connection);
  assert.equal(zero.legs.length, 2);
  assert.ok(zero.legs.every(leg => leg.request.costMicros === 0));
  assert.throws(() => planBudgetReservation(auth, "llm.responses", { ...cost, pricingGap: "hosted_tool_fee" }, connection), error => error.code === "pricing_required");
  assert.throws(() => planBudgetReservation({ ...auth, policy: { monthlyBudgetMicros: 0 } }, "llm.responses", cost), error => error.code === "budget_exhausted");
});

test("only a boolean reservation acknowledgement distinguishes acceptance from denial", async () => {
  const intent = planBudgetReservation(auth, "llm.responses", cost).legs[0];
  for (const reply of [{}, { allowed: null }, { allowed: 1 }, null]) {
    const env = { BUDGET_LEDGER: { idFromName: name => name, get: () => ({ fetch: async () => Response.json(reply) }) } };
    await assert.rejects(reserveLedgerIntent(env, intent), /not acknowledged/);
  }
  const env = { BUDGET_LEDGER: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ allowed: false }) }) } };
  await assert.rejects(reserveLedgerIntent(env, intent), error => error.code === "budget_exhausted");
});

const pricing = { effectiveAt: "2026-09-23", source: "https://example.com/pricing", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: null, cacheWriteInputMicrosPerMillion: null, maxInputTokens: 100, defaultMaxOutputTokens: 70, inputTokenOverhead: 0, longContext: null };
const model = { id: "fixture/model", upstream: "model", pricing_ref: "fixture-price", pricing };
const tokens = { input: 10, output: 5, total: 15, cached: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
const outcome = { occurredAtMs: 5_000, statusCode: 200, status: "success", billable: true, tokens, reservation: { reservations: [], reservedMicros: 100 }, contentRef: null };

function facts(overrides = {}) {
  return { ...createProxyAccounting({
    env: {}, context: {}, auth, startedAtMs: 1_000, cost,
    selection: { provider: { id: "fixture" }, model, capability: "llm.responses", endpoint: { request_format: "openai.responses" }, body: { input: "not stored", secret: "not stored" } },
    request: new Request("https://router.example/v1/responses", { headers: { "x-request-id": "request-fixture", "x-clawrouter-session-id": "session-fixture" } }),
  }).facts, ...overrides };
}

test("a serialized accounting snapshot produces one immutable event without storing generation content", () => {
  const input = facts(), before = JSON.stringify(input), result = accountingReceipt(input, outcome);
  assert.equal(result.id, input.event.id);
  assert.equal(result.request_id, "request-fixture");
  assert.equal(result.session_id, "session-fixture");
  assert.equal(result.policy_id, auth.policyId);
  assert.equal(result.principal_id, auth.principalId);
  assert.equal(result.occurred_at_ms, 5_000);
  assert.equal(result.duration_ms, 4_000);
  assert.equal(result.actual_cost_micros, 20);
  assert.equal(result.cost_basis, "manifest_pricing");
  assert.deepEqual(accountingReceipt(JSON.parse(before), structuredClone(outcome)), result);
  assert.equal(JSON.stringify(input), before);
  assert.doesNotMatch(before, /not stored/);
});

test("receipt calculation retains override, gap, missing-usage and served-rate precedence", () => {
  for (const [input, observed, amount, basis] of [
    [facts(), { tokens: null }, 100, "manifest_reservation"],
    [facts(), { billable: false }, 0, "none"],
    [facts(), { tokens: { ...tokens, billable: false } }, 0, "none"],
    [facts({ fixed: 0, cost: { ...cost, reserveMicros: 0, basis: "policy_fixed" } }), {}, 0, "policy_fixed"],
    [facts({ fixed: 7, cost: { ...cost, reserveMicros: 7, basis: "policy_fixed" } }), {}, 7, "policy_fixed"],
    [facts({ cost: { ...cost, reserveMicros: 0, pricingGap: "hosted_tool_fee" } }), {}, 0, "unpriced_usage"],
    [facts({ model: null, cost: { ...cost, reserveMicros: 1, basis: "flat_fallback" } }), {}, 1, "flat_fallback"],
    [facts({ model: { ...model, pricing: { ...pricing, settlementBasis: "published_upper_bound" } } }), {}, 20, "manifest_rate_upper_bound"],
    [facts({ cost: { ...cost, basis: "unpriced_service_tier" }, model: { ...model, pricing: { ...pricing, settlementBasis: "published_upper_bound", serviceTiers: [{ ...pricing, id: "default", aliases: [] }] } } }), { tokens: { ...tokens, serviceTier: "default" } }, 20, "manifest_rate_upper_bound"],
  ]) {
    const event = accountingReceipt(input, { ...outcome, ...observed });
    assert.equal(event.actual_cost_micros, amount);
    assert.equal(event.cost_basis, basis);
  }
});
