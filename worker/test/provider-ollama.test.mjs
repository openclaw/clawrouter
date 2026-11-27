import assert from "node:assert/strict";
import test from "node:test";
import { createOllamaChatInspector, filterOllamaModels, inspectOllamaChatResponse, ollamaInspectionLimit, prepareOllamaChatRequest } from "../provider-ollama.ts";

const encode = value => new TextEncoder().encode(value);
const final = { model: "tenant/model", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 17, prompt_eval_cached_count: 3, eval_count: 4 };
const expected = { input: 17, output: 4, total: 21, cached: 3, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
const chunks = [
  { message: { role: "assistant", content: "", thinking: "synthetic reasoning 🦊" }, done: false },
  { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "forecast", arguments: { city: "Paris" } } }] }, done: false },
  { message: { role: "assistant", content: "synthetic answer" }, done: false }, final,
];
const wire = chunks.map(value => JSON.stringify(value)).join("\r\n") + "\n";

test("native request binds selected model without rewriting tool or thinking contracts", () => {
  const input = { model: "caller-alias", messages: [{ role: "user", content: "synthetic question", images: ["c3ludGhldGlj"] }, chunks[1].message, { role: "tool", content: "sunny", tool_name: "forecast" }], tools: [{ type: "function", function: { name: "forecast", parameters: { type: "object" } } }], think: "high", stream: true, options: { num_predict: 8 }, format: { type: "object" } };
  const before = structuredClone(input);
  assert.deepEqual(prepareOllamaChatRequest(input, "tenant/model"), { ...input, model: "tenant/model" });
  assert.deepEqual(input, before);
  for (const patch of [{ messages: [] }, { messages: [{}] }, { think: 2 }, { stream: "true" }, { options: [] }, { tools: {} }]) assert.throws(() => prepareOllamaChatRequest({ ...input, ...patch }, "tenant/model"), /invalid_ollama/);
});

test("NDJSON observer survives every byte boundary, preserves tools and counts one terminal snapshot", () => {
  const bytes = encode(wire), before = bytes.slice();
  for (let split = 0; split <= bytes.length; split++) {
    const inspector = createOllamaChatInspector();
    inspector.push(bytes.subarray(0, split)); inspector.push(bytes.subarray(split));
    assert.deepEqual(inspector.result(), { tokens: expected, outcome: "success" });
  }
  const inspector = createOllamaChatInspector();
  for (const byte of bytes) inspector.push(Uint8Array.of(byte));
  assert.deepEqual(inspector.result(), { tokens: expected, outcome: "success" });
  assert.deepEqual(bytes, before);
});

test("JSON and an EOF-delimited NDJSON terminal have the same usage", () => {
  for (const format of ["json", "ndjson"]) {
    const inspector = createOllamaChatInspector(format);
    inspector.push(encode(JSON.stringify(final, null, format === "json" ? 2 : undefined)));
    assert.deepEqual(inspector.result(), { tokens: expected, outcome: "success" });
    assert.deepEqual(inspector.result(), { tokens: expected, outcome: "success" });
  }
});

test("tools, partial counts and delivery EOF cannot invent terminal success", () => {
  const inspector = createOllamaChatInspector();
  inspector.push(encode(JSON.stringify({ ...chunks[1], prompt_eval_count: 17, eval_count: 1 }) + "\n"));
  assert.deepEqual(inspector.result(), { tokens: null, outcome: null });
  const canceled = createOllamaChatInspector();
  canceled.push(encode(JSON.stringify(final)));
  assert.deepEqual(canceled.result(false), { tokens: null, outcome: null });
});

test("provider errors are explicit, never a synthetic free request", () => {
  for (const value of [{ error: "synthetic failure" }, { ...final, error: "synthetic failure" }]) {
    const inspector = createOllamaChatInspector();
    inspector.push(encode(JSON.stringify(value) + "\n"));
    const result = inspector.result();
    assert.equal(result.outcome, "provider_error");
    assert.deepEqual(result.tokens, value.done ? expected : null);
    assert.equal(result.tokens?.billable, undefined);
  }
});

test("missing, fractional, negative and unsafe counters never become zero prices or usage", () => {
  for (const value of [undefined, null, -1, 1.5, "17", Number.MAX_SAFE_INTEGER]) {
    assert.equal(inspectOllamaChatResponse({ ...final, prompt_eval_count: value }).tokens, null);
  }
  assert.deepEqual(inspectOllamaChatResponse({ ...final, prompt_eval_count: 0, eval_count: 0 }).tokens, { ...expected, input: 0, output: 0, total: 0, cached: null });
  assert.equal(inspectOllamaChatResponse({ ...final, prompt_eval_cached_count: 18 }).tokens.cached, null);
});

test("oversized output can recover at a bounded terminal, while oversized JSON cannot", () => {
  const large = encode(JSON.stringify({ ...chunks[0], message: { content: "x".repeat(ollamaInspectionLimit) } }));
  const inspector = createOllamaChatInspector();
  inspector.push(large); inspector.push(encode("\n" + JSON.stringify(final) + "\n"));
  assert.deepEqual(inspector.result(), { tokens: expected, outcome: "success" });
  const json = createOllamaChatInspector("json");
  json.push(encode(JSON.stringify({ ...final, extra: "x".repeat(ollamaInspectionLimit) })));
  assert.deepEqual(json.result(), { tokens: null, outcome: null });
});

test("malformed, duplicate or post-terminal records invalidate accounting evidence", () => {
  for (const value of ["{bad}\n" + wire, wire + JSON.stringify(final), wire + JSON.stringify(chunks[0]), wire + "x".repeat(ollamaInspectionLimit + 1)]) {
    const inspector = createOllamaChatInspector(); inspector.push(encode(value));
    assert.deepEqual(inspector.result(), { tokens: null, outcome: null });
  }
  const invalidUtf8 = createOllamaChatInspector();
  invalidUtf8.push(Uint8Array.of(0xff, 10)); invalidUtf8.push(encode(wire));
  assert.deepEqual(invalidUtf8.result(), { tokens: null, outcome: null });
});

test("native tags retain allowed metadata and exclude denied models", () => {
  const allowed = { name: "tenant/model", model: "tenant/model", details: { family: "fixture", quantization_level: "Q4_K_M" }, digest: "synthetic-digest" };
  const value = { models: [allowed, { name: "private/model", model: "private/model" }], extra: "retained" };
  assert.deepEqual(filterOllamaModels(value, id => id === "tenant/model"), { models: [allowed], extra: "retained" });
  assert.equal(value.models.length, 2);
  for (const invalid of [{ data: [] }, { models: [null] }, { models: [{ name: "public", model: "private" }] }]) assert.throws(() => filterOllamaModels(invalid, () => true), /invalid_ollama_model/);
});
