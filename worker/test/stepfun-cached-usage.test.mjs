import assert from "node:assert/strict";
import test from "node:test";
import { createSseUsageInspector, extractSseUsageTokens, extractUsageTokens } from "../token-usage.ts";
const context = { providerId: "stepfun", requestFormat: "openai.chat_completions", responseFormat: "openai.chat_completions" };
const usage = { prompt_tokens: 591, completion_tokens: 120, total_tokens: 711, cached_tokens: 512 };
const chunk = usage => ({ object: "chat.completion.chunk", model: "step-3.7-flash", choices: [], usage });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const sse = (...values) => values.map(frame).join("") + "data: [DONE]\n\n";

test("standard StepFun Chat cache hits stay an inclusive prompt subset in JSON and cumulative SSE", () => {
  for (const providerId of ["stepfun", "stepfun-cn"]) for (const cached of [0, 512, 591]) {
    const scope = { ...context, providerId }, value = { ...usage, cached_tokens: cached };
    const expected = { input: 591, output: 120, total: 711, cached, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
    assert.deepEqual(extractUsageTokens({ usage: value }, scope), expected);
    assert.deepEqual(extractSseUsageTokens(sse(chunk({ ...value, completion_tokens: 1, total_tokens: 592 }), chunk(value), chunk(value)), scope), expected);
  }
});

test("StepFun top-level cache meaning requires the trusted standard Chat context", () => {
  for (const scope of [undefined, { ...context, providerId: "openai" }, { ...context, providerId: "stepfun-plan" }, { ...context, providerId: "stepfun-plan-cn" },
    { ...context, requestFormat: "openai.responses" }, { ...context, responseFormat: "openai.responses" }]) {
    const tokens = extractUsageTokens({ model: "stepfun/step-3.7-flash", provider: "stepfun", usage }, scope);
    assert.equal(tokens.cached, null); assert.equal(tokens.input, 591); assert.equal(tokens.total, 711);
  }
  assert.equal(extractUsageTokens({ usage: { input_tokens: 591, output_tokens: 120, cached_tokens: 512 } }, context).cached, null);
});

test("malformed or contradictory StepFun cache evidence never discounts input or keeps an earlier SSE cache count", () => {
  for (const cached_tokens of [-1, 592, 0.5, "512", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = { ...usage, cached_tokens };
    for (const tokens of [extractUsageTokens({ usage: invalid }, context), extractSseUsageTokens(sse(chunk(usage), chunk(invalid)), context)]) {
      assert.equal(tokens.input, 591); assert.equal(tokens.output, 120); assert.equal(tokens.total, 711); assert.equal(tokens.cached, null);
    }
  }
  for (const patch of [{ prompt_tokens_details: { cached_tokens: 511 } }, { prompt_cache_hit_tokens: 511 }, { prompt_cache_miss_tokens: 80 }, { input_tokens: 590 }])
    assert.equal(extractUsageTokens({ usage: { ...usage, ...patch } }, context).cached, null);
  assert.equal(extractUsageTokens({ usage: { ...usage, prompt_tokens_details: { cached_tokens: 512 }, prompt_cache_hit_tokens: 512, prompt_cache_miss_tokens: 79 } }, context).cached, 512);
  assert.equal(extractUsageTokens({ usage: { cached_tokens: 512, completion_tokens: 120 } }, context).cached, null);
});

test("fragmented StepFun SSE requires a terminal and does not sum repeated cumulative snapshots", () => {
  const text = sse(chunk(usage), chunk(usage));
  const inspector = createSseUsageInspector(undefined, undefined, context), bytes = new TextEncoder().encode(text);
  for (let index = 0; index < bytes.length; index += 3) inspector.push(bytes.slice(index, index + 3));
  assert.equal(inspector.result().tokens.cached, 512); assert.equal(inspector.result().tokens.total, 711);
  assert.equal(extractSseUsageTokens(frame(chunk(usage)), context), null);
  const interrupted = createSseUsageInspector(undefined, undefined, context); interrupted.push(bytes.slice(0, bytes.length - 14));
  assert.equal(interrupted.result(false).tokens, null);
});
