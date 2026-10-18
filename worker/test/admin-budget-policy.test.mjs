import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";


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

test("weekly-only principal policies expose balances in their weekly administrator breakdown", async () => {
  const windows = [];
  const namespace = { idFromName: name => name, get: name => ({ fetch: async url => {
    windows.push([name, new URL(url).searchParams.get("window_key")]);
    return Response.json({ spentMicros: 20, remainingMicros: 80 });
  } }) };
  for (const dailyBudgetMicros of [null, 200]) {
    windows.length = 0;
    const status = await adminBudgetStatus({ BUDGET_LEDGER: namespace }, { policyId: "member_weekly", policy: policy({ monthlyBudgetMicros: null, dailyBudgetMicros, weeklyBudgetMicros: 100, budgetScope: "principal" }) }, ["one@example.com", "two@example.com"]);
    assert.equal(status.weekly.ledger, "per_principal");
    assert.deepEqual(status.weekly.breakdown.map(row => [row.principal, row.spentMicros, row.remainingMicros]), [["one@example.com", 20, 80], ["two@example.com", 20, 80]]);
    assert.equal(status.breakdown[0].weekly.spentMicros, 20);
    assert.equal(windows.filter(([, key]) => key.includes("/week/")).length, 2);
  }
});

function policy(overrides = {}) { return { enabled: true, generation: "policy_v1", providers: ["openai"], tenantId: "tenant", monthlyBudgetMicros: 100, retainRequestContent: true, ...overrides }; }
function credential(credentialId, principalId) { return { credentialId, credential: { enabled: true, policyId: "maintainer_access", policyGeneration: "policy_v1", principalId } }; }

test("policy model scopes validate known IDs, bound input, deduplicate and preserve defaults", () => {
  const base = { providers: ["anthropic"] }, id = "anthropic/claude-opus-5-5";
  assert.equal(normalizePolicy(base, undefined, false).models, null);
  assert.equal(normalizePolicy(base, undefined, false).poolStatus, "hidden");
  const selected = normalizePolicy({ ...base, models: [id, id], poolStatus: "visible" }, undefined, false);
  assert.deepEqual(selected.models, [id]); assert.equal(selected.poolStatus, "visible");
  assert.deepEqual(normalizePolicy(base, selected, false).models, [id]);
  assert.equal(normalizePolicy({ ...base, models: null }, selected, false).models, null);
  assert.deepEqual(normalizePolicy({ ...base, models: [] }, undefined, false).models, []);
  for (const models of [["anthropic/unknown"], [42], "all", Array(1025).fill(id)]) assert.throws(() => normalizePolicy({ ...base, models }, undefined, false), { code: "invalid_policy" });
  assert.throws(() => normalizePolicy({ ...base, poolStatus: "public" }, undefined, false), { code: "invalid_policy" });
});
