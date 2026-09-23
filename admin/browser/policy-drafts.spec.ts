import { expect, test, type Page, type Route } from "@playwright/test";
import type { AccessPolicy, AdminBootstrapResponse, PolicyBinding, UsageSnapshot } from "../src/ui-types";

for (const initialOutcome of ["success", "failure then retry"] as const) {
  test(`initial policy loading preserves an early New draft through ${initialOutcome} without overwriting an existing ID`, async ({ page }) => {
    const state = await fixture(page);
    state.holdBootstrap = true;
    await page.goto("/dashboard/access");
    await expect.poll(() => state.reads.length).toBe(1);
    await page.getByRole("button", { name: "New policy", exact: true }).click();
    await policyId(page).fill("policy_a");
    await page.getByRole("button", { name: "service", exact: true }).click();
    await tenant(page).fill("early-new-draft");
    await expect(page.getByText(/Saving is unavailable until policies load/)).toBeVisible();
    await expect(save(page)).toBeDisabled();
    await tenant(page).focus();
    await page.keyboard.press("Enter");
    expect(state.writes).toHaveLength(0);
    state.holdBootstrap = false;
    if (initialOutcome === "failure then retry") {
      await state.reads[0].route.fulfill({ status: 503, body: "reporting unavailable" });
      await expect(page.locator(".statusBar")).toContainText("reporting unavailable");
      await expect(save(page)).toBeDisabled();
      await expect(tenant(page)).toHaveValue("early-new-draft");
      await page.getByRole("button", { name: "Retry refresh", exact: true }).click();
    } else await state.reads[0].route.fulfill({ json: state.reads[0].body });
    await expect(row(page, "policy_a").locator('[data-label="tenant"]')).toHaveText("default");
    await expect(save(page)).toBeEnabled();
    await expect(page.getByText(/Saving is unavailable until policies load/)).toHaveCount(0);
    await expect(tenant(page)).toHaveValue("early-new-draft");
    await expect(policyId(page)).not.toHaveAttribute("readonly", "");
    await save(page).click();
    await expect(page.locator(".inspector .inlineError")).toContainText("policy id already exists");
    expect(state.writes).toHaveLength(0);
    await policyId(page).fill("policy_new");
    await save(page).click();
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0].request().postDataJSON()).toMatchObject({ policyId: "policy_new", tenantId: "early-new-draft" });
    await state.commit(0);
    await expect(row(page, "policy_new").locator('[data-label="tenant"]')).toHaveText("early-new-draft");
    await expect(row(page, "policy_a").locator('[data-label="tenant"]')).toHaveText("default");
  });
}

for (const destination of ["other policy", "New", "same policy"] as const) {
  test(`a held save keeps later edits to ${destination} and releases admission before refresh`, async ({ page }) => {
    const state = await fixture(page);
    await open(page);
    await tenant(page).fill("submitted-a");
    await save(page).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => state.writes.length).toBe(1);
    await expect(save(page)).toBeDisabled();
    if (destination !== "same policy") {
      page.once("dialog", (dialog) => dialog.accept());
      if (destination === "New") await page.getByRole("button", { name: "New policy", exact: true }).click();
      else await row(page, "policy_b").click();
    }
    await tenant(page).fill("later-draft");
    if (destination === "New") await policyId(page).fill("new_policy");
    state.holdBootstrap = true;
    await state.commit(0, { tenantId: "canonical-a" });
    await expect.poll(() => state.reads.length).toBe(1);
    await expect(save(page)).toBeEnabled();
    await expect(tenant(page)).toHaveValue("later-draft");
    await expect(policyId(page)).toHaveValue(destination === "New" ? "new_policy" : destination === "other policy" ? "policy_b" : "policy_a");
    await expect(row(page, "policy_a").locator('[data-label="tenant"]')).toHaveText("canonical-a");
    state.reads[0].body.policies = state.reads[0].body.policies.map((policy) => policy.policyId === "policy_b" ? { ...policy, tenantId: "refresh-observed" } : policy);
    await state.reads[0].route.fulfill({ json: state.reads[0].body });
    await expect(row(page, "policy_b").locator('[data-label="tenant"]')).toHaveText("refresh-observed");
    await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
    await expect(tenant(page)).toHaveValue("later-draft");
    await expect(policyId(page)).toHaveValue(destination === "New" ? "new_policy" : destination === "other policy" ? "policy_b" : "policy_a");
    expect(state.writes).toHaveLength(1);
  });
}

