import assert from "node:assert/strict";
import test from "node:test";
import { queue } from "../ledgers.ts";

test("usage delivery targets its policy shard and acknowledges success", async () => {
  const calls = [], message = queueMessage(usageEvent());
  await queue({ messages: [message] }, mockEnv(calls, new Response("accepted")));
  assert.deepEqual(calls.map((call) => call.name), ["policy:tenant:policy"]);
  assert.equal(message.ackCount, 1);
  assert.equal(message.retryCount, 0);
});

test("non-2xx usage and settlement writes retry instead of being acknowledged", async () => {
  for (const body of [usageEvent(), { kind: "budget_settlement", tenant_id: "tenant", policy_id: "policy", request: { reservationId: "r1", actualCostMicros: 2 } }]) {
    const message = queueMessage(body);
    await queue({ messages: [message] }, mockEnv([], new Response("failed", { status: 503 })));
    assert.equal(message.ackCount, 0);
    assert.equal(message.retryCount, 1);
  }
});

function usageEvent() { return { id: "usage", type: "clawrouter.usage.v1", tenant_id: "tenant", policy_id: "policy" }; }
function queueMessage(body) {
  return { body, ackCount: 0, retryCount: 0, ack() { this.ackCount += 1; }, retry() { this.retryCount += 1; } };
}
function mockEnv(calls, response) {
  const namespace = { idFromName: (name) => name, get: (name) => ({ fetch: async (url) => { calls.push({ name, url }); return response.clone(); } }) };
  return { USAGE_LEDGER: namespace, BUDGET_LEDGER: namespace };
}
