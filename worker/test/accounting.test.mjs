import assert from "node:assert/strict";
import test from "node:test";
import { finalizeAccounting, reserveBudget, settleBudget } from "../accounting.ts";
import { queue } from "../ledgers.ts";

const reservation = {
  reservations: [{ reservationId: "reservation", objectName: "tenant:policy" }],
  reservedMicros: 100,
};
const event = { id: "usage", type: "clawrouter.usage.v1", tenant_id: "tenant", policy_id: "policy", request_id: "request-safe" };

test("thrown ledger settlement queues a retry", async () => {
  for (const objectName of ["tenant:policy", "tenant:policy:user@example.com", "provider:openai"]) {
    const sent = [], destinations = [];
    let available = false, acknowledged = false;
    const env = mockEnv(async message => { sent.push(message); });
    env.BUDGET_LEDGER.get = name => ({ fetch: async (_url, init) => {
      destinations.push(name);
      assert.deepEqual(JSON.parse(init.body), { reservationId: "reservation", actualCostMicros: 42 });
      if (!available) throw new Error("synthetic outage");
      return new Response("settled");
    } });
    await settleBudget(env, { ...reservation, reservations: [{ reservationId: "reservation", objectName }] }, 42);
    assert.deepEqual(sent, [{ kind: "budget_settlement", ledger: { objectName }, request: { reservationId: "reservation", actualCostMicros: 42 } }]);
    available = true;
    await queue({ messages: [{ body: sent[0], ack() { acknowledged = true; }, retry() { assert.fail("settlement should succeed"); } }] }, env);
    assert.equal(acknowledged, true);
    assert.deepEqual(destinations, [objectName, objectName]);
  }
});

test("settlement retry failure does not suppress the usage event", async () => {
  const sent = [];
  const env = mockEnv(async (message) => {
    if (message.kind === "budget_settlement") throw new Error("queue settlement unavailable");
    sent.push(message);
  });
  const errors = [];
  const original = console.error;
  console.error = (...values) => errors.push(JSON.stringify(values));
  try {
    assert.equal(await finalizeAccounting(env, reservation, 42, event), false);
  } finally {
    console.error = original;
  }
  assert.deepEqual(sent, [event]);
  assert.match(errors.join("\n"), /accounting finalization failed/);
  assert.match(errors.join("\n"), /request-safe/);
  assert.doesNotMatch(errors.join("\n"), /queue settlement unavailable/);
});

test("finalization reports durable recovery success and independent usage publication failure", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const usageFails of [false, true]) {
    const sent = [];
    const env = mockEnv(async (message) => {
      if (usageFails && message.type === "clawrouter.usage.v1") throw new Error("usage unavailable");
      sent.push(message);
    });
    assert.equal(await finalizeAccounting(env, reservation, 42, event), !usageFails);
    assert.ok(sent.some((message) => message.kind === "budget_settlement"));
    assert.equal(sent.includes(event), !usageFails);
  }
});

test("provider admission denial preserves queued rollback but surfaces exhausted rollback", async () => {
  for (const recovered of [true, false]) {
    const queued = [];
    const env = mockEnv(async (message) => { if (!recovered) throw new Error("fixture queue outage"); queued.push(message); });
    env.BUDGET_LEDGER.get = (name) => ({ fetch: async (url) => {
      if (new URL(url).pathname === "/reserve") return Response.json({ allowed: !name.startsWith("provider:"), chargedMicros: 1 });
      return new Response("fixture ledger outage", { status: 503 });
    } });
    const auth = { policyId: "fixture", policy: { monthlyBudgetMicros: 100, tenantId: "default", budgetScope: "policy" } };
    await assert.rejects(reserveBudget(env, auth, "llm.responses", { reserveMicros: 1, basis: "manifest_pricing" }, { providerId: "openai", monthlyBudgetMicros: 100 }), (error) => error.code === (recovered ? "provider_budget_exhausted" : "accounting_unavailable"));
    assert.equal(queued.length, recovered ? 1 : 0);
    if (recovered) assert.equal(queued[0].request.actualCostMicros, 0);
  }
});

function mockEnv(send) {
  return {
    BUDGET_LEDGER: {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => { throw new Error("ledger unavailable"); } }),
    },
    USAGE_QUEUE: { send },
  };
}
