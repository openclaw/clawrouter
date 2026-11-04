import "./typescript-setup.mjs";
import assert from "node:assert/strict";
const { createProxyAccounting } = await import("../proxy-accounting.ts");
const { anthropicPricing } = await import("../anthropic-pricing.ts");
const { guardAnthropicPrice } = await import("../anthropic-price-response.ts");
const { HttpOperation } = await import("../http-operation.ts");
const { providerById } = await import("../providers.ts");
const { extractUsageTokens } = await import("../token-usage.ts");

// Real receipt producers, reusable by ingestion/migration/export regression tests.
function fixture(providerId, modelId, body, fixed = null) {
  const provider = providerById(providerId), model = provider.models.find(row => row.id === modelId);
  const endpoint = provider.endpoints.find(row => row.id === (providerId === "anthropic" ? "messages" : "responses"));
  assert.ok(model); assert.ok(endpoint);
  const events = [], settlements = [];
  const env = { USAGE_QUEUE: { send: async event => events.push(event) },
    BUDGET_LEDGER: { idFromName: name => name, get: () => ({ fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      settlements.push({ path: new URL(url).pathname, ...body });
      return Response.json({ settled: true, charged: true, chargeId: body.chargeId });
    } }) } };
  const accounting = createProxyAccounting({ env, context: { waitUntil() { assert.fail("unexpected deferred finalization"); } },
    auth: { policyId: "policy", credentialId: "key", principalId: "alice@example.com", authType: "proxy_key",
      policy: { tenantId: "tenant", requestCostMicros: fixed, monthlyBudgetMicros: 1_000_000, budgetMode: providerId === "anthropic" ? "reserve" : "soft" } },
    selection: { provider, model, endpoint, capability: providerId === "anthropic" ? "llm.messages" : "llm.responses", body },
    request: new Request("https://router.example/v1/fixture", { headers: { "x-request-id": "reporting-evidence-fixture" } }), startedAtMs: 0,
    grantKey: "private-fixture-handle", grantLane: "api_key",
  });
  return { accounting, events, settlements, model };
}

export async function anthropicHardBudgetGuardReceipt(stream = false) {
  const body = { messages: [{ role: "user", content: "synthetic" }], max_tokens: 128 };
  const f = fixture("anthropic", "anthropic/claude-opus-5-5", body);
  assert.ok(f.accounting.cost.reserveMicros > 0);
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: "priority" };
  const frames = [{ type: "message_start", message: { type: "message", usage: { ...usage, output_tokens: 0 } } },
    { type: "message_delta", usage: { output_tokens: 1 }, delta: { stop_reason: "end_turn" } }, { type: "message_stop" }];
  const wire = stream ? frames.map(value => "data: " + JSON.stringify(value) + "\n\n").join("") : JSON.stringify({ type: "message", usage });
  const guard = await guardAnthropicPrice(new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } }),
    tokens => !!anthropicPricing(f.model.pricing, f.model.upstream, {}, tokens?.anthropic ?? {}), new HttpOperation(), f.accounting.requestId);
  const responseText = await guard.response.text();
  assert.match(responseText, /reservation is retained/);
  const failure = guard.failure(); assert.ok(failure);
  assert.equal(failure.tokens.anthropic.serviceTier, "priority");
  const reservation = { reservedMicros: f.accounting.cost.reserveMicros,
    reservations: [{ reservationId: "reservation-fixture", objectName: "budget-fixture", dispatched: true }] };
  assert.equal(await f.accounting.pricingFailure(failure.tokens, reservation, null), true);
  assert.equal(f.events.length, 1);
  return { event: f.events[0], reservation, settlements: f.settlements, response: guard.response };
}

export async function softHostedToolReceipt({ fixed = null, complete = false } = {}) {
  const f = fixture("openai", "openai/gpt-4.1-mini", { input: "synthetic", max_output_tokens: 32, tools: [{ type: "web_search" }] }, fixed);
  const tokens = extractUsageTokens({ object: "response", service_tier: "default", usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });
  const reservation = { reservations: [], reservedMicros: 0, charges: [{ objectName: "soft-budget-fixture",
    request: { chargeId: "soft-charge-fixture", policyId: "policy", windowKey: "2026-11", scopeKey: "alice@example.com", amountMicros: 0, capability: "llm.responses" } }] };
  assert.equal(await f.accounting.settle(200, "success", true, tokens, reservation, null,
    null, { webSearch: complete ? 1 : 0, complete }), true);
  assert.equal(f.events.length, 1);
  return f.events[0];
}
