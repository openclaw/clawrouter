import assert from "node:assert/strict";
import test from "node:test";

import { extractSseUsageTokens, extractUsageTokens } from "../token-usage.ts";
import { actualModelCost } from "../pricing.ts";

test("OpenAI usage extracts cache writes from Chat Completions and Responses details", () => {
  for (const [inputKey, detailsKey] of [
    ["prompt_tokens", "prompt_tokens_details"],
    ["input_tokens", "input_tokens_details"],
  ]) {
    const tokens = extractUsageTokens({
      usage: {
        [inputKey]: 2_006,
        output_tokens: 300,
        [detailsKey]: { cached_tokens: 1_920, cache_write_tokens: 64 },
      },
    });
    assert.deepEqual(tokens, {
      input: 2_006,
      output: 300,
      total: 2_306,
      cached: 1_920,
      cacheWrite: 64,
      cacheWrite5m: null,
      cacheWrite1h: null,
    });
  }
});

test("OpenAI Responses SSE payloads expose nested completed usage", () => {
  const tokens = extractUsageTokens({
    type: "response.completed",
    response: {
      id: "resp_test",
      usage: {
        input_tokens: 1_500,
        output_tokens: 200,
        input_tokens_details: { cached_tokens: 1_024, cache_write_tokens: 128 },
      },
    },
  });
  assert.deepEqual(tokens, {
    input: 1_500,
    output: 200,
    total: 1_700,
    cached: 1_024,
    cacheWrite: 128,
    cacheWrite5m: null,
    cacheWrite1h: null,
  });
});

const cachePricing = {
  inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 5_000_000,
  cachedInputMicrosPerMillion: 100_000, cacheWriteInputMicrosPerMillion: null,
  cacheWrite5mInputMicrosPerMillion: 1_250_000, cacheWrite1hInputMicrosPerMillion: 2_000_000,
  longContext: null,
};

test("Anthropic input includes disjoint cache reads and writes before pricing", () => {
  for (const [usage, expected] of [
    [{ input_tokens: 10, cache_creation_input_tokens: 4_000 }, { input: 4_010, cached: null, cacheWrite: 4_000, cacheWrite5m: null, cacheWrite1h: null, cost: 8_110 }],
    [{ input_tokens: 10, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 0 }, { input: 4_010, cached: 4_000, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null, cost: 510 }],
    [{ input_tokens: 0, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 3_000, cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 } }, { input: 4_000, cached: 1_000, cacheWrite: 3_000, cacheWrite5m: 2_000, cacheWrite1h: 1_000, cost: 4_700 }],
    [{ input_tokens: 10, cache_creation_input_tokens: 3_000, cache_creation_ephemeral_5m_input_tokens: 2_000, cache_creation_ephemeral_1h_input_tokens: 1_000 }, { input: 3_010, cached: null, cacheWrite: 3_000, cacheWrite5m: 2_000, cacheWrite1h: 1_000, cost: 4_610 }],
  ]) {
    const { cost, ...counts } = expected;
    const tokens = extractUsageTokens({ usage: { ...usage, output_tokens: 20 } });
    assert.deepEqual(tokens, { ...counts, output: 20, total: expected.input + 20 });
    assert.equal(actualModelCost(cachePricing, tokens), cost);
  }
});

test("Anthropic long-context pricing uses the full input, including the cache", () => {
  const tokens = extractUsageTokens({ usage: { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 20 } });
  const tiered = { ...cachePricing, longContext: { ...cachePricing, thresholdInputTokens: 1_000, inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 10_000_000, cachedInputMicrosPerMillion: 200_000 } };
  assert.equal(actualModelCost(tiered, tokens), 420);
  assert.equal(actualModelCost(cachePricing, extractUsageTokens({ usage: { cache_creation_input_tokens: 4_000, output_tokens: 20 } })), null);
});

const sse = (...events) => events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");

test("Chat top-level cache hits are inclusive and agree with nested details in JSON and terminal SSE", () => {
  for (const details of [undefined, {}, { cached_tokens: 800 }]) {
    const usage = { prompt_tokens: 1_000, completion_tokens: 20, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, prompt_tokens_details: details };
    const chunk = { object: "chat.completion.chunk", usage };
    for (const tokens of [extractUsageTokens({ usage }), extractSseUsageTokens(sse(chunk, "[DONE]"))]) {
      assert.equal(tokens.input, 1_000);
      assert.equal(tokens.total, 1_020);
      assert.equal(tokens.cached, 800);
      assert.equal(actualModelCost(cachePricing, tokens), 380);
    }
  }
  assert.equal(extractUsageTokens({ usage: { prompt_tokens: 1_000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1_000 } }).cached, 0);
  assert.equal(extractUsageTokens({ usage: { prompt_cache_hit_tokens: 800, completion_tokens: 20 } }).input, null);
});

