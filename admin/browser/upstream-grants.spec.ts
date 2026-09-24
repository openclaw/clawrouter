import { expect, test, type Route } from "@playwright/test";
import type { AccessPolicy, AdminBootstrapResponse, UpstreamGrant } from "../src/ui-types";

test("demo accounts pause, revoke and explicitly replace with fresh material", async ({ page }) => {
  await page.route("**/v1/**", route => route.fulfill({ status: 503, json: { error: { message: "Demo fixture" } } }));
  await page.goto("/dashboard/access?demo=1&resource=upstream");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.getByRole("combobox", { name: "provider", exact: true }).selectOption("openai");
  await page.getByLabel("fresh API key", { exact: true }).fill("demo-primary-fixture");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const revoke = page.getByRole("button", { name: "Revoke", exact: true });
  const state = page.locator('.tableRow.selected [data-label="state"]');
  const facts = page.locator(".inspector .facts");
  await expect(state).toHaveText("usable");
  await expect(page.getByLabel("fresh API key", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Pause account", exact: true }).click();
  await expect(state).toHaveText("paused");
  await expect(facts.getByText("stored", { exact: true })).toBeVisible();
  await expect(revoke).toBeEnabled();
  await revoke.focus(); await page.keyboard.press("Enter");
  await expect(state).toHaveText("revoked");
  await expect(facts.getByText("missing", { exact: true })).toBeVisible();
  await expect(revoke).toBeDisabled();
  await page.getByRole("button", { name: "Prepare credential replacement", exact: true }).click();
  await page.getByRole("button", { name: "Replace credentials", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("fresh primary credential");
  await page.getByLabel("fresh API key", { exact: true }).fill("demo-replacement-fixture");
  await page.getByRole("button", { name: "Replace credentials", exact: true }).click();
  await expect(state).toHaveText("paused");
  await expect(revoke).toBeEnabled();
  await page.getByRole("button", { name: "Resume account", exact: true }).click();
  await expect(state).toHaveText("usable");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an authenticated paused unusable grant can be revoked with the keyboard", async ({ page }) => {
  const pending: Route[] = [];
  const policy: AccessPolicy = {
    policyId: "policy_fixture", enabled: true, providers: [], tenantId: "default", retainRequestContent: false,
    grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} },
  };
  const grant: UpstreamGrant = {
    key: "oauth/policy_fixture/paused", scope: "policies", scopeId: "policy_fixture", tokenRef: "paused", version: 1,
    provider: "test-provider", kind: "subscription", tokenType: "Bearer", scopes: [], enabled: false, usable: false, priority: 100, weight: 1,
    hasCredential: false, credentialFields: [], hasAccessToken: true, hasRefreshToken: true, credentialStatus: "reauth_required",
    refreshConfigured: true, selectedCount: 0, quotaStatus: "unknown", quotaWindows: [], revokedAt: null,
  };
  const bootstrap: AdminBootstrapResponse = {
    policies: [policy], grants: [grant], credentials: [], connections: [], users: [], bindings: [], rules: [], providers: [], tenants: [],
    overview: { policiesTotal: 1, policiesActive: 1, tenantsTotal: 1, keysTotal: 0, keysActive: 0, providerCount: 1, openaiCompatibleProviders: 0, manifestRoutes: 0, monthlyBudgetMicros: 0, requestCostMicros: 0 },
    fusion: { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "", adviserTimeoutMs: 10_000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 },
  };
  const responses: Record<string, unknown> = {
    "/v1/providers": { providers: [{ id: "test-provider", display_name: "Test Provider", class: "test", service_kind: "model_provider", capabilities: [] }] },
    "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
    "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: "admin@example.com", tenantId: "default", entitlements: { providers: [] } },
    "/v1/session/usage": { policies: [] },
    "/v1/session/credentials": { credentials: [] },
    "/v1/admin/bootstrap": bootstrap,
  };
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") { pending.push(route); return; }
    const { selectedCount: _count, quotaStatus: _quota, quotaWindows: _windows, ...safe } = bootstrap.grants[0];
    const body = path === "/v1/admin/upstream-grants/policies/policy_fixture/paused" ? { ...safe, credentialGeneration: safe.revokedAt ? 2 : 1, publication: "ready", refreshTokenUrl: null, clientIdConfig: null, clientSecretConfig: null } : responses[path];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  await page.goto("/dashboard/access?resource=upstream");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  const revoke = page.getByRole("button", { name: "Revoke", exact: true });
  await expect(page.locator('.tableRow.selected [data-label="state"]')).toHaveText("paused");
  await expect(revoke).toBeEnabled();
  await revoke.focus();
  await expect(revoke).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => pending.length).toBe(1);
  expect(new URL(pending[0].request().url()).pathname).toBe("/v1/admin/upstream-grants/policies/policy_fixture/paused/revoke");
  expect(pending[0].request().method()).toBe("POST");
  await expect(revoke).toBeDisabled();
  const revoked = { ...grant, hasAccessToken: false, hasRefreshToken: false, revokedAt: "2026-09-01T00:00:00.000Z" };
  bootstrap.grants = [revoked];
  await pending[0].fulfill({ json: revoked });
  await expect(page.locator('.tableRow.selected [data-label="state"]')).toHaveText("revoked");
  await expect(page.locator(".inspector .facts").getByText("missing", { exact: true })).toBeVisible();
  await expect(revoke).toBeDisabled();
});