test("a clean reselected policy adopts its held save before a failed refresh and the next save", async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await tenant(page).fill("submitted-a");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  page.once("dialog", (dialog) => dialog.accept());
  await row(page, "policy_b").click();
  await row(page, "policy_a").click();
  await expect(tenant(page)).toHaveValue("default");
  await expect(page.getByText("Unsaved policy changes.", { exact: true })).toHaveCount(0);
  state.holdBootstrap = true;
  await state.commit(0, { tenantId: "canonical-a" });
  await expect.poll(() => state.reads.length).toBe(1);
  await expect(row(page, "policy_a").locator('[data-label="tenant"]')).toHaveText("canonical-a");
  await expect(tenant(page)).toHaveValue("canonical-a");
  await expect(page.getByText("Unsaved policy changes.", { exact: true })).toHaveCount(0);
  await expect(save(page)).toBeEnabled();
  state.holdBootstrap = false;
  state.failBootstrap = true;
  await state.reads[0].route.fulfill({ status: 503, body: "reporting unavailable" });
  await expect(page.locator(".statusBar")).toContainText("reporting unavailable");
  await expect(tenant(page)).toHaveValue("canonical-a");
  await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0);
  await save(page).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].request().postDataJSON()).toMatchObject({ policyId: "policy_a", tenantId: "canonical-a", enabled: true });
  await state.commit(1);
  await expect(save(page)).toBeEnabled();
  await expect(tenant(page)).toHaveValue("canonical-a");
});

test("sibling saves, failures and refreshes preserve the policy draft and its own error", async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await tenant(page).fill("policy-draft");
  await page.getByRole("tab", { name: /^Bindings/ }).click();
  await page.getByRole("textbox", { name: "priority", exact: true }).fill("7");
  state.policies[0] = { ...state.policies[0], tenantId: "server-after-binding" };
  await page.getByRole("button", { name: "Save binding", exact: true }).click();
  await expect(row(page, "maintainers").locator('[data-label="priority"]')).toHaveText("7");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await page.getByRole("tab", { name: /^Policies/ }).click();
  await expect(tenant(page)).toHaveValue("policy-draft");
  state.failBinding = true;
  await page.getByRole("tab", { name: /^Bindings/ }).click();
  await page.getByRole("button", { name: "Save binding", exact: true }).click();
  await expect(page.locator(".inspector .inlineError")).toContainText("binding unavailable");
  await page.getByRole("tab", { name: /^Policies/ }).click();
  await expect(page.locator(".inspector .inlineError")).toHaveCount(0);
  await expect(tenant(page)).toHaveValue("policy-draft");

  state.failBootstrap = true;
  await focus(page, state);
  await expect(page.locator(".statusBar")).toContainText("reporting unavailable");
  state.failBootstrap = false;
  state.policies[0] = { ...state.policies[0], tenantId: "latest-server" };
  state.groups = ["refreshed-group"];
  expect(state.usageReads).toBe(0);
  await page.getByRole("button", { name: "Retry refresh", exact: true }).click();
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  expect(state.usageReads).toBe(1);
  await expect(page.getByRole("button", { name: "Retry refresh", exact: true })).toHaveCount(0);
  await expect(tenant(page)).toHaveValue("policy-draft");
  await page.getByRole("button", { name: "Discard changes", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(tenant(page)).toHaveValue("latest-server");
  await expect(page.getByText("Unsaved policy changes.", { exact: true })).toHaveCount(0);
});

for (const order of ["write fails first", "refresh finishes first"] as const) {
  test(`an older Retry preserves a later policy failure and draft when ${order}`, async ({ page }) => {
    const state = await fixture(page);
    await open(page);
    state.failBootstrap = true;
    await focus(page, state);
    await expect(page.locator(".statusBar")).toContainText("reporting unavailable");
    state.failBootstrap = false;
    state.holdBootstrap = true;
    await page.clock.setFixedTime(new Date("2026-09-01T00:02:00.000Z"));
    await page.getByRole("button", { name: "Retry refresh", exact: true }).click();
    await expect.poll(() => state.reads.length).toBe(1);
    await tenant(page).fill("submitted-a");
    await save(page).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => state.writes.length).toBe(1);
    await tenant(page).fill("later-draft");
    const rejectWrite = () => state.writes[0].fulfill({ status: 503, json: { error: { message: "policy unavailable" } } });
    if (order === "write fails first") {
      await rejectWrite();
      await expect(save(page)).toBeEnabled();
    }
    state.holdBootstrap = false;
    await state.reads[0].route.fulfill({ json: state.reads[0].body });
    await expect(page.locator(".connectionMeta time")).toHaveAttribute("datetime", "2026-09-01T00:02:00.000Z");
    await expect(page.getByRole("button", { name: "Retry refresh", exact: true })).toHaveCount(0);
    expect(state.usageReads).toBe(1);
    if (order === "refresh finishes first") {
      await expect(page.locator(".statusBar")).toContainText("saving policy");
      await rejectWrite();
    }
    await expect(page.locator(".connectionMeta strong")).toHaveText("Needs attention");
    await expect(page.locator(".statusBar")).toContainText("policy save failed (policy_a):");
    await expect(page.locator(".statusBar")).toContainText("policy unavailable");
    await expect(page.locator(".statusBar")).not.toContainText("reporting unavailable");
    await expect(page.locator(".inspector .inlineError")).toHaveCount(0);
    await expect(tenant(page)).toHaveValue("later-draft");
    await expect(save(page)).toBeEnabled();
    expect(state.writes).toHaveLength(1);
  });
}

