import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./http-continuation-fixture.mjs";
import { queue } from "../ledgers.ts";

const reasoning = { type: "reasoning", id: "rs_tariff", encrypted_content: "synthetic-private-reasoning", summary: [] };
const search = { type: "web_search_call", id: "ws_tariff", status: "completed", action: { type: "search", query: "synthetic-private-query" } };
const terminal = { object: "response", id: "resp_tariff", status: "completed", output: [search], service_tier: "default", usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };

async function run(t, { stream = false, tool = "web_search", extra = {}, fee = 10_000 } = {}) {
  const f = await fixture(t, false);
  Object.assign(f.policy, { requestCostMicros: null, monthlyBudgetMicros: 100_000_000, budgetMode: "soft" });
  await f.authority("/policies/put", { policyId: "fixture", policy: f.policy });
  await f.authority("/connections/put", { providerId: "openai", enabled: true, monthlyBudgetMicros: 100_000_000 });
  const ledger = f.env.BUDGET_LEDGER, calls = [];
  f.env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch: (url, init) => {
    calls.push({ name, path: new URL(url).pathname, body: JSON.parse(init.body) });
    return ledger.get(name).fetch(url, init);
  } }) };
  const wire = stream ? "data: " + JSON.stringify({ type: "response.completed", response: terminal }) + String.fromCharCode(10, 10) : JSON.stringify(terminal);
  f.response = () => new Response(new ReadableStream({ start(c) {
    const bytes = new TextEncoder().encode(wire);
    for (let offset = 0; offset < bytes.length; offset += 7) c.enqueue(bytes.slice(offset, offset + 7));
    c.close();
  } }), { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
  const body = { input: [reasoning], tools: [{ type: tool }], stream, service_tier: "default", ...extra };
  const response = await f.request(body);
  assert.equal(response.status, 200); assert.equal(await f.consume(response), wire);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].body.input, body.input); assert.deepEqual(f.sent[0].body.tools, body.tools);
  assert.equal(f.events.length, 1);
  const event = f.events[0], amount = 1500 + (fee ?? 0);
  assert.deepEqual(event.hosted_tool_calls, { web_search: 1 }); assert.equal(event.hosted_tool_calls_complete, true);
  // An ordinary reasoning item is not a retained ToolParam inventory. The fee
  // comes only from this request's declared, versioned tariff and observed call.
  assert.equal(event.hosted_tool_cost_micros, fee);
  assert.equal(event.hosted_tool_pricing_ref, "openai-web-search-2026-10-20");
  assert.equal(event.actual_cost_micros, amount); assert.equal(event.cost_basis, "unpriced_usage");
  assert.doesNotMatch(JSON.stringify(event), /synthetic-private/);
  const charges = calls.filter(call => call.path === "/charge");
  assert.equal(charges.length, 2); assert.equal(new Set(charges.map(call => call.name)).size, 2);
  assert.equal(new Set(charges.map(call => call.body.chargeId)).size, 2);
  for (const charge of charges) {
    assert.equal(charge.body.amountMicros, amount);
    assert.deepEqual(ledger.get(charge.name).reservations().map(row => ({ id: row.reservation_id, amount: row.reserved_micros })), [{ id: charge.body.chargeId, amount }]);
    ledger.get(charge.name).restart();
    for (let replay = 0; replay < 2; replay++) await queue({ messages: [{ body: { kind: "budget_charge", ledger: { objectName: charge.name }, request: charge.body }, ack() {}, retry() { assert.fail("SQL charge replay must succeed"); } }] }, f.env);
    assert.equal(ledger.get(charge.name).reservations().reduce((sum, row) => sum + row.reserved_micros, 0), amount);
  }
  assert.ok(!calls.some(call => ["/reserve", "/settle", "/dispatch"].includes(call.path)));
}

for (const stream of [false, true]) for (const tool of ["web_search", "web_search_preview"]) test("ordinary encrypted reasoning pays its declared current-request tariff: " + tool + (stream ? " fragmented SSE" : " JSON"), async t => {
  await run(t, { stream, tool });
});

for (const [name, item] of [
  ["compaction", { type: "compaction", id: "cmp_tariff", encrypted_content: "synthetic-private-compaction" }],
  ["item_reference", { type: "item_reference", id: "item_tariff" }],
]) test("encrypted reasoning does not qualify an accompanying " + name + " tariff", async t => {
  await run(t, { extra: { input: [reasoning, item] }, fee: null });
});
