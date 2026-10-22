import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");
const { capabilityForPath, modelRoute, providerById, providerModel, routeCatalog, unifiedPathForEndpoint } = await import("../providers.ts");
const { concreteOpenAiSelection, isSelectionFailure, prepareNativeRequest } = await import("../proxy-selection.ts");
const { actualModelCost, estimateModelCost } = await import("../pricing.ts");
const { grantSupports } = await import("../provider-auth.ts");
const { operationAffordability } = await import("../operation-budget.ts");
const { accountingReceipt, estimateCost } = await import("../proxy-accounting.ts");
const { extractUsageTokens } = await import("../token-usage.ts");

const provider = providerById("openai");
const endpoint = provider.endpoints.find(({ id }) => id === "decisions");
const luna = provider.models.find(({ id }) => id === "openai/gpt-6-luna");
const routes = ["/v1/decisions", "/v1/native/openai/v1/decisions", "/v1/proxy/openai/decisions"];
const owners = ["tenant:maintainer_access:owner@example.com", "provider:openai"];
const questions = [
  { type: "predicate", name: "damaged", instructions: "Is the product damaged?" },
  { type: "choice", name: "department", instructions: "Which team?", choices: [{ value: "billing" }, { value: "other" }] },
  { type: "score", name: "severity", instructions: "How severe?", levels: [{ label: "Cosmetic" }, { label: "Blocked" }] },
];
const answers = [
  { type: "predicate", name: "damaged", probability: 0.95 },
  { type: "choice", name: "department", choice: "other", probabilities: [{ value: "billing", probability: 0.1 }, { value: "other", probability: 0.9 }], confidence: 0.8 },
  { type: "refusal", name: "severity" },
];
const usage = (input = 1000) => ({ input_tokens: input, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input });

function fixture(t, options = {}) {
  const env = usageEnv([], { limit: 1_000_000, fixedCost: null, retainContent: false, ...options });
  const events = [], pending = [], ledger = sqlBudgetNamespace(t);
  Object.assign(env, { BUDGET_LEDGER: ledger, OPENAI_API_KEY: "fixture-upstream-key", USAGE_QUEUE: { send: async event => events.push(event) } });
  const call = (path = routes[0], body = {}, key = proxyKey()) => handler.fetch(new Request(
    `https://router.example${path}`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(path === routes[2] ? { body: { model: luna.id, questions, ...body } } : { model: path === routes[1] ? "gpt-6-luna" : luna.id, questions, ...body }),
    }
  ), env, { waitUntil: promise => pending.push(promise) });
  return { env, events, pending, ledger, call };
}

test("Decisions capability and endpoint pricing do not alter Luna Chat/Responses", () => {
  assert.equal(capabilityForPath(routes[0]), "llm.decisions");
  assert.equal(unifiedPathForEndpoint(provider, endpoint), routes[0]);
  assert.equal(endpoint.streaming, null);
  assert.equal(endpoint.websocket, undefined);
  assert.equal(endpoint.modelPassthrough, undefined);
  assert.deepEqual(provider.models.filter(model => model.capabilities.includes("llm.decisions")).map(model => model.id), [luna.id]);
  const selected = modelRoute(luna.id, "llm.decisions").model;
  assert.notEqual(selected, luna);
  assert.equal(selected.pricing, luna.endpointPricing.decisions.pricing);
  assert.equal(selected.pricing_ref, "openai-gpt-6-luna-decisions-2026-10-21");
  assert.equal(providerModel(provider, "gpt-6-luna", endpoint, true).pricing, selected.pricing);
  for (const capability of ["llm.chat", "llm.responses"]) assert.equal(modelRoute(luna.id, capability).model, luna);
  assert.equal(luna.pricing.outputMicrosPerMillion, 500_000);
  const catalog = routeCatalog().openaiCompatible.find(({ provider }) => provider === "openai");
  assert.ok(catalog.endpoints.includes(routes[0]));
  assert.ok(catalog.models.find(({ id }) => id === luna.id).endpoints.includes(routes[0]));
  assert.equal(grantSupports({ provider, endpoint, mode: "http" }, { kind: "subscription" }), false);
  assert.equal(grantSupports({ provider, endpoint, mode: "http" }, { kind: "api_key" }), true);
  assert.equal(grantSupports({ provider, endpoint, mode: "websocket" }, { kind: "api_key" }), false);
  const auth = { policy: { enabled: true, monthlyBudgetMicros: 1_000_000 } };
  assert.equal(operationAffordability(auth, { providerId: "openai", enabled: true }, luna, "llm.decisions", endpoint).status, "request-dependent");
});