test("invalid or conflicting cache evidence never discounts Chat input or preserves an earlier SSE discount", () => {
  const valid = { prompt_tokens: 1_000, completion_tokens: 20, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 };
  for (const invalid of [
    { prompt_tokens_details: { cached_tokens: 900 } },
    { prompt_tokens_details: { cached_tokens: null } },
    { prompt_tokens_details: { cached_tokens: -1 } },
    { prompt_cache_hit_tokens: 1_001 }, { prompt_cache_hit_tokens: -1 },
    { prompt_cache_hit_tokens: 800.5 }, { prompt_cache_hit_tokens: "800" },
    { prompt_cache_hit_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { prompt_cache_miss_tokens: 201 }, { prompt_cache_miss_tokens: null },
  ]) {
    const usage = { ...valid, ...invalid };
    for (const tokens of [extractUsageTokens({ usage }), extractSseUsageTokens(sse({ object: "chat.completion.chunk", usage: valid }, { object: "chat.completion.chunk", usage }, "[DONE]"))]) {
      assert.equal(tokens.input, 1_000);
      assert.equal(tokens.cached, null);
      assert.equal(actualModelCost(cachePricing, tokens), 1_100);
    }
  }
});

test("served tiers come from terminal Responses and persist across Chat usage-only chunks", () => {
  const usage = { input_tokens: 12, output_tokens: 3 };
  assert.equal(extractUsageTokens({ service_tier: "priority", usage }).serviceTier, "priority");
  const created = { type: "response.created", response: { service_tier: "priority" } };
  const completed = { type: "response.completed", response: { service_tier: "default", usage } };
  assert.equal(extractSseUsageTokens(sse(created, completed)).serviceTier, "default");
  assert.equal(extractSseUsageTokens(sse(created, { ...completed, response: { usage } })).serviceTier, undefined);
  const chunk = { object: "chat.completion.chunk", service_tier: "priority" };
  assert.equal(extractSseUsageTokens(sse(chunk, { object: chunk.object, usage }, "[DONE]")).serviceTier, "priority");
  assert.equal(extractSseUsageTokens(sse(chunk, { object: chunk.object, service_tier: "default", usage }, "[DONE]")).serviceTier, "default");
  assert.equal(extractSseUsageTokens(sse(chunk, { object: chunk.object, usage })), null);
  assert.equal(extractUsageTokens({ service_tier: "x".repeat(65), usage }).serviceTier, undefined);
});

test("Anthropic early refusals retain observed usage without billing it", () => {
  const message = { type: "message", role: "assistant", content: [], stop_reason: "refusal", usage: { input_tokens: 412, output_tokens: 0 } };
  const start = { type: "message_start", message: { ...message, stop_reason: null } };
  const delta = { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 0 } };
  const stop = { type: "message_stop" };
  for (const tokens of [extractUsageTokens(message), extractSseUsageTokens(sse(start, delta, stop))]) {
    assert.equal(tokens.input, 412);
    assert.equal(tokens.total, 412);
    assert.equal(actualModelCost(cachePricing, tokens), 0);
  }
  assert.equal(extractSseUsageTokens(sse(start, delta)), null);
  assert.equal(extractSseUsageTokens(sse(start, delta, { type: "message_delta", usage: { output_tokens: 0 } }, stop)).billable, false);
  for (const tokens of [
    extractUsageTokens({ ...message, stop_reason: "end_turn" }),
    extractUsageTokens({ ...message, content: [{ type: "text", text: "Partial output" }], usage: { input_tokens: 412, output_tokens: 2 } }),
    extractSseUsageTokens(sse(start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "Partial output" } }, { ...delta, usage: { output_tokens: 2 } }, stop)),
  ]) assert.ok(actualModelCost(cachePricing, tokens) >= 412);
});

test("Anthropic cumulative deltas update cache buckets without summing snapshots", () => {
  const stream = sse(
    { type: "message_start", message: { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 } } },
    { type: "message_delta", usage: { input_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 3_000, cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 }, output_tokens: 5 } },
    { type: "message_delta", usage: { output_tokens: 20, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: null } },
    { type: "message_stop" },
  );
  for (const newline of ["\n", "\r\n", "\r"]) {
    const tokens = extractSseUsageTokens(stream.replaceAll("\n", newline));
    assert.equal(actualModelCost(cachePricing, tokens), 4_710);
    assert.equal(tokens.total, 4_030);
  }
});

