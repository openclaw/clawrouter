import snapshot from "../../worker/generated/provider-snapshot.json" with { type: "json" };
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const routing = { strategy: "most_remaining", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, eligibleGrants: {}, includedQuotaReservePercent: 5, environmentFallback: true };
const policy = { policyId: "claude_pool", enabled: true, providers: ["anthropic"], tenantId: "synthetic", grantRouting: routing };
const grant = { key: "oauth/claude_pool/max", scope: "policies", scopeId: "claude_pool", tokenRef: "max", provider: "anthropic", kind: "subscription", label: "Synthetic Max account", enabled: true, usable: true, hasRefreshToken: true, credentialStatus: "active", selectedCount: 42, account: { email: "operator@example.test", rateLimitTier: "default_claude_max_20x", subscriptionStatus: "active", extraUsageEnabled: true }, extraUsage: { enabled: true, usedCredits: 125, monthlyLimit: 1000, currency: "USD" }, quotaStatus: "limited", quotaObservedAt: new Date().toISOString(), quotaWindows: [
  { id: "5h", kind: "subscription", window: "five_hour", limit: 100, remaining: 62, resetAt: "2099-01-01T00:00:00.000Z" },
  { id: "7d", kind: "subscription", window: "seven_day", limit: 100, remaining: 82, resetAt: "2099-01-01T00:00:00.000Z" },
  { id: "fable", kind: "subscription", window: "seven_day_scoped", models: ["fable"], limit: 100, remaining: 0, resetAt: "2099-01-01T00:00:00.000Z" },
] };

test("subscriptions show scoped headroom, currency and usage in both themes", async ({ page }, testInfo) => {
  let refreshed = 0;
  const ranges: string[] = [];
  await page.route("**/v1/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith("/quota-refresh")) { refreshed++; await route.fulfill({ json: grant }); return; }
    if (path === "/v1/admin/upstream-grants/usage") {
      ranges.push(url.searchParams.get("days")!);
      await route.fulfill({ json: { days: 7, retentionDays: 30, since: 0, until: Date.now(), grants: [{ grantKey: grant.key, requests: 42, inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5, costMicros: 123456 }], lanes: [{ provider: "anthropic", grantLane: "subscription", requests: 42 }, { provider: "anthropic", grantLane: "environment", requests: 2, costMicros: 230000 }], daily: [] } }); return;
    }
    const bodies: Record<string, unknown> = {
      "/v1/providers": { providers: snapshot.providers.filter(provider => provider.id === "anthropic") }, "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: "operator@example.test", entitlements: { providers: [] } },
      "/v1/session/credentials": { credentials: [] }, "/v1/session/usage": { policies: [] },
      "/v1/admin/bootstrap": { policies: [{ ...policy, policyId: "empty" }, policy], credentials: [], users: [], bindings: [], grants: [grant, { ...grant, key: "oauth/claude_pool/openai", tokenRef: "openai", provider: "openai", label: "Other provider", quotaWindows: [{ id: "other", kind: "subscription", limit: 100, remaining: 90, resetAt: "2099-01-01T00:00:00.000Z" }] }], rules: [], providers: [], connections: [], fusion: { enabled: false, adviserModels: [], aggregatorModel: "" }, overview: null, tenants: [] },
    };
    await route.fulfill({ status: path in bodies ? 200 : 404, json: bodies[path] ?? {} });
  });
  await page.goto("/dashboard/subscriptions");
  await expect(page.getByLabel("Subscription policy")).toHaveValue("claude_pool");
  await expect(page.getByText("operator@example.test", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("62% free", { exact: true })).toBeVisible();
  await expect(page.getByText("0/1 subs eligible", { exact: true })).toBeVisible();
  await expect(page.getByText("0% free", { exact: true })).toBeVisible();
  await expect(page.getByText(/Max 20x/).first()).toBeVisible();
  await expect(page.getByText(/\$1.25 \/ \$10.00/).first()).toBeVisible();
  await expect(page.getByText("Fable: unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("150", { exact: true }).first()).toBeVisible(); // Input already includes the cache subsets.
  await page.getByRole("button", { name: "Refresh quota", exact: true }).first().click();
  await expect.poll(() => refreshed).toBe(1);
  await page.getByLabel("Usage range").selectOption("14");
  await expect.poll(() => ranges.at(-1)).toBe("14");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.setAttribute("data-theme", theme), theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const violations = (await new AxeBuilder({ page }).analyze()).violations.filter(violation => ["critical", "serious"].includes(violation.impact ?? ""));
    expect(violations).toEqual([]);
    await page.screenshot({ path: `/tmp/clawrouter-subscriptions-${testInfo.project.name}-${theme}.png`, fullPage: true });
  }
});
