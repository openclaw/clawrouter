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

test("personal creation sends a create-only request without selecting an owner", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await connected(page);
  await page.locator(".myKeysPanel").getByRole("button", { name: "Create key", exact: true }).click();
  await expect(page.locator(".issuedKey code")).toHaveText(/^clawrouter-live-key_[0-9a-f]{16}-[0-9a-f]{48}$/);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].path).toBe("/v1/session/credentials");
  expect(Object.keys(state.writes[0].body).sort()).toEqual(["credentialId", "policyId", "secretSha256"]);
});

for (const operation of ["rotate", "revoke"] as const) {
  test(`admin ${operation} consumes the latest policy and evicts a reassigned personal key`, async ({ page }) => {
    const state = await fixture(page);
    await openAdmin(page);
    await page.getByRole("button", { name: /owned_key.*proxy credential/ }).click();
    state.credentials[0].policyId = "another_policy";
    state.credentials[0].principalId = "other@example.com";
    state.failBootstrap = true;
    await page.getByRole("button", { name: operation === "rotate" ? "Rotate credential" : "Revoke credential", exact: true }).click();
    await expect(page.locator(".facts")).toContainText("another_policy");
    await expect(page.locator(".inspector")).not.toContainText("could not be confirmed");
    if (operation === "rotate") {
      await expect(page.locator(".issuedKey")).toContainText("owned_key · another_policy");
      await expect(page.locator(".issuedKey code")).toHaveText(/^clawrouter-live-owned_key-[0-9a-f]{48}$/);
      expect(Object.keys(state.writes[0].body)).toEqual(["secretSha256"]);
    }
    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
    await expect(page.locator(".myKeysList article")).toHaveCount(0);
  });
}

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

for (const completion of ["before", "after"] as const) {
  test(`new-identity hydration survives an old operation completing ${completion} it`, async ({ page }) => {
    const state = await fixture(page);
    await openAdmin(page);
    await draft(page, "previous_key");
    const sessionRead = deferred();
    state.holdSession = sessionRead.promise;
    await focusRefresh(page);
    await expect.poll(() => state.sessionReads).toBe(2);
    const mutation = deferred();
    state.holdMutation = mutation.promise;
    await page.getByRole("button", { name: "Issue credential", exact: true }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    state.email = "second@example.com";
    state.role = "user";
    state.credentials.push({ credentialId: "second_key", policyId: "team_policy", principalId: state.email, enabled: true, active: true });
    const reads = deferred();
    state.holdKeys = reads.promise;
    sessionRead.release();
    await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
    await expect.poll(() => state.keyReads).toBe(3);
    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
    if (completion === "before") {
      const response = page.waitForResponse("**/v1/admin/credentials");
      mutation.release();
      await response;
      await expect(page.locator(".myKeysPanel")).not.toContainText("A credential change is still finishing");
    }
    reads.release();
    await expect(page.locator(".myKeysList")).toContainText("second_key");
    if (completion === "after") mutation.release();
    await expect(page.locator(".myKeysPanel").getByRole("button", { name: "Create key", exact: true })).toBeEnabled();
    await expect(page.locator(".myKeysList")).not.toContainText("owned_key");
    await expect(page.locator(".issuedKey code")).toHaveCount(0);
  });
}

test("confirmed auth loss clears a reveal before the login availability probe finishes", async ({ page }) => {
  const state = await fixture(page);
  await openAdmin(page);
  const previousRefresh = await page.locator(".connectionMeta time").getAttribute("datetime");
  await draft(page, "revealed_key");
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await expect(page.locator(".issuedKey code")).toBeVisible();
  await expect(page.locator(".connectionMeta time")).not.toHaveAttribute("datetime", previousRefresh!);
  const login = deferred();
  state.holdLogin = login.promise;
  state.authLost = true;
  await focusRefresh(page);
  await expect.poll(() => state.loginReads).toBe(1);
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
  login.release();
});

for (const role of ["admin", "user"] as const) {
  for (const path of ["/v1/session/usage", "/v1/session/credentials", "/v1/entitlements"]) {
    test(`${role} auth loss at ${path} clears the reveal before sibling reads and login finish`, async ({ page }) => {
      const state = await fixture(page);
      state.role = role;
      if (role === "admin") await openAdmin(page);
      else { await page.goto("/"); await connected(page); }
      const previousRefresh = await page.locator(".connectionMeta time").getAttribute("datetime");
      if (role === "admin") {
        await draft(page, "secondary_key");
        await page.getByRole("button", { name: "Issue credential", exact: true }).click();
      } else await page.locator(".myKeysPanel").getByRole("button", { name: "Create key", exact: true }).click();
      await expect(page.locator(".issuedKey code")).toBeVisible();
      await expect(page.locator(".connectionMeta time")).not.toHaveAttribute("datetime", previousRefresh!);
      const login = deferred(), sibling = deferred();
      state.holdLogin = login.promise;
      state.authLostPath = path;
      state.omitEntitlements = path === "/v1/entitlements";
      state.holdReadPath = path === "/v1/session/usage" ? "/v1/session/credentials" : "/v1/session/usage";
      state.holdRead = sibling.promise;
      await focusRefresh(page);
      await expect.poll(() => state.loginReads).toBe(1);
      await expect(page.locator(".issuedKey code")).toHaveCount(0);
      sibling.release();
      login.release();
    });
  }
}

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

test("a secondary auth failure clears a reveal after bootstrap has already failed", async ({ page }) => {
  const state = await fixture(page);
  await openAdmin(page);
  await revealAdminKey(page, "late_auth_key");
  const auth = deferred();
  state.failBootstrap = true;
  state.authLostPath = "/v1/session/credentials";
  state.holdAuthLoss = auth.promise;
  await focusRefresh(page);
  await expect.poll(() => state.authLossReads).toBe(1);
  await expect(page.locator(".statusBar")).toContainText("Console data refresh failed");
  const reads = state.sessionReads;
  auth.release();
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /owned_key.*proxy credential/ })).toHaveCount(0);
  expect(state.sessionReads).toBe(reads);
});

