import { expect, test, type Page } from "@playwright/test";
import type { GrantPoolReadiness } from "../../shared/contracts";

test("first admin recovers and activates while legacy bootstrap is unavailable", async ({ page }) => {
  let state: GrantPoolReadiness = { revision: 0, baseline: null, acceptedAt: null, phase: "idle", cursor: null, scanRevision: null, scanned: 0, issues: [], overflow: false, activatedAt: null };
  const actions: string[] = [];
  await page.route("**/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : {};
    if (path === "/v1/admin/bootstrap") return route.fulfill({ status: 500, json: { error: { code: "admin_error", message: "legacy account listing unavailable" } } });
    if (path.startsWith("/v1/admin/grant-pools/")) {
      const action = path.split("/").at(-1)!;
      if (action !== "readiness") actions.push(action);
      if (action === "baseline") {
        expect(body).toEqual({ revision: 0, baseline: "existing", confirmed: true });
        state = { ...state, revision: 1, baseline: "existing", acceptedAt: "2026-09-23T00:00:00Z" };
      }
      if (action === "scan") state = { ...state, revision: 2, scanRevision: 2, phase: "kv" };
      if (action === "advance") {
        expect(body).toEqual({ scanRevision: 2, phase: "kv", cursor: null });
        state = { ...state, phase: "complete", scanned: 1 };
        return route.fulfill({ json: { readiness: state, outcomes: [{ key: "oauth/policy/account", outcome: "attached" }] } });
      }
      if (action === "activate") { expect(body).toEqual({ revision: 2 }); state = { ...state, revision: 3, activatedAt: "2026-09-23T00:00:00Z" }; }
      return route.fulfill({ json: state });
    }
    const responses: Record<string, unknown> = {
      "/v1/providers": { providers: [] }, "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "local", role: "admin", email: "admin@example.com", entitlementsError: "grant_pool_not_ready" },
      "/v1/session/usage": { policies: [] }, "/v1/session/credentials": { credentials: [] },
    };
    return route.fulfill({ status: responses[path] ? 200 : 503, json: responses[path] ?? { error: { message: "environment fallback waits for activation" } } });
  });
  await page.goto("/dashboard/access?resource=upstream");
  const panel = page.getByRole("region", { name: "account routing recovery" });
  await expect(panel).toContainText("Environment fallback is blocked");
  await expect(panel.getByRole("button", { name: "Accept baseline" })).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Accept baseline" }).click();
  await panel.getByRole("button", { name: "Start account scan" }).click();
  await expect(panel.getByRole("button", { name: "Activate account routing" })).toBeDisabled();
  await panel.getByRole("button", { name: "Reconcile next page" }).click();
  await expect(panel.getByLabel("last repair outcomes")).toContainText("attached");
  await panel.getByRole("button", { name: "Activate account routing" }).click();
  await expect(panel).toContainText("Active. Paused");
  expect(actions).toEqual(["baseline", "scan", "advance", "activate"]);
});

test("actual Upstream activation owns the first read and navigation cannot release its admission", async ({ page }) => {
  const fixture = await recoveryFixture(page), held = deferred();
  fixture.readiness.activatedAt = null;
  fixture.readiness.phase = "idle";
  fixture.waits.set("readiness", held.promise);
  await page.goto("/dashboard/access");
  const upstream = page.getByRole("tab", { name: /^Upstream/ });
  await upstream.focus();
  await flush(page);
  expect(fixture.requests).toHaveLength(0);
  await upstream.press("Enter");
  await expect.poll(() => fixture.requests.length).toBe(1);
  await expect(recoveryPanel(page).getByRole("button", { name: "Refresh readiness" })).toBeDisabled();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await expect(recoveryPanel(page)).toBeVisible();
  await expect(recoveryPanel(page).getByRole("button", { name: "Refresh readiness" })).toBeDisabled();
  expect(fixture.requests).toHaveLength(1);
  held.release();
  await expect(recoveryPanel(page).getByRole("button", { name: "Start account scan" })).toBeEnabled();
  fixture.replies.set("scan", { json: { ...fixture.readiness, revision: 4, scanRevision: 4, phase: "kv" } });
  await recoveryPanel(page).getByRole("button", { name: "Start account scan" }).click();
  await expect(recoveryPanel(page)).toContainText("Scan: kv");
  expect(fixture.requests.map(item => item.action)).toEqual(["readiness", "scan"]);
  await expect(page.getByRole("tabpanel", { name: /^Upstream/ })).toContainText("Account routing readiness");
});

test("a sent repair retains admission and its resume cursor across navigation", async ({ page }) => {
  const fixture = await recoveryFixture(page), held = deferred();
  fixture.waits.set("repair", held.promise);
  fixture.replies.set("repair", { json: { readiness: fixture.readiness, outcomes: [{ key: "oauth/policy/account", outcome: "attached" }], cursor: "oauth/policy/page-32" } });
  await openRecovery(page);
  await recoveryPanel(page).getByRole("button", { name: "Repair account publication" }).click();
  await expect.poll(() => fixture.requests.filter(item => item.action === "repair").length).toBe(1);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await expect(recoveryPanel(page).getByRole("button", { name: "Repair account publication" })).toBeDisabled();
  await expect(recoveryPanel(page).getByRole("button", { name: "Refresh readiness" })).toBeDisabled();
  held.release();
  await expect(recoveryPanel(page).getByLabel("last repair outcomes")).toContainText("attached");
  fixture.waits.delete("repair");
  await recoveryPanel(page).getByRole("button", { name: "Repair next indexed page" }).click();
  await expect.poll(() => fixture.requests.filter(item => item.action === "repair").length).toBe(2);
  expect(fixture.requests.filter(item => item.action === "repair").map(item => item.body)).toEqual([{ cursor: null }, { cursor: "oauth/policy/page-32" }]);
  expect(fixture.requests.filter(item => item.action === "readiness")).toHaveLength(1);
});

