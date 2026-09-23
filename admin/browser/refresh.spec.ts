import { expect, test, type Page } from "@playwright/test";
import type { AccessPolicy, AccessUser, AdminBootstrapResponse, AdminUsageRow, UsageAuditEvent, UsageSnapshot } from "../src/ui-types";

test("unavailable usage shows unknown spend and policy limits, then recovers", async ({ page }) => {
  const state = await fixture(page);
  state.failUsage = true;
  await page.goto("/dashboard/usage");
  await expect(page.locator(".usageFreshness")).toContainText("Spend and remaining balances are unknown");
  await expect(page.locator(".usageSummaryGrid .metric strong")).toHaveText(["—", "—", "—", "—"]);
  await expect(page.getByText("No request audit events recorded yet.")).toHaveCount(0);
  await expect(page.getByText("Request audit events unavailable.")).toBeVisible();
  await expect(page.locator(".budgetUsage")).toContainText("Used amount unavailable");
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.locator(".quotaNumbers")).toContainText("$10.00 monthly limit");
  await expect(page.locator(".quotaNumbers")).toContainText("Remaining unavailable");
  await expect(page.locator(".dashboardStats > div").filter({ has: page.getByText("requests", { exact: true }) }).locator("strong")).toHaveText("—");
  state.failUsage = false;
  await page.getByRole("button", { name: "Retry refresh" }).click();
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(page.locator(".usageFreshness")).toHaveCount(0);
  await expect(page.locator(".quotaNumbers")).toContainText("$8.00 remaining$10.00 monthly limit · $2.00 used");
});

test("Usage renders recorded cost bases and partial Fusion without reclassifying the 30-day totals", async ({ page }) => {
  const state = await fixture(page);
  const cases = [
    ["none", 0, "$0.00", "Accounted · no charge"],
    ["policy_fixed", 0, "$0.00", "Fixed policy tariff"],
    ["manifest_pricing", 1_000_000, "$1.00", "Token-based estimate"],
    ["manifest_rate_upper_bound", 1_000_000, "$1.00", "Token-based estimate (rate upper bound)"],
    ["manifest_reservation", 1_000_000, "$1.00", "Retained reservation estimate"],
    ["unpriced_usage", 0, "Price unavailable", "Unpriced usage"],
    ["model_pricing", 1_000_000, "$1.00", "Accounting basis unavailable"],
  ] as const;
  const event = (id: string, basis: string, amount: number): UsageAuditEvent => ({
    id, type: "clawrouter.usage.v1", occurred_at_ms: Date.UTC(2026, 6, 6, 12), tenant_id: "default", provider: "example",
    model: id, actual_cost_micros: amount, reserved_cost_micros: 1_000_000, cost_basis: basis, status: "success",
  });
  state.usage.usage.events = [
    ...cases.map(([basis, amount]) => event(basis, basis, amount)),
    { ...event("synth", "policy_fixed", 1_000_000), compound_request_id: "fusion", compound_request_stage: "fusion_synthesizer", compound_request_size: 3 },
    { ...event("adviser", "unpriced_usage", 0), compound_request_id: "fusion", compound_request_stage: "fusion_adviser", compound_request_index: 1, compound_request_size: 3 },
  ];
  Object.assign(state.usage.usage.summary, { requestCount: 1_000, actualCostMicros: 2_000_000, unpricedRequestCount: 2 });
  await page.goto("/dashboard/usage");
  await expect(page.locator(".auditCost strong")).toHaveText([...cases.map(([, , value]) => value), "≥$1.00 accounted; 1 unpriced"]);
  await expect(page.locator(".auditCost small")).toHaveText([...cases.map(([, , , label]) => label), "accounted spend"]);
  const spend = page.locator(".usageSummaryGrid .metric").filter({ has: page.getByText("accounted spend", { exact: true }) });
  await expect(spend.locator("strong")).toHaveText("$2.00 accounted; 2 unpriced");
  await expect(spend.locator("small")).toContainText("Last 30 days · May include estimates");
  await page.locator(".compoundRequestToggle").click();
  await expect(page.locator(".compoundRequest")).toContainText("Partial model call detail");
  await expect(page.locator(".compoundRequest")).toContainText("partial call history");
  await expect(page.locator(".compoundRequest")).toContainText("2 of 3 calls");
  await expect(page.locator(".compoundRequestCalls")).toContainText("Fixed policy tariff");
  await expect(page.locator(".compoundRequestCalls")).toContainText("Price unavailable");
});