for (const outcome of ["connected", "failed"] as const) {
  test(`an unchanged foreground refresh preserves the ${outcome} OAuth callback`, async ({ page }) => {
    await fixture(page);
    await page.goto(`/dashboard/access?oauth=${outcome}&provider=test-provider`);
    await expect(page.locator(".connectionMeta time")).toHaveAttribute("datetime", "2026-09-01T00:00:00.000Z");
    await expect(page.locator(".connectionMeta strong")).toHaveText(outcome === "connected" ? "Connected" : "Needs attention");
    if (outcome === "failed") await expect(page.locator(".statusBar")).toContainText("test-provider OAuth failed");
    else await expect(page.locator(".statusBar")).toHaveCount(0);
  });
}

test("a selected policy deleted by refresh stays visible as missing until explicit New", async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await tenant(page).fill("keep-deleted-draft");
  state.policies = state.policies.filter((policy) => policy.policyId !== "policy_a");
  await focus(page, state);
  await expect(page.getByRole("alert")).toContainText("This policy is no longer available. Your draft is preserved.");
  await expect(policyId(page)).toHaveValue("policy_a");
  await expect(policyId(page)).toHaveAttribute("readonly", "");
  await expect(tenant(page)).toHaveValue("keep-deleted-draft");
  await expect(save(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toBeDisabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New policy", exact: true }).click();
  await expect(policyId(page)).toHaveValue("");
  await expect(policyId(page)).not.toHaveAttribute("readonly", "");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test("failed saves retain the draft and retry commits the canonical response", async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await tenant(page).fill("retry-draft");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await state.writes[0].fulfill({ status: 503, json: { error: { message: "policy unavailable" } } });
  await expect(page.locator(".inspector .inlineError")).toContainText("policy unavailable");
  await expect(tenant(page)).toHaveValue("retry-draft");
  await expect(save(page)).toBeEnabled();
  await save(page).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.writes.length).toBe(2);
  state.failBootstrap = true;
  await state.commit(1, { tenantId: "canonical-retry" });
  await expect(tenant(page)).toHaveValue("canonical-retry");
  await expect(page.locator(".inspector .inlineError")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0);
  await expect(page.locator(".statusBar")).toContainText("saved policy");
  await expect(page.locator(".statusBar")).toContainText("reporting unavailable");
  await expect(save(page)).toBeEnabled();
});

test("a pre-write bootstrap cannot replace the committed policy, and refresh begins a fresh read", async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  state.holdBootstrap = true;
  await focus(page, state);
  await expect.poll(() => state.reads.length).toBe(1);
  await tenant(page).fill("new-canonical");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await state.commit(0);
  await expect(tenant(page)).toHaveValue("new-canonical");
  await state.reads[0].route.fulfill({ json: state.reads[0].body });
  await expect.poll(() => state.reads.length).toBe(2);
  await expect(row(page, "policy_a").locator('[data-label="tenant"]')).toHaveText("new-canonical");
  await state.reads[1].route.fulfill({ json: state.reads[1].body });
  await expect(tenant(page)).toHaveValue("new-canonical");
  expect(state.writes).toHaveLength(1);
});

test("tenant edit, Disable, then Save preserves both the edit and the disabled state", async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await tenant(page).fill("keep-tenant-edit");
  await page.getByRole("button", { name: "Disable policy", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].request().method()).toBe("POST");
  expect(new URL(state.writes[0].request().url()).pathname).toBe("/v1/admin/policies/policy_a/revoke");
  await state.commit(0);
  await expect(page.getByRole("combobox", { name: "status", exact: true })).toHaveValue("disabled");
  await expect(tenant(page)).toHaveValue("keep-tenant-edit");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].request().postDataJSON()).toMatchObject({ enabled: false, tenantId: "keep-tenant-edit" });
  await state.commit(1);
  await expect(row(page, "policy_a").locator('[data-label="state"]')).toHaveText("revoked");
  await expect(row(page, "policy_a").locator('[data-label="tenant"]')).toHaveText("keep-tenant-edit");
  await expect(page.getByText("Unsaved policy changes.", { exact: true })).toHaveCount(0);
});

