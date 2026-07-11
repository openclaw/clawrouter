import assert from "node:assert/strict";
import test from "node:test";

import { extractUsageTokens } from "../token-usage.ts";

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
