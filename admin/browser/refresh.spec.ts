import { expect, test, type Page } from "@playwright/test";
import type { AccessPolicy, AccessUser, AdminBootstrapResponse } from "../src/ui-types";

test("unavailable usage shows unknown spend and policy limits, then recovers", async ({ page }) => {
  const state = await fixture(page);
  state.failUsage = true;
  await page.goto("/dashboard/usage");
  await expect(page.locator(".usageFreshness")).toContainText("Spend and remaining balances are unknown");
  await expect(page.locator(".usageSummaryGrid .metric strong")).toHaveText(["—", "—", "—", "—"]);
  await expect(page.getByText("No request audit events recorded yet.")).toHaveCount(0);
  await expect(page.getByText("Request audit events unavailable.")).toBeVisible();
  await expect(page.locator(".budgetUsage")).toContainText("Spend unavailable");
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.locator(".quotaNumbers")).toContainText("$10.00monthly limit");
  await expect(page.locator(".quotaNumbers")).not.toContainText("remaining of");
  await expect(page.locator(".dashboardStats > div").filter({ has: page.getByText("requests", { exact: true }) }).locator("strong")).toHaveText("—");
  state.failUsage = false;
  await page.getByRole("button", { name: "Retry refresh" }).click();
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(page.locator(".usageFreshness")).toHaveCount(0);
  await expect(page.locator(".quotaNumbers")).toContainText("$8.00remaining of $10.00");
});

test("background failure retains the actual snapshot time and recovers on focus", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  const updated = await page.locator(".connectionMeta time").getAttribute("datetime");
  state.failUsage = true;
  await focusRefresh(page, "2026-07-06T12:01:00.000Z");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Needs attention");
  await expect(page.locator(".connectionMeta time")).toHaveAttribute("datetime", updated!);
  await expect(page.locator(".usageFreshness time")).toHaveAttribute("datetime", updated!);
  await expect(page.locator(".quotaPanel")).toContainText("last known ledger");
  await expect(page.locator(".quotaNumbers")).toContainText("$8.00");
  state.failUsage = false;
  await focusRefresh(page, "2026-07-06T12:02:00.000Z");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(page.locator(".connectionMeta time")).toHaveAttribute("datetime", "2026-07-06T12:02:00.000Z");
  await expect(page.locator(".usageFreshness")).toHaveCount(0);
});

test("successful user edits survive a failed follow-up read", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/dashboard/users");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  const updated = await page.locator(".connectionMeta time").getAttribute("datetime");
  await page.getByRole("textbox", { name: "groups", exact: true }).fill("maintainers");
  state.failAfterWrite = true;
  await page.getByRole("button", { name: "Save user", exact: true }).click();
  await expect(page.locator(".statusBar")).toContainText("saved user");
  await expect(page.locator(".statusBar")).toContainText("Console data refresh failed");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Needs attention");
  await expect(page.locator(".connectionMeta time")).toHaveAttribute("datetime", updated!);
  await expect(page.getByRole("button", { name: "Save user", exact: true })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "groups", exact: true })).toHaveValue("maintainers");
  expect(state.writes).toBe(1);
  state.failBootstrap = false;
  await page.getByRole("button", { name: "Retry refresh" }).click();
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(page.locator(".statusBar")).toHaveCount(0);
  expect(state.writes).toBe(1);
});

test("partial background refresh reports credential failures without advancing freshness", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  const updated = await page.locator(".connectionMeta time").getAttribute("datetime");
  state.failCredentials = true;
  await focusRefresh(page, "2026-07-06T12:01:00.000Z");
  await expect(page.locator(".statusBar")).toContainText("personal credentials unavailable");
  await expect(page.locator(".connectionMeta time")).toHaveAttribute("datetime", updated!);
  state.failCredentials = false;
  await focusRefresh(page, "2026-07-06T12:02:00.000Z");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(page.locator(".statusBar")).toHaveCount(0);
});