for (const identity of ["same", "changed"] as const) {
  test(`a delayed auth observation belongs to its ${identity} identity despite a later mutation`, async ({ page }) => {
    const state = await fixture(page);
    await openAdmin(page);
    const auth = deferred();
    state.failBootstrap = true;
    state.authLostPath = "/v1/session/credentials";
    state.holdAuthLoss = auth.promise;
    await focusRefresh(page);
    await expect.poll(() => state.authLossReads).toBe(1);
    await expect(page.locator(".statusBar")).toContainText("Console data refresh failed");
    state.failBootstrap = false;
    state.authLostPath = "";
    state.holdAuthLoss = null;
    if (identity === "changed") {
      state.email = "second@example.com";
      state.role = "user";
      await focusRefresh(page);
      await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
      await page.getByRole("button", { name: "Dashboard", exact: true }).click();
      await connected(page);
      await page.locator(".myKeysPanel").getByRole("button", { name: "Create key", exact: true }).click();
      await expect(page.locator(".issuedKey code")).toBeVisible();
    } else await revealAdminKey(page, "same_identity_key");
    const secret = await page.locator(".issuedKey code").textContent();
    const response = page.waitForResponse((item) => item.url().endsWith("/v1/session/credentials") && item.status() === 401);
    auth.release();
    await response;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    if (identity === "changed") await expect(page.locator(".issuedKey code")).toHaveText(secret!);
    else await expect(page.locator(".issuedKey code")).toHaveCount(0);
  });
}