test("Decisions reserves and settles its input-only tariff including long context and opaque images", () => {
  const pricing = modelRoute(luna.id, "llm.decisions").model.pricing;
  const tokens = { input: 272_000, output: 0, cached: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null };
  assert.equal(actualModelCost(pricing, tokens), 27_200);
  assert.equal(actualModelCost(pricing, { ...tokens, input: 272_001 }), 54_401);
  assert.equal(actualModelCost(pricing, { ...tokens, input: 1000, cached: 100, cacheWrite: 200, output: 500 }), 100);
  assert.equal(actualModelCost(pricing, { ...tokens, input: null }), null);
  const inputOnly = extractUsageTokens({ usage: { input_tokens: 1000 } });
  assert.equal(actualModelCost(pricing, inputOnly), 100);
  assert.equal(actualModelCost({ ...pricing, cacheWriteInputMicrosPerMillion: 125_000 }, inputOnly), null, "positive cache-write tariffs still require their counter");
  const estimate = estimateModelCost(pricing, { model: "gpt-6-luna", input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/product.png" }] }], questions }, endpoint);
  assert.deepEqual(estimate, { inputTokens: 922_000, outputTokens: 0, reserveMicros: 184_400 });
  const selection = concreteOpenAiSelection(routes[0], { model: luna.id, input: "Damaged product", questions }, {});
  assert.equal(isSelectionFailure(selection), false);
  assert.equal(selection.model.pricing, pricing);
  assert.equal(selection.body.model, "gpt-6-luna");
  assert.equal(selection.body.service_tier, undefined);
  assert.throws(() => prepareNativeRequest(provider, endpoint, { model: "gpt-6-sol", input: "text", questions }, endpoint.path, {}), error => error.code === "model_capability_unsupported");
});

for (const soft of [false, true]) test(`Decisions input-only usage settles without cache-write counters in ${soft ? "soft" : "reserve"} mode`, () => {
  const model = modelRoute(luna.id, "llm.decisions").model;
  const cost = estimateCost(model, { input: [{ type: "input_image", image_url: "https://example.com/product.png" }], questions }, null, "llm.decisions", endpoint);
  assert.equal(cost.reserveMicros, 184_400);
  const receipt = accountingReceipt({ model, fixed: null, cost, requestFormat: endpoint.request_format, event: {}, startedAtMs: 0 }, {
    occurredAtMs: 1, statusCode: 200, status: "success", billable: true, contentRef: null,
    tokens: extractUsageTokens({ usage: { input_tokens: 1000 } }),
    reservation: { reservations: [], reservedMicros: soft ? 0 : cost.reserveMicros, ...(soft ? { charges: [] } : {}) },
  });
  assert.equal(receipt.actual_cost_micros, 100);
  assert.equal(receipt.cost_basis, "manifest_pricing");
  assert.equal(receipt.input_tokens, 1000);
  assert.equal(receipt.cache_write_input_tokens, null, "do not invent a missing counter");
});

for (const route of routes) test(`Decisions ${route} forwards typed answers and settles both SQL budgets`, async t => {
  const f = fixture(t);
  const upstream = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://api.openai.com/v1/decisions");
    assert.equal(options.headers.get("authorization"), "Bearer fixture-upstream-key");
    assert.deepEqual(JSON.parse(options.body), { model: "gpt-6-luna", input: "The product is damaged.", questions });
    return Response.json({ model: "gpt-6-luna", answers, usage: usage() });
  });
  const response = await f.call(route, { input: "The product is damaged." });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { model: "gpt-6-luna", answers, usage: usage() });
  await Promise.all(f.pending);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(f.events.length, 1);
  const event = f.events[0];
  assert.equal(event.capability, "llm.decisions");
  assert.equal(event.model, luna.id);
  assert.equal(event.pricing_ref, "openai-gpt-6-luna-decisions-2026-10-21");
  assert.equal(event.input_tokens, 1000);
  assert.equal(event.output_tokens, 0);
  assert.equal(event.reserved_output_tokens, 0);
  assert.equal(event.actual_cost_micros, 100);
  assert.equal(event.cost_basis, "manifest_pricing");
  assert.equal(event.status, "success");
  assert.equal(event.content_retained, false);
  assert.equal(event.served_service_tier, null);
  assert.ok(event.reserved_cost_micros >= event.actual_cost_micros);
  for (const owner of owners) {
    const [row] = f.ledger.get(owner).reservations();
    assert.equal(row.settled, 1);
    assert.equal(row.reserved_micros, 100);
  }
});

