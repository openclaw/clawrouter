import assert from "node:assert/strict";
import test from "node:test";
import { createRadiusEventInspector, extractRadiusUsage, filterRadiusCatalog, prepareRadiusRequest } from "../provider-radius.ts";

const usage = { input: 50, output: 12, cacheRead: 10, cacheWrite: 4, totalTokens: 76, cost: { input: 0.00015, output: 0.00018, cacheRead: 0.000003, cacheWrite: 0.000015, total: 0.000348 } };
const final = { type: "done", reason: "toolUse", usage };
const events = [
  { type: "start" },
  { type: "thinking_start", contentIndex: 0 },
  { type: "thinking_delta", contentIndex: 0, delta: "synthetic reasoning" },
  { type: "thinking_end", contentIndex: 0, content: "synthetic reasoning", contentSignature: "synthetic-signature", redacted: true },
  { type: "text_start", contentIndex: 1 },
  { type: "text_delta", contentIndex: 1, delta: "synthetic text" },
  { type: "text_end", contentIndex: 1, content: "synthetic text" },
  { type: "toolcall_start", contentIndex: 2, id: "fixture-call", toolName: "forecast" },
  { type: "toolcall_delta", contentIndex: 2, delta: '{"city":' },
  { type: "toolcall_delta", contentIndex: 2, delta: '"Paris"}' },
  { type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "fixture-call", name: "forecast", arguments: { city: "Paris" }, thoughtSignature: "synthetic-tool-signature" } },
  final,
];
const inspect = list => { const inspector = createRadiusEventInspector(); for (const event of list) inspector.accept(event); return inspector.result(); };

test("Pi-native request preserves context, tool identity and options, and binds selected model", () => {
  const body = { model: "alias", context: { systemPrompt: "synthetic instructions", tools: [{ name: "forecast", parameters: { type: "object" } }], messages: [{ role: "user", content: "synthetic request", timestamp: 1 }, { role: "toolResult", toolCallId: "fixture-call", toolName: "forecast", content: [{ type: "text", text: "sunny" }], timestamp: 2 }] }, options: { reasoning: "off", maxTokens: 512, cacheRetention: "long", sessionId: "synthetic-session", toolChoice: "required" } };
  const before = structuredClone(body), result = prepareRadiusRequest(body, "tenant/model");
  assert.deepEqual(result, { ...body, model: "tenant/model", options: { maxTokens: 512, cacheRetention: "long", sessionId: "synthetic-session", toolChoice: "required" } });
  assert.deepEqual(body, before);
  assert.throws(() => prepareRadiusRequest({ messages: [] }, "tenant/model"), /invalid_radius/);
  assert.throws(() => prepareRadiusRequest({ ...body, options: { maxTokens: -1 } }, "tenant/model"), /invalid_radius/);
});

test("native text/thinking/tool sequence retains bytes and signed payloads without accumulation", () => {
  const before = structuredClone(events), result = inspect(events);
  assert.deepEqual(events, before);
  assert.equal(result.outcome, "success");
  assert.deepEqual(result.tokens, { input: 64, output: 12, total: 76, cached: 10, cacheWrite: 4, cacheWrite5m: null, cacheWrite1h: null });
  assert.equal(result.tokens.cost, undefined);
});

test("explicit errors retain incurred token evidence without declaring free execution", () => {
  const result = inspect([...events.slice(0, -2), { type: "error", reason: "aborted", usage, errorMessage: "synthetic failure" }]);
  assert.equal(result.outcome, "provider_error");
  assert.equal(result.tokens.total, 76);
  assert.equal(result.tokens.billable, undefined);
});

test("EOF, unfinished tools and framing loss cannot certify native completion", () => {
  assert.deepEqual(inspect(events.slice(0, -1)), { tokens: null, outcome: null });
  assert.deepEqual(inspect([...events.slice(0, -2), final]), { tokens: null, outcome: null });
  const inspector = createRadiusEventInspector(); inspector.accept(events[0]); inspector.unavailable(); inspector.accept(final);
  assert.deepEqual(inspector.result(), { tokens: null, outcome: null });
});

test("wrong tool identity, block order, duplicate terminals and contradictory counters fail closed", () => {
  const mismatch = structuredClone(events); mismatch.at(-2).toolCall.id = "other";
  for (const list of [mismatch, [events[4], final], [...events, final], [...events.slice(0, -1), { ...final, reason: "unknown" }], [...events.slice(0, -1), { ...final, usage: { ...usage, totalTokens: 1 } }]]) {
    assert.deepEqual(inspect(list), { tokens: null, outcome: null });
  }
  for (const value of [-1, 1.5, "50", Number.MAX_SAFE_INTEGER]) assert.equal(extractRadiusUsage({ ...usage, input: value }), null);
});

test("catalog filtering preserves native model metadata but cannot choose a new credential origin", () => {
  const model = { id: "tenant/model", name: "Fixture", cost: { input: 1, output: 2 }, reasoning: true };
  const input = { baseUrl: "https://radius.example.com/v1/", models: [model, { id: "private/model" }, { id: "disabled/model", enabled: false }] };
  assert.deepEqual(filterRadiusCatalog(input, "https://radius.example.com/v1", id => id !== "private/model"), { baseUrl: "https://radius.example.com/v1", models: [model] });
  for (const baseUrl of ["https://other.example.com/v1", "http://radius.example.com/v1", "https://user:secret@radius.example.com/v1", "https://radius.example.com/v1?credential=x", "https://radius.example.com/v1#fragment"]) {
    assert.throws(() => filterRadiusCatalog({ ...input, baseUrl }, "https://radius.example.com/v1", () => true), /invalid_radius_catalog_origin/);
  }
  assert.throws(() => filterRadiusCatalog({ ...input, models: [model, model] }, input.baseUrl, () => true), /invalid_radius_catalog_model/);
});