test("Fusion total prices only the server's executable calls", async ({ page }) => {
  await fixture(page);
  const readiness = {
    policyId: policy.policyId, policyEnabled: true, configEnabled: false, executable: true, advertisable: false,
    readyAdviserCount: 0, adviserCount: 1, callCount: 2, estimatedReservationMicros: 1_000_000,
    budgetConfigured: true, budgetLedger: "ready", remainingBudgetMicros: 8_000_000, budgetSufficientForAll: true,
    estimateNote: "Estimate for currently eligible calls.",
    calls: [
      { stage: "adviser", index: 1, model: "example/adviser", provider: "example", policyAllowed: true, executable: false, verified: false,
        status: "blocked", reasons: ["Price unavailable for this budgeted call."], estimatedReservationMicros: 0, estimateBasis: "unpriced_request" },
      { stage: "synthesizer", index: null, model: "example/final", provider: "example", policyAllowed: true, executable: true, verified: true,
        status: "verified", reasons: [] as string[], estimatedReservationMicros: 1_000_000, estimateBasis: "manifest_pricing" },
    ],
  };
  await page.route("**/v1/admin/fusion/preview", (route) => route.fulfill({ json: readiness }));
  await page.goto("/dashboard/access");
  await page.getByRole("tab", { name: /Fusion/ }).click();
  await page.getByLabel("final synthesizer", { exact: true }).fill("example/final");
  await page.getByRole("button", { name: "Check readiness" }).click();
  await expect(page.locator(".fusionReadinessCalls article").first().locator("b")).toHaveText("Price unavailable");
  await expect(page.locator(".fusionReadinessEstimate strong")).toHaveText("$1.00");

  readiness.executable = false;
  readiness.estimatedReservationMicros = 0;
  Object.assign(readiness.calls[1], { executable: false, verified: false, status: "blocked", estimateBasis: "unpriced_request", estimatedReservationMicros: 0 });
  await page.getByRole("button", { name: "Check readiness" }).click();
  await expect(page.locator(".fusionReadinessCalls article b")).toHaveText(["Price unavailable", "Price unavailable"]);
  await expect(page.locator(".fusionReadinessEstimate strong")).toHaveText("$0.00");
});

test("policy and principal budget views show used reservations separately from remaining", async ({ page }) => {
  const state = await fixture(page);
  state.usage.policies.push({
    ...state.usage.policies[0], policyId: "personal", kid: "personal", budgetScope: "principal",
    budget: { configured: true, ledger: "per_principal", limitMicros: 10_000_000, spentMicros: null, remainingMicros: null,
      breakdown: [{ principal: "member@example.com", configured: true, ledger: "ready", limitMicros: 10_000_000, spentMicros: 2_000_000, remainingMicros: 8_000_000 }] },
  });
  await page.goto("/dashboard/usage");
  await expect(page.locator(".budgetUsage").first()).toContainText("$2.00 used");
  await expect(page.locator(".budgetUsage").first()).toContainText("$8.00 remaining · Shared policy pool");
  await expect(page.locator(".budgetUsage").nth(1)).toContainText("Separate balance per principal");
  await expect(page.locator(".budgetBreakdown")).toContainText("$2.00 used");
  await expect(page.locator(".budgetBreakdown")).toContainText("$8.00 remaining");
  await expect(page.locator(".budgetTablePanel")).toContainText("UTC calendar month · Used includes reservations");
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.locator(".quotaNumbers").nth(1)).toContainText("Per-principal balances");
  await expect(page.locator(".quotaPercent").nth(1)).toHaveText("—");
});

for (const principal of ["initial", "changed"] as const) {
  test(`bootstrap failure shows unknown usage for the ${principal} principal`, async ({ page }) => {
    const state = await fixture(page);
    if (principal === "changed") {
      await page.goto("/dashboard/catalog");
      await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
      state.email = "second@example.com";
    }
    state.failBootstrap = true;
    if (principal === "initial") await page.goto("/dashboard/usage");
    else await focusRefresh(page, "2026-07-06T12:01:00.000Z");
    await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
    await expect(page.locator(".statusBar")).toContainText("Console data refresh failed");
    if (principal === "changed") await page.getByRole("button", { name: "Usage", exact: true }).click();
    await expect(page.locator(".usageFreshness")).toContainText("Spend and remaining balances are unknown");
    await expect(page.locator(".usageSummaryGrid .metric strong")).toHaveText(["—", "—", "—", "—"]);
    await expect(page.getByRole("button", { name: "Retry refresh" })).toBeEnabled();
  });
}