for (const input of [100_000, 272_000, 272_001]) for (const bucket of ["cached_tokens", "cache_write_tokens"]) {
  test(`Decisions bills all ${input} ${bucket} at the input tariff in both SQL budgets`, async t => {
    const f = fixture(t);
    const expected = input === 272_001 ? 54_401 : input / 10;
    const metered = usage(input);
    metered.input_tokens_details[bucket] = input;
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ model: "gpt-6-luna", answers, usage: metered }));
    const response = await f.call(routes[0], { input: "x".repeat(input) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).usage, metered);
    await Promise.all(f.pending);
    assert.equal(upstream.mock.callCount(), 1);
    assert.equal(f.events.length, 1);
    const [event] = f.events;
    assert.equal(event.actual_cost_micros, expected);
    assert.equal(event.cost_basis, "manifest_pricing");
    assert.equal(event.input_tokens, input);
    assert.equal(event[bucket === "cached_tokens" ? "cached_input_tokens" : "cache_write_input_tokens"], input);
    assert.ok(event.reserved_cost_micros >= expected);
    for (const owner of owners) {
      const rows = f.ledger.get(owner).reservations();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].settled, 1);
      assert.equal(rows[0].reserved_micros, expected);
    }
  });
}

for (const scenario of ["missing-usage", "invalid-json", "rejection", "fetch-error", "budget", "unauthorized", "wrong-model", "unknown-model", "fixed-zero"]) {
  test(`Decisions lifecycle ${scenario}`, async t => {
    const f = fixture(t, { ...(scenario === "budget" ? { limit: 1 } : {}), ...(scenario === "fixed-zero" ? { fixedCost: 0 } : {}) });
    const upstream = t.mock.method(globalThis, "fetch", async () => {
      if (scenario === "fetch-error") throw new Error("fixture upstream failure");
      if (scenario === "invalid-json") return new Response("{", { headers: { "content-type": "application/json" } });
      if (scenario === "rejection") return Response.json({ error: { code: "invalid_request_error" } }, { status: 400 });
      return Response.json({ answers, ...(scenario === "missing-usage" ? {} : { usage: usage() }) });
    });
    const body = { input: "The product is damaged.", ...(scenario === "wrong-model" ? { model: "openai/gpt-6-sol" } : {}), ...(scenario === "unknown-model" ? { model: "openai/unknown" } : {}) };
    const response = await f.call(routes[0], body, scenario === "unauthorized" ? "invalid" : proxyKey());
    const text = await response.text();
    await Promise.all(f.pending);
    for (const owner of owners) assert.ok(f.ledger.get(owner).reservations().every(row => row.settled === 1), "no open reservation after terminal accounting");
    if (["budget", "unauthorized", "wrong-model", "unknown-model"].includes(scenario)) {
      const [status, code] = { budget: [402, "budget_exhausted"], unauthorized: [401, "invalid_proxy_key"], "wrong-model": [400, "model_capability_unsupported"], "unknown-model": [404, "model_not_found"] }[scenario];
      assert.equal(response.status, status);
      assert.equal(JSON.parse(text).error.code, code);
      assert.equal(upstream.mock.callCount(), 0);
    } else {
      assert.equal(response.status, scenario === "fetch-error" ? 502 : scenario === "rejection" ? 400 : 200);
      if (scenario === "fetch-error" || scenario === "rejection") assert.equal(JSON.parse(text).error.code, scenario === "fetch-error" ? "provider_unavailable" : "invalid_request_error");
      assert.equal(upstream.mock.callCount(), 1);
      const [event] = f.events;
      assert.ok(event);
      if (["rejection", "fixed-zero"].includes(scenario)) assert.equal(event.actual_cost_micros, 0);
      else {
        assert.equal(event.actual_cost_micros, event.reserved_cost_micros);
        assert.equal(event.cost_basis, "manifest_reservation");
      }
      if (scenario === "invalid-json" || scenario === "fetch-error") assert.equal(event.status, "provider_error");
    }
  });
}
