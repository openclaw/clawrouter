import { expect, test, type Page } from "@playwright/test";

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
  await page.route("**/v1/**", async (route) => {
    const bodies: Record<string, unknown> = {
      "/v1/providers": { providers: [] },
      "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role, email: "alice@example.test", entitlements: { providers: [] } },
      "/v1/session/credentials": { credentials: [] },
      "/v1/session/usage": { policies: [], usage: personal },
      "/v1/admin/usage": { policies: [], usage: admin },
      "/v1/admin/bootstrap": { policies: [], credentials: [], users: [], bindings: [], grants: [], rules: [], providers: [], connections: [], fusion: { enabled: false, adviserModels: [], aggregatorModel: "" }, overview: null, tenants: [] },
    };
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ status: path in bodies ? 200 : 404, json: bodies[path] ?? {} });
  });
}

test("members see their own request count next to the shared policy total", async ({ page }) => {
  await serve(page, "user");
  await page.goto("/");
  const stat = page.locator(".dashboardStats > div").filter({ has: page.getByText("your requests", { exact: true }) });
  await expect(stat.locator("strong")).toHaveText("7");
  await expect(stat.locator("small")).toContainText("120 across your policy pools");
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
