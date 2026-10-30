import snapshot from "../../worker/generated/provider-snapshot.json" with { type: "json" };
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const routing = { strategy: "most_remaining", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, eligibleGrants: {}, includedQuotaReservePercent: 5, environmentFallback: true };
const policy = { policyId: "claude_pool", enabled: true, providers: ["anthropic"], tenantId: "synthetic", grantRouting: routing };
const grant = { key: "oauth/claude_pool/max", scope: "policies", scopeId: "claude_pool", tokenRef: "max", provider: "anthropic", kind: "subscription", label: "Synthetic Max account", enabled: true, usable: true, hasRefreshToken: true, credentialStatus: "active", selectedCount: 42, account: { email: "operator@example.test", rateLimitTier: "default_claude_max_20x", subscriptionStatus: "active", extraUsageEnabled: true }, extraUsage: { enabled: true, usedCredits: 125, monthlyLimit: 1000, currency: "USD" }, quotaStatus: "limited", quotaObservedAt: new Date().toISOString(), quotaWindows: [
  { id: "5h", kind: "subscription", window: "five_hour", limit: 100, remaining: 62, resetAt: "2099-01-01T00:00:00.000Z" },
  { id: "7d", kind: "subscription", window: "seven_day", limit: 100, remaining: 82, resetAt: "2099-01-01T00:00:00.000Z" },
  { id: "fable", kind: "subscription", window: "seven_day_scoped", models: ["fable"], limit: 100, remaining: 0, resetAt: "2099-01-01T00:00:00.000Z" },
] };

test("subscriptions show scoped headroom, currency and usage in both themes", async ({ page }) => {
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
  }
});

const retiredPolicy = { ...policy, policyId: "retired_pool", enabled: false };
function scopedGrant(scopeId: string, tokenRef: string, fields: Record<string, unknown> = {}) {
  return { ...grant, scopeId, tokenRef, key: "oauth/" + scopeId + "/" + tokenRef, label: tokenRef, ...fields };
}
const retired = scopedGrant(policy.policyId, "Retired Max", { enabled: false, usable: false, hasRefreshToken: false, revokedAt: "2026-10-01T00:00:00Z" });

async function inventoryFixture(page: Page, inventory: { policies: Record<string, unknown>[]; grants: Record<string, unknown>[]; usageError?: boolean }) {
  const requests: { method: string; path: string; policyId: string | null }[] = [];
  await page.route("**/v1/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    requests.push({ method: request.method(), path, policyId: url.searchParams.get("scopeId") });
    if (path === "/v1/admin/upstream-grants/usage" && inventory.usageError) {
      await route.fulfill({ status: 503, json: { error: { message: "Synthetic usage offline" } } }); return;
    }
    const bodies: Record<string, unknown> = {
      "/v1/providers": { providers: snapshot.providers.filter(provider => provider.id === "anthropic") },
      "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: "operator@example.test", entitlements: { providers: [] } },
      "/v1/session/credentials": { credentials: [] }, "/v1/session/usage": { policies: [] },
      "/v1/admin/bootstrap": { ...inventory, credentials: [], users: [], bindings: [], rules: [], providers: [], connections: [], fusion: { enabled: false, adviserModels: [], aggregatorModel: "" }, overview: null, tenants: [] },
      "/v1/admin/upstream-grants/usage": { days: 7, retentionDays: 30, since: 0, until: Date.now(), grants: [], lanes: [], daily: [] },
    };
    await route.fulfill({ status: path in bodies ? 200 : 404, json: bodies[path] ?? {} });
  });
  return requests;
}

