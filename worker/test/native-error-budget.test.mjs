import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, sse, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");
const messageStart = { type: "message_start", message: { type: "message", usage: { input_tokens: 10, output_tokens: 1 } } };

for (const fixedCost of [null, 0, 7]) for (const first of [true, false]) test(`Anthropic overloaded SSE first=${first}, tariff=${fixedCost} preserves native bytes and correct charges`, async t => {
  const limit = 1_000_000, events = [], pending = [];
  const env = usageEnv([], { provider: "anthropic", limit, fixedCost, retainContent: false });
  env.ANTHROPIC_API_KEY = "fixture-anthropic-key"; env.BUDGET_LEDGER = sqlBudgetNamespace(t);
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  const overloaded = { type: "error", error: { type: "overloaded_error", message: "synthetic overload" } };
  const body = sse(...(first ? [] : [messageStart]), overloaded);
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const response = await handler.fetch(new Request("https://router.example/v1/messages", {
    method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-haiku-4-5", messages: [{ role: "user", content: "fixture" }], max_tokens: 32, stream: true }),
  }), env, { waitUntil: promise => pending.push(promise) });
  assert.equal(response.status, 200); assert.equal(await response.text(), body); await Promise.all(pending);
  assert.equal(events.length, 1); const event = events[0], cost = first ? 0 : event.reserved_cost_micros;
  assert.equal(event.status_code, 200); assert.equal(event.status, "provider_error");
  assert.equal(event.actual_cost_micros, cost); assert.equal(event.cost_basis, first ? "none" : fixedCost === null ? "manifest_reservation" : "policy_fixed");
  for (const name of ["tenant:maintainer_access:owner@example.com", "provider:anthropic"]) {
    const [row] = env.BUDGET_LEDGER.get(name).reservations(); assert.equal(row.settled, 1); assert.equal(row.reserved_micros, cost);
  }
});
