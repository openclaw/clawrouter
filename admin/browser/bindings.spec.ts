import { expect, test, type Page } from "@playwright/test";
import type { AccessPolicy, AdminBootstrapResponse, PolicyBinding } from "../src/ui-types";

test("selecting another policy preserves the existing binding target and draft", async ({ page }) => {
  const writes = await openAccess(page);
  await page.getByRole("tab", { name: /^Bindings/ }).click();
  await page.locator(".tableRow").filter({ hasText: "maintainers" }).click();
  await page.getByRole("textbox", { name: "priority", exact: true }).fill("7");

  await selectPolicyA(page);
  await page.getByRole("tab", { name: /^Bindings/ }).click();
  await expect(page.getByRole("combobox", { name: "policy", exact: true })).toHaveValue("policy_b");
  await expect(page.getByRole("combobox", { name: "policy", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "priority", exact: true })).toHaveValue("7");
  await page.getByRole("button", { name: "Save binding", exact: true }).click();

  await expect.poll(() => writes).toEqual([{ policyId: "policy_b", principalType: "group", principalId: "maintainers", enabled: true, priority: 7 }]);
  await expect(page.locator(".tableRow.selected").filter({ hasText: "maintainers" }).locator('[data-label="priority"]')).toHaveText("7");
  await expect(page.getByRole("combobox", { name: "policy", exact: true })).toHaveValue("policy_b");
});

test("an explicit new binding defaults to the selected policy", async ({ page }) => {
  const writes = await openAccess(page);
  await selectPolicyA(page);
  await page.getByRole("tab", { name: /^Bindings/ }).click();
  await page.getByRole("button", { name: "New binding", exact: true }).click();

  await expect(page.getByRole("combobox", { name: "policy", exact: true })).toHaveValue("policy_a");
  await expect(page.getByRole("combobox", { name: "policy", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "principal", exact: true }).fill("new-team");
  await page.getByRole("button", { name: "Save binding", exact: true }).click();

  await expect.poll(() => writes).toEqual([{ policyId: "policy_a", principalType: "group", principalId: "new-team", enabled: true, priority: 100 }]);
  await expect(page.locator(".tableRow.selected").filter({ hasText: "new-team" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "policy", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "policy", exact: true })).toHaveValue("policy_a");
});

async function selectPolicyA(page: Page) {
  await page.getByRole("tab", { name: /^Policies/ }).click();
  await page.locator(".tableRow").filter({ hasText: "policy_a" }).click();
  await expect(page.getByRole("textbox", { name: "policy id", exact: true })).toHaveValue("policy_a");
}

async function openAccess(page: Page) {
  const writes: PolicyBinding[] = [];
  const policies: AccessPolicy[] = ["policy_b", "policy_a"].map((policyId) => ({
    policyId, enabled: true, providers: [], tenantId: "default", monthlyBudgetMicros: null, budgetScope: "policy", retainRequestContent: false,
    grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} },
  }));
  const bootstrap: AdminBootstrapResponse = {
    policies, credentials: [], connections: [], users: [], grants: [], rules: [], providers: [], tenants: [],
    bindings: [{ policyId: "policy_b", principalType: "group", principalId: "maintainers", enabled: true, priority: 100 }],
    overview: { policiesTotal: 2, policiesActive: 2, tenantsTotal: 1, keysTotal: 0, keysActive: 0, providerCount: 0, openaiCompatibleProviders: 0, manifestRoutes: 0, monthlyBudgetMicros: 0, requestCostMicros: 0 },
    fusion: { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "", adviserTimeoutMs: 10_000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 },
  };
  const responses: Record<string, unknown> = {
    "/v1/providers": { providers: [] },
    "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
    "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: "admin@example.com", tenantId: "default", entitlements: { providers: [] } },
    "/v1/session/usage": { policies: [] },
    "/v1/session/credentials": { credentials: [] },
    "/v1/admin/bootstrap": bootstrap,
  };
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "PUT") {
      expect(path).toBe("/v1/admin/policy-bindings");
      const binding = route.request().postDataJSON() as PolicyBinding;
      writes.push(binding);
      bootstrap.bindings = [...bootstrap.bindings.filter((item) => item.policyId !== binding.policyId || item.principalType !== binding.principalType || item.principalId !== binding.principalId), binding];
      await route.fulfill({ json: binding });
      return;
    }
    const body = responses[path];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  await page.goto("/dashboard/access");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  return writes;
}
