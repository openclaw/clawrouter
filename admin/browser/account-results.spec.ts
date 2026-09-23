import { expect, test, type Page, type Route } from "@playwright/test";
import type { AccessPolicy, AdminBootstrapResponse, UpstreamGrant } from "../src/ui-types";

for (const action of ["Save grant", "Connect with provider"]) {
  test(`early policy draft ${action} uses the displayed first inventory scope`, async ({ page }) => {
    const state = await openAccounts(page, true, true);
    await page.getByRole("button", { name: "New grant", exact: true }).click();
    const scope = page.getByLabel("scope id", { exact: true });
    await expect(scope).toHaveValue("");
    await expect(scope.locator("option:checked")).toHaveText("Select a policy");
    await page.getByLabel("token reference", { exact: true }).fill("account_a");
    await page.getByLabel("API key", { exact: true }).fill("synthetic-early-primary");
    await page.getByLabel("label", { exact: true }).fill("early policy draft");
    await expect(page.getByRole("button", { name: action, exact: true })).toBeDisabled();
    if (action === "Connect with provider") {
      await state.reads[0].route.fulfill({ status: 503, json: { error: { message: "reporting offline" } } });
      await expect(page.locator(".statusBar")).toContainText("Console data refresh failed");
      await expect(scope).toHaveValue("");
      await page.getByRole("button", { name: "Retry refresh", exact: true }).click();
      await expect.poll(() => state.reads.length).toBe(2);
    }
    const read = state.reads.at(-1)!;
    if (action === "Save grant") read.body.grants = [];
    await read.route.fulfill({ json: read.body });
    await expect(scope).toHaveValue("team_policy");
    await expect(scope.locator("option:checked")).toHaveText("team_policy");
    await expect(page.getByLabel("provider", { exact: true })).toHaveValue("test-provider");
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("early policy draft");
    await expect(page.getByLabel("API key", { exact: true })).toHaveValue("synthetic-early-primary");
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0].request().method()).toBe(action === "Save grant" ? "PUT" : "POST");
    expect(new URL(state.writes[0].request().url()).pathname).toBe(`/v1/admin/upstream-grants/policies/team_policy/account_a${action === "Save grant" ? "" : "/authorize"}`);
    expect(state.writes[0].request().postDataJSON().provider).toBe("test-provider");
    await state.writes[0].fulfill({ status: 400, json: { error: { message: "synthetic rejection" } } });
  });
}

