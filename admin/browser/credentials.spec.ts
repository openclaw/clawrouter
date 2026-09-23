import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { AccessPolicy, ProxyCredential } from "../src/ui-types";

test("admin creation is create-only, guarded synchronously, and survives a failed refresh", async ({ page }) => {
  const state = await fixture(page);
  await openAdmin(page);
  await draft(page, "created_key");
  state.failBootstrap = true;
  await page.getByRole("button", { name: "Issue credential", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.locator(".issuedKey code")).toHaveText(/^clawrouter-live-created_key-[0-9a-f]{48}$/);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ path: "/v1/admin/credentials", method: "POST", body: { credentialId: "created_key", policyId: "team_policy", principalId: null } });
  expect(state.writes[0].body.secretSha256).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.locator(".statusBar")).toContainText("Console data refresh failed");
  await expect(page.getByRole("button", { name: "Rotate credential", exact: true })).toBeEnabled();
  await expect(page.locator(".facts")).toContainText("created_key");
});

test("a collision retains the create draft and a confirmed rejection can be retried", async ({ page }) => {
  const state = await fixture(page);
  state.reject = "credential_exists";
  await openAdmin(page);
  await draft(page, "owned_key");
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await expect(page.locator(".inspector")).toContainText("credential_exists");
  await expect(page.getByRole("textbox", { name: "credential id", exact: true })).toHaveValue("owned_key");
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
  state.reject = "";
  await page.getByRole("textbox", { name: "credential id", exact: true }).fill("another_key");
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await expect(page.locator(".issuedKey code")).toContainText("another_key");
  expect(state.writes.map((write) => [write.method, write.path])).toEqual([["POST", "/v1/admin/credentials"], ["POST", "/v1/admin/credentials"]]);
});

test("personal and admin screens share admission, rotate only the hash, and synchronize revocation", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await connected(page);
  const pending = deferred();
  state.holdMutation = pending.promise;
  await page.locator(".myKeysPanel").getByRole("button", { name: "Rotate", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await page.getByRole("tab", { name: /Credentials/ }).click();
  await page.getByRole("button", { name: /owned_key.*proxy credential/ }).click();
  await expect(page.getByRole("button", { name: "Rotate credential", exact: true })).toBeDisabled();
  pending.release();
  await expect(page.getByRole("button", { name: "Rotate credential", exact: true })).toBeEnabled();
  expect(state.writes[0].path).toBe("/v1/session/credentials/owned_key/rotate");
  expect(Object.keys(state.writes[0].body)).toEqual(["secretSha256"]);
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
  state.holdMutation = null;
  state.failBootstrap = true;
  await page.getByRole("button", { name: "Revoke credential", exact: true }).click();
  await expect(page.getByRole("button", { name: "Revoke credential", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.locator(".myKeysList")).toContainText("revoked");
  await expect(page.locator(".myKeysPanel").getByRole("button", { name: "Rotate", exact: true })).toBeDisabled();
});

test("a dismissed sent result updates rows without replacing the next draft or revealing a secret", async ({ page }) => {
  const state = await fixture(page);
  await openAdmin(page);
  await draft(page, "first_key");
  const pending = deferred();
  state.holdMutation = pending.promise;
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.getByRole("textbox", { name: "credential id", exact: true }).fill("next_draft");
  pending.release();
  await expect(page.locator(".inspector")).toContainText("Created first_key.");
  await expect(page.locator(".inspector")).toContainText("one-time secret was dismissed");
  await expect(page.getByRole("textbox", { name: "credential id", exact: true })).toHaveValue("next_draft");
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /first_key.*proxy credential/ })).toBeVisible();
});

for (const invalidate of ["dismiss", "leave-return"] as const) {
  test(`${invalidate} while hashing prevents dispatch, even after returning to the same panel`, async ({ page }) => {
    const state = await fixture(page);
    await delayHash(page);
    await openAdmin(page);
    await draft(page, "unsent_key");
    await page.getByRole("button", { name: "Issue credential", exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean((window as HashWindow).releaseHash))).toBe(true);
    if (invalidate === "dismiss") await page.getByRole("button", { name: "Dismiss pending secret" }).click();
    else {
      await page.getByRole("button", { name: "Catalog", exact: true }).click();
      await page.getByRole("button", { name: "Access", exact: true }).click();
    }
    await page.evaluate(() => (window as HashWindow).releaseHash!());
    await expect(page.getByRole("button", { name: "Issue credential", exact: true })).toBeEnabled();
    expect(state.writes).toHaveLength(0);
    await expect(page.locator(".issuedKey code")).toHaveCount(0);
  });
}