test("returning to the original value during a save stays unsaved after commit and refresh", async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await tenant(page).fill("submitted-change");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await tenant(page).fill("default");
  await expect(page.getByText("Unsaved policy changes.", { exact: true })).toHaveCount(0);
  state.holdBootstrap = true;
  await state.commit(0);
  await expect.poll(() => state.reads.length).toBe(1);
  await expect(page.getByText("Unsaved policy changes.", { exact: true })).toBeVisible();
  state.reads[0].body.policies = state.reads[0].body.policies.map((policy) => policy.policyId === "policy_b" ? { ...policy, tenantId: "refresh-observed" } : policy);
  await state.reads[0].route.fulfill({ json: state.reads[0].body });
  await expect(row(page, "policy_b").locator('[data-label="tenant"]')).toHaveText("refresh-observed");
  await expect(tenant(page)).toHaveValue("default");
  await page.getByRole("button", { name: "Discard changes", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(tenant(page)).toHaveValue("submitted-change");
});

test("typing during New policy creation keeps the created identity for the next Save", async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await page.getByRole("button", { name: "New policy", exact: true }).click();
  await policyId(page).fill("policy_new");
  await page.getByRole("button", { name: "service", exact: true }).click();
  await tenant(page).fill("submitted-new");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await tenant(page).fill("later-edit");
  state.holdBootstrap = true;
  await state.commit(0);
  await expect.poll(() => state.reads.length).toBe(1);
  await expect(row(page, "policy_new")).toHaveClass(/selected/);
  await expect(policyId(page)).toHaveAttribute("readonly", "");
  state.reads[0].body.policies = state.reads[0].body.policies.map((policy) => policy.policyId === "policy_b" ? { ...policy, tenantId: "refresh-observed" } : policy);
  await state.reads[0].route.fulfill({ json: state.reads[0].body });
  await expect(row(page, "policy_b").locator('[data-label="tenant"]')).toHaveText("refresh-observed");
  await expect(tenant(page)).toHaveValue("later-edit");
  await save(page).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.writes.length).toBe(2);
  expect(new URL(state.writes[1].request().url()).pathname).toBe("/v1/admin/policies/policy_new");
  expect(state.writes[1].request().postDataJSON()).toMatchObject({ tenantId: "later-edit" });
  state.holdBootstrap = false;
  await state.commit(1);
  await expect(row(page, "policy_new").locator('[data-label="tenant"]')).toHaveText("later-edit");
  await expect(page.locator(".inspector .inlineError")).toHaveCount(0);
  await expect(page.getByText("Unsaved policy changes.", { exact: true })).toHaveCount(0);
  expect(state.policies.filter((policy) => policy.policyId === "policy_new")).toHaveLength(1);
});

test("demo New drafts survive navigation, deliberate discard, save and keyboard reset", async ({ page }) => {
  await page.route("**/v1/**", (route) => route.fulfill({ status: 503, json: { error: { message: "Demo fixture" } } }));
  await page.goto("/dashboard/access?demo=1");
  const originalId = await policyId(page).inputValue();
  await tenant(page).fill("demo-unsaved");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "New policy", exact: true }).click();
  await expect(policyId(page)).toHaveValue(originalId);
  await expect(tenant(page)).toHaveValue("demo-unsaved");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New policy", exact: true }).click();
  await policyId(page).fill("demo_policy_draft");
  await tenant(page).fill("demo-saved");
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await expect(policyId(page)).toHaveValue("demo_policy_draft");
  await expect(tenant(page)).toHaveValue("demo-saved");
  await save(page).focus();
  await page.keyboard.press("Enter");
  await expect(row(page, "demo_policy_draft")).toHaveClass(/selected/);
  await tenant(page).fill("demo-discard");
  await page.getByRole("button", { name: "Discard changes", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(tenant(page)).toHaveValue("demo-saved");
  await expect(page.getByText("Unsaved policy changes.", { exact: true })).toHaveCount(0);
  await tenant(page).fill("demo-disabled-edit");
  await page.getByRole("button", { name: "Disable policy", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "status", exact: true })).toHaveValue("disabled");
  await expect(tenant(page)).toHaveValue("demo-disabled-edit");
  await save(page).click();
  await expect(row(page, "demo_policy_draft").locator('[data-label="state"]')).toHaveText("revoked");
  await expect(row(page, "demo_policy_draft").locator('[data-label="tenant"]')).toHaveText("demo-disabled-edit");
  await expect(page.getByText("Unsaved policy changes.", { exact: true })).toHaveCount(0);
});