test("a lost create response is reconciled by a fresh read after stale snapshots finish", async ({ page }) => {
  const state = await fixture(page);
  await openAdmin(page);
  await draft(page, "recovered_key");
  const reads = deferred();
  state.holdKeys = reads.promise;
  await focusRefresh(page);
  await expect.poll(() => state.keyReads).toBe(4);
  state.loseResponse = true;
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await expect(page.locator(".inspector")).toContainText("could not be confirmed");
  state.holdKeys = null;
  reads.release();
  await expect.poll(() => state.keyReads).toBe(6);
  await expect(page.getByRole("button", { name: /recovered_key.*proxy credential/ })).toBeVisible();
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test("old-identity recovery does not start a refresh after an in-flight read accepts another identity", async ({ page }) => {
  const state = await fixture(page);
  await openAdmin(page);
  await draft(page, "previous_recovery");
  const sessionRead = deferred();
  state.holdSession = sessionRead.promise;
  await focusRefresh(page);
  await expect.poll(() => state.sessionReads).toBe(2);
  state.loseResponse = true;
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await expect(page.locator(".inspector")).toContainText("could not be confirmed");
  state.email = "second@example.com";
  state.role = "user";
  state.credentials.push({ credentialId: "second_key", policyId: "team_policy", principalId: state.email, enabled: true, active: true });
  state.holdSession = null;
  sessionRead.release();
  await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.locator(".myKeysList")).toContainText("second_key");
  await connected(page);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(state.sessionReads).toBe(2);
  expect(state.writes).toHaveLength(1);
  await expect(page.locator(".issuedKey code")).toHaveCount(0);
});

for (const status of [401, 403]) {
  test(`personal mutation ${status} distinguishes sign-in loss from a policy rejection`, async ({ page }) => {
    const state = await fixture(page);
    state.role = "user";
    await page.goto("/");
    await connected(page);
    state.reject = status === 401 ? "access_session_required" : "credential_policy_not_held";
    state.rejectStatus = status;
    const card = page.locator(".myKeysPanel");
    await card.getByRole("button", { name: "Rotate", exact: true }).click();
    await expect(card).toContainText(status === 401 ? "Sign-in required. Sign in again, then refresh keys." : "credential_policy_not_held");
    await expect(card.locator(".myKeysList article")).toHaveCount(status === 401 ? 0 : 1);
    await expect(page.locator(".issuedKey code")).toHaveCount(0);
    expect(state.writes).toHaveLength(1);
    if (status === 401) {
      await card.getByRole("button", { name: "Refresh keys", exact: true }).click();
      await expect(card.locator(".myKeysList")).toContainText("owned_key");
    }
  });
}

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
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
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
async function revealAdminKey(page: Page, id: string) {
  const previousRefresh = await page.locator(".connectionMeta time").getAttribute("datetime");
  await draft(page, id);
  await page.getByRole("button", { name: "Issue credential", exact: true }).click();
  await expect(page.locator(".issuedKey code")).toBeVisible();
  await expect(page.locator(".connectionMeta time")).not.toHaveAttribute("datetime", previousRefresh!);
}
async function focusRefresh(page: Page) { await page.evaluate(() => window.dispatchEvent(new Event("focus"))); }

async function fixture(page: Page) {
  const policy: AccessPolicy = { policyId: "team_policy", enabled: true, providers: [], tenantId: "default", retainRequestContent: false, grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} } };
  const state = {
    credentials: [{ credentialId: "owned_key", policyId: policy.policyId, principalId: "admin@example.com", enabled: true, active: true }] as ProxyCredential[],
    writes: [] as { path: string; method: string; body: Record<string, string> }[],
    reject: "", rejectStatus: 409, failBootstrap: false, loseResponse: false, held: true, authLost: false, authLostPath: "", authLossReads: 0, omitEntitlements: false, holdReadPath: "", email: "admin@example.com", role: "admin", keyReads: 0, sessionReads: 0, loginReads: 0,
    holdMutation: null as Promise<void> | null, holdKeys: null as Promise<void> | null, holdSession: null as Promise<void> | null, holdLogin: null as Promise<void> | null, holdRead: null as Promise<void> | null, holdAuthLoss: null as Promise<void> | null,
  };
  const usage = { ledger: "ready", providers: [], daily: [], events: [], summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 } };
  await page.route("**/v1**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      const body = request.postData() ? request.postDataJSON() : {};
      state.writes.push({ path, method: request.method(), body });
      if (state.reject) { await route.fulfill({ status: state.rejectStatus, body: state.reject }); return; }
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
    if (path === state.authLostPath) {
      // Capture this request's failure before a later identity changes the fixture.
      const held = state.holdAuthLoss;
      state.authLossReads += 1;
      if (held) await held;
      await route.fulfill({ status: 401, body: "access_session_required" });
      return;
    }
    if (path === state.holdReadPath && state.holdRead) await state.holdRead;
    const policies = state.held ? [policy] : [];
    const responses: Record<string, unknown> = {
      "/v1": { endpoints: {} },
      "/v1/providers": { providers: [] },
      "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "access", role: state.role, email: state.email, tenantId: "default", ...(!state.omitEntitlements ? { entitlements: { providers: [] } } : {}) },
      "/v1/session/usage": { policies: policies.map((item) => ({ ...item, budget: { configured: false, ledger: "ready" } })), usage },
      "/v1/session/credentials": { credentials: state.credentials.filter((item) => item.principalId === state.email) },
      "/v1/admin/usage": { policies: [], usage },
      "/v1/admin/bootstrap": { policies: [policy, { ...policy, policyId: "another_policy" }], credentials: state.credentials, connections: [], users: [], bindings: [], grants: [], rules: [], providers: [], tenants: [], overview: null, fusion: { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "", adviserTimeoutMs: 10000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 } },
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
