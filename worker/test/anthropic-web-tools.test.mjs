import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { accountingReceipt, estimateCost } = await import("../proxy-accounting.ts");
import { anthropicWebPrice, requestPricingGap } from "../pricing.ts";
import { extractUsageTokens, extractSseUsageTokens, usageInspectionLimit } from "../token-usage.ts";
import { observeUsage } from "../proxy-response.ts";
const { validateBudgetReservation } = await import("../accounting.ts");
const { snapshot } = await import("../providers.ts");
import { sse } from "./usage-budget-fixture.mjs";

const provider = snapshot.providers.find(row => row.id === "anthropic");
const endpoint = provider.endpoints.find(row => row.id === "messages");
const model = provider.models.find(row => row.id === "anthropic/claude-opus-5-5");
const body = { max_tokens: 32, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }] };
const usage = { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 2 } };
const message = counters => ({ type: "message", content: [], usage: counters });
const frames = counters => [{ type: "message_start", message: message({ ...usage, output_tokens: 0, server_tool_use: { web_search_requests: 1 } }) }, { type: "message_delta", usage: counters }, { type: "message_delta", usage: { output_tokens: 20 } }, { type: "message_stop" }];

function receipt(request, tokens, selectedModel = model) {
  const cost = estimateCost(selectedModel, request, null, "llm.messages", endpoint);
  return accountingReceipt({ model: selectedModel, fixed: null, cost, requestFormat: "anthropic.messages", event: {}, startedAtMs: 0, anthropicWebPrice: anthropicWebPrice(endpoint.toolPricing, request) }, { occurredAtMs: 1, statusCode: 200, status: "success", billable: true, tokens, reservation: { reservations: [], reservedMicros: 0 }, contentRef: null });
}

test("known search tariffs do not qualify even a max_uses=1 hard budget; no-max and provider-only stay closed", () => {
  for (const max_uses of [undefined, null, 0, 1, 2, -1, 1.5, "1", Number.MAX_SAFE_INTEGER]) {
    const request = { ...body, tools: [{ ...body.tools[0], max_uses }] };
    const cost = estimateCost(model, request, null, "llm.messages", endpoint);
    assert.equal(cost.pricingGap, "hosted_tool_usage");
    for (const [policy, provider] of [[100000, null], [null, 100000], [100000, 100000]]) {
      assert.throws(() => validateBudgetReservation("llm.messages", cost, policy, { monthlyBudgetMicros: provider }), error => error.code === "pricing_required");
    }
  }
  assert.equal(requestPricingGap(model.pricing, { tools: [{ type: "web_search_20990101" }] }, "anthropic.messages"), "hosted_tool_fee", "future tariff remains unqualified");
});

test("cumulative counters survive omitted deltas but explicit malformed counters invalidate earlier search evidence", () => {
  for (const value of [-1, 1.2, "2", null, true, {}, Number.MAX_SAFE_INTEGER + 1]) {
    const counters = { ...usage, server_tool_use: { web_search_requests: value } };
    for (const tokens of [extractUsageTokens(message(counters)), extractSseUsageTokens(sse(...frames(counters)))]) {
      assert.equal(tokens.webSearchRequests, null);
      const event = receipt(body, tokens);
      assert.equal(event.hosted_tool_cost_micros, null); assert.equal(event.hosted_tool_calls_complete, false);
      assert.equal(event.actual_cost_micros, 4400); assert.equal(event.cost_basis, "unpriced_usage");
    }
  }
  for (const counter of [0, 2]) {
    const tokens = extractSseUsageTokens(sse(...frames({ ...usage, server_tool_use: { web_search_requests: counter } })));
    assert.equal(tokens.webSearchRequests, counter);
    assert.equal(receipt(body, tokens).actual_cost_micros, 4400 + counter * 10000);
  }
  assert.equal(extractUsageTokens({ object: "response", usage }).webSearchRequests, undefined, "Claude metadata is not accepted from OpenAI documents");
});

test("mixed compaction, server tools and unknown model prices retain partial basis without dropping a known search fee", () => {
  const tokens = extractUsageTokens(message(usage));
  for (const extra of [{ compaction: { type: "summarize" } }, { mcp_servers: [{}] }, { tools: [...body.tools, { type: "advisor_20260301" }] }]) {
    const event = receipt({ ...body, ...extra }, tokens);
    assert.equal(event.actual_cost_micros, 24400); assert.equal(event.cost_basis, "unpriced_usage");
    assert.equal(event.hosted_tool_cost_micros, 20000);
  }
  const noPrice = receipt(body, tokens, { pricing: null });
  assert.equal(noPrice.actual_cost_micros, 20000); assert.equal(noPrice.cost_basis, "unpriced_usage");
  const refusal = receipt(body, { ...tokens, billable: false });
  assert.equal(refusal.actual_cost_micros, 0); assert.equal(refusal.cost_basis, "none");
});

test("bounded JSON/SSE inspection and cancellation never manufacture search counts or token usage", async () => {
  const encoded = text => new TextEncoder().encode(text);
  for (const [wire, mime] of [[JSON.stringify({ ...message(usage), content: [{ type: "text", text: "x".repeat(usageInspectionLimit) }] }), "application/json"], [sse(...frames(usage).slice(0, -1)), "text/event-stream"]]) {
    const observed = observeUsage(new Response(wire, { headers: { "content-type": mime } }), undefined, undefined, "anthropic.messages");
    assert.equal(await observed.response.text(), wire);
    const result = await observed.result;
    assert.equal(result.tokens, null); assert.equal(receipt(body, result.tokens).actual_cost_micros, 0);
  }
  for (const terminal of [false, true]) {
    let canceled = false;
    const wire = sse(...frames(usage).slice(0, terminal ? undefined : -1));
    const observed = observeUsage(new Response(new ReadableStream({ start(controller) { controller.enqueue(encoded(wire)); }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } }), undefined, undefined, "anthropic.messages");
    const reader = observed.response.body.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value), wire);
    await reader.cancel(); const result = await observed.result;
    assert.equal(canceled, true); assert.equal(result.delivery, "canceled");
    assert.equal(receipt(body, result.tokens).actual_cost_micros, terminal ? 24400 : 0);
  }
});
