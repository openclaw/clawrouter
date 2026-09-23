import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import type { AccessPolicy, AccessRole, AdminBootstrapResponse, ProviderReadiness, UsageSnapshot } from "../src/ui-types";

for (const surface of ["Catalog", "Users"] as const) {
  test(`${surface} policy links respect cancelled discard and preserve the same dirty policy`, async ({ page }) => {
    const state = await open(page);
    await tenant(page).fill("keep-a");
    await page.getByRole("tab", { name: /^Bindings/ }).click();
    await page.getByRole("button", { name: surface, exact: true }).click();
    page.once("dialog", (dialog) => dialog.dismiss());
    await policyLink(page, "policy_b").click();
    await expect(page.getByRole("heading", { name: surface, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/dashboard/${surface.toLowerCase()}$`));

    await page.getByRole("button", { name: "Access", exact: true }).click();
    await expect(page.getByRole("tab", { name: /^Bindings/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /^Policies/ }).click();
    await expect(policyId(page)).toHaveValue("policy_a");
    await expect(tenant(page)).toHaveValue("keep-a");
    await page.getByRole("tab", { name: /^Bindings/ }).click();
    await page.getByRole("button", { name: surface, exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await policyLink(page, "policy_b").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: /^Policies/ })).toHaveAttribute("aria-selected", "true");
    await expect(policyId(page)).toHaveValue("policy_b");
    await expect(tenant(page)).toHaveValue("default");

    await tenant(page).fill("keep-b");
    await page.getByRole("button", { name: surface, exact: true }).click();
    let prompts = 0;
    page.on("dialog", async (dialog) => { prompts += 1; await dialog.dismiss(); });
    await policyLink(page, "policy_b").focus();
    await page.keyboard.press("Space");
    await expect(policyId(page)).toHaveValue("policy_b");
    await expect(tenant(page)).toHaveValue("keep-b");
    await expect(page.getByText("Unsaved policy changes.", { exact: true })).toBeVisible();
    expect(prompts).toBe(0);
    expect(state.writes).toEqual([]);
  });

  test(`${surface} navigation during a held save keeps the newly selected policy draft`, async ({ page }) => {
    const state = await open(page);
    await tenant(page).fill("submitted-a");
    await page.getByRole("button", { name: "Save policy", exact: true }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0].request().postDataJSON()).toMatchObject({ policyId: "policy_a", tenantId: "submitted-a" });
    await page.getByRole("button", { name: surface, exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await policyLink(page, "policy_b").click();
    await expect(policyId(page)).toHaveValue("policy_b");
    await tenant(page).fill("later-b");
    const canonical = { ...state.policies[0], tenantId: "canonical-a" };
    state.policies = [canonical, state.policies[1]];
    await state.writes[0].fulfill({ json: canonical });
    await expect.poll(() => state.bootstrapReads).toBeGreaterThan(1);
    await expect(page.getByRole("button", { name: "Save policy", exact: true })).toBeEnabled();
    await expect(policyId(page)).toHaveValue("policy_b");
    await expect(tenant(page)).toHaveValue("later-b");
    await expect(page.getByText("Unsaved policy changes.", { exact: true })).toBeVisible();
    await expect(page.locator(".tableRow").filter({ hasText: "policy_a" }).locator('[data-label="tenant"]')).toHaveText("canonical-a");
    expect(state.writes).toHaveLength(1);
  });
}

test("missing policy references and effective services are static while loaded policies remain keyboard actions", async ({ page }) => {
  const state = await open(page);
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  const missing = page.locator(".miniListItem").filter({ hasText: "missing_policy" });
  await expect(missing).toHaveCount(1);
  expect(await missing.evaluate((element) => (element as HTMLElement).tabIndex)).toBe(-1);
  await expect(page.locator(".miniList").getByRole("button")).toHaveCount(2);
  await policyLink(page, "policy_b").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Disable connection", exact: true })).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(page.locator(".miniList").getByRole("button")).toHaveCount(2);
  await expect(missing).toHaveCount(1);
  expect(await missing.evaluate((element) => (element as HTMLElement).tabIndex)).toBe(-1);
  const service = page.locator(".miniListItem").filter({ hasText: "Test provider" });
  await expect(service).toHaveCount(1);
  expect(await service.evaluate((element) => (element as HTMLElement).tabIndex)).toBe(-1);
  await policyLink(page, "policy_b").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Save user", exact: true })).toBeFocused();
  expect(state.writes).toEqual([]);
});

test("member Catalog policy references remain informational without editor access", async ({ page }) => {
  const state = await open(page, "user");
  const references = page.locator(".miniListItem");
  await expect(references).toHaveCount(3);
  await expect(page.locator(".miniList").getByRole("button")).toHaveCount(0);
  expect(await references.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).tabIndex))).toEqual([-1, -1, -1]);
  await expect(page.getByRole("button", { name: "Access", exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("demo Catalog opens its selected policy without discarding its dirty draft", async ({ page }) => {
  await page.route("**/v1/**", (route) => route.fulfill({ status: 503, json: { error: { message: "Demo fixture" } } }));
  await page.goto("/dashboard/access?demo=1");
  await expect(policyId(page)).toHaveValue("maintainer_models");
  await tenant(page).fill("demo-draft");
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page.locator(".tableRow").filter({ has: page.getByText("Anthropic", { exact: true }) }).click();
  await policyLink(page, "maintainer_models").focus();
  await page.keyboard.press("Enter");
  await expect(policyId(page)).toHaveValue("maintainer_models");
  await expect(tenant(page)).toHaveValue("demo-draft");
});

function tenant(page: Page) { return page.getByRole("textbox", { name: "tenant", exact: true }); }
function policyId(page: Page) { return page.getByRole("textbox", { name: "policy id", exact: true }); }
function policyLink(page: Page, id: string) { return page.locator(".inspector .miniList").getByRole("button", { name: new RegExp(`^${id}`) }); }

async function open(page: Page, role: AccessRole = "admin") {
  const state = {
    policies: ["policy_a", "policy_b"].map((policyId): AccessPolicy => ({
      policyId, enabled: true, providers: [], tenantId: "default", retainRequestContent: false,
      grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} },
    })),
    writes: [] as Route[], bootstrapReads: 0,
  };
  const provider = { id: "test-provider", display_name: "Test provider", class: "test", service_kind: "model_provider", capabilities: [] };
  const readiness: ProviderReadiness = {
    id: provider.id, displayName: provider.display_name, class: provider.class, serviceKind: provider.service_kind,
    requiredConfig: [], optionalConfig: [], missingConfig: [], configPresent: true, connectionEnabled: true,
    oauthGrantRequired: false, oauthGrantCount: 0, upstreamGrantCount: 0, openaiCompatible: false,
    manifestRoutes: 0, modelCount: 0, executable: false, verified: false, status: "declared", reasons: [],
  };
  const usage: UsageSnapshot = { ledger: "ready", summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 }, providers: [], daily: [], events: [] };
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      state.writes.push(route);
      if (route.request().method() === "PUT" && path.startsWith("/v1/admin/policies/")) return;
      await route.fulfill({ status: 405, json: { error: "Unexpected mutation" } });
      return;
    }
    const bootstrap: AdminBootstrapResponse = {
      policies: state.policies, credentials: [], connections: [], grants: [], rules: [], providers: [readiness], tenants: [],
      users: [{ email: "operator@example.com", role: "user", tenantId: "default", enabled: true, groups: [], contentRetentionDisabled: false }],
      bindings: ["policy_a", "policy_b", "missing_policy"].map((policyId, index) => ({ policyId, principalType: "user", principalId: "operator@example.com", enabled: true, priority: index * 10 })),
      overview: { policiesTotal: 2, policiesActive: 2, tenantsTotal: 1, keysTotal: 0, keysActive: 0, providerCount: 1, openaiCompatibleProviders: 0, manifestRoutes: 0, monthlyBudgetMicros: 0, requestCostMicros: 0 },
      fusion: { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "", adviserTimeoutMs: 10_000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 },
    };
    if (path === "/v1/admin/bootstrap") state.bootstrapReads += 1;
    const responses: Record<string, unknown> = {
      "/v1/providers": { providers: [provider] }, "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role, email: "operator@example.com", tenantId: "default", entitlements: { providers: [{ provider: provider.id, displayName: provider.display_name, serviceKind: provider.service_kind, allowed: true, policies: ["policy_a", "policy_b", "missing_policy"], readiness }] } },
      "/v1/session/credentials": { credentials: [] }, "/v1/session/usage": { policies: [], usage }, "/v1/admin/bootstrap": bootstrap,
      "/v1/admin/usage": { policies: state.policies.map((policy) => ({ ...policy, kid: policy.policyId, tenantId: "default", budget: { configured: false, ledger: "ready", limitMicros: null, spentMicros: 0, remainingMicros: null } })), usage },
    };
    await route.fulfill({ status: responses[path] ? 200 : 404, json: responses[path] ?? {} });
  });
  await page.goto(role === "admin" ? "/dashboard/access" : "/dashboard/catalog");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  if (role === "admin") await expect(policyId(page)).toHaveValue("policy_a");
  else await expect(page.locator(".tableRow .entityTitle")).toHaveText(["Test provider"]);
  return state;
}
