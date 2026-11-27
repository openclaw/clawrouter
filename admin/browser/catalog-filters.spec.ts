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
    await expect(page.locator(".inspectorHeader")).toContainText("outside current filters");

    await search.fill("");
    await expectFilters(filters, "search", ["3", "2", "1"]);
    await expect(titles).toHaveText(["Gamma search"]);
    await page.keyboard.press("Tab");
    await expect(all).toBeFocused();
    await page.keyboard.press("Enter");
    await expectFilters(filters, "all", ["3", "2", "1"]);
    await expect(titles).toHaveText(["Alpha models", "Beta models", "Gamma search"]);
    await expect(page.locator(".tableRow.selected .entityTitle")).toHaveText("Beta models");
    await expect(page.locator(".inspectorHeader")).not.toContainText("outside current filters");
    expect(writes).toEqual([]);
  });

  test(`${role} Catalog opens the matching service in Playground before a row is explicitly selected`, async ({ page }) => {
    const writes = await openCatalog(page, role);
    const search = page.getByRole("textbox", { name: "search catalog", exact: true });
    const play = page.getByRole("button", { name: "Try in playground", exact: true });
    await expect(page.locator(".outcomeCallout")).toContainText("denied");
    await expect(play).toBeDisabled();

    await search.fill("Gamma");
    await expect(page.locator(".tableRow .entityTitle")).toHaveText(["Gamma search"]);
    await expect(page.locator(".tableRow.selected .entityTitle")).toHaveText("Gamma search");
    await expect(page.locator(".inspectorHeader h2")).toHaveText("Gamma search");
    await expect(page.locator(".catalogMeta strong")).toHaveText("1 service");
    await expect(page.locator(".catalogMeta span")).toHaveText("1 usable · 1 granted · 0 blocked");
    await expect(play).toBeEnabled();
    await play.press("Enter");
    await expect(page).toHaveURL(/\/dashboard\/playground$/);
    await expect(page.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue("gamma-search");
    await expect(page.getByRole("textbox", { name: "JSON request body", exact: true })).toBeVisible();

    await page.getByRole("navigation", { name: "console" }).getByRole("button", { name: "Catalog", exact: true }).click();
    await search.fill("Beta");
    await expect(page.locator(".inspectorHeader h2")).toHaveText("Beta models");
    await expect(play).toBeDisabled();
    await expect(page.locator(".outcomeCallout")).toContainText("The provider connection is disabled.");
    await expect(page.locator(".catalogMeta span")).toHaveText("0 usable · 1 granted · 1 blocked");
    const searchTop = () => search.evaluate((input) => Math.round(input.getBoundingClientRect().top + window.scrollY));
    const beforeEmpty = await searchTop();
    await search.fill("no such service");
    await expect(page.locator(".tableRow")).toHaveCount(0);
    await expect(play).toHaveCount(0);
    await expect(page.locator(".catalogMeta span")).toHaveText("0 usable · 0 granted · 0 blocked");
    await expect(page.locator(".mainPane")).toContainText("No matching services");
    expect(await searchTop()).toBe(beforeEmpty);
    expect(writes).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`${role} Catalog is WCAG AA clean with a service-kind filter group in ${theme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await openCatalog(page, role);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("group", { name: "service kind", exact: true })).toBeVisible();
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(result.violations).toEqual([]);
    });
  }
}

test("member recovers from a kind miss or a text miss without losing the other filter or pinned service", async ({ page, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 760 });
  const writes = await openCatalog(page, "user");
  const filters = page.getByRole("group", { name: "service kind" });
  const all = filters.getByRole("button", { name: /^all/ });
  const searchKind = filters.getByRole("button", { name: /^search/ });
  const search = page.getByRole("textbox", { name: "search catalog" });
  const empty = page.locator(".catalogPane .emptyTable");
  const rows = page.locator(".tableRow .entityTitle");
  const inspector = page.locator(".inspectorHeader");

  await page.locator(".tableRow").filter({ hasText: "Beta models" }).click();
  await searchKind.click();
  await search.fill("models");
  await expect(empty.getByRole("button", { name: "Show 2 matches across all kinds" })).toBeVisible();
  await search.fill("Alpha");
  await expect(empty).toContainText("No matching services in this kind.");
  const showAll = empty.getByRole("button", { name: "Show 1 match across all kinds", exact: true });
  await searchKind.focus();
  await page.keyboard.press("Tab");
  await expect(showAll).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(all).toBeFocused();
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(search).toHaveValue("Alpha");
  await expect(rows).toHaveText(["Alpha models"]);
  await expect(page.locator(".catalogMeta span")).toHaveText("0 usable · 0 granted · 1 blocked");
  await expect(inspector).toContainText("Beta models");
  await expect(inspector).toContainText("outside current filters");

  await searchKind.click();
  await search.fill("no such service");
  await expect(empty).toContainText("No matching services in any kind.");
  await expect(showAll).toHaveCount(0);
  const clear = empty.getByRole("button", { name: "Clear search", exact: true });
  await searchKind.focus();
  await page.keyboard.press("Tab");
  await expect(clear).toBeFocused();
  await page.keyboard.press("Space");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(searchKind).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveText(["Gamma search"]);
  await expect(page.locator(".catalogMeta span")).toHaveText("1 usable · 1 granted · 0 blocked");
  await expect(inspector).toContainText("Beta models");
  await expect(inspector).toContainText("outside current filters");
  expect(writes).toEqual([]);
});

test("an edited provider budget stays with its service when Catalog filters change", async ({ page }) => {
  const writes = await openCatalog(page, "admin");
  const search = page.getByRole("textbox", { name: "search catalog", exact: true });
  const budget = page.getByRole("textbox", { name: "monthly provider budget ($)", exact: true });
  await search.fill("Gamma");
  await expect(page.locator(".inspectorHeader h2")).toHaveText("Gamma search");
  await budget.fill("42");
  await search.fill("Beta");
  await expect(page.locator(".tableRow .entityTitle")).toHaveText(["Beta models"]);
  await expect(page.locator(".inspectorHeader h2")).toHaveText("Gamma search");
  await expect(budget).toHaveValue("42");
  expect(writes).toEqual([]);
});

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
    { id: "gamma-search", display_name: "Gamma search", class: "test", service_kind: "search", capabilities: [{ id: "web.search" }] },
  ];
  const readiness: ProviderReadiness[] = providers.map((provider) => ({
    id: provider.id, displayName: provider.display_name, class: provider.class, serviceKind: provider.service_kind,
    requiredConfig: [], optionalConfig: [], missingConfig: [], configPresent: true, connectionEnabled: provider.id !== "beta-model",
    oauthGrantRequired: false, oauthGrantCount: 0, upstreamGrantCount: 0, openaiCompatible: provider.service_kind === "model_provider",
    manifestRoutes: provider.service_kind === "search" ? 1 : 0, modelCount: provider.service_kind === "model_provider" ? 1 : 0,
    executable: provider.id !== "beta-model", verified: false, status: provider.id === "beta-model" ? "disabled" : "configured",
    reasons: provider.id === "beta-model" ? ["The provider connection is disabled."] : [],
  }));
  const usage: UsageSnapshot = {
    ledger: "ready", summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 },
    providers: [], daily: [], events: [],
  };
  const bootstrap: AdminBootstrapResponse = {
    policies: [], credentials: [], connections: [], users: [], bindings: [], providers: readiness, grants: [], rules: [], tenants: [],
    overview: { policiesTotal: 0, policiesActive: 0, tenantsTotal: 0, keysTotal: 0, keysActive: 0, providerCount: 3, openaiCompatibleProviders: 2, manifestRoutes: 1, monthlyBudgetMicros: 0, requestCostMicros: 0 },
    fusion: { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "", adviserTimeoutMs: 10_000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 },
  };
  const responses: Record<string, unknown> = {
    "/v1/providers": { providers },
    "/v1/routes": {
      openaiCompatible: providers.filter((provider) => provider.service_kind === "model_provider").map(({ id }) => ({
        provider: id, endpoints: ["/v1/chat/completions"],
        models: [{ id: `${id}/chat`, capabilities: ["llm.chat"], endpoints: ["/v1/chat/completions"] }],
      })),
      manifestProxy: [{ provider: "gamma-search", endpoint: "search", route: "/v1/proxy/gamma-search/search", methods: ["POST"] }],
    },
    "/v1/session": {
      authenticated: true, auth: "cloudflare_access", role, email: "operator@example.com", tenantId: "default",
      entitlements: { providers: readiness.map((item) => ({
        provider: item.id, displayName: item.displayName, serviceKind: item.serviceKind, allowed: item.id !== "alpha-model",
        policies: item.id === "alpha-model" ? [] : [item.id === "gamma-search" ? "search_policy" : "model_policy"], readiness: item,
      })) },
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
    const path = new URL(route.request().url()).pathname;
    if (role === "user") expect(path.startsWith("/v1/admin/")).toBe(false);
    const body = responses[path];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  await page.goto("/dashboard/catalog");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(page.locator(".tableRow .entityTitle")).toHaveText(["Alpha models", "Beta models", "Gamma search"]);
  return writes;
}
