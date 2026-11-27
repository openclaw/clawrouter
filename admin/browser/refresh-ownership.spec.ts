import { expect, test } from "@playwright/test";
import snapshot from "../../worker/generated/provider-snapshot.json" with { type: "json" };

for (const provenance of ["imported", "clawrouter_oauth", "legacy", "ambiguous", "provider_ok_persist_failed"]) {
  test(`refresh ownership card and dashboard: ${provenance}`, async ({ page }) => {
    const atRisk = ["ambiguous", "provider_ok_persist_failed"].includes(provenance);
    const healthy = { key: "oauth/pool/healthy", scope: "policies", scopeId: "pool", tokenRef: "healthy", provider: "anthropic", kind: "subscription", label: "Healthy fallback", enabled: true, usable: true, hasRefreshToken: false, hasAccessToken: true, credentialFields: [], credentialStatus: "active", selectedCount: 0, quotaStatus: "unknown", quotaWindows: [] };
    const grant = { ...healthy, key: "oauth/pool/login", tokenRef: "login", label: "Dedicated login", hasRefreshToken: true, refreshConfigured: true,
      credentialProvenance: provenance === "legacy" ? null : provenance === "clawrouter_oauth" ? provenance : "imported",
      refreshDiagnosis: atRisk ? { lastSuccessfulRefreshAt: null, failure: { failureClass: provenance, oauthError: "outcome_unknown", httpStatus: null, firstFailureAt: "2026-10-21T00:00:00Z", lastFailureAt: "2026-10-21T00:00:00Z", attemptCount: 1, nextRetryAt: null } } : null,
    };
    await page.route("**/v1/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const bodies: Record<string, unknown> = {
        "/v1/providers": { providers: snapshot.providers.filter(provider => provider.id === "anthropic") },
        "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
        "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: "operator@example.test", entitlements: { providers: [] } },
        "/v1/session/credentials": { credentials: [] }, "/v1/session/usage": { policies: [] },
        "/v1/admin/bootstrap": { policies: [{ policyId: "pool", enabled: true, providers: ["anthropic"], grantRouting: { eligibleGrants: {}, environmentFallback: true, staleState: "allow", staleAfterSeconds: 300, includedQuotaReservePercent: 0 } }], credentials: [], users: [], bindings: [], grants: [grant, healthy], rules: [], providers: [], connections: [], fusion: { enabled: false, adviserModels: [], aggregatorModel: "" }, overview: null, tenants: [] },
        "/v1/admin/upstream-grants/usage": { days: 7, retentionDays: 30, grants: [], lanes: [], daily: [] },
      };
      await route.fulfill({ status: path in bodies ? 200 : 404, json: bodies[path] ?? {} });
    });
    await page.goto("/dashboard");
    await expect(page.locator(".tenantSwitch")).toContainText("operator@example.test");
    const incidents = page.getByRole("region", { name: "Credential maintenance incidents" });
    if (atRisk) {
      await expect(incidents).toContainText("Refresh at risk — automatic replay stopped");
      await expect(incidents).toContainText("Fallback serving traffic does not resolve this incident");
      await incidents.getByRole("button", { name: "Repair Dedicated login" }).click();
      await expect(page.getByRole("tabpanel")).toContainText("fresh dedicated login");
    } else await expect(incidents).toHaveCount(0);
    await page.getByRole("button", { name: "Subscriptions", exact: true }).click();
    const card = page.locator(".subscriptionCard").filter({ hasText: "Dedicated login" });
    if (provenance === "clawrouter_oauth") {
      await expect(card).toContainText("Minted by ClawRouter OAuth");
      await expect(card).not.toContainText("may also be refreshed by another program");
    } else {
      await expect(card).toContainText("Login provenance: Imported");
      await expect(card).toContainText("may also be refreshed by another program");
      await expect(card).toContainText("never copy an active Claude Code login");
    }
    await expect(page.locator(".subscriptionCard").filter({ hasText: "Healthy fallback" })).not.toContainText("Login provenance");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