test("a failed action holds admission through the recovery read and uses its new revision", async ({ page }) => {
  const fixture = await recoveryFixture(page), held = deferred();
  await openRecovery(page);
  fixture.replies.set("repair", { status: 409, json: { error: { code: "grant_pool_readiness_changed", message: "inventory changed" } } });
  fixture.readiness = { ...fixture.readiness, revision: 4, scanRevision: 4, activatedAt: null };
  fixture.waits.set("readiness", held.promise);
  await recoveryPanel(page).getByRole("button", { name: "Repair account publication" }).click();
  await expect.poll(() => fixture.requests.filter(item => item.action === "readiness").length).toBe(2);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await expect(recoveryPanel(page).getByRole("button", { name: "Repair account publication" })).toBeDisabled();
  await expect(recoveryPanel(page)).toContainText("inventory changed");
  held.release();
  await expect(recoveryPanel(page).getByRole("button", { name: "Activate account routing" })).toBeEnabled();
  await recoveryPanel(page).getByRole("button", { name: "Activate account routing" }).click();
  await expect.poll(() => fixture.requests.filter(item => item.action === "activate").length).toBe(1);
  expect(fixture.requests.at(-1)?.body).toEqual({ revision: 4 });
});

test("an exact admin authentication loss invalidates recovery without a fallback read", async ({ page }) => {
  const fixture = await recoveryFixture(page);
  await openRecovery(page);
  fixture.replies.set("repair", { status: 401, json: { error: { code: "admin_unauthorized", message: "Sign-in required" } } });
  await recoveryPanel(page).getByRole("button", { name: "Repair account publication" }).click();
  await expect(page.locator(".loginShell")).toContainText("Sign-in required");
  await expect(page.locator(".appShell")).toHaveCount(0);
  await flush(page);
  expect(fixture.requests.map(item => item.action)).toEqual(["readiness", "repair"]);
});

for (const status of [200, 503]) test(`late repair ${status} cannot publish or recover into another identity`, async ({ page }) => {
  const fixture = await recoveryFixture(page), held = deferred();
  await openRecovery(page);
  fixture.waits.set("repair", held.promise);
  fixture.replies.set("repair", status === 200
    ? { json: { readiness: fixture.readiness, outcomes: [{ key: "oauth/old/private-account", outcome: "attached" }], cursor: "oauth/old/private-account" } }
    : { status, json: { error: { code: "fixture_error", message: "old private failure" } } });
  await recoveryPanel(page).getByRole("button", { name: "Repair account publication" }).click();
  await expect.poll(() => fixture.requests.filter(item => item.action === "repair").length).toBe(1);
  fixture.email = "next-admin@example.com";
  fixture.readiness = { ...fixture.readiness, revision: 9, scanRevision: 9 };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".tenantSwitch strong")).toHaveText(fixture.email);
  await expect.poll(() => fixture.requests.filter(item => item.action === "readiness").length).toBe(2);
  await expect(recoveryPanel(page).getByRole("button", { name: "Repair account publication" })).toBeEnabled();
  const response = page.waitForResponse("**/v1/admin/grant-pools/repair");
  held.release();
  await response;
  await flush(page);
  expect(fixture.requests.filter(item => item.action === "readiness")).toHaveLength(2);
  await expect(recoveryPanel(page)).not.toContainText("private-account");
  await expect(recoveryPanel(page)).not.toContainText("old private failure");
  await expect(recoveryPanel(page).getByRole("button", { name: "Repair account publication" })).toBeEnabled();
});

function recoveryPanel(page: Page) { return page.getByRole("region", { name: "account routing recovery" }); }
async function openRecovery(page: Page) {
  await page.goto("/dashboard/access?resource=upstream");
  await expect(recoveryPanel(page).getByRole("button", { name: "Repair account publication" })).toBeEnabled();
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function flush(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }

async function recoveryFixture(page: Page) {
  const fixture = {
    email: "admin@example.com",
    readiness: { revision: 3, baseline: "existing", acceptedAt: "2026-09-23T00:00:00Z", phase: "complete", cursor: null, scanRevision: 3, scanned: 0, issues: [], overflow: false, activatedAt: "2026-09-23T00:00:00Z" } as GrantPoolReadiness,
    requests: [] as Array<{ action: string; body: unknown }>,
    waits: new Map<string, Promise<void>>(),
    replies: new Map<string, { status?: number; json: unknown }>(),
  };
  await page.route("**/v1**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/v1/admin/grant-pools/")) {
      const action = path.split("/").at(-1)!;
      fixture.requests.push({ action, body: route.request().method() === "POST" ? route.request().postDataJSON() : null });
      const response = structuredClone(fixture.replies.get(action) ?? { json: fixture.readiness });
      await fixture.waits.get(action);
      return route.fulfill(response);
    }
    if (path === "/v1/admin/bootstrap") return route.fulfill({ status: 500, json: { error: { message: "legacy account listing unavailable" } } });
    const responses: Record<string, unknown> = {
      "/v1": { endpoints: {} },
      "/v1/providers": { providers: [] }, "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: fixture.email, entitlements: { providers: [] } },
      "/v1/session/usage": { policies: [] }, "/v1/session/credentials": { credentials: [] },
    };
    return route.fulfill({ status: responses[path] ? 200 : 404, json: responses[path] ?? {} });
  });
  return fixture;
}
