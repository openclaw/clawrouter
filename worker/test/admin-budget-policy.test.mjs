import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) return nextResolve(`${specifier}.ts`, context);
  return nextResolve(specifier, context);
} });

const { adminBudgetStatus, budgetPrincipalsByPolicy, normalizePolicy } = await import("../admin.ts");

test("policy normalization validates budgetScope and preserves generation", () => {
  const existing = policy({ generation: "policy_existing" });
  const updated = normalizePolicy({ providers: ["openai"], budgetScope: "principal" }, existing, true);
  assert.equal(updated.budgetScope, "principal");
  assert.equal(updated.generation, "policy_existing");
  assert.throws(() => normalizePolicy({ providers: ["openai"], budgetScope: "tenant" }, existing, true), (error) => error?.code === "invalid_policy" && error?.status === 400);
});

test("admin budget rows use the finite principals derived from loaded authority data", async () => {
  const credentials = [credential("owned_key", "owner@example.com"), credential("fallback_key", null)];
  const users = [{ email: "group@example.com", record: { groups: ["maintainers"] } }, { email: "unbound@example.com", record: { groups: [] } }];
  const bindings = [
    { policyId: "maintainer_access", principalType: "group", principalId: "maintainers", enabled: true, priority: 10 },
    { policyId: "maintainer_access", principalType: "user", principalId: "direct@example.com", enabled: true, priority: 20 },
    { policyId: "maintainer_access", principalType: "user", principalId: "disabled@example.com", enabled: false, priority: 30 },
  ];
  const principals = budgetPrincipalsByPolicy(credentials, users, bindings).get("maintainer_access");
  assert.deepEqual(principals, ["direct@example.com", "fallback_key", "group@example.com", "owner@example.com"]);
  const objectNames = [];
  const namespace = { idFromName: (name) => name, get: (name) => ({ fetch: async () => { objectNames.push(name); return Response.json({ spentMicros: 10, remainingMicros: 90 }); } }) };
  const status = await adminBudgetStatus({ BUDGET_LEDGER: namespace }, { policyId: "maintainer_access", policy: policy({ budgetScope: "principal" }) }, principals);
  assert.equal(status.ledger, "per_principal");
  assert.equal(status.spentMicros, null);
  assert.deepEqual(status.breakdown.map((row) => row.principal), principals);
  assert.deepEqual(objectNames.sort(), principals.map((principal) => `tenant:maintainer_access:${principal}`).sort());
});

function policy(overrides = {}) { return { enabled: true, generation: "policy_v1", providers: ["openai"], tenantId: "tenant", monthlyBudgetMicros: 100, retainRequestContent: true, ...overrides }; }
function credential(credentialId, principalId) { return { credentialId, credential: { enabled: true, policyId: "maintainer_access", policyGeneration: "policy_v1", principalId } }; }
