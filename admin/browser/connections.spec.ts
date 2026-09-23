import { expect, test, type Page, type Route } from "@playwright/test";

test("connection edits admit one operation per provider and consume the committed response", async ({ page }) => {
  const pending = await openCatalog(page);
  const disable = page.getByRole("button", { name: "Disable connection", exact: true });
  await disable.evaluate((button: HTMLButtonElement) => {
    button.click();
    document.querySelector<HTMLFormElement>("form.providerBudgetEditor")!.requestSubmit();
    button.click();
  });
  await expect.poll(() => pending.length).toBe(1);
  expect(pending[0].request().method()).toBe("PATCH");
  expect(pending[0].request().postDataJSON()).toEqual({ enabled: false });
  await expect(disable).toBeDisabled();
  await expect(page.getByRole("button", { name: "Saving connection…" })).toBeDisabled();
  await expect(page.getByLabel("monthly provider budget ($)")).toBeDisabled();

  await page.locator(".tableRow").filter({ hasText: "test-b" }).click();
  await expect(disable).toBeEnabled();
  await expect(page.getByRole("button", { name: "Save budget", exact: true })).toBeEnabled();
  await page.locator(".tableRow").filter({ hasText: "test-a" }).click();
  await expect(disable).toBeDisabled();

  // The following refresh deliberately returns the earlier bootstrap snapshot.
  await pending[0].fulfill({ json: { providerId: "test-a", enabled: false, label: "Shared", monthlyBudgetMicros: 1_000_000 } });
  await expect(page.getByRole("button", { name: "Enable connection", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Save budget", exact: true })).toBeEnabled();
  await expect(page.locator(".providerBudgetEditor")).toContainText("Used amount unavailable · Remaining unavailable");

  await page.getByLabel("monthly provider budget ($)").fill("2");
  await page.getByRole("button", { name: "Save budget", exact: true }).click();
  await expect.poll(() => pending.length).toBe(2);
  expect(pending[1].request().postDataJSON()).toEqual({ monthlyBudgetMicros: 2_000_000 });
  await pending[1].fulfill({ json: { providerId: "test-a", enabled: false, label: "Shared", monthlyBudgetMicros: 2_000_000 } });
  await expect(page.getByRole("button", { name: "Enable connection", exact: true })).toBeEnabled();
  await expect(page.getByLabel("monthly provider budget ($)")).toHaveValue("2");
});

test("failed connection writes release controls and preserve a retryable budget draft", async ({ page }) => {
  const pending = await openCatalog(page);
  const budget = page.getByLabel("monthly provider budget ($)");
  await budget.fill("3");
  await page.locator("form.providerBudgetEditor").evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  await expect.poll(() => pending.length).toBe(1);
  await pending[0].fulfill({ status: 503, json: { error: { code: "unavailable", message: "Connection write failed" } } });
  await expect(page.getByRole("status")).toContainText("connection error");
  await expect(budget).toBeEnabled();
  await expect(budget).toHaveValue("3");
  await expect(page.getByRole("button", { name: "Disable connection", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Save budget", exact: true }).click();
  await expect.poll(() => pending.length).toBe(2);
  expect(pending[1].request().postDataJSON()).toEqual({ monthlyBudgetMicros: 3_000_000 });
  await pending[1].fulfill({ json: { providerId: "test-a", enabled: true, label: "Shared", monthlyBudgetMicros: 3_000_000 } });
  await expect(page.getByRole("button", { name: "Save budget", exact: true })).toBeEnabled();
  await expect(budget).toHaveValue("3");
});

async function openCatalog(page: Page) {
  const pending: Route[] = [];
  const providers = ["test-a", "test-b"].map((id) => ({ id, display_name: id, class: "test", service_kind: "model_provider", capabilities: [] }));
  const readiness = providers.map(({ id }) => ({
    id, displayName: id, class: "test", serviceKind: "model_provider", requiredConfig: [], optionalConfig: [], missingConfig: [],
    configPresent: true, connectionEnabled: true, oauthGrantRequired: false, oauthGrantCount: 0, openaiCompatible: false,
    manifestRoutes: 0, modelCount: 0, executable: true, verified: true, status: "verified", reasons: [],
  }));
  const bootstrap: Record<string, unknown> = {
    "/v1/providers": { providers },
    "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
    "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: "admin@example.com", entitlements: { providers: [] } },
    "/v1/session/credentials": { credentials: [] },
    "/v1/session/usage": { policies: [] },
    "/v1/admin/bootstrap": {
      policies: [], credentials: [], users: [], bindings: [], grants: [], rules: [], providers: readiness,
      connections: providers.map(({ id }) => ({ providerId: id, enabled: true, label: "Shared", monthlyBudgetMicros: 1_000_000, spentMicros: 250_000, remainingMicros: 750_000 })),
      fusion: { enabled: false, adviserModels: [], aggregatorModel: "" }, overview: null, tenants: [],
    },
  };
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/v1/admin/connections/")) { pending.push(route); return; }
    const body = bootstrap[path];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  await page.goto("/dashboard/catalog");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await page.getByRole("button", { name: "Configure providers", exact: true }).click();
  await page.locator(".tableRow").filter({ hasText: "test-a" }).click();
  await expect(page.getByLabel("monthly provider budget ($)")).toHaveValue("1");
  return pending;
}
