import assert from "node:assert/strict";
import test from "node:test";
import { applyBudgetMode, budgetModePlan, budgetModeRequests, effectiveBudgetMode } from "../scripts/policy-budget-mode.mjs";

const policies = [
  { policyId: "hard", enabled: true, providers: ["openai"], tenantId: "acme", monthlyBudgetMicros: 100, budgetMode: "reserve", grantRouting: { strategy: "priority" } },
  { policyId: "legacy", enabled: true, providers: [], tenantId: "default", weeklyBudgetMicros: 5 },
  { policyId: "fast", enabled: true, providers: ["anthropic"], budgetMode: "soft" },
];

test("plan requires an explicit target and a valid mode", () => {
  assert.throws(() => budgetModePlan([]), /--policy ID or --all/);
  assert.throws(() => budgetModePlan(["--all", "--policy", "hard"]), /--policy ID or --all/);
  assert.throws(() => budgetModePlan(["--all", "--mode", "fast"]), /soft or reserve/);
  assert.throws(() => budgetModePlan(["--policy", "bad id"]), /invalid --policy/);
  assert.deepEqual(budgetModePlan(["--policy", "hard", "--policy", "hard"]), { mode: "soft", policies: ["hard"], all: false, apply: false });
});

test("requests rewrite only budgetMode, treat an omitted mode as reserve, and skip policies already in the mode", () => {
  assert.equal(effectiveBudgetMode(policies[1]), "reserve");
  const requests = budgetModeRequests(budgetModePlan(["--all"]), policies);
  assert.deepEqual(requests.map(request => request.path), ["/v1/admin/policies/hard", "/v1/admin/policies/legacy"]);
  assert.deepEqual(requests[0].body, { ...policies[0], budgetMode: "soft" });
  assert.deepEqual(requests[1].body, { ...policies[1], allProviders: true, budgetMode: "soft" }, "wildcard scope stays explicit");
  assert.deepEqual(budgetModeRequests(budgetModePlan(["--all", "--mode", "reserve"]), policies).map(request => request.policy.policyId), ["fast"]);
  assert.throws(() => budgetModeRequests(budgetModePlan(["--policy", "missing"]), policies), /policy not found/);
});

test("dry run reads only; apply writes each changed policy once", async () => {
  const env = { CLAWROUTER_BASE_URL: "https://router.example", CLAWROUTER_ADMIN_TOKEN: "synthetic-admin" };
  for (const apply of [false, true]) {
    const calls = [], logs = [];
    const fetchImpl = async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      assert.equal(init.headers.authorization, "Bearer synthetic-admin");
      return init.method === "GET" ? Response.json({ policies }) : Response.json({ ok: true });
    };
    await applyBudgetMode(["--", "--policy", "hard", "--policy", "fast", ...(apply ? ["--apply"] : [])], { env, fetchImpl, log: line => logs.push(line) });
    assert.deepEqual(calls, apply ? ["GET /v1/admin/policies", "PUT /v1/admin/policies/hard"] : ["GET /v1/admin/policies"]);
    assert.ok(logs.some(line => line.includes("hard reserve -> soft (monthly=100; tenant acme)")));
    assert.ok(!logs.join("\n").includes("synthetic-admin"), "the admin token is never logged");
  }
});
