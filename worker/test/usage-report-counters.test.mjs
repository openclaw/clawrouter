import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { extractUsageTokens, extractSseUsageTokens } = await import("../token-usage.ts");
const { accountingReceipt, estimateCost } = await import("../proxy-accounting.ts");
import { readFileSync } from "node:fs";
const model = JSON.parse(readFileSync(new URL("../generated/provider-snapshot.json", import.meta.url))).model_index["openai/gpt-6.1-sol"];
const base = { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 400, cache_write_tokens: 0 } };
test("reasoning is a reported subset of output, never added to totals", () => {
  const usage = extractUsageTokens({ usage: { ...base, output_tokens_details: { reasoning_tokens: 120 } } });
  assert.equal(usage.reasoning, 120); assert.equal(usage.output, 200); assert.equal(usage.total, 1200);
  assert.equal(usage.cached, 400); assert.equal(usage.input, 1000);
  assert.equal(extractUsageTokens({ usage: base }).reasoning, undefined);
  for (const reasoning_tokens of [null, -1, 0.5, "12", 201, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(extractUsageTokens({ usage: { ...base, output_tokens_details: { reasoning_tokens } } }).reasoning, null);
  }
  assert.equal(extractUsageTokens({ usage: { ...base, output_tokens_details: { reasoning_tokens: 0 } } }).reasoning, 0);
});
test("Chat and Responses JSON and SSE preserve reasoning without changing inclusive tokens", () => {
  const chat = { object: "chat.completion.chunk", service_tier: "default", usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 120 } } };
  const tokens = extractSseUsageTokens('data: ' + JSON.stringify(chat) + '\n\ndata: [DONE]\n\n');
  assert.equal(tokens.reasoning, 120); assert.equal(tokens.total, 1200);
  assert.equal(tokens.cacheWrite, null, "no budget-changing default-zero normalization");
  const response = { type: "response.completed", response: { service_tier: "default", usage: { ...base, output_tokens_details: { reasoning_tokens: 120 } } } };
  assert.equal(extractSseUsageTokens('data: ' + JSON.stringify(response) + '\n\n').reasoning, 120);
});
test("Gemini thoughts remain included once; Anthropic unreported reasoning stays unavailable", () => {
  const g = extractUsageTokens({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10, totalTokenCount: 130 } });
  assert.equal(g.reasoning, 10); assert.equal(g.output, 30); assert.equal(g.total, 130);
  const a = extractUsageTokens({ type: "message", usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 30 } });
  assert.equal(a.input, 150); assert.equal(a.total, 180); assert.equal(a.reasoning, undefined);
});
test("recording reasoning does not change any settlement amount or basis", () => {
  const cost = estimateCost(model, { input: "x", max_output_tokens: 256, service_tier: "default" }, null, "llm.responses", { request_format: "openai.responses" });
  const facts = { event: { capability: "llm.responses" }, model: { pricing: model.pricing, upstream: model.upstream }, fixed: null, cost, requestFormat: "openai.responses", startedAtMs: 0 };
  const settle = (usage, reservation) => accountingReceipt(facts, { occurredAtMs: 1, statusCode: 200, status: "success", billable: true, tokens: extractUsageTokens({ service_tier: "default", usage }), reservation, contentRef: null });
  for (const reservation of [{ reservations: [], reservedMicros: cost.reserveMicros }, { reservations: [], reservedMicros: 0, charges: [] }]) {
    for (const complete of [true, false]) {
      const usage = complete ? base : { ...base, input_tokens_details: { cached_tokens: 400 } };
      const before = settle(usage, reservation), after = settle({ ...usage, output_tokens_details: { reasoning_tokens: 120 } }, reservation);
      assert.equal(after.actual_cost_micros, before.actual_cost_micros);
      assert.equal(after.cost_basis, before.cost_basis);
      assert.equal(after.reasoning_output_tokens, 120);
    }
  }
});