test("live inventory hides revoked tombstones; local history labels them without changing headroom", async ({ page }) => {
  const requests = await inventoryFixture(page, { policies: [policy, retiredPolicy], grants: [grant, retired, { ...retired, key: "oauth/claude_pool/retired-pro", label: "Retired Pro" }] });
  await page.goto("/dashboard/subscriptions");
  const cards = page.locator(".subscriptionCard");
  await expect(cards).toHaveCount(1);
  await expect(page.getByLabel("Subscription policy").locator("option")).toHaveText([policy.policyId]);
  await expect(page.getByText("1/1 subs eligible", { exact: true })).toHaveCount(2);
  await expect(page.getByText("0/1 subs eligible", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Refresh usage", exact: true })).toBeEnabled();
  const before = requests.length;
  await page.getByLabel("Show retired / disabled history").check();
  await expect(cards).toHaveCount(3);
  await expect(page.getByLabel("Subscription policy").locator("option")).toHaveText([policy.policyId, retiredPolicy.policyId + " (disabled)"]);
  await expect(cards.filter({ hasText: "Retired Max" }).getByText("Revoked", { exact: true })).toBeVisible();
  await expect(cards.filter({ hasText: "Retired Pro" }).getByText("Revoked", { exact: true })).toBeVisible();
  await expect(cards.filter({ hasText: "Retired Max" }).getByRole("button", { name: "Refresh quota" })).toBeDisabled();
  await expect(page.getByText("1/1 subs eligible", { exact: true })).toHaveCount(2);
  await expect(page.getByText("0/1 subs eligible", { exact: true })).toHaveCount(1);
  await page.getByLabel("Show retired / disabled history").uncheck();
  await expect(cards).toHaveCount(1);
  expect(requests.slice(before)).toEqual([]);
});

test("default selection prefers a current subscription over revoked-only and empty policies", async ({ page }) => {
  const old = { ...policy, policyId: "old_only" };
  const empty = { ...policy, policyId: "empty" };
  const requests = await inventoryFixture(page, { policies: [retiredPolicy, old, empty, policy], grants: [scopedGrant(retiredPolicy.policyId, "Disabled policy account"), { ...retired, scopeId: old.policyId }, { ...grant, kind: "oauth" }] });
  await page.goto("/dashboard/subscriptions");
  await expect(page.getByLabel("Subscription policy")).toHaveValue(policy.policyId);
  await expect(page.locator(".subscriptionCard")).toHaveCount(1);
  await expect.poll(() => requests.filter(row => row.path.endsWith("/usage") && row.policyId !== null).map(row => row.policyId)).toEqual([policy.policyId]);
  await page.getByLabel("Show retired / disabled history").check();
  await page.getByLabel("Subscription policy").selectOption(retiredPolicy.policyId);
  await expect(page.getByRole("heading", { name: "Disabled policy account", exact: true })).toBeVisible();
  await expect(page.getByText("0/1 subs eligible", { exact: true })).toHaveCount(3);
  await page.getByLabel("Show retired / disabled history").uncheck();
  await expect(page.getByLabel("Subscription policy")).toHaveValue(policy.policyId);
  await expect(page.getByRole("heading", { name: "Synthetic Max account", exact: true })).toBeVisible();
  await page.getByLabel("Show retired / disabled history").check();
  await expect(page.getByLabel("Subscription policy")).toHaveValue(policy.policyId);
  await page.getByLabel("Subscription policy").selectOption(old.policyId);
  await expect(page.locator(".subscriptionCard")).toHaveCount(1);
  await expect(page.getByText("0/0 subs eligible", { exact: true })).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "No current Claude subscriptions in this policy", exact: true })).toBeVisible();
  await page.getByLabel("Show retired / disabled history").uncheck();
  await expect(page.getByLabel("Subscription policy")).toHaveValue(old.policyId);
  await expect(page.locator(".subscriptionCard")).toHaveCount(0);
  expect(requests.filter(row => row.method !== "GET" || row.path.endsWith("/quota-refresh"))).toEqual([]);
});

test("paused and reauthorization-required nonrevoked accounts stay visible", async ({ page }) => {
  await inventoryFixture(page, { policies: [policy], grants: [grant, scopedGrant(policy.policyId, "Paused account", { enabled: false }), scopedGrant(policy.policyId, "Renew account", { usable: false, credentialStatus: "reauth_required" }), retired] });
  await page.goto("/dashboard/subscriptions");
  await expect(page.locator(".subscriptionCard")).toHaveCount(3);
  const paused = page.locator(".subscriptionCard").filter({ hasText: "Paused account" });
  await expect(paused.getByText("Paused", { exact: true })).toBeVisible();
  await expect(paused.getByRole("button", { name: "Refresh quota" })).toBeDisabled();
  await expect(page.locator(".subscriptionCard").filter({ hasText: "Renew account" }).getByText("reauth required", { exact: true })).toBeVisible();
  await expect(page.getByText("1/3 subs eligible", { exact: true })).toHaveCount(2);
});