test("empty first policy inventory stays unselected until an explicit later choice", async ({ page }) => {
  const state = await openAccounts(page, true);
  await page.getByRole("button", { name: "New grant", exact: true }).click();
  await page.getByLabel("API key", { exact: true }).fill("synthetic-early-primary");
  state.reads[0].body.policies = [];
  await state.reads[0].route.fulfill({ json: state.reads[0].body });
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  const scope = page.getByLabel("scope id", { exact: true });
  await expect(scope).toHaveValue("");
  await expect(scope.locator("option:checked")).toHaveText("Select a policy");
  await expect(page.getByRole("button", { name: "Save grant", exact: true })).toBeDisabled();
  await page.locator(".inspector form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(state.writes).toHaveLength(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.reads.length).toBe(2);
  await state.reads[1].route.fulfill({ json: state.reads[1].body });
  await expect(scope.locator("option")).toHaveText(["Select a policy", "team_policy"]);
  await expect(scope).toHaveValue("");
  await expect(page.getByRole("button", { name: "Save grant", exact: true })).toBeDisabled();
  await scope.selectOption("team_policy");
  await expect(page.getByRole("button", { name: "Save grant", exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(0);
});

test("unavailable account identities remain visible instead of displaying the first options", async ({ page }) => {
  await openAccounts(page, false, false, [grant("account_a", { key: "oauth/removed_policy/account_a", scopeId: "removed_policy", provider: "removed-provider" })]);
  const scope = page.getByLabel("scope id", { exact: true }), provider = page.getByLabel("provider", { exact: true });
  await expect(scope).toHaveValue("removed_policy");
  await expect(scope.locator("option:checked")).toHaveText("removed_policy (unavailable)");
  await expect(provider).toHaveValue("removed-provider");
  await expect(provider.locator("option:checked")).toHaveText("removed-provider (unavailable)");
  await page.getByRole("button", { name: "New grant", exact: true }).click();
  await expect(scope).toHaveValue("team_policy");
  await expect(provider).toHaveValue("test-provider");
});

for (const firstReadFails of [false, true]) {
  test(`initial account loading blocks writes and preserves early drafts${firstReadFails ? " through failure and retry" : ""}`, async ({ page }) => {
    const state = await openAccounts(page, true, true);
    await page.getByRole("button", { name: "New grant", exact: true }).click();
    await page.getByLabel("scope", { exact: true }).selectOption("tenants");
    await page.getByLabel("scope id", { exact: true }).fill("default");
    await page.getByLabel("token reference", { exact: true }).fill("account_a");
    await page.getByLabel("API key", { exact: true }).fill("synthetic-early-primary");
    await page.getByLabel("label", { exact: true }).fill("early draft");
    const save = page.getByRole("button", { name: "Save grant", exact: true });
    await expect(save).toBeDisabled();
    await expect(page.getByRole("button", { name: "Connect with provider", exact: true })).toBeDisabled();
    await expect(page.locator(".inspector")).toContainText("Upstream accounts have not loaded");
    await page.locator(".inspector form").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await flush(page);
    expect(state.writes).toHaveLength(0);
    if (firstReadFails) {
      await state.reads[0].route.fulfill({ status: 503, json: { error: { message: "reporting offline" } } });
      await expect(page.locator(".statusBar")).toContainText("Console data refresh failed");
      await expect(save).toBeDisabled();
      await page.getByRole("button", { name: "Retry refresh", exact: true }).click();
      await expect.poll(() => state.reads.length).toBe(2);
    }
    const read = state.reads.at(-1)!;
    await read.route.fulfill({ json: read.body });
    await expect(save).toBeEnabled();
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("early draft");
    await expect(page.getByLabel("API key", { exact: true })).toHaveValue("synthetic-early-primary");
    await expect(page.locator(".tableRow").filter({ hasText: "Account A" })).toBeVisible();
    await expect(page.locator(".inspector")).toContainText("New upstream grant");
    expect(state.writes).toHaveLength(0);
  });
}

test("held OAuth authorization blocks account writes and failure restores them", async ({ page }) => {
  const state = await openAccounts(page, false, true);
  state.holdBootstrap = true;
  const connect = page.getByRole("button", { name: "Reconnect with provider", exact: true });
  await connect.click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].request().method()).toBe("POST");
  expect(new URL(state.writes[0].request().url()).pathname).toBe("/v1/admin/upstream-grants/policies/team_policy/account_a/authorize");
  await expect(connect).toBeDisabled();
  for (const name of ["Save grant", "Revoke", "Refresh token", "Refresh quota"]) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  await page.locator(".inspector form").evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  await flush(page);
  expect(state.writes).toHaveLength(1);
  await state.writes[0].fulfill({ status: 503, json: { error: { message: "authorization unavailable" } } });
  await expect(page.locator(".inspector")).toContainText("authorization unavailable");
  await expect(connect).toBeEnabled();
  for (const name of ["Save grant", "Revoke", "Refresh token", "Refresh quota"]) await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Save grant", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].request().method()).toBe("PUT");
  expect(new URL(state.writes[1].request().url()).pathname).toBe("/v1/admin/upstream-grants/policies/team_policy/account_a");
  await state.writes[1].fulfill({ json: grant() });
  await expect(page.getByRole("button", { name: "Save grant", exact: true })).toBeEnabled();
});

for (const [action, method, suffix] of [["Save grant", "PUT", ""], ["Revoke", "POST", "/revoke"], ["Refresh token", "POST", "/refresh"], ["Refresh quota", "POST", "/quota-refresh"]] as const) {
  test(`${action} shows its canonical result before a held, then failed bootstrap`, async ({ page }) => {
    const state = await openAccounts(page);
    state.holdBootstrap = true;
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0].request().method()).toBe(method);
    expect(new URL(state.writes[0].request().url()).pathname).toBe(`/v1/admin/upstream-grants/policies/team_policy/account_a${suffix}`);
    await expect(page.getByRole("button", { name: "Save grant", exact: true })).toBeDisabled();
    await page.getByLabel("label", { exact: true }).fill("later draft");
    const saved = action === "Revoke" ? revoked() : grant("account_a", {
      priority: 7, expiresAt: "2030-01-01T00:00:00Z", quotaStatus: "limited",
      quotaWindows: [{ id: "monthly", kind: "requests", unit: "requests", window: "month", remaining: 0, limit: 10, resetAt: null }],
    });
    await state.writes[0].fulfill({ json: saved });
    await expect(page.locator('.tableRow.selected [data-label="state"]')).toHaveText(action === "Revoke" ? "revoked" : "limited");
    await expect(page.getByLabel("pool priority", { exact: true })).toHaveValue(String(saved.priority));
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("later draft");
    await expect(page.getByRole("button", { name: "Save grant", exact: true })).toBeEnabled();
    await expect.poll(() => state.reads.length).toBe(1);
    if (action === "Revoke") await expect(page.locator(".inspector .facts").getByText("missing", { exact: true })).toBeVisible();
    else await expect(page.locator(".inspector .facts")).toContainText("monthly (month) 0/10 requests");
    await state.reads[0].route.fulfill({ status: 503, json: { error: { message: "reporting offline" } } });
    await expect(page.locator(".statusBar")).toContainText("Console data refresh failed");
    await expect(page.locator('.tableRow.selected [data-label="state"]')).toHaveText(action === "Revoke" ? "revoked" : "limited");
    await expect(page.getByRole("button", { name: "Save grant", exact: true })).toBeEnabled();
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("later draft");
    expect(state.writes).toHaveLength(1);
  });
}

