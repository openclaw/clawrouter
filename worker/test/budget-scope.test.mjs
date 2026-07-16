import assert from "node:assert/strict";
import test from "node:test";

import { reserveBudget, settleBudget } from "../accounting.ts";

const cost = { reserveMicros: 60, basis: "policy_fixed", inputTokens: null, outputTokens: null };

test("different principals have independent budget windows", async () => {
  const env = budgetEnv();
  await reserveBudget(env, auth("first@example.com", "first_key"), "llm.chat", cost);
  await assert.rejects(() => reserveBudget(env, auth("first@example.com", "first_key"), "llm.chat", cost), (error) => error?.status === 402);
  await assert.doesNotReject(() => reserveBudget(env, auth("second@example.com", "second_key"), "llm.chat", cost));
});

test("credentials sharing a principal share its budget window", async () => {
  const env = budgetEnv();
  await reserveBudget(env, auth("shared@example.com", "first_key"), "llm.chat", cost);
  await assert.rejects(() => reserveBudget(env, auth("shared@example.com", "second_key"), "llm.chat", cost), (error) => error?.status === 402);
});

test("credentials without a principal scope by credential id", async () => {
  const env = budgetEnv();
  await reserveBudget(env, auth(null, "first_key"), "llm.chat", cost);
  await assert.rejects(() => reserveBudget(env, auth(null, "first_key"), "llm.chat", cost), (error) => error?.status === 402);
  await assert.doesNotReject(() => reserveBudget(env, auth(null, "second_key"), "llm.chat", cost));
  assert.deepEqual(env.objectNames.slice(0, 4), ["tenant:maintainer_access:first_key", "tenant:maintainer_access:first_key", "tenant:maintainer_access:second_key"]);
});

test("reserve and settle use the same principal ledger without orphaning the reservation", async () => {
  const env = budgetEnv();
  const identity = auth("owner@example.com", "owner_key");
  const reservation = await reserveBudget(env, identity, "llm.chat", cost);
  await settleBudget(env, identity, reservation, 25);
  await assert.doesNotReject(() => reserveBudget(env, identity, "llm.chat", { ...cost, reserveMicros: 75 }));
  assert.equal(env.objectNames[0], "tenant:maintainer_access:owner@example.com");
  assert.equal(env.objectNames[1], env.objectNames[0]);
});

test("absent budgetScope preserves policy-wide object and window keys", async () => {
  const env = budgetEnv();
  await reserveBudget(env, auth("owner@example.com", "owner_key", null), "llm.chat", cost);
  const request = env.requests[0];
  const month = new Date().toISOString().slice(0, 7);
  assert.equal(env.objectNames[0], "tenant:maintainer_access");
  assert.equal(request.policyId, "tenant/maintainer_access");
  assert.equal(request.windowKey, `tenant/maintainer_access/${month}`);
});

function auth(principalId, credentialId, budgetScope = "principal") {
  return { credentialId, principalId, authType: "proxy_key", policyId: "maintainer_access", policy: policy(budgetScope), contentRetentionDisabled: false };
}

function policy(budgetScope) {
  return { tenantId: "tenant", monthlyBudgetMicros: 100, ...(budgetScope ? { budgetScope } : {}) };
}

function budgetEnv() {
  const ledgers = new Map(), objectNames = [], requests = [];
  const namespace = {
    idFromName: (name) => name,
    get(name) {
      objectNames.push(name);
      let ledger = ledgers.get(name);
      if (!ledger) { ledger = { reservations: new Map() }; ledgers.set(name, ledger); }
      return { fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === "/status") {
          const windowKey = new URL(url).searchParams.get("window_key");
          const limit = Number(new URL(url).searchParams.get("limit_micros"));
          const spent = [...ledger.reservations.values()].filter((item) => item.windowKey === windowKey).reduce((sum, item) => sum + item.costMicros, 0);
          return Response.json({ spentMicros: spent, remainingMicros: Math.max(0, limit - spent) });
        }
        const body = JSON.parse(init.body);
        if (path === "/reserve") {
          requests.push(body);
          const spent = [...ledger.reservations.values()].filter((item) => item.windowKey === body.windowKey).reduce((sum, item) => sum + item.costMicros, 0);
          if (body.costMicros > body.limitMicros - spent) return Response.json({ allowed: false, chargedMicros: 0 });
          ledger.reservations.set(body.reservationId, { windowKey: body.windowKey, costMicros: body.costMicros });
          return Response.json({ allowed: true, chargedMicros: body.costMicros });
        }
        const reservation = ledger.reservations.get(body.reservationId);
        if (reservation) reservation.costMicros = body.actualCostMicros;
        return Response.json({ settled: Boolean(reservation) });
      } };
    },
  };
  return { BUDGET_LEDGER: namespace, USAGE_QUEUE: { send: async () => {} }, objectNames, requests };
}
