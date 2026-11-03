import assert from "node:assert/strict";
import test from "node:test";
import { createSseUsageInspector, extractUsageTokens, responseOutcome, usageInspectionLimit } from "../token-usage.ts";

const usage = { tokens: { input_tokens: 71, output_tokens: 26 }, billed_units: { input_tokens: 5, output_tokens: 26 } };
const terminal = (value = usage, finish_reason = "COMPLETE") => ({ type: "message-end", delta: { finish_reason, usage: value } });
const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const start = { type: "message-start", delta: { message: { role: "assistant" } } };
const expected = { input: 71, output: 26, total: 97, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null, billedTokens: { input: 5, output: 26 } };

function inspect(text, ended = true, step = 1) {
  const inspector = createSseUsageInspector(), bytes = new TextEncoder().encode(text);
  for (let offset = 0; offset < bytes.length; offset += step) inspector.push(bytes.subarray(offset, offset + step));
  return inspector.result(ended);
}

test("Cohere unary and terminal SSE keep observed and billed tokens distinct", () => {
  assert.deepEqual(extractUsageTokens({ usage }), expected);
  assert.deepEqual(extractUsageTokens(terminal()), expected);
  for (const newline of ["\n", "\r\n", "\r"]) for (const reason of ["COMPLETE", "STOP_SEQUENCE", "MAX_TOKENS", "TOOL_CALL"]) {
    const text = (frame(start) + frame(terminal(usage, reason))).replaceAll("\n", newline);
    assert.deepEqual(inspect(text), { tokens: expected, outcome: "success" });
  }
});

test("Cohere counters reject fractional, negative, unsafe and nonnumeric values without borrowing another bucket", () => {
  for (const value of [undefined, null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "4", {}, []]) {
    const result = extractUsageTokens({ usage: { tokens: { input_tokens: value, output_tokens: 26 }, billed_units: { input_tokens: 5, output_tokens: value } } });
    assert.equal(result.input, null);
    assert.equal(result.total, null);
    assert.deepEqual(result.billedTokens, { input: 5, output: null });
  }
  assert.deepEqual(extractUsageTokens({ usage: { tokens: usage.tokens } }).billedTokens, { input: null, output: null });
  assert.equal(extractUsageTokens({ usage: { billed_units: usage.billed_units } }).input, null);
  assert.deepEqual(extractUsageTokens({ usage: { tokens: {}, billed_units: { input_tokens: 0, output_tokens: 0 } } }).billedTokens, { input: 0, output: 0 });
});

test("Cohere SSE requires a delimited terminal and records terminal errors", () => {
  for (const text of [frame(start), frame(start) + frame(terminal()).trimEnd(), frame(start) + 'data: [DONE]\n\n', frame(start) + 'data: broken\n\n']) {
    assert.deepEqual(inspect(text), { tokens: null, outcome: "provider_error" });
  }
  assert.deepEqual(inspect(frame(start), false), { tokens: null, outcome: null });
  for (const reason of ["ERROR", "TIMEOUT", undefined, "future"]) {
    const end = terminal(); end.delta.finish_reason = reason;
    assert.equal(responseOutcome(end), "provider_error");
    assert.deepEqual(inspect(frame(start) + frame(end)), { tokens: expected, outcome: "provider_error" });
  }
  assert.deepEqual(inspect(frame(start) + frame(terminal(null))), { tokens: null, outcome: "success" });
  assert.deepEqual(inspect(frame(start) + frame(terminal()) + 'event: error\ndata: {}\n\n'), { tokens: expected, outcome: "provider_error" });
});

test("oversized content is skipped and bounded terminal counters restore evidence", () => {
  const huge = frame({ type: "content-delta", delta: { message: { content: { text: "x".repeat(usageInspectionLimit + 1) } } } });
  assert.deepEqual(inspect(frame(start) + huge + frame(terminal()), true, 8191), { tokens: expected, outcome: "success" });
  assert.deepEqual(inspect(frame(start) + huge, true, 8191), { tokens: null, outcome: null });
});
