import { expect, test, type Page } from "@playwright/test";
import { fixtureReport } from "./fixtures/personal-usage";

const summary = (requestCount: number, totalTokens: number) => ({ requestCount, successCount: requestCount, errorCount: 0, inputTokens: totalTokens, outputTokens: 0, totalTokens, actualCostMicros: 0, unpricedRequestCount: 0 });
const shared = { ledger: "fixture", summary: summary(120, 9_000), providers: [], daily: [], events: [] };
const personal = { ...shared, personal: { summary: summary(7, 300), providers: [], daily: [] } };
const admin = {
  ...shared,
  principals: [
    { principalId: "bob@example.test", credentialId: null, summary: summary(113, 8_700) },
    { principalId: "alice@example.test", credentialId: null, summary: summary(6, 250) },
    { principalId: null, credentialId: "svc_123", summary: summary(1, 50) },
  ],
};

// Serves one signed-in session with the given role and fixed usage responses.
async function serve(page: Page, role: "admin" | "user") {
  const report = fixtureReport();
  report.metrics = { calls: 7, generationCalls: 7, utilityCalls: 0, successfulCalls: 7, errorCalls: 0, deniedCalls: 0, inputTokens: 300, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, inputReportedCalls: 7, outputReportedCalls: 7, cacheReadReportedCalls: 0, cacheWriteReportedCalls: 0, reasoningReportedCalls: 0 };
  report.costs = [{ lane: "api", costClass: "no_charge", calls: 7, amountMicros: 0 }];
  await page.route("**/v1/**", async (route) => {
    const bodies: Record<string, unknown> = {
      "/v1/providers": { providers: [] },
      "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role, email: "alice@example.test", entitlements: { providers: [] } },
      "/v1/session/credentials": { credentials: [] },
      "/v1/session/usage": { policies: [], usage: personal },
      "/v1/session/usage/report": report,
      "/v1/admin/usage": { policies: [], usage: admin },
      "/v1/admin/bootstrap": { policies: [], credentials: [], users: [], bindings: [], grants: [], rules: [], providers: [], connections: [], fusion: { enabled: false, adviserModels: [], aggregatorModel: "" }, overview: null, tenants: [] },
    };
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ status: path in bodies ? 200 : 404, json: bodies[path] ?? {} });
  });
}

test("members see personal model calls without shared policy totals in analytics", async ({ page }) => {
  await serve(page, "user");
  await page.goto("/");
  const personalUsage = page.getByRole("region", { name: "Your personal usage", exact: true });
  await expect(personalUsage.locator(".personalCallStats dd").first()).toHaveText("7");
  await expect(personalUsage).toContainText("MODEL CALLS");
  await expect(personalUsage).toContainText("300");
  await expect(personalUsage).not.toContainText("120 across your policy pools");
  await expect(page.locator(".dashboardAnalyticsGrid")).toHaveCount(0);
});

test("admins see thirty-day usage broken down by user", async ({ page }) => {
  await serve(page, "admin");
  await page.goto("/dashboard/usage");
  const table = page.locator(".usageTablePanel").filter({ hasText: "Usage by user" });
  await expect(table).toContainText("3 identities · last 30 days");
  const rows = table.locator(".tableRow");
  await expect(rows.filter({ hasText: "bob@example.test" })).toContainText("113");
  await expect(rows.filter({ hasText: "alice@example.test" })).toContainText("6");
  await expect(rows.filter({ hasText: "service key svc_123" })).toContainText("no principal");
});