test("OpenAI streams keep inclusive cache usage and require their terminal event", () => {
  const usage = { input_tokens: 4_000, input_tokens_details: { cached_tokens: 1_000, cache_write_tokens: 2_000 }, output_tokens: 20 };
  const chunk = { object: "chat.completion.chunk", usage };
  const completed = { type: "response.completed", response: { usage } };
  for (const stream of [sse(chunk, "[DONE]"), sse(completed), sse({ ...completed, type: "response.incomplete" }), sse({ ...completed, type: "response.failed" })]) {
    const tokens = extractSseUsageTokens(stream);
    assert.equal(tokens.input, 4_000);
    assert.equal(actualModelCost(cachePricing, tokens), 5_200);
  }
  for (const stream of [
    sse(chunk),
    sse(chunk, "[DONE]").trimEnd(),
    sse({ type: "response.in_progress", response: { usage } }),
    sse({ type: "response.failed", response: { usage: null } }),
    sse({ type: "response.incomplete", response: {} }),
    sse({ type: "response.incomplete", response: { usage } }).trimEnd(),
    sse(chunk, { error: { message: "fixture stream error" } }, "[DONE]"),
  ]) assert.equal(extractSseUsageTokens(stream), null);
});

test("other SSE usage metadata and multiline data retain their existing totals", () => {
  const stream = ': heartbeat\n\ndata: {"usageMetadata": {\ndata: "promptTokenCount": 100, "candidatesTokenCount": 20, "totalTokenCount": 120}}\n\n';
  assert.deepEqual(extractSseUsageTokens(stream), { input: 100, output: 20, total: 120, cached: 0, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null });
});

test("Gemini keeps cache-inclusive input and bills thoughts plus candidates in JSON and cumulative SSE", () => {
  const usageMetadata = { promptTokenCount: 1_000, cachedContentTokenCount: 900, candidatesTokenCount: 100, thoughtsTokenCount: 1_000, totalTokenCount: 2_100 };
  const final = { usageMetadata };
  for (const tokens of [extractUsageTokens(final), extractSseUsageTokens(sse({ usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 5, totalTokenCount: 1_005 } }, final, { candidates: [] }))]) {
    assert.deepEqual(tokens, { input: 1_000, output: 1_100, total: 2_100, cached: 900, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null });
    assert.equal(actualModelCost({ ...cachePricing, inputMicrosPerMillion: 1_500_000, cachedInputMicrosPerMillion: 150_000, outputMicrosPerMillion: 9_000_000 }, tokens), 10_185);
  }
  const thoughtsOnly = extractUsageTokens({ usageMetadata: { promptTokenCount: 1_000, thoughtsTokenCount: 100, totalTokenCount: 1_100 } });
  assert.equal(thoughtsOnly.output, 100);
  assert.equal(thoughtsOnly.cached, 0);
  assert.equal(extractUsageTokens({ usageMetadata: { ...usageMetadata, totalTokenCount: 2_123 } }).total, 2_123, "keep provider total instead of inferring generated tokens from it");
});

test("Gemini scalar defaults are distinct from absent or malformed metadata", () => {
  const zero = { input: 0, output: 0, total: 0, cached: 0, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
  for (const usageMetadata of [{}, { promptTokenCount: 0, candidatesTokenCount: 0 }, { thoughtsTokenCount: null }]) assert.deepEqual(extractUsageTokens({ usageMetadata }), zero);
  for (const body of [{}, { usageMetadata: null }, { usageMetadata: [] }]) assert.equal(extractUsageTokens(body), null);
  const wire = { usage_metadata: { prompt_token_count: "1e3", candidates_token_count: "16", thoughts_token_count: "2", total_token_count: "1018" } };
  assert.deepEqual(extractUsageTokens(wire), { ...zero, input: 1_000, output: 18, total: 1_018 });
  const partial = { usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 5, totalTokenCount: 1_005 } };
  for (const field of ["promptTokenCount", "cachedContentTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount"]) {
    for (const invalid of [-1, 1.5, 2_147_483_648, "bad", "Infinity", true, {}]) {
      const final = { usageMetadata: { ...partial.usageMetadata, [field]: invalid } };
      assert.equal(extractUsageTokens(final), null);
      assert.equal(extractSseUsageTokens(sse(partial, final)), null, "invalid final usage cannot retain a cheaper partial snapshot");
    }
  }
  assert.equal(extractSseUsageTokens(sse(partial, { usageMetadata: null })), null);
  assert.equal(extractUsageTokens({ usageMetadata: { candidatesTokenCount: 2_147_483_647, thoughtsTokenCount: 2_147_483_647 } }).output, 4_294_967_294);
});
