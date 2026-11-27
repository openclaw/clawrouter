import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { actualModelCost } from "../pricing.ts";
import { observeUsage } from "../proxy-response.ts";
import { extractUsageTokens } from "../token-usage.ts";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");
const usage = { tokens: { input_tokens: 71, output_tokens: 26 }, billed_units: { input_tokens: 5, output_tokens: 26 } };
const final = { type: "message-end", delta: { finish_reason: "COMPLETE", usage } };
const pricing = { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: null, cacheWriteInputMicrosPerMillion: null, cacheWrite5mInputMicrosPerMillion: null, cacheWrite1hInputMicrosPerMillion: null, longContext: null };

test("Cohere settlement uses billed units and fails closed when they are absent or malformed", () => {
  for (const tokens of [extractUsageTokens({ usage }), extractUsageTokens(final)]) assert.equal(actualModelCost(pricing, tokens, "cohere.chat"), 57);
  for (const billed_units of [undefined, {}, { input_tokens: 5 }, { input_tokens: "5", output_tokens: 26 }, { input_tokens: 5, output_tokens: -1 }]) {
    assert.equal(actualModelCost(pricing, extractUsageTokens({ usage: { tokens: usage.tokens, billed_units } }), "cohere.chat"), null);
  }
  assert.equal(actualModelCost(pricing, extractUsageTokens({ usage: { input_tokens: 71, output_tokens: 26 } }), "cohere.chat"), null);
  assert.equal(actualModelCost(pricing, extractUsageTokens({ usage: { tokens: usage.tokens, billed_units: { input_tokens: 0, output_tokens: 0 } } }), "cohere.chat"), 0);
});

for (const stream of [false, true]) for (const manifest of [false, true]) test(`Cohere ${manifest ? "manifest" : "native"} ${stream ? "SSE" : "JSON"} preserves bytes and observed usage`, async t => {
  const pending = [], events = [], env = usageEnv([], { provider: "cohere", limit: null, fixedCost: null, retainContent: false });
  env.COHERE_API_KEY = "fixture-cohere-key";
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  const wire = stream ? sse({ type: "message-start" }, { type: "content-delta", delta: { message: { content: { text: "fixture" } } } }, final) : JSON.stringify({ message: { content: [{ type: "text", text: "fixture" }] }, finish_reason: "COMPLETE", usage });
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response(wire, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } }));
  const body = { model: "command-a-plus-05-2026", messages: [{ role: "user", content: "fixture" }], stream };
  const response = await handler.fetch(new Request(`https://router.example/v1/${manifest ? "proxy/cohere/chat" : "native/cohere/v2/chat"}`, {
    method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, body: JSON.stringify(manifest ? { body } : body),
  }), env, { waitUntil: promise => pending.push(promise) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), wire);
  await Promise.all(pending);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].input_tokens, events[0].output_tokens, events[0].total_tokens], [71, 26, 97]);
  assert.equal(events[0].status, "success");
});

test("Cohere observation preserves backpressure and cancellation without terminal usage", async () => {
  let pulls = 0, canceled;
  const bytes = new TextEncoder().encode(sse({ type: "message-start" }));
  const upstream = new ReadableStream({ pull(c) { pulls++; c.enqueue(bytes); }, cancel(reason) { canceled = reason; } }, { highWaterMark: 0 });
  const observed = observeUsage(new Response(upstream, { headers: { "content-type": "text/event-stream" } }), undefined, undefined, "cohere.chat");
  assert.equal(pulls, 0);
  const reader = observed.response.body.getReader();
  assert.deepEqual((await reader.read()).value, bytes);
  assert.equal(pulls, 1);
  await reader.cancel("fixture cancel");
  assert.equal(canceled, "fixture cancel");
  assert.deepEqual(await observed.result, { tokens: null, outcome: null, delivery: "canceled" });
});