test("returning after an edit refreshes usage and rejects a pre-edit read", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(page.locator(".quotaNumbers")).toContainText("$8.00");
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page.getByRole("textbox", { name: "groups", exact: true }).fill("maintainers");
  state.usage.policies[0].budget.remainingMicros = 6_000_000;
  await page.getByRole("button", { name: "Save user", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save user", exact: true })).toBeEnabled();
  await expect.poll(() => state.writes).toBe(1);
  let release!: () => void;
  state.holdUsage = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect.poll(() => state.usageReads).toBe(2);
  await expect(page.locator(".usageFreshness")).toContainText("Showing last known usage");
  await expect(page.locator(".quotaPanel")).toContainText("last known ledger");
  await page.getByRole("button", { name: "Users", exact: true }).click();
  state.usage.policies[0].budget.remainingMicros = 4_000_000;
  await page.getByRole("button", { name: "Save user", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save user", exact: true })).toBeEnabled();
  await expect.poll(() => state.writes).toBe(2);
  let releaseCurrent!: () => void;
  state.holdUsage = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect.poll(() => state.usageReads).toBe(3);
  const oldResponse = page.waitForResponse("**/v1/admin/usage");
  release();
  await oldResponse;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(page.locator(".quotaNumbers")).toContainText("$8.00");
  await expect(page.locator(".usageFreshness")).toContainText("Showing last known usage");
  releaseCurrent();
  await expect(page.locator(".quotaNumbers")).toContainText("$4.00");
  await expect(page.locator(".usageFreshness")).toHaveCount(0);
});

test("navigation keeps its first usage read while a Catalog background refresh finishes", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/dashboard/catalog");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  let releaseBootstrap!: () => void;
  state.holdBootstrap = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
  await focusRefresh(page, "2026-07-06T12:01:00.000Z");
  await expect.poll(() => state.bootstrapReads).toBe(2);
  let releaseUsage!: () => void;
  state.holdUsage = new Promise<void>((resolve) => { releaseUsage = resolve; });
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect.poll(() => state.usageReads).toBe(1);
  releaseBootstrap();
  await expect(page.locator(".connectionMeta time")).toHaveAttribute("datetime", "2026-07-06T12:01:00.000Z");
  releaseUsage();
  await expect(page.locator(".quotaNumbers")).toContainText("$8.00remaining of $10.00");
  await expect(page.locator(".usageFreshness")).toHaveCount(0);
  expect(state.usageReads).toBe(1);
});

test("a late admin usage read cannot overwrite a new principal's unavailable usage", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/dashboard/catalog");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  let release!: () => void;
  state.holdUsage = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect.poll(() => state.usageReads).toBe(1);
  state.role = "user";
  state.email = "second@example.com";
  state.failUsage = true;
  await focusRefresh(page, "2026-07-06T12:01:00.000Z");
  await expect(page.locator(".tenantSwitch strong")).toHaveText("second@example.com");
  await expect(page.locator(".usageFreshness")).toContainText("Spend and remaining balances are unknown");
  const oldResponse = page.waitForResponse("**/v1/admin/usage");
  release();
  await oldResponse;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(page.locator(".usageFreshness")).toContainText("Spend and remaining balances are unknown");
  await expect(page.locator(".quotaNumbers")).toHaveCount(0);
});

async function focusRefresh(page: Page, time: string) {
  await page.clock.setFixedTime(new Date(time));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

async function fixture(page: Page) {
  await page.clock.setFixedTime(new Date("2026-07-06T12:00:00.000Z"));
  const state = {
    failUsage: false, failBootstrap: false, failCredentials: false, failAfterWrite: false,
    role: "admin", email: "admin@example.com", writes: 0, usageReads: 0, bootstrapReads: 0,
    usage: structuredClone(usage),
    holdUsage: null as Promise<void> | null,
    holdBootstrap: null as Promise<void> | null,
  };
  const user: AccessUser = { email: "member@example.com", role: "user", tenantId: "default", enabled: true, groups: [], contentRetentionDisabled: false };
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "PUT") {
      expect(path).toBe("/v1/admin/access-user-grants/member%40example.com");
      state.writes += 1;
      user.groups = route.request().postDataJSON().groups;
      if (state.failAfterWrite) state.failBootstrap = true;
      await route.fulfill({ json: { user, bindings: [] } });
      return;
    }
    if (path === "/v1/admin/usage") {
      state.usageReads += 1;
      // Capture the old response before waiting so a new principal can arrive first.
      const fail = state.failUsage;
      const snapshot = structuredClone(state.usage);
      if (state.holdUsage) await state.holdUsage;
      await route.fulfill(fail ? { status: 503, body: "ledger offline" } : { json: snapshot });
      return;
    }
    if (path === "/v1/admin/bootstrap") {
      state.bootstrapReads += 1;
      if (state.holdBootstrap) await state.holdBootstrap;
    }
    if ((path === "/v1/admin/bootstrap" && state.failBootstrap)
      || (path === "/v1/session/credentials" && state.failCredentials)
      || (path === "/v1/session/usage" && state.role === "user" && state.failUsage)) {
      await route.fulfill({ status: 503, body: "reporting offline" });
      return;
    }
    const responses: Record<string, unknown> = {
      "/v1/providers": { providers: [] },
      "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "access", role: state.role, email: state.email, tenantId: "default", entitlements: { providers: [] } },
      "/v1/session/usage": state.usage,
      "/v1/session/credentials": { credentials: [] },
      "/v1/admin/bootstrap": {
        policies: [policy], credentials: [], connections: [], users: [user], bindings: [], grants: [], rules: [], providers: [], tenants: [],
        overview: { policiesTotal: 1, policiesActive: 1, tenantsTotal: 1, keysTotal: 0, keysActive: 0, providerCount: 0, openaiCompatibleProviders: 0, manifestRoutes: 0, monthlyBudgetMicros: 10_000_000, requestCostMicros: 0 },
        fusion: { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "", adviserTimeoutMs: 10_000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 },
      } satisfies AdminBootstrapResponse,
    };
    const body = responses[path];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  return state;
}

const policy: AccessPolicy = {
  policyId: "team_policy", enabled: true, providers: [], tenantId: "default", monthlyBudgetMicros: 10_000_000, budgetScope: "policy", retainRequestContent: false,
  grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} },
};
const usage = {
  policies: [{ ...policy, budget: { configured: true, ledger: "ready", limitMicros: 10_000_000, spentMicros: 2_000_000, remainingMicros: 8_000_000 } }],
  usage: {
    ledger: "ready", providers: [], daily: [], events: [],
    summary: { requestCount: 7, successCount: 6, errorCount: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20, actualCostMicros: 2_000_000 },
  },
};