test("history preserves tenant, policy, provider and explicit grant isolation", async ({ page }) => {
  const restricted = { ...policy, grantRouting: { ...routing, eligibleGrants: { anthropic: ["max", "shared", "retired"] } } };
  await inventoryFixture(page, { policies: [restricted], grants: [grant,
    scopedGrant(policy.tenantId, "shared", { scope: "tenants" }),
    scopedGrant(policy.tenantId, "retired", { scope: "tenants", enabled: false, usable: false, revokedAt: "2026-10-01T00:00:00Z" }),
    scopedGrant("other-tenant", "shared", { scope: "tenants" }),
    scopedGrant("other-policy", "max"), scopedGrant(policy.policyId, "excluded"),
    scopedGrant(policy.policyId, "openai", { provider: "openai" }),
  ] });
  await page.goto("/dashboard/subscriptions");
  await expect(page.locator(".subscriptionCard h2")).toHaveText(["Synthetic Max account", "shared"]);
  await expect(page.getByText("2/2 subs eligible", { exact: true })).toHaveCount(2);
  await page.getByLabel("Show retired / disabled history").check();
  await expect(page.locator(".subscriptionCard h2")).toHaveText(["Synthetic Max account", "shared", "retired"]);
  await expect(page.getByText("2/2 subs eligible", { exact: true })).toHaveCount(2);
});

test("disabled-only inventory has no implicit selection and remains inspectable in history", async ({ page }) => {
  const inventory = { policies: [retiredPolicy], grants: [scopedGrant(retiredPolicy.policyId, "Disabled policy account")], usageError: true };
  const requests = await inventoryFixture(page, inventory);
  await page.goto("/dashboard/subscriptions");
  await expect(page.getByRole("heading", { name: "No enabled policies", exact: true })).toBeVisible();
  await expect(page.getByLabel("Subscription policy")).toHaveValue("");
  await expect(page.getByLabel("Subscription policy")).toBeDisabled();
  await expect(page.locator(".subscriptionCard")).toHaveCount(0);
  expect(requests.filter(row => row.path.endsWith("/usage") && row.policyId !== null)).toEqual([]);
  await page.getByLabel("Show retired / disabled history").check();
  await expect(page.getByLabel("Subscription policy")).toHaveValue(retiredPolicy.policyId);
  await expect(page.locator(".subscriptionCard")).toHaveCount(1);
  await expect(page.getByText("0/1 subs eligible", { exact: true })).toHaveCount(3);
  await expect(page.getByRole("alert")).toContainText("Synthetic usage offline");
  await page.getByLabel("Show retired / disabled history").uncheck();
  await expect(page.getByRole("heading", { name: "No enabled policies", exact: true })).toBeVisible();
  await expect(page.locator(".subscriptionCard")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  inventory.usageError = false;
  await page.getByLabel("Show retired / disabled history").check();
  await expect(page.getByRole("button", { name: "Refresh usage", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("empty inventory stays empty in either history mode", async ({ page }) => {
  const requests = await inventoryFixture(page, { policies: [], grants: [] });
  await page.goto("/dashboard/subscriptions");
  await expect(page.getByRole("heading", { name: "No policies yet", exact: true })).toBeVisible();
  await page.getByLabel("Show retired / disabled history").check();
  await expect(page.getByRole("heading", { name: "No policies yet", exact: true })).toBeVisible();
  await expect(page.getByLabel("Subscription policy")).toBeDisabled();
  await expect(page.locator(".subscriptionCard")).toHaveCount(0);
  expect(requests.filter(row => row.path.endsWith("/usage") && row.policyId !== null)).toEqual([]);
});

test("a selected policy disabled by refresh falls back without hiding Access management", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2030-01-01T00:00:00Z"));
  const other = { ...policy, policyId: "other_pool" };
  const inventory = { policies: [policy, other], grants: [grant, scopedGrant(other.policyId, "Other account")] };
  const requests = await inventoryFixture(page, inventory);
  await page.goto("/dashboard/subscriptions");
  await page.getByLabel("Subscription policy").selectOption(other.policyId);
  await expect(page.getByRole("heading", { name: "Other account", exact: true })).toBeVisible();
  other.enabled = false;
  await page.clock.setFixedTime(new Date("2030-01-01T00:01:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("Subscription policy").locator("option")).toHaveText([policy.policyId]);
  await expect(page.getByLabel("Subscription policy")).toHaveValue(policy.policyId);
  await expect(page.locator(".subscriptionCard h2")).toHaveText(["Synthetic Max account"]);
  await page.getByLabel("Show retired / disabled history").check();
  await expect(page.getByLabel("Subscription policy")).toHaveValue(policy.policyId);
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await expect(page.locator(".tableRow").filter({ hasText: other.policyId }).getByText("revoked", { exact: true })).toBeVisible();
  expect(requests.filter(row => row.method !== "GET")).toEqual([]);
});