test("Save then keyboard Revoke proceeds during held metadata and old cleanup cannot release it", async ({ page }) => {
  const state = await openAccounts(page);
  state.holdBootstrap = true;
  const save = page.getByRole("button", { name: "Save grant", exact: true });
  await page.locator(".inspector form").evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
  await expect.poll(() => state.writes.length).toBe(1);
  await state.writes[0].fulfill({ json: grant("account_a", { label: "saved first" }) });
  await expect(save).toBeEnabled();
  await expect.poll(() => state.reads.length).toBe(1);
  const revoke = page.getByRole("button", { name: "Revoke", exact: true });
  await revoke.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.writes.length).toBe(2);
  await expect(save).toBeDisabled();
  await state.reads[0].route.fulfill({ json: state.reads[0].body });
  await flush(page);
  await expect(save).toBeDisabled();
  await expect(page.getByLabel("label", { exact: true })).toHaveValue("saved first");
  await state.writes[1].fulfill({ json: revoked() });
  await expect(page.locator('.tableRow.selected [data-label="state"]')).toHaveText("revoked");
  await expect(save).toBeEnabled();
  await expect.poll(() => state.reads.length).toBe(2);
  await state.reads[1].route.fulfill({ json: state.reads[1].body });
  await flush(page);
  await expect(page.locator('.tableRow.selected [data-label="state"]')).toHaveText("revoked");
  await expect(page.getByLabel("state", { exact: true })).toHaveValue("disabled");
  await expect(revoke).toBeDisabled();
  expect(state.writes).toHaveLength(2);
});

for (const action of ["Refresh token", "Refresh quota"] as const) {
  test(`${action} preserves unsaved secrets and metadata present before dispatch`, async ({ page }) => {
    const state = await openAccounts(page);
    state.holdBootstrap = true;
    await page.getByLabel("label", { exact: true }).fill("unsaved label");
    await page.getByLabel("replace access token", { exact: true }).fill("synthetic-unsaved-access");
    await page.getByLabel("replace refresh token", { exact: true }).fill("synthetic-unsaved-refresh");
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    await page.getByLabel("routing weight", { exact: true }).fill("3");
    await state.writes[0].fulfill({ json: grant("account_a", { expiresAt: "2030-01-01T00:00:00Z" }) });
    await expect(page.getByLabel("expires at", { exact: true })).toHaveValue("2030-01-01T00:00:00Z");
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("unsaved label");
    await expect(page.getByLabel("routing weight", { exact: true })).toHaveValue("3");
    await expect(page.getByLabel("replace access token", { exact: true })).toHaveValue("synthetic-unsaved-access");
    await expect(page.getByLabel("replace refresh token", { exact: true })).toHaveValue("synthetic-unsaved-refresh");
    expect(state.writes[0].request().postData()).toBeNull();
  });
}