test("leave and return after dispatch cannot resurrect the one-time result", async ({ page }) => {
  const state = await fixture(page);
  await openAdmin(page);
  await draft(page, "sent_key");
  const pending = deferred();
  state.holdMutation = pending.promise;
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page.goBack();
  await expect(page.getByRole("textbox", { name: "credential id", exact: true })).toBeVisible();
  pending.release();
  await expect(page.locator(".inspector")).toContainText("Created sent_key.");
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
});

test("pre-mutation admin and personal snapshots cannot restore a revoked row", async ({ page }) => {
  const state = await fixture(page);
  await openAdmin(page);
  await page.getByRole("button", { name: /owned_key.*proxy credential/ }).click();
  const reads = deferred();
  state.holdKeys = reads.promise;
  await focusRefresh(page);
  await expect.poll(() => state.keyReads).toBe(4);
  await page.getByRole("button", { name: "Revoke credential", exact: true }).click();
  await expect(page.locator(".facts")).toContainText("revoked");
  const response = page.waitForResponse("**/v1/admin/bootstrap");
  reads.release();
  await response;
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.locator(".myKeysList")).toContainText("revoked");
});

test("an accepted identity change fences a pending mutation and clears old admin drafts", async ({ page }) => {
  const state = await fixture(page);
  await openAdmin(page);
  await draft(page, "old_draft");
  const sessionRead = deferred();
  state.holdSession = sessionRead.promise;
  await focusRefresh(page);
  await expect.poll(() => state.sessionReads).toBe(2);
  const mutation = deferred();
  state.holdMutation = mutation.promise;
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  state.email = "second@example.com";
  state.failBootstrap = true;
  sessionRead.release();
  await expect(page.locator(".tenantSwitch strong")).toHaveText("second@example.com");
  await expect(page.getByRole("textbox", { name: "credential id", exact: true })).toHaveValue("");
  mutation.release();
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /owned_key.*proxy credential/ })).toHaveCount(0);
});

test("confirmed auth loss clears a reveal before the login availability probe finishes", async ({ page }) => {
  const state = await fixture(page);
  await openAdmin(page);
  await draft(page, "revealed_key");
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await expect(page.locator(".issuedKey code")).toBeVisible();
  await expect.poll(() => state.sessionReads).toBe(2);
  const login = deferred();
  state.holdLogin = login.promise;
  state.authLost = true;
  await focusRefresh(page);
  await expect.poll(() => state.loginReads).toBe(1);
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
  login.release();
});