function tenant(page: Page) { return page.getByRole("textbox", { name: "tenant", exact: true }); }
function policyId(page: Page) { return page.getByRole("textbox", { name: "policy id", exact: true }); }
function save(page: Page) { return page.getByRole("button", { name: "Save policy", exact: true }); }
function row(page: Page, id: string) { return page.locator(".tableRow").filter({ has: page.getByText(id, { exact: true }) }); }
async function open(page: Page) { await page.goto("/dashboard/access"); await expect(page.locator(".connectionMeta strong")).toHaveText("Connected"); }
async function focus(page: Page, state: { refreshes: number }) {
  state.refreshes += 1;
  await page.clock.setFixedTime(new Date(Date.UTC(2026, 8, 1, 0, state.refreshes)));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

async function fixture(page: Page) {
  await page.clock.setFixedTime(new Date("2026-09-01T00:00:00.000Z"));
  const policies: AccessPolicy[] = ["policy_a", "policy_b"].map((policyId) => ({
    policyId, enabled: true, providers: [], tenantId: "default", retainRequestContent: false,
    grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} },
  }));
  const providers = [{ id: "test-provider", display_name: "Test provider", class: "test", service_kind: "model_provider", capabilities: [] }];
  const usage: UsageSnapshot = { ledger: "ready", summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 }, providers: [], daily: [], events: [] };
  const state = {
    policies, groups: [] as string[], failBinding: false, failBootstrap: false, holdBootstrap: false, refreshes: 0, usageReads: 0,
    bindings: [{ policyId: "policy_b", principalType: "group", principalId: "maintainers", enabled: true, priority: 100 }] as PolicyBinding[],
    writes: [] as Route[], reads: [] as { route: Route; body: AdminBootstrapResponse }[],
    async commit(index: number, overrides: Partial<AccessPolicy> = {}) {
      const request = state.writes[index].request();
      const policy = { ...(request.method() === "POST" ? { ...state.policies.find((item) => item.policyId === new URL(request.url()).pathname.split("/").at(-2)), enabled: false } : request.postDataJSON()), ...overrides } as AccessPolicy & { allProviders?: boolean };
      delete policy.allProviders;
      state.policies = [policy, ...state.policies.filter((item) => item.policyId !== policy.policyId)];
      await state.writes[index].fulfill({ json: policy });
    },
  };
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/admin/usage") state.usageReads += 1;
    if (path.startsWith("/v1/admin/policies/") && (route.request().method() === "PUT" || (route.request().method() === "POST" && path.endsWith("/revoke")))) { state.writes.push(route); return; }
    if (route.request().method() === "PUT" && path === "/v1/admin/policy-bindings") {
      if (state.failBinding) { await route.fulfill({ status: 503, json: { error: { message: "binding unavailable" } } }); return; }
      const binding = route.request().postDataJSON() as PolicyBinding;
      state.bindings = [binding];
      await route.fulfill({ json: binding });
      return;
    }
    const bootstrap: AdminBootstrapResponse = {
      policies: state.policies, bindings: state.bindings, credentials: [], connections: [], users: [], grants: [], rules: [], providers: [], tenants: [],
      overview: { policiesTotal: state.policies.length, policiesActive: state.policies.filter((policy) => policy.enabled).length, tenantsTotal: 1, keysTotal: 0, keysActive: 0, providerCount: providers.length, openaiCompatibleProviders: 0, manifestRoutes: 0, monthlyBudgetMicros: 0, requestCostMicros: 0 },
      fusion: { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "", adviserTimeoutMs: 10_000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 },
    };
    if (path === "/v1/admin/bootstrap") {
      if (state.failBootstrap) { await route.fulfill({ status: 503, body: "reporting unavailable" }); return; }
      if (state.holdBootstrap) { state.reads.push({ route, body: structuredClone(bootstrap) }); return; }
    }
    const responses: Record<string, unknown> = {
      "/v1/providers": { providers }, "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: "admin@example.com", tenantId: "default", groups: state.groups, entitlements: { providers: [] } },
      "/v1/session/usage": { policies: [] }, "/v1/session/credentials": { credentials: [] }, "/v1/admin/bootstrap": bootstrap,
      "/v1/admin/usage": { policies: state.policies.map((policy) => ({ ...policy, budget: { configured: false, ledger: "ready" } })), usage },
    };
    await route.fulfill({ status: responses[path] ? 200 : 404, json: responses[path] ?? {} });
  });
  return state;
}
