import { expect, test } from "@playwright/test";
import snapshot from "../../worker/generated/provider-snapshot.json" with { type: "json" };

const usage = { ledger: "fixture", summary: { requestCount: 2, successCount: 2, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 }, providers: [], daily: [], events: [] };
const policy = { policyId: "fixture-pool", enabled: true, providers: ["anthropic"], tenantId: "fixture", grantRouting: { strategy: "most_remaining", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, eligibleGrants: {}, includedQuotaReservePercent: 0, environmentFallback: true } };
const healthy = { key: "oauth/fixture-pool/healthy", scope: "policies", scopeId: "fixture-pool", tokenRef: "healthy", provider: "anthropic", kind: "subscription", label: "Healthy setup grant", enabled: true, usable: true, hasRefreshToken: false, hasAccessToken: true, credentialFields: [], credentialStatus: "active", selectedCount: 3, quotaStatus: "available", quotaWindows: [] };
const failed = { ...healthy, key: "oauth/fixture-pool/failed", tokenRef: "failed", label: "Failed grant", hasRefreshToken: true, refreshConfigured: true, usable: false, credentialStatus: "reauth_required", refreshDiagnosis: { lastSuccessfulRefreshAt: "2026-10-20T10:00:00Z", failure: { oauthError: "invalid_grant", httpStatus: 400, failureClass: "permanent", firstFailureAt: "2026-10-21T10:00:00Z", lastFailureAt: "2026-10-21T10:00:00Z", attemptCount: 1, nextRetryAt: null } } };

for (const scenario of ["reauth", "capacity", "healthy", "member", "unavailable"]) test(`dashboard grant health: ${scenario}`, async ({ page }) => {
  const grants = scenario === "healthy" ? [healthy, { ...healthy, key: failed.key, tokenRef: "failed" }]
    : scenario === "capacity" ? [healthy, { ...failed, credentialStatus: "active", refreshDiagnosis: null, enabled: false }]
    : [healthy, failed];
  await page.route("**/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/admin/bootstrap" && scenario === "unavailable") return route.fulfill({ status: 503, json: { error: { message: "fixture unavailable" } } });
    const bodies: Record<string, unknown> = {
      "/v1/providers": { providers: snapshot.providers.filter(provider => provider.id === "anthropic") },
      "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role: scenario === "member" ? "user" : "admin", email: "fixture@example.test", entitlements: { providers: [] } },
      "/v1/session/credentials": { credentials: [] }, "/v1/session/usage": { policies: [], usage },
      "/v1/admin/usage": { policies: [], usage },
      "/v1/admin/bootstrap": { policies: [policy], credentials: [], users: [], bindings: [], grants, rules: [], providers: [], connections: [], fusion: { enabled: false, adviserModels: [], aggregatorModel: "" }, overview: null, tenants: [] },
    };
    return route.fulfill({ status: path in bodies ? 200 : 404, json: bodies[path] ?? {} });
  });
  await page.goto("/");
  await expect(page.locator(".tenantSwitch")).toContainText("fixture@example.test");
  const incidents = page.getByRole("region", { name: "Credential maintenance incidents" });
  if (scenario === "member" || scenario === "healthy") {
    await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
    await expect(incidents).toHaveCount(0);
  } else if (scenario === "unavailable") {
    await expect(incidents).toContainText("Pool health unavailable or stale");
  } else {
    await expect(incidents).toContainText("1/2 grants eligible");
    await expect(incidents).toContainText("Fallback serving traffic does not resolve this incident");
    if (scenario === "reauth") {
      await expect(incidents).toContainText("invalid_grant");
      await expect(incidents.locator('time[datetime="2026-10-20T10:00:00Z"]')).toBeVisible();
      await incidents.getByRole("button", { name: "Repair Failed grant" }).click();
      await expect(page.getByRole("heading", { name: "Edit upstream grant" })).toBeVisible();
      await expect(page.getByRole("tabpanel")).toContainText("Reauth required — invalid_grant");
      await expect(page.getByRole("tabpanel")).toContainText("fresh dedicated login");
      await page.getByRole("button", { name: "Subscriptions", exact: true }).click();
      await expect(page.locator(".subscriptionCard").filter({ hasText: "Failed grant" })).toContainText("Last good refresh:");
    }
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
