import snapshot from "../../worker/generated/provider-snapshot.json" with { type: "json" };
import { expect, test, type Page } from "@playwright/test";

const now = new Date("2030-01-01T00:00:00Z");
const policy = { policyId: "pool", enabled: true, providers: ["anthropic"], grantRouting: { eligibleGrants: {}, environmentFallback: true, staleState: "allow", staleAfterSeconds: 300, includedQuotaReservePercent: 0 } };
const grant = { key: "oauth/pool/claude", scope: "policies", scopeId: "pool", tokenRef: "claude", provider: "anthropic", kind: "subscription", label: "Fixture login", enabled: true, usable: true, hasRefreshToken: true, credentialStatus: "active", credentialFields: [], scopes: [], selectedCount: 1, priority: 100, weight: 1, quotaWindows: [], quotaStatus: "unknown" };
async function fixture(page: Page, fields: Record<string, unknown> = {}, role = "admin", failed = false) {
  await page.clock.setFixedTime(now);
  await page.route("**/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (failed && path === "/v1/admin/bootstrap") { await route.fulfill({ status: 503, json: { error: { message: "fixture read unavailable" } } }); return; }
    const bodies: Record<string, unknown> = {
      "/v1/providers": { providers: snapshot.providers.filter(provider => provider.id === "anthropic") }, "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role, email: "operator@example.test", entitlements: { providers: [] } },
      "/v1/session/credentials": { credentials: [] }, "/v1/session/usage": { policies: [] },
      "/v1/admin/bootstrap": { policies: [policy], credentials: [], users: [], bindings: [], grants: [{ ...grant, ...fields }, { ...grant, key: "oauth/pool/setup", tokenRef: "setup", label: "Healthy fallback", hasRefreshToken: false }], rules: [], providers: [], connections: [], fusion: { enabled: false, adviserModels: [], aggregatorModel: "" }, overview: null, tenants: [] },
      "/v1/admin/upstream-grants/usage": { days: 7, retentionDays: 30, grants: [], lanes: [], daily: [] },
    };
    await route.fulfill({ status: path in bodies ? 200 : 404, json: bodies[path] ?? {} });
  });
}
for (const [hours, label] of [[72, "Reauthorize within 3 days"], [12, "Reauthorize within 12 hours"], [0, "Refresh/session expiry reached"]] as const) {
  test(`dashboard warns at ${hours} hours despite healthy fallback and opens the affected grant`, async ({ page }) => {
    await fixture(page, { refreshTokenExpiresAt: new Date(+now + hours * 3600000).toISOString(), lastManualAuthorizationAt: "2029-12-05T00:00:00Z" });
    await page.goto("/dashboard");
    const health = page.getByRole("region", { name: "Pool refresh expiry health" });
    await expect(health).toContainText(label);
    await expect(health).toContainText("1 grant(s)");
    await health.getByRole("button", { name: "Renew Fixture login" }).click();
    await expect(page.getByRole("heading", { name: "Edit upstream grant" })).toBeVisible();
    await expect(page.getByLabel("Refresh session lifetime")).toContainText(label);
    await expect(page.getByLabel("Refresh session lifetime")).toContainText("Automatic refresh does not reset this date");
  });
}
test("unknown expiry has no false dashboard alarm and is explicit on subscription cards", async ({ page }) => {
  await fixture(page);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Routing and access at a glance" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Pool refresh expiry health" })).toHaveCount(0);
  await page.getByRole("button", { name: "Subscriptions", exact: true }).click();
  await expect(page.getByText("Refresh/session expiry unknown", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Refresh session lifetime")).toContainText("Last manual authorization: Unknown");
  await expect(page.getByLabel("Refresh session lifetime")).toHaveCount(1);
});
test("known distant expiry is displayed without an early warning", async ({ page }) => {
  await fixture(page, { refreshTokenExpiresAt: "2030-02-01T00:00:00Z" });
  await page.goto("/dashboard/subscriptions");
  await expect(page.getByText("Refresh/session expiry", { exact: true })).toBeVisible();
  await expect(page.getByText(/Reauthorize within/)).toHaveCount(0);
});
test("failed admin reads say expiry health is unavailable, not all clear", async ({ page }) => {
  await fixture(page, {}, "admin", true);
  await page.goto("/dashboard");
  await expect(page.getByRole("region", { name: "Pool refresh expiry health" })).toContainText("unavailable or stale");
});
test("member dashboard never exposes private grant deadlines", async ({ page }) => {
  await fixture(page, { refreshTokenExpiresAt: "2030-01-01T12:00:00Z" }, "user");
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Your gateway, operator" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Pool refresh expiry health" })).toHaveCount(0);
});