test("a lost response is visibly uncertain and never retried or revealed automatically", async ({ page }) => {
  const state = await fixture(page);
  state.loseResponse = true;
  await openAdmin(page);
  await draft(page, "uncertain_key");
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await expect(page.locator(".inspector")).toContainText("could not be confirmed");
  await page.getByRole("button", { name: "Refresh keys", exact: true }).click();
  await expect(page.getByRole("button", { name: /uncertain_key.*proxy credential/ })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
});

test("binding loss keeps an active key revocable while rotation and the chosen policy become unavailable", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await connected(page);
  state.held = false;
  await focusRefresh(page);
  const card = page.locator(".myKeysPanel");
  await expect(card.getByRole("combobox")).toHaveValue("team_policy");
  await expect(card).toContainText("Policy no longer held: rotation unavailable");
  await expect(card.getByRole("button", { name: "Rotate", exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Revoke", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(card.locator(".myKeysList")).toContainText("revoked");
});

for (const inactive of ["owner", "generation", "policy"] as const) {
  test(`canonical ${inactive} inactivity disables rotation without hiding revoke`, async ({ page }) => {
    const state = await fixture(page);
    state.credentials[0].active = false;
    if (inactive === "owner") state.credentials[0].principalEnabled = false;
    if (inactive === "generation") state.credentials[0].generationMatches = false;
    if (inactive === "policy") state.credentials[0].policyEnabled = false;
    await openAdmin(page);
    await page.getByRole("button", { name: /owned_key.*proxy credential/ }).click();
    await expect(page.getByRole("button", { name: "Rotate credential", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Revoke credential", exact: true })).toBeEnabled();
  });
}

test("clipboard failure is visible, Dismiss works by keyboard, and refresh cannot re-reveal", async ({ page }) => {
  await fixture(page);
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("denied"); } } }));
  await openAdmin(page);
  await draft(page, "copy_key");
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.locator(".issuedKey")).toContainText("Copy failed");
  const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
  await dismiss.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
  await focusRefresh(page);
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

type HashWindow = Window & { releaseHash?: () => void };
async function delayHash(page: Page) {
  await page.addInitScript(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args: Parameters<SubtleCrypto["digest"]>) => {
      await new Promise<void>((resolve) => { (window as HashWindow).releaseHash = resolve; });
      return digest(...args);
    };
  });
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function connected(page: Page) { await expect(page.locator(".connectionMeta strong")).toHaveText("Connected"); }
async function openAdmin(page: Page) { await page.goto("/dashboard/access?resource=credentials"); await connected(page); }
async function draft(page: Page, id: string) {
  await page.getByRole("textbox", { name: "credential id", exact: true }).fill(id);
  await page.getByRole("combobox", { name: "policy", exact: true }).selectOption("team_policy");
}
async function focusRefresh(page: Page) { await page.evaluate(() => window.dispatchEvent(new Event("focus"))); }

async function fixture(page: Page) {
  const policy: AccessPolicy = { policyId: "team_policy", enabled: true, providers: [], tenantId: "default", retainRequestContent: false, grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} } };
  const state = {
    credentials: [{ credentialId: "owned_key", policyId: policy.policyId, principalId: "admin@example.com", enabled: true, active: true }] as ProxyCredential[],
    writes: [] as { path: string; method: string; body: Record<string, string> }[],
    reject: "", failBootstrap: false, loseResponse: false, held: true, authLost: false, email: "admin@example.com", keyReads: 0, sessionReads: 0, loginReads: 0,
    holdMutation: null as Promise<void> | null, holdKeys: null as Promise<void> | null, holdSession: null as Promise<void> | null, holdLogin: null as Promise<void> | null,
  };
  const usage = { ledger: "ready", providers: [], daily: [], events: [], summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 } };
  await page.route("**/v1**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      const body = request.postData() ? request.postDataJSON() : {};
      state.writes.push({ path, method: request.method(), body });
      if (state.reject) { await route.fulfill({ status: 409, body: state.reject }); return; }
      const create = path.endsWith("/credentials");
      const credentialId = create ? body.credentialId : decodeURIComponent(path.split("/").at(-2)!);
      const prior = state.credentials.find((item) => item.credentialId === credentialId);
      const credential: ProxyCredential = { ...prior, credentialId, policyId: prior?.policyId ?? body.policyId, principalId: prior?.principalId ?? (path.includes("/session/") ? state.email : body.principalId), enabled: !path.endsWith("/revoke"), active: !path.endsWith("/revoke") };
      state.credentials = [...state.credentials.filter((item) => item.credentialId !== credentialId), credential];
      if (state.holdMutation) await state.holdMutation;
      if (state.loseResponse) { await route.abort("failed"); return; }
      await route.fulfill({ status: create ? 201 : 200, json: credential });
      return;
    }
    if (path === "/v1/session") {
      state.sessionReads += 1;
      if (state.holdSession) await state.holdSession;
      if (state.authLost) { await route.fulfill({ status: 401, body: "access_session_required" }); return; }
    }
    if (path === "/v1") {
      state.loginReads += 1;
      if (state.holdLogin) await state.holdLogin;
    }
    const policies = state.held ? [policy] : [];
    const responses: Record<string, unknown> = {
      "/v1": { endpoints: {} },
      "/v1/providers": { providers: [] },
      "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "access", role: "admin", email: state.email, tenantId: "default", entitlements: { providers: [] } },
      "/v1/session/usage": { policies: policies.map((item) => ({ ...item, budget: { configured: false, ledger: "ready" } })), usage },
      "/v1/session/credentials": { credentials: state.credentials.filter((item) => item.principalId === state.email) },
      "/v1/admin/usage": { policies: [], usage },
      "/v1/admin/bootstrap": { policies: [policy], credentials: state.credentials, connections: [], users: [], bindings: [], grants: [], rules: [], providers: [], tenants: [], overview: null, fusion: { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "", adviserTimeoutMs: 10000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 } },
    };
    const snapshot = structuredClone(responses[path]);
    if (path === "/v1/admin/bootstrap" || path === "/v1/session/credentials") {
      state.keyReads += 1;
      if (state.holdKeys) await state.holdKeys;
    }
    if (path === "/v1/admin/bootstrap" && state.failBootstrap) { await route.fulfill({ status: 503, body: "reporting offline" }); return; }
    await route.fulfill({ status: snapshot ? 200 : 404, json: snapshot ?? {} });
  });
  return state;
}
