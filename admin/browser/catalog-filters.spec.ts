import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AccessRole, AdminBootstrapResponse, ProviderReadiness, ProviderRow, UsageSnapshot } from "../src/ui-types";

for (const role of ["admin", "user"] as const) {
  test(`${role} can filter Catalog by keyboard without losing search or service selection`, async ({ page }) => {
    const writes = await openCatalog(page, role);
    const filters = page.getByRole("group", { name: "service kind", exact: true });
    const search = page.getByRole("textbox", { name: "search catalog", exact: true });
    const all = filters.getByRole("button", { name: /^all/ });
    const model = filters.getByRole("button", { name: /^model/ });
    const searchKind = filters.getByRole("button", { name: /^search/ });
    const titles = page.locator(".tableRow .entityTitle");
    await expectFilters(filters, "all", ["3", "2", "1"]);
    await page.locator(".tableRow").filter({ hasText: "Beta models" }).click();

    await search.fill("models");
    await expect(titles).toHaveText(["Alpha models", "Beta models"]);
    await expectFilters(filters, "all", ["2", "2", "0"]);
    await page.keyboard.press("Tab");
    await expect(all).toBeFocused();
    await page.keyboard.press("Space");
    await expectFilters(filters, "all", ["2", "2", "0"]);
    await page.keyboard.press("Tab");
    await expect(model).toBeFocused();
    await expect(all).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Enter");
    await expectFilters(filters, "model", ["2", "2", "0"]);
    await expect(titles).toHaveText(["Alpha models", "Beta models"]);

    await page.keyboard.press("Tab");
    await expect(searchKind).toBeFocused();
    await expect(model).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Space");
    await expectFilters(filters, "search", ["2", "2", "0"]);
    await expect(titles).toHaveCount(0);
    await expect(search).toHaveValue("models");
    await expect(page.locator(".inspectorHeader h2")).toHaveText("Beta models");

    await search.fill("");
    await expectFilters(filters, "search", ["3", "2", "1"]);
    await expect(titles).toHaveText(["Gamma search"]);
    await page.keyboard.press("Tab");
    await expect(all).toBeFocused();
    await page.keyboard.press("Enter");
    await expectFilters(filters, "all", ["3", "2", "1"]);
    await expect(titles).toHaveText(["Alpha models", "Beta models", "Gamma search"]);
    await expect(page.locator(".tableRow.selected .entityTitle")).toHaveText("Beta models");
    expect(writes).toEqual([]);
  });

  test(`${role} Catalog is WCAG AA clean with a service-kind filter group`, async ({ page }) => {
    await openCatalog(page, role);
    await expect(page.getByRole("group", { name: "service kind", exact: true })).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(result.violations).toEqual([]);
  });
}

async function expectFilters(filters: Locator, active: string, counts: string[]) {
  await expect(filters.getByRole("button", { pressed: true })).toHaveCount(1);
  await expect(filters.getByRole("button", { pressed: false })).toHaveCount(2);
  await expect(filters.getByRole("button", { name: new RegExp(`^${active}`) })).toHaveAttribute("aria-pressed", "true");
  await expect(filters.locator("button > span")).toHaveText(counts);
}

async function openCatalog(page: Page, role: AccessRole) {
  const writes: string[] = [];
  const providers: ProviderRow[] = [
    { id: "alpha-model", display_name: "Alpha models", class: "test", service_kind: "model_provider", capabilities: [] },
    { id: "beta-model", display_name: "Beta models", class: "test", service_kind: "model_provider", capabilities: [] },
    { id: "gamma-search", display_name: "Gamma search", class: "test", service_kind: "search", capabilities: [] },
  ];
  const readiness: ProviderReadiness[] = providers.map((provider) => ({
    id: provider.id, displayName: provider.display_name, class: provider.class, serviceKind: provider.service_kind,
    requiredConfig: [], optionalConfig: [], missingConfig: [], configPresent: true, connectionEnabled: true,
    oauthGrantRequired: false, oauthGrantCount: 0, upstreamGrantCount: 0, openaiCompatible: false,
    manifestRoutes: 0, modelCount: 0, executable: false, verified: false, status: "declared", reasons: [],
  }));
  const usage: UsageSnapshot = {
    ledger: "ready", summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 },
    providers: [], daily: [], events: [],
  };
  const bootstrap: AdminBootstrapResponse = {
    policies: [], credentials: [], connections: [], users: [], bindings: [], providers: readiness, grants: [], rules: [], tenants: [],
    overview: { policiesTotal: 0, policiesActive: 0, tenantsTotal: 0, keysTotal: 0, keysActive: 0, providerCount: 3, openaiCompatibleProviders: 0, manifestRoutes: 0, monthlyBudgetMicros: 0, requestCostMicros: 0 },
    fusion: { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "", adviserTimeoutMs: 10_000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 },
  };
  const responses: Record<string, unknown> = {
    "/v1/providers": { providers },
    "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
    "/v1/session": {
      authenticated: true, auth: "cloudflare_access", role, email: "operator@example.com", tenantId: "default",
      entitlements: { providers: readiness.map((item) => ({ provider: item.id, displayName: item.displayName, serviceKind: item.serviceKind, allowed: false, policies: [], readiness: item })) },
    },
    "/v1/session/credentials": { credentials: [] },
    "/v1/session/usage": { policies: [], usage },
    "/v1/admin/bootstrap": bootstrap,
  };
  await page.route("**/v1/**", async (route) => {
    if (route.request().method() !== "GET") {
      writes.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      await route.fulfill({ status: 405, json: { error: "Unexpected mutation" } });
      return;
    }
    const body = responses[new URL(route.request().url()).pathname];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  await page.goto("/dashboard/catalog");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(page.locator(".tableRow .entityTitle")).toHaveText(["Alpha models", "Beta models", "Gamma search"]);
  return writes;
}
