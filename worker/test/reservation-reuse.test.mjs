import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";

const { default: handler } = await import("../index.ts");

test("Fusion settles the final body estimate while retaining both original reservation receipts", async (t) => {
  const { estimateCost } = await import("../proxy-accounting.ts");
  const { modelRoute } = await import("../providers.ts");
  const { concreteOpenAiSelection } = await import("../proxy-selection.ts");
  const { DEFAULT_FUSION_CONFIG, buildAggregatorBody, buildFusionReservationProposals } = await import("../fusion.ts");
  const config = { ...DEFAULT_FUSION_CONFIG, enabled: true, adviserModels: ["openai/gpt-4.1-mini"], aggregatorModel: "openai/gpt-6-astra", maxProposalChars: 256 };
  const body = { model: "clawrouter/fusion", messages: [{ role: "user", content: "fixture" }], max_tokens: 32 };
  const route = modelRoute(config.aggregatorModel, "llm.chat");
  const prepared = concreteOpenAiSelection("/v1/chat/completions", buildAggregatorBody(body, config, buildFusionReservationProposals(config)), {});
  const initial = estimateCost(route.model, prepared.body, null, "llm.chat", prepared.endpoint);
  const env = usageEnv([], { limit: 1_000_000, fixedCost: null, retainContent: false });
  env.OPENAI_API_KEY = "fixture-openai-key";
  env.POLICY_KV.get = async (key) => key === "config/fusion" ? config : Array.isArray(key) ? new Map() : null;
  const ledger = sqlBudgetNamespace(t), calls = [], events = [], pending = [], bodies = [];
  env.BUDGET_LEDGER = { ...ledger, get: (name) => ({ fetch: (url, init) => {
    calls.push({ name, path: new URL(url).pathname, body: JSON.parse(init.body) });
    return ledger.get(name).fetch(url, init);
  } }) };
  env.USAGE_QUEUE = { send: async (event) => events.push(event) };
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: "short fixture answer" } }] });
  });
  const response = await handler.fetch(new Request("https://router.example/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), env, { waitUntil: (promise) => pending.push(promise) });
  assert.equal(response.status, 200); await response.text();
  while (pending.length) await Promise.all(pending.splice(0));
  assert.deepEqual(bodies.map(({ model }) => model), ["gpt-4.1-mini", "gpt-6-astra"]);
  const final = estimateCost(route.model, bodies[1], null, "llm.chat", prepared.endpoint);
  assert.ok(final.reserveMicros < initial.reserveMicros);
  const event = events.find(({ compound_request_stage }) => compound_request_stage === "fusion_synthesizer");
  assert.equal(event.reserved_cost_micros, initial.reserveMicros);
  assert.equal(event.actual_cost_micros, final.reserveMicros);
  assert.equal(event.reserved_input_tokens, final.inputTokens);
  assert.equal(event.cost_basis, "manifest_reservation");
  const original = calls.filter(({ path }) => path === "/reserve").slice(0, 2);
  assert.deepEqual(original.map(({ body }) => body.costMicros), [initial.reserveMicros, initial.reserveMicros]);
  for (const { name, body: held } of original) {
    const receipt = calls.filter((call) => call.name === name && call.body.reservationId === held.reservationId);
    assert.deepEqual(receipt.map(({ path }) => path), ["/reserve", "/dispatch", "/settle"]);
    assert.equal(receipt[2].body.actualCostMicros, final.reserveMicros);
  }
});

test("reservation reuse reassesses a final pricing gap before admission and unmetered settlement", async (t) => {
  const { reserveBudget, validateBudgetReservation } = await import("../accounting.ts");
  const { createProxyAccounting, estimateCost } = await import("../proxy-accounting.ts");
  const { modelRoute } = await import("../providers.ts");
  const { correlateIngressRequest } = await import("../correlation.ts");
  const route = modelRoute("openai/gpt-6-astra", "llm.chat");
  const endpoint = route.provider.endpoints.find(({ id }) => id === "chat_completions");
  const originalBody = { messages: [{ role: "user", content: "fixture" }], max_tokens: 32 };
  for (const [policyLimit, providerLimit] of [[1_000_000, null], [null, 1_000_000], [null, null]]) {
    const events = [], pending = [], env = { BUDGET_LEDGER: sqlBudgetNamespace(t), USAGE_QUEUE: { send: async (event) => events.push(event) } };
    const auth = { policyId: "fixture", policy: { tenantId: "default", monthlyBudgetMicros: policyLimit }, credentialId: "fixture", authType: "proxy_key" };
    const connection = { providerId: "openai", monthlyBudgetMicros: providerLimit };
    const initial = estimateCost(route.model, originalBody, null, "llm.chat", endpoint);
    const reservation = await reserveBudget(env, auth, "llm.chat", initial, connection);
    const originalReceipt = structuredClone(reservation);
    // Exercise the shared reuse boundary: monetary coverage cannot certify a
    // later request's completeness. Fusion's current builder preserves tools.
    const body = { ...originalBody, web_search_options: {} };
    const final = estimateCost(route.model, body, null, "llm.chat", endpoint);
    assert.equal(final.basis, "unpriced_request");
    assert.equal(final.pricingGap, "hosted_tool_fee");
    assert.ok(final.reserveMicros <= initial.reserveMicros);
    const owner = createProxyAccounting({ env, context: { waitUntil: (promise) => pending.push(promise) }, auth, selection: { ...route, endpoint, body, capability: "llm.chat" }, cost: final, request: correlateIngressRequest(new Request("https://router.example/v1/chat/completions")).request });
    const budgeted = policyLimit != null || providerLimit != null;
    if (budgeted) {
      assert.throws(() => validateBudgetReservation("llm.chat", final, policyLimit, connection), (error) => error.code === "pricing_required");
      owner.fail(400, "client_error", reservation);
    } else {
      assert.equal(validateBudgetReservation("llm.chat", final, policyLimit, connection), false);
      await owner.settle(200, "success", true, { input: 100, output: 10, total: 110, serviceTier: "default" }, reservation, null);
    }
    await Promise.all(pending);
    assert.deepEqual(reservation, originalReceipt);
    assert.equal(events[0].reserved_cost_micros, budgeted ? initial.reserveMicros : 0);
    assert.equal(events[0].actual_cost_micros, 0);
    assert.equal(events[0].cost_basis, budgeted ? "none" : "unpriced_usage");
    for (const { objectName, reservationId } of reservation.reservations) {
      const [row] = env.BUDGET_LEDGER.get(objectName).reservations();
      assert.equal(row.reservation_id, reservationId);
      assert.equal(row.reserved_micros, 0); assert.equal(row.settled, 1);
    }
  }
});