for (const failure of ["failUsage", "failBootstrap"] as const) {
  test(`background ${failure} retains the actual snapshot time and recovers on focus`, async ({ page }) => {
    const state = await fixture(page);
    await page.goto("/");
    await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
    const updated = await page.locator(".connectionMeta time").getAttribute("datetime");
    state[failure] = true;
    await focusRefresh(page, "2026-07-06T12:01:00.000Z");
    await expect(page.locator(".connectionMeta strong")).toHaveText("Needs attention");
    await expect(page.locator(".connectionMeta time")).toHaveAttribute("datetime", updated!);
    await expect(page.locator(".usageFreshness time")).toHaveAttribute("datetime", updated!);
    await expect(page.locator(".quotaPanel")).toContainText("last known ledger");
    await expect(page.locator(".quotaNumbers")).toContainText("$8.00");
    state[failure] = false;
    await focusRefresh(page, "2026-07-06T12:02:00.000Z");
    await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
    await expect(page.locator(".connectionMeta time")).toHaveAttribute("datetime", "2026-07-06T12:02:00.000Z");
    await expect(page.locator(".usageFreshness")).toHaveCount(0);
  });
}

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
  await expect(page.locator(".quotaNumbers")).toContainText("$8.00 remaining$10.00 monthly limit · $2.00 used");
  await expect(page.locator(".usageFreshness")).toHaveCount(0);
  expect(state.usageReads).toBe(1);
});

test("same-role principal changes replace the first lazy usage read", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/dashboard/catalog");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  let releaseSession!: () => void;
  state.holdSession = new Promise<void>((resolve) => { releaseSession = resolve; });
  state.email = "second@example.com";
  await focusRefresh(page, "2026-07-06T12:01:00.000Z");
  await expect.poll(() => state.sessionReads).toBe(2);
  let releaseOld!: () => void;
  state.holdUsage = new Promise<void>((resolve) => { releaseOld = resolve; });
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect.poll(() => state.usageReads).toBe(1);
  let releaseCurrent!: () => void;
  state.holdUsage = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  state.usage.policies[0].budget.remainingMicros = 4_000_000;
  releaseSession();
  await expect(page.locator(".tenantSwitch strong")).toHaveText("second@example.com");
  await expect.poll(() => state.usageReads).toBe(2);
  const oldResponse = page.waitForResponse("**/v1/admin/usage");
  releaseOld();
  await oldResponse;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(page.locator(".quotaNumbers")).not.toContainText("$8.00");
  releaseCurrent();
  await expect(page.locator(".quotaNumbers")).toContainText("$4.00 remaining$10.00 monthly limit · $2.00 used");
  await expect(page.locator(".usageFreshness")).toHaveCount(0);
  expect(state.usageReads).toBe(2);
});

for (const readStart of ["before", "after"] as const) {
  test(`a ledger read started ${readStart} metadata refresh keeps its success`, async ({ page }) => {
    const state = await fixture(page);
    await page.goto("/dashboard/catalog");
    await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
    const updated = await page.locator(".connectionMeta time").getAttribute("datetime");
    let releaseUsage!: () => void;
    state.holdUsage = new Promise<void>((resolve) => { releaseUsage = resolve; });
    let releaseBootstrap!: () => void;
    state.holdBootstrap = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
    state.failBootstrap = true;
    if (readStart === "before") {
      await page.getByRole("button", { name: "Dashboard", exact: true }).click();
      await expect.poll(() => state.usageReads).toBe(1);
    }
    await focusRefresh(page, "2026-07-06T12:01:00.000Z");
    await expect.poll(() => state.bootstrapReads).toBe(2);
    if (readStart === "after") {
      await page.getByRole("button", { name: "Dashboard", exact: true }).click();
      await expect.poll(() => state.usageReads).toBe(1);
    }
    releaseUsage();
    await expect(page.locator(".quotaNumbers")).toContainText("$8.00 remaining$10.00 monthly limit · $2.00 used");
    releaseBootstrap();
    await expect(page.locator(".statusBar")).toContainText("Console data refresh failed");
    await expect(page.locator(".connectionMeta time")).toHaveAttribute("datetime", updated!);
    await expect(page.locator(".usageFreshness")).toHaveCount(0);
    await expect(page.locator(".quotaPanel")).toContainText("live ledger");
    expect(state.usageReads).toBe(1);
  });
}

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
    role: "admin", email: "admin@example.com", writes: 0, usageReads: 0, bootstrapReads: 0, sessionReads: 0,
    usage: structuredClone(usage),
    holdUsage: null as Promise<void> | null,
    holdBootstrap: null as Promise<void> | null,
    holdSession: null as Promise<void> | null,
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
    if (path === "/v1/session") {
      state.sessionReads += 1;
      if (state.holdSession) await state.holdSession;
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

const policy = {
  policyId: "team_policy", enabled: true, providers: [], tenantId: "default", monthlyBudgetMicros: 10_000_000, budgetScope: "policy", retainRequestContent: false,
  grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} },
} satisfies AccessPolicy;
const usage: { policies: AdminUsageRow[]; usage: UsageSnapshot } = {
  policies: [{ ...policy, kid: policy.policyId, budget: { configured: true, ledger: "ready", limitMicros: 10_000_000, spentMicros: 2_000_000, remainingMicros: 8_000_000 } }],
  usage: {
    ledger: "ready", providers: [], daily: [], events: [],
    summary: { requestCount: 7, successCount: 6, errorCount: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20, actualCostMicros: 2_000_000 },
  },
};
