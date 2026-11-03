import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";
const { default: worker } = await import("../index.ts");
const { providerById } = await import("../providers.ts");
const usage = { input: 50, output: 12, cacheRead: 10, cacheWrite: 4, totalTokens: 76, cost: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100, total: 400 } };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const events = [
  { type: "start" },
  { type: "thinking_start", contentIndex: 0 },
  { type: "thinking_end", contentIndex: 0, content: "synthetic reasoning 🦊", contentSignature: "synthetic-signature", redacted: true },
  { type: "toolcall_start", contentIndex: 1, id: "fixture-call", toolName: "forecast" },
  { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "fixture-call", name: "forecast", arguments: { city: "Paris" }, thoughtSignature: "synthetic-tool-signature" } },
];
const done = { type: "done", reason: "toolUse", usage };
const input = { model: "fixture", context: { systemPrompt: "synthetic instructions", tools: [{ name: "forecast", parameters: { type: "object" } }], messages: [{ role: "user", content: "fixture" }, { role: "toolResult", toolCallId: "fixture-call", toolName: "forecast", content: [{ type: "text", text: "sunny" }] }] }, options: { reasoning: "off", maxTokens: 10, cacheRetention: "long", sessionId: "fixture-session" } };

function fixture(t, { fixed = 7, permitted = true } = {}) {
  // Use a different provider ID to exercise format dispatch independently of
  // source-owned Radius endpoint declarations and catalog activation.
  const provider = providerById("openai"), original = structuredClone(provider);
  t.after(() => { Object.keys(provider).forEach(key => delete provider[key]); Object.assign(provider, original); });
  const endpoint = provider.endpoints.find(e => e.id === "chat_completions");
  Object.assign(endpoint, { path: "/fixture/messages", request_format: "radius.messages", response_format: "radius.messages" });
  provider.models = [{ id: "openai/fixture", upstream: "fixture", capabilities: ["llm.chat"], pricing: null, pricing_ref: null }];
  const pending = [], recorded = [], budgets = [], sent = [];
  const env = usageEnv(budgets, { provider: permitted ? "openai" : "anthropic", fixedCost: fixed, retainContent: false });
  env.OPENAI_API_KEY = "fixture-native-key"; env.USAGE_QUEUE = { send: async event => recorded.push(event) };
  const f = { env, recorded, budgets, sent, reply: () => new Response([...events, done].map(frame).join(""), { headers: { "content-type": "text/event-stream" } }),
    call(body = input, manifest = false, signal) { return worker.fetch(new Request(`https://router.example${manifest ? "/v1/proxy/openai/chat_completions" : "/v1/native/openai/fixture/messages"}`, {
      method: "POST", signal, headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, body: JSON.stringify(manifest ? { body } : body),
    }), env, { waitUntil: promise => pending.push(promise) }); },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => { const r = new Request(url, init); sent.push(r); return f.reply(r); });
  return f;
}

for (const manifest of [false, true]) test(`Radius ${manifest ? "manifest" : "native"} preserves Pi wire and settles native counters once`, async t => {
  const f = fixture(t), wire = Buffer.from([...events, done].map(frame).join("")); let offset = 0;
  f.reply = () => new Response(new ReadableStream({ pull(c) { if (offset === wire.length) c.close(); else c.enqueue(wire.subarray(offset, ++offset)); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const response = await f.call({ ...input, model: manifest ? "openai/fixture" : "fixture" }, manifest);
  assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(Buffer.from(await response.arrayBuffer()), wire); await f.drain();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].url, "https://api.openai.com/fixture/messages");
  assert.equal(f.sent[0].headers.get("authorization"), "Bearer fixture-native-key");
  const sent = await f.sent[0].json(), expected = structuredClone(input); delete expected.options.reasoning; assert.deepEqual(sent, expected);
  assert.equal(f.recorded.length, 1); const event = f.recorded[0];
  assert.equal(event.status, "success"); assert.equal(event.credential_id, "maintainer_key"); assert.equal(event.tenant_id, "tenant");
  assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens, event.cache_write_input_tokens], [64, 12, 76, 10, 4]);
  assert.equal(event.actual_cost_micros, 7, "native cost fields never replace the fixed policy tariff"); assert.equal(event.cost_basis, "policy_fixed");
  assert.doesNotMatch(JSON.stringify(event), /synthetic-reasoning|synthetic-signature|synthetic-tool-signature|fixture-native-key/);
});

test("native HTTP-200 errors retain billable usage and bytes; missing terminals remain conservative", async t => {
  const f = fixture(t);
  for (const [wire, expectedTokens] of [
    [frame({ type: "error", reason: "aborted", usage, errorMessage: "synthetic failure" }), 76],
    [events.map(frame).join(""), null],
    [[...events, done].map(frame).join("") + 'data: {', null],
    [frame({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 12 } }), null],
  ]) {
    f.reply = () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
    const response = await f.call(); assert.equal(response.status, 200); assert.equal(await response.text(), wire); await f.drain();
    const event = f.recorded.at(-1); assert.equal(event.status, "provider_error"); assert.equal(event.total_tokens, expectedTokens); assert.equal(event.actual_cost_micros, 7);
  }
  assert.equal(f.recorded.length, 4);
});

test("Radius cancellation does not drain the producer or fabricate terminal usage", async t => {
  const f = fixture(t); let pulls = 0, canceled;
  const bytes = Buffer.from(frame(events[0]));
  f.reply = () => new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(bytes); }, cancel(reason) { canceled = reason; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const response = await f.call(); assert.equal(response.status, 200); assert.equal(pulls, 0);
  const reader = response.body.getReader(); assert.deepEqual((await reader.read()).value, bytes); assert.equal(pulls, 1);
  await reader.cancel("fixture cancel"); await f.drain();
  assert.equal(canceled, "fixture cancel"); assert.equal(pulls, 1); assert.equal(f.recorded.length, 1);
  assert.equal(f.recorded[0].status, "client_error"); assert.equal(f.recorded[0].total_tokens, null); assert.equal(f.recorded[0].actual_cost_micros, 7);
});

test("unpriced native usage and malformed Pi options cannot bypass hard budgets", async t => {
  const f = fixture(t, { fixed: null });
  const unpriced = await f.call(); assert.equal(unpriced.status, 400); assert.equal((await unpriced.json()).error.code, "pricing_required");
  for (const patch of [{ context: [] }, { messages: [] }, { options: { maxTokens: -1 } }, { stream: true }]) {
    const response = await f.call({ ...input, ...patch }); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "invalid_radius_request");
  }
  await f.drain(); assert.equal(f.sent.length, 0);
});

test("native provider policy is enforced before egress", async t => {
  const f = fixture(t, { permitted: false }); const response = await f.call();
  assert.equal(response.status, 403); assert.equal(f.sent.length, 0); await f.drain();
});
