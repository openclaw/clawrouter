import assert from "node:assert/strict";
import test from "node:test";

import { reserveBudget, settleBudget } from "../accounting.ts";

const cost = { reserveMicros: 60, basis: "policy_fixed", inputTokens: null, outputTokens: null };
const auth = {
  credentialId: "credential",
  principalId: "operator@example.com",
  authType: "proxy_key",
  policyId: "policy",
  policy: { tenantId: "tenant", monthlyBudgetMicros: 100 },
  contentRetentionDisabled: false,
};

test("provider denial returns provider_budget_exhausted and releases the policy reservation", async () => {
  const env = budgetEnv({ denyProvider: true });
  await assert.rejects(
    () => reserveBudget(env, auth, "llm.chat", cost, { providerId: "openai", enabled: true, monthlyBudgetMicros: 50 }),
    (error) => error?.status === 402 && error?.code === "provider_budget_exhausted" && /openai/.test(error.message),
  );
  assert.deepEqual(env.calls.map(({ name, path, body }) => ({ name, path, actualCostMicros: body.actualCostMicros })), [
    { name: "tenant:policy", path: "/reserve", actualCostMicros: undefined },
    { name: "provider:openai", path: "/reserve", actualCostMicros: undefined },
    { name: "tenant:policy", path: "/settle", actualCostMicros: 0 },
  ]);
});

test("successful accounting settles policy and provider ledgers to actual cost", async () => {
  const env = budgetEnv();
  const reservation = await reserveBudget(env, auth, "llm.chat", cost, { providerId: "openai", enabled: true, monthlyBudgetMicros: 100 });
  await settleBudget(env, auth, reservation, 25);
  const settlements = env.calls.filter((call) => call.path === "/settle");
  assert.deepEqual(settlements.map(({ name, body }) => [name, body.actualCostMicros]).sort(), [["provider:openai", 25], ["tenant:policy", 25]]);
  assert.equal(reservation.reservedMicros, 60);
  assert.equal(reservation.reservations.length, 2);
});

test("unmetered providers add no provider-ledger calls", async () => {
  const env = budgetEnv();
  await reserveBudget(env, auth, "llm.chat", cost, { providerId: "openai", enabled: true, monthlyBudgetMicros: null });
  assert.deepEqual(env.calls.map((call) => call.name), ["tenant:policy"]);
});

test("provider budgets fail closed on fallback pricing and skip zero-cost capabilities", async () => {
  const env = budgetEnv();
  const connection = { providerId: "openai", enabled: true, monthlyBudgetMicros: 100 };
  await assert.rejects(() => reserveBudget(env, { ...auth, policy: { tenantId: "tenant" } }, "llm.chat", { ...cost, basis: "flat_fallback" }, connection), (error) => error?.status === 400 && error?.code === "pricing_required");
  await reserveBudget(env, auth, "llm.count_tokens", { ...cost, reserveMicros: 0, basis: "none" }, connection);
  assert.equal(env.calls.length, 0);
});

function budgetEnv({ denyProvider = false } = {}) {
  const calls = [];
  const namespace = {
    idFromName: (name) => name,
    get: (name) => ({ fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body);
      calls.push({ name, path, body });
      if (path === "/reserve") return Response.json({ allowed: !(denyProvider && name.startsWith("provider:")), chargedMicros: body.costMicros });
      return Response.json({ settled: true });
    } }),
  };
  return { BUDGET_LEDGER: namespace, USAGE_QUEUE: { send: async () => {} }, calls };
}
