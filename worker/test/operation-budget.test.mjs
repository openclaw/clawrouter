import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { operationAffordability } = await import("../operation-budget.ts");
import { providerById } from "../providers.ts";

const base = { credentialId: "fixture", principalId: "fixture@example.com", policyId: "policy", authType: "proxy_key", policy: { monthlyBudgetMicros: 100, requestCostMicros: null }, contentRetentionDisabled: true };
const connection = { providerId: "openai", enabled: true, monthlyBudgetMicros: 100 };
const priced = providerById("openai").models.find(({ id }) => id === "openai/gpt-6-astra");
const zero = providerById("local-openai").models[0];
const observation = { policyRemaining: 0, providerRemaining: 0 };

test("affordability preserves free requests at exhausted positive limits", () => {
  assert.deepEqual(operationAffordability(base, connection, zero, "llm.chat", observation), { status: "exact-covered" });
  assert.deepEqual(operationAffordability(base, connection, priced, "llm.count_tokens", observation), { status: "exact-covered" });
  assert.deepEqual(operationAffordability({ ...base, policy: { ...base.policy, requestCostMicros: 0 } }, connection, null, "llm.chat", observation), { status: "exact-covered" });
  assert.deepEqual(operationAffordability(base, connection, priced, "llm.chat", observation), { status: "exact-blocked", reasonCode: "budget_exhausted" });
});

test("fixed tariffs compare the actual selected policy and provider balances", () => {
  const auth = { ...base, policy: { ...base.policy, requestCostMicros: 20 } };
  assert.deepEqual(operationAffordability(auth, connection, null, "llm.chat", { policyRemaining: 20, providerRemaining: 19 }), { status: "exact-blocked", reasonCode: "provider_budget_exhausted" });
  assert.deepEqual(operationAffordability(auth, connection, null, "llm.chat", { policyRemaining: 19, providerRemaining: 100 }), { status: "exact-blocked", reasonCode: "budget_exhausted" });
  assert.deepEqual(operationAffordability(auth, connection, null, "llm.chat", { policyRemaining: 20, providerRemaining: 20 }), { status: "exact-covered" });
  assert.deepEqual(operationAffordability(auth, connection, null, "llm.chat", { policyRemaining: null, providerRemaining: 20 }), { status: "request-dependent", reasonCode: "budget_status_unavailable" });
});

test("variable prices never use a default request estimate as a universal budget decision", () => {
  assert.equal(operationAffordability(base, connection, priced, "llm.chat", { policyRemaining: 1, providerRemaining: 1 }).status, "request-dependent");
  const outputOnly = { ...zero, pricing: { ...zero.pricing, outputMicrosPerMillion: 1_000_000 } };
  assert.equal(operationAffordability(base, connection, outputOnly, "llm.chat", observation).status, "request-dependent");
  const paidLongContext = { ...zero, pricing: { ...zero.pricing, longContext: { ...zero.pricing, thresholdInputTokens: 100, inputMicrosPerMillion: 1_000_000 } } };
  assert.equal(operationAffordability(base, connection, paidLongContext, "llm.chat", observation).status, "request-dependent");
  const paidCache = { ...zero, pricing: { ...zero.pricing, cacheWrite1hInputMicrosPerMillion: 1_000_000 } };
  assert.equal(operationAffordability(base, connection, paidCache, "llm.chat", observation).status, "request-dependent");
});

test("pricing and zero-limit guards agree with mandatory reservation admission", () => {
  assert.deepEqual(operationAffordability(base, connection, null, "llm.chat", observation), { status: "exact-blocked", reasonCode: "pricing_required" });
  for (const [auth, provider, reasonCode] of [
    [{ ...base, policy: { monthlyBudgetMicros: 0, requestCostMicros: 0 } }, connection, "budget_exhausted"],
    [base, { ...connection, monthlyBudgetMicros: 0 }, "provider_budget_exhausted"],
  ]) assert.deepEqual(operationAffordability(auth, provider, zero, "llm.chat", observation), { status: "exact-blocked", reasonCode });
  const noPrincipal = { ...base, credentialId: null, principalId: null, policy: { ...base.policy, budgetScope: "principal" } };
  assert.deepEqual(operationAffordability(noPrincipal, connection, priced, "llm.chat", observation), { status: "exact-blocked", reasonCode: "principal_required" });
});
