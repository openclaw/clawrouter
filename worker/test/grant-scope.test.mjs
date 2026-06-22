import assert from "node:assert/strict";
import test from "node:test";
import { grantsVisibleToPolicies } from "../grant-scope.ts";

const policies = [
  { policyId: "policy_a", policy: { tenantId: "tenant_a" } },
  { policyId: "policy_b", policy: { tenantId: "tenant_b" } },
];
const grants = [
  { key: "oauth/policy_a/openai", grant: { provider: "openai" } },
  { key: "oauth/tenants/tenant_b/anthropic", grant: { provider: "anthropic" } },
  { key: "oauth/policy_other/openai", grant: { provider: "openai" } },
  { key: "oauth/tenants/tenant_other/openai", grant: { provider: "openai" } },
];

test("readiness grants are limited to the current policies and tenants", () => {
  assert.deepEqual(grantsVisibleToPolicies(grants, policies), grants.slice(0, 2));
});

test("similarly prefixed policy and tenant ids do not cross scope", () => {
  const visible = grantsVisibleToPolicies([
    { key: "oauth/policy_a_extra/openai", grant: { provider: "openai" } },
    { key: "oauth/tenants/tenant_a_extra/openai", grant: { provider: "openai" } },
  ], policies.slice(0, 1));
  assert.deepEqual(visible, []);
});
