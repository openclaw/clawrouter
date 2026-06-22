import assert from "node:assert/strict";
import test from "node:test";
import { finalizeAccounting, settleBudget } from "../accounting.ts";

const auth = {
  credentialId: "credential",
  principalId: "user@example.com",
  authType: "proxy_key",
  policyId: "policy",
  policy: { enabled: true, generation: "v1", providers: [], tenantId: "tenant", retainRequestContent: true },
  contentRetentionDisabled: false,
};
const reservation = { reservationId: "reservation", reservedMicros: 100 };
const event = { id: "usage", type: "clawrouter.usage.v1", tenant_id: "tenant", policy_id: "policy" };

test("thrown ledger settlement queues a retry", async () => {
  const sent = [];
  const env = mockEnv(async (message) => { sent.push(message); });
  await settleBudget(env, auth, reservation, 42);
  assert.deepEqual(sent, [{ kind: "budget_settlement", tenant_id: "tenant", policy_id: "policy", request: { reservationId: "reservation", actualCostMicros: 42 } }]);
});

test("settlement retry failure does not suppress the usage event", async () => {
  const sent = [];
  const env = mockEnv(async (message) => {
    if (message.kind === "budget_settlement") throw new Error("queue settlement unavailable");
    sent.push(message);
  });
  const errors = [];
  const original = console.error;
  console.error = (...values) => errors.push(values.join(" "));
  try {
    await finalizeAccounting(env, auth, reservation, 42, event);
  } finally {
    console.error = original;
  }
  assert.deepEqual(sent, [event]);
  assert.match(errors.join("\n"), /queue settlement unavailable/);
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