for (const destination of ["away and back", "New"] as const) {
  test(`a pending account save cannot steal a ${destination} editor`, async ({ page }) => {
    const state = await openAccounts(page);
    state.holdBootstrap = true;
    await page.getByRole("button", { name: "Save grant", exact: true }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    if (destination === "New") await page.getByRole("button", { name: "New grant", exact: true }).click();
    else {
      await page.locator(".tableRow").filter({ hasText: "Account B" }).click();
      await page.locator(".tableRow").filter({ hasText: "Account A" }).click();
    }
    await page.getByLabel("label", { exact: true }).fill("replacement draft");
    await state.writes[0].fulfill({ json: grant("account_a", { label: "saved account" }) });
    await expect(page.locator(".tableRow").filter({ hasText: "saved account" })).toBeVisible();
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("replacement draft");
    if (destination === "New") await expect(page.locator(".inspector")).toContainText("New upstream grant");
    else await expect(page.locator(".inspector")).toContainText("oauth/team_policy/account_a");
  });
}

test("New save adopts its account for another save while metadata remains held", async ({ page }) => {
  const state = await openAccounts(page);
  state.holdBootstrap = true;
  await page.getByRole("button", { name: "New grant", exact: true }).click();
  await page.getByLabel("token reference", { exact: true }).fill("created");
  await page.getByLabel("API key", { exact: true }).fill("synthetic-created-primary");
  await page.getByLabel("label", { exact: true }).fill("submitted");
  await page.getByRole("button", { name: "Save grant", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.getByLabel("label", { exact: true }).fill("later edit");
  await state.writes[0].fulfill({ json: grant("created", { kind: "api_key", hasCredential: true, label: "submitted" }) });
  await expect(page.getByLabel("replace API key", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("label", { exact: true })).toHaveValue("later edit");
  await expect.poll(() => state.reads.length).toBe(1);
  await page.getByRole("button", { name: "Save grant", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(new URL(state.writes[1].request().url()).pathname).toBe("/v1/admin/upstream-grants/policies/team_policy/created");
  expect(state.writes[1].request().postDataJSON()).toMatchObject({ label: "later edit", enabled: true });
  expect(state.writes[1].request().postDataJSON().credential).toBeUndefined();
  await state.writes[1].fulfill({ json: grant("created", { kind: "api_key", hasCredential: true, label: "later edit" }) });
  await expect(page.getByRole("button", { name: "Save grant", exact: true })).toBeEnabled();
});

test("returning to a pending pause adopts its state without discarding a replacement draft", async ({ page }) => {
  const state = await openAccounts(page);
  state.holdBootstrap = true;
  await page.getByLabel("state", { exact: true }).selectOption("disabled");
  await page.getByRole("button", { name: "Save grant", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.locator(".tableRow").filter({ hasText: "Account B" }).click();
  await page.locator(".tableRow").filter({ hasText: "Account A" }).click();
  await page.getByLabel("label", { exact: true }).fill("replacement draft");
  await state.writes[0].fulfill({ json: grant("account_a", { enabled: false, label: "confirmed pause" }) });
  await expect(page.getByLabel("state", { exact: true })).toHaveValue("disabled");
  await expect(page.getByLabel("label", { exact: true })).toHaveValue("replacement draft");
  await expect(page.locator('.tableRow.selected [data-label="state"]')).toHaveText("paused");
  await expect.poll(() => state.reads.length).toBe(1);
  await page.getByLabel("label", { exact: true }).fill("next label");
  await page.getByRole("button", { name: "Save grant", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].request().postDataJSON()).toMatchObject({ enabled: false, label: "next label" });
  await state.writes[1].fulfill({ json: grant("account_a", { enabled: false, label: "next label" }) });
  await expect(page.getByRole("button", { name: "Save grant", exact: true })).toBeEnabled();
});

test("an older bootstrap cannot replace a confirmed result, including a later edit back to baseline", async ({ page }) => {
  const state = await openAccounts(page);
  state.holdBootstrap = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.reads.length).toBe(1);
  await page.getByLabel("label", { exact: true }).fill("submitted");
  await page.getByRole("button", { name: "Save grant", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.getByLabel("label", { exact: true }).fill("Account A");
  await state.writes[0].fulfill({ json: grant("account_a", { label: "submitted", priority: 7 }) });
  await expect(page.getByLabel("pool priority", { exact: true })).toHaveValue("7");
  await state.reads[0].route.fulfill({ json: state.reads[0].body });
  await expect.poll(() => state.reads.length).toBe(2);
  await state.reads[1].route.fulfill({ json: state.reads[1].body });
  await flush(page);
  await expect(page.getByLabel("label", { exact: true })).toHaveValue("Account A");
  await expect(page.getByLabel("pool priority", { exact: true })).toHaveValue("7");
  await expect(page.locator(".tableRow").filter({ hasText: "submitted" })).toBeVisible();
});

test("a lost save response preserves edit-back through reconciliation and the next PUT", async ({ page }) => {
  const state = await openAccounts(page);
  state.holdBootstrap = true;
  const label = page.getByLabel("label", { exact: true });
  await label.fill("submitted B");
  await page.getByRole("button", { name: "Save grant", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].request().postDataJSON().label).toBe("submitted B");
  await label.fill("Account A");
  // The server committed independently; only its write response is lost.
  state.grants[0] = grant("account_a", { label: "submitted B" });
  await state.writes[0].abort("failed");
  await expect(page.locator(".inspector")).toContainText("could not be confirmed");
  await expect.poll(() => state.reads.length).toBe(1);
  expect(state.reads[0].body.grants[0].label).toBe("submitted B");
  await state.reads[0].route.fulfill({ json: state.reads[0].body });
  await expect(page.locator(".tableRow").filter({ hasText: "submitted B" })).toBeVisible();
  await expect(label).toHaveValue("Account A");
  await page.getByRole("button", { name: "Save grant", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].request().method()).toBe("PUT");
  expect(state.writes[1].request().postDataJSON().label).toBe("Account A");
  state.grants[0] = grant();
  await state.writes[1].fulfill({ json: grant() });
  await expect.poll(() => state.reads.length).toBe(2);
  await state.reads[1].route.fulfill({ json: state.reads[1].body });
  await flush(page);
  state.grants[0] = grant("account_a", { label: "later canonical label" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.reads.length).toBe(3);
  await state.reads[2].route.fulfill({ json: state.reads[2].body });
  await expect(label).toHaveValue("later canonical label");
});

test("same-role identity replacement retires a pending account response and its metadata refresh", async ({ page }) => {
  const state = await openAccounts(page);
  state.email = "second@example.com";
  state.holdSession = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.sessions.length).toBe(1);
  await page.getByLabel("replace access token", { exact: true }).fill("synthetic-old-draft");
  await page.getByRole("button", { name: "Save grant", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  state.holdSession = false;
  await state.sessions[0].route.fulfill({ json: state.sessions[0].body });
  await expect(page.locator(".tenantSwitch strong")).toHaveText("second@example.com");
  await expect(page.getByLabel("replace access token", { exact: true })).toHaveValue("");
  const response = page.waitForResponse((item) => item.request().method() === "PUT");
  await state.writes[0].fulfill({ json: grant("account_a", { label: "retired identity response" }) });
  await response;
  await flush(page);
  await expect(page.locator("body")).not.toContainText("retired identity response");
  await expect(page.getByLabel("replace access token", { exact: true })).toHaveValue("");
  expect(state.writes).toHaveLength(1);
});

function grant(tokenRef = "account_a", values: Partial<UpstreamGrant> = {}): UpstreamGrant {
  return { key: `oauth/team_policy/${tokenRef}`, scope: "policies", scopeId: "team_policy", tokenRef, kind: "subscription", provider: "test-provider", label: tokenRef === "account_b" ? "Account B" : "Account A", version: 1, tokenType: "Bearer", scopes: [], enabled: true, priority: 100, weight: 1, hasCredential: false, credentialFields: [], hasAccessToken: true, hasRefreshToken: true, refreshConfigured: true, usable: true, selectedCount: 0, quotaStatus: "unknown", quotaWindows: [], revokedAt: null, ...values };
}
function revoked() { return grant("account_a", { enabled: false, usable: false, hasAccessToken: false, hasRefreshToken: false, revokedAt: "2026-09-01T00:00:00Z" }); }
async function flush(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }

async function openAccounts(page: Page, holdInitialBootstrap = false, authorization = false, grants = [grant(), grant("account_b")]) {
  const state = { writes: [] as Route[], reads: [] as { route: Route; body: AdminBootstrapResponse }[], sessions: [] as { route: Route; body: unknown }[], grants, holdBootstrap: holdInitialBootstrap, holdSession: false, email: "admin@example.com" };
  const mutations: Record<string, string> = {
    "/v1/admin/upstream-grants/policies/team_policy/account_a": "PUT",
    "/v1/admin/upstream-grants/policies/team_policy/account_a/revoke": "POST",
    "/v1/admin/upstream-grants/policies/team_policy/account_a/refresh": "POST",
    "/v1/admin/upstream-grants/policies/team_policy/account_a/quota-refresh": "POST",
    "/v1/admin/upstream-grants/policies/team_policy/account_a/authorize": "POST",
    "/v1/admin/upstream-grants/policies/team_policy/created": "PUT",
  };
  const policy: AccessPolicy = { policyId: "team_policy", enabled: true, providers: [], tenantId: "default", retainRequestContent: false, grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} } };
  const bootstrap: AdminBootstrapResponse = {
    policies: [policy], grants: state.grants, credentials: [], connections: [], users: [], bindings: [], rules: [], providers: [], tenants: [],
    overview: { policiesTotal: 1, policiesActive: 1, tenantsTotal: 1, keysTotal: 0, keysActive: 0, providerCount: 1, openaiCompatibleProviders: 0, manifestRoutes: 0, monthlyBudgetMicros: 0, requestCostMicros: 0 },
    fusion: { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "", adviserTimeoutMs: 10_000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 },
  };
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      expect(mutations[path], `unexpected mutation ${route.request().method()} ${path}`).toBe(route.request().method());
      state.writes.push(route);
      return;
    }
    const session = { authenticated: true, auth: "cloudflare_access", role: "admin", email: state.email, tenantId: "default", entitlements: { providers: [] } };
    if (path === "/v1/admin/bootstrap" && state.holdBootstrap) { state.reads.push({ route, body: structuredClone(bootstrap) }); return; }
    if (path === "/v1/session" && state.holdSession) { state.sessions.push({ route, body: session }); return; }
    const responses: Record<string, unknown> = {
      "/v1/providers": { providers: [{ id: "test-provider", display_name: "Test Provider", class: "test", service_kind: "model_provider", capabilities: [], ...(authorization ? { auth: { authorization: { grantKind: "subscription" } } } : {}), quota: { probes: [{ grantKinds: ["subscription"], requiresRefreshToken: false }] } }] },
      "/v1/routes": { openaiCompatible: [], manifestProxy: [] }, "/v1/session": session,
      "/v1/session/usage": { policies: [] }, "/v1/session/credentials": { credentials: [] }, "/v1/admin/bootstrap": bootstrap,
    };
    await route.fulfill({ status: responses[path] ? 200 : 404, json: responses[path] ?? {} });
  });
  await page.goto("/dashboard/access?resource=upstream");
  if (holdInitialBootstrap) {
    const provider = page.getByLabel("provider", { exact: true });
    await expect(provider.locator("option")).toHaveText(["Select a provider", "Test Provider"]);
    await expect(provider).toHaveValue("");
    await expect(provider.locator("option:checked")).toHaveText("Select a provider");
    await expect.poll(() => state.reads.length).toBe(1);
    return state;
  }
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(page.getByLabel("label", { exact: true })).toHaveValue("Account A");
  return state;
}
