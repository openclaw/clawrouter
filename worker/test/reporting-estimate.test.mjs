import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { reportingEstimate } = await import("../reporting-estimate.ts");
const { accountingReceipt, estimateCost } = await import("../proxy-accounting.ts");
const { extractUsageTokens } = await import("../token-usage.ts");
const { createResponsesUsageInspector } = await import("../responses-usage.ts");
const pricing = { inputMicrosPerMillion: 2000000, outputMicrosPerMillion: 10000000, cachedInputMicrosPerMillion: 100000, cacheWriteInputMicrosPerMillion: 2500000, serviceTiers: [
  { id: "default", aliases: [], inputMicrosPerMillion: 2000000, outputMicrosPerMillion: 10000000, cachedInputMicrosPerMillion: 100000, cacheWriteInputMicrosPerMillion: 2500000 },
  { id: "priority", aliases: [], inputMicrosPerMillion: 4000000, outputMicrosPerMillion: 20000000, cachedInputMicrosPerMillion: 200000, cacheWriteInputMicrosPerMillion: 5000000 },
] };
const tokens = { input: 1000, output: 200, cached: 400, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null, serviceTier: "default" };
test("missing cache writes are not zero and display estimate uses maximum disjoint allocation", () => {
  const copy = structuredClone(tokens);
  assert.deepEqual(reportingEstimate(pricing, tokens, "openai.responses"), { micros: 3540, reason: "cache_write_unreported_max_rate_allocation" });
  assert.deepEqual(tokens, copy);
});
test("missing served tier uses disclosed maximum declared tier, never prices explicit unknown tiers", () => {
  assert.deepEqual(reportingEstimate(pricing, { ...tokens, serviceTier: null, cacheWrite: 0 }, "openai.responses"), { micros: 6480, reason: "served_tier_unreported_max_declared_rate" });
  assert.equal(reportingEstimate(pricing, { ...tokens, serviceTier: "future" }, "openai.responses"), null);
  for (const input of [{ ...tokens, input: null }, { ...tokens, output: null }, { ...tokens, cached: 1001 }, { ...tokens, cacheWrite: 601, serviceTier: null }, { ...tokens, cacheWrite5m: -1 }, { ...tokens, billable: false }]) assert.equal(reportingEstimate(pricing, input, "openai.responses"), null);
  assert.equal(reportingEstimate(pricing, tokens, "anthropic.messages"), null);
});
test("soft debit stays unknown zero while reporting estimate is separate; hosted tools stay partial/unknown", () => {
  const model = { pricing, upstream: "fixture" }, endpoint = { request_format: "openai.responses" };
  for (const tools of [false, true]) {
    const cost = estimateCost(model, { input: "x", max_output_tokens: 256, service_tier: "default", ...(tools ? { tools: [{ type: "web_search" }] } : {}) }, null, "llm.responses", endpoint);
    const event = accountingReceipt({ event: { capability: "llm.responses" }, model, fixed: null, cost, requestFormat: "openai.responses", startedAtMs: 0 }, { occurredAtMs: 1, statusCode: 200, status: "success", billable: true, tokens, reservation: { reservations: [], reservedMicros: 0, charges: [] }, contentRef: null });
    assert.equal(event.actual_cost_micros, 0); assert.equal(event.cost_basis, "unpriced_usage");
    assert.equal(event.cache_write_input_tokens, null);
    assert.equal(event.reporting_estimated_cost_micros, tools ? undefined : 3540);
  }
});
test("bounded JSON/SSE projection keeps Chat and Responses reasoning through chunk boundaries", async () => {
  for (const chat of [false, true]) for (const sse of [false, true]) {
    if (chat && !sse) continue;
    const body = chat ? { object: "chat.completion.chunk", usage: { prompt_tokens: 1000, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 120 } } } : { object: "response", status: "completed", usage: { input_tokens: 1000, output_tokens: 200, output_tokens_details: { reasoning_tokens: 120 } } };
    const wire = sse ? (chat ? 'data: ' + JSON.stringify(body) + '\n\ndata: [DONE]\n\n' : 'data: ' + JSON.stringify({ type: "response.completed", response: body }) + '\n\n') : JSON.stringify(body);
    const inspector = createResponsesUsageInspector(sse), bytes = new TextEncoder().encode(wire);
    for (let i = 0; i < bytes.length; i += 3) await inspector.push(bytes.subarray(i, i + 3));
    await inspector.end();
    assert.equal(inspector.result(true).tokens.reasoning, 120);
    assert.equal(inspector.result(true).tokens.total, 1200);
    assert.equal(extractUsageTokens(body).reasoning, 120);
  }
});
