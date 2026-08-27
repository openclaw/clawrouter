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
  for (const stream of [sse(chunk, "[DONE]"), sse(completed)]) {
    const tokens = extractSseUsageTokens(stream);
    assert.equal(tokens.input, 4_000);
    assert.equal(actualModelCost(cachePricing, tokens), 5_200);
  }
  for (const stream of [
    sse(chunk),
    sse(chunk, "[DONE]").trimEnd(),
    sse({ type: "response.in_progress", response: { usage } }),
    sse({ type: "response.failed", response: { usage } }),
    sse(chunk, { error: { message: "fixture stream error" } }, "[DONE]"),
  ]) assert.equal(extractSseUsageTokens(stream), null);
});

test("other SSE usage metadata and multiline data retain their existing totals", () => {
  const stream = ': heartbeat\n\ndata: {"usageMetadata": {\ndata: "promptTokenCount": 100, "candidatesTokenCount": 20, "totalTokenCount": 120}}\n\n';
  assert.deepEqual(extractSseUsageTokens(stream), { input: 100, output: 20, total: 120, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null });
});
