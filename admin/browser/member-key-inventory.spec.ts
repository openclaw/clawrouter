import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { fixtureResponses } from "./fixtures/personal-usage";
import type { ProxyCredential } from "../src/ui-types";

const policyId = "studio";
const budget = { configured: false, ledger: "unmetered", limitMicros: null, spentMicros: 0, remainingMicros: null };
const row = { kid: policyId, policyId, enabled: true, tenantId: "studio", providers: [], monthlyBudgetMicros: null, budget };

function gate() {
  let open!: () => void;
  return { release: () => open(), wait: new Promise<void>(resolve => { open = resolve; }) };
}

async function member(page: Page) {
  const state = { held: true, inline: true, failKeys: false, failPolicies: false, keys: [] as ProxyCredential[],
    keyGate: null as ReturnType<typeof gate> | null, policyGate: null as ReturnType<typeof gate> | null,
    keyReads: 0, requests: [] as {method: string; path: string}[], allowIssue: false };
  await page.route("**/v1/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    state.requests.push({ method, path });
    if (state.allowIssue && path === "/v1/session/credentials" && method === "POST") {
      state.allowIssue = false;
      const { credentialId, policyId } = route.request().postDataJSON();
      const credential = { credentialId, policyId, enabled: true, active: true, principalId: "member@example.com" };
      state.keys = [credential]; state.failKeys = true;
      return route.fulfill({ status: 201, json: credential });
    }
    if (method !== "GET" || path.startsWith("/v1/admin/")) return route.abort();
    const session = { authenticated: true, auth: "cloudflare_access", role: "user", email: "member@example.com", tenantId: "studio",
      entitlements: { providers: [], ...(state.inline ? { policies: state.held ? [{ policyId, budget }] : [] } : {}) } };
    if (path === "/v1/session") return route.fulfill({ json: session });
    if (path === "/v1/session/credentials") {
      state.keyReads++; await state.keyGate?.wait;
      return route.fulfill(state.failKeys ? { status: 503, json: { error: { message: "Inventory temporarily unavailable" } } } : { json: { credentials: state.keys } });
    }
    if (path === "/v1/session/usage") {
      await state.policyGate?.wait;
      return route.fulfill(state.failPolicies ? { status: 503, json: { error: { message: "Allowance read unavailable" } } } : { json: { ...fixtureResponses[path] as object, policies: state.held ? [row] : [] } });
    }
    if (path === "/v1/session/usage/report") return route.fulfill({ json: { kind: "no_access" } });
    const json = fixtureResponses[path]; return route.fulfill({ status: json ? 200 : 404, json: json ?? {} });
  });
  return state;
}
function expectReadsOnly(requests: {method: string; path: string}[]) {
  expect(requests.filter(r => r.method !== "GET" || r.path.startsWith("/v1/admin/"))).toEqual([]);
}
async function refresh(page: Page) { await page.evaluate(() => window.dispatchEvent(new Event("focus"))); }

test("member key inventory: unknown is not empty; keyboard retry recovers confirmed access", async ({ page }, info) => {
  const state = await member(page); state.keyGate = gate(); state.failKeys = true;
  await page.goto("/dashboard/home");
  if (info.project.name === "mobile") await page.getByRole("switch", { name: "Light mode" }).click();
  const card = page.locator(".myKeysPanel");
  await expect(card).toContainText("Loading your keys");
  await expect(card).not.toContainText(/0\/0 enabled|No personal keys|No policy assigned/);
  state.keyGate.release(); state.keyGate = null;
  await expect(card).toContainText("Your keys couldn’t be loaded");
  await expect(card).not.toContainText(/0\/0 enabled|No personal keys|No policies available|No policy assigned/);
  expect((await new AxeBuilder({page}).include(".myKeysPanel").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  const retry = card.getByRole("button", { name: "Retry key access" });
  state.failKeys = false; await retry.focus(); await page.keyboard.press("Enter");
  await expect(card.getByRole("combobox", { name: "policy", exact: true })).toHaveValue(policyId);
  await expect(card.getByRole("button", { name: "Create key" })).toBeEnabled(); await expect(card).toContainText("No personal keys");
  await expect(card).toContainText("0/0 enabled"); await expect(retry).toHaveCount(0);
  expect(state.keyReads).toBe(2); expectReadsOnly(state.requests);
});

for (const action of ["Retry key access", "Retry refresh"]) {
  for (const phase of ["initial", "stale"]) {
    test(`${phase} inventory: ${action} keeps focus after another failure and admits one read per retry`, async ({ page }) => {
      const state = await member(page);
      state.failKeys = phase === "initial";
      state.keys = [{ credentialId: "old-laptop", policyId, enabled: true, active: true }];
      await page.goto("/dashboard/home");
      const card = page.locator(".myKeysPanel");
      if (phase === "stale") {
        await expect(card).toContainText("old-laptop");
        state.failKeys = true;
        await refresh(page);
      }
      const note = phase === "initial" ? "Your keys couldn’t be loaded." : "Your keys couldn’t be refreshed. Showing the last known key list.";
      const count = phase === "initial" ? "Unavailable" : "Last known: 1/1 enabled";
      const retry = page.getByRole("button", { name: action, exact: true });
      await expect(card.getByRole("status")).toHaveText(note);
      await expect(retry).toBeEnabled();
      await retry.focus();
      const before = state.keyReads;
      state.keyGate = gate();
      try {
        await page.keyboard.press("Enter");
        await expect.poll(() => state.keyReads).toBe(before + 1);
        const pending = page.getByRole("button", { name: action === "Retry key access" ? "Retrying…" : action, exact: true });
        await expect(pending).toBeDisabled();
        await expect(pending).toBeFocused();
        for (let press = 0; press < 3; press++) await page.keyboard.press("Enter");
      } finally { state.keyGate.release(); state.keyGate = null; }
      await expect(retry).toBeEnabled();
      await expect(retry).toBeFocused();
      await expect(card.getByRole("status")).toHaveText(note);
      await expect(card.locator(".dashboardPanelMeta")).toHaveText(count);
      await expect(card.getByText("old-laptop", { exact: true })).toHaveCount(phase === "initial" ? 0 : 1);
      expect(state.keyReads).toBe(before + 1);
      state.failKeys = false;
      state.keys = [{ credentialId: "current-laptop", policyId, enabled: true, active: true }];
      await page.keyboard.press("Enter"); // No re-focusing the recovered Retry button.
      await expect(card).toContainText("current-laptop");
      await expect(card).not.toContainText("old-laptop");
      await expect(card.locator(".dashboardPanelMeta")).toHaveText("1/1 enabled");
      await expect(retry).toHaveCount(0);
      expect(state.keyReads).toBe(before + 2);
      expectReadsOnly(state.requests);
    });
  }

  test(`${action} does not take focus back after Tab or navigation during the read`, async ({ page }) => {
    const state = await member(page);
    state.failKeys = true;
    await page.goto("/dashboard/home");
    const retry = page.getByRole("button", { name: action, exact: true });
    const nav = page.getByRole("navigation", { name: "console" });
    const catalog = nav.getByRole("button", { name: "Catalog", exact: true });
    await expect(retry).toBeEnabled();
    for (const navigate of [false, true]) {
      const before = state.keyReads;
      state.keyGate = gate();
      try {
        await retry.press("Enter");
        await expect.poll(() => state.keyReads).toBe(before + 1);
        if (navigate) {
          await catalog.press("Enter");
          await expect(page.getByRole("heading", { name: "Catalog", exact: true })).toBeVisible();
          await page.goBack();
          await expect(nav.getByRole("button", { name: "Dashboard", exact: true })).toBeFocused();
        } else {
          await page.keyboard.press("Tab");
          const pending = page.getByRole("button", { name: action === "Retry key access" ? "Retrying…" : action, exact: true });
          await expect(pending).not.toBeFocused();
        }
        const moved = await page.locator(":focus").elementHandle();
        state.keyGate.release();
        await expect(retry).toBeEnabled();
        expect(await moved!.evaluate(element => element === document.activeElement)).toBe(true);
      } finally { state.keyGate.release(); state.keyGate = null; }
      expect(state.keyReads).toBe(before + 1);
    }
    expectReadsOnly(state.requests);
  });
}

test("a card retry queued behind automatic refresh owns one pending manual read", async ({ page }) => {
  const state = await member(page);
  state.failKeys = true;
  await page.goto("/dashboard/home");
  const card = page.locator(".myKeysPanel");
  const retry = card.getByRole("button", { name: "Retry key access" });
  await expect(retry).toBeEnabled();
  const before = state.keyReads;
  const automatic = gate(), manual = gate();
  state.keyGate = automatic;
  try {
    await refresh(page);
    await expect.poll(() => state.keyReads).toBe(before + 1);
    await retry.press("Enter");
    const pending = card.getByRole("button", { name: "Retrying…" });
    await expect(pending).toBeDisabled();
    await expect(pending).toBeFocused();
    await expect(page.getByRole("button", { name: "Retry refresh", exact: true })).toBeDisabled();
    await page.keyboard.press("Enter");
    state.keyGate = manual;
    automatic.release();
    await expect.poll(() => state.keyReads).toBe(before + 2);
    await refresh(page);
    await page.keyboard.press("Enter");
    manual.release();
    await expect(retry).toBeEnabled();
    await expect(retry).toBeFocused();
    expect(state.keyReads).toBe(before + 2);
    expectReadsOnly(state.requests);
  } finally { automatic.release(); manual.release(); state.keyGate = null; }
});

for (const previous of [false, true]) {
  test(`detached ${previous ? "stale" : "unavailable"} policy recovery owns both retries without blocking navigation`, async ({ page }) => {
    const state = await member(page);
    state.inline = false;
    state.failPolicies = !previous;
    state.keys = [{ credentialId: "old-laptop", policyId, enabled: true, active: true }];
    await page.goto("/dashboard/home");
    const card = page.locator(".myKeysPanel"), bar = page.locator(".refreshNotice");
    const note = previous ? "Your policies couldn’t be refreshed. Showing the last known selection." : "Your policies couldn’t be loaded.";
    if (previous) {
      await expect(card.getByRole("combobox", { name: "policy", exact: true })).toHaveValue(policyId);
      state.failPolicies = true;
      await refresh(page);
    }
    await expect(card.getByRole("status")).toHaveText(note);
    const start = state.requests.length;
    const pending = gate();
    state.policyGate = pending;
    state.keys = [{ credentialId: "current-laptop", policyId, enabled: true, active: true }];
    try {
      await bar.getByRole("button", { name: "Retry refresh" }).press("Enter");
      await expect(card).toContainText("current-laptop"); // Credentials settled; policy fallback has not.
      await expect(card.getByRole("status")).toHaveText(note);
      await expect(card).not.toContainText("No policy assigned");
      await expect(card.getByRole("button", { name: "Retrying…" })).toBeDisabled();
      const shellRetry = bar.getByRole("button", { name: "Retry refresh" });
      await expect(shellRetry).toBeDisabled();
      await expect(shellRetry).toBeFocused();
      await page.keyboard.press("Enter");
      await refresh(page);
      const nav = page.getByRole("navigation", { name: "console" });
      await nav.getByRole("button", { name: "Catalog", exact: true }).press("Enter");
      await expect(page.getByRole("heading", { name: "Catalog", exact: true })).toBeVisible();
      await page.goBack();
      await expect(nav.getByRole("button", { name: "Dashboard", exact: true })).toBeFocused();
      await expect(card.getByRole("button", { name: "Retrying…" })).toBeDisabled();
      pending.release();
      await expect(card.getByRole("button", { name: "Retry key access" })).toBeEnabled();
      await expect(card.getByRole("status")).toHaveText(note);
      await expect(nav.getByRole("button", { name: "Dashboard", exact: true })).toBeFocused();
      state.policyGate = null;
      state.failPolicies = false;
      await card.getByRole("button", { name: "Retry key access" }).press("Enter");
      await expect(card.getByRole("status")).toHaveCount(0);
      await expect(card.getByRole("combobox", {name: "policy", exact: true})).toHaveValue(policyId);
      const reads = state.requests.slice(start);
      for (const path of ["/v1/session/credentials", "/v1/session/usage"]) expect(reads.filter(r => r.path === path)).toHaveLength(2);
      expectReadsOnly(state.requests);
    } finally { pending.release(); state.policyGate = null; }
  });
}

test("a confirmed unassigned member sees a next step instead of an impossible create action", async ({ page }) => {
  const state = await member(page); state.held = false;
  await page.goto("/dashboard/home"); const card = page.locator(".myKeysPanel");
  await expect(card).toContainText("Ask an administrator to assign a policy"); await expect(card).toContainText("No personal keys");
  await expect(card).not.toContainText("Create one"); await expect(card.getByRole("button", { name: "Create key" })).toHaveCount(0);
  expectReadsOnly(state.requests);
});

test("a missing policy projection is not a confirmed empty list; failed fallback is retryable", async ({ page }) => {
  const state = await member(page); state.inline = false; state.policyGate = gate(); state.failPolicies = true;
  await page.goto("/dashboard/home"); const card = page.locator(".myKeysPanel");
  await expect(card).toContainText("Loading your policies"); await expect(card).toContainText("No personal keys");
  await expect(card).not.toContainText(/No policy assigned|Create one/);
  state.policyGate.release(); state.policyGate = null;
  await expect(card).toContainText("Your policies couldn’t be loaded"); await expect(card).not.toContainText("No policy assigned");
  state.failPolicies = false; await card.getByRole("button", {name:"Retry key access"}).press("Enter");
  await expect(card.getByRole("combobox", {name:"policy",exact:true})).toHaveValue(policyId); expectReadsOnly(state.requests);
});

test("a failed background read keeps labeled last-known keys and the member's creation draft", async ({ page }) => {
  const state = await member(page); state.keys = [{ credentialId:"laptop", policyId, enabled:true, active:true }];
  await page.goto("/dashboard/home"); const card = page.locator(".myKeysPanel");
  const name = card.getByRole("textbox", {name:"Name (optional)"}); await name.fill("Next laptop");
  state.failKeys = true; await refresh(page);
  await expect(card).toContainText("Last known: 1/1 enabled"); await expect(card).toContainText("Showing the last known key list");
  await expect(card.getByRole("button", {name:"Create key"})).toBeDisabled(); await expect(card.getByRole("button", {name:"Renew"})).toBeDisabled();
  await expect(card.getByRole("button", {name:"Revoke"})).toBeEnabled();
  state.failKeys = false; state.keys = []; await card.getByRole("button", {name:"Retry key access"}).press("Enter");
  await expect(card).toContainText("No personal keys"); await expect(name).toHaveValue("Next laptop");
  await expect(card.getByRole("button", {name:"Create key"})).toBeEnabled(); expectReadsOnly(state.requests);
});

test("inventory retry cannot replay credential issuance or restore a dismissed secret", async ({ page }) => {
  const state = await member(page); state.allowIssue = true;
  await page.goto("/dashboard/home"); const card = page.locator(".myKeysPanel");
  await card.getByRole("button", {name:"Create key"}).click();
  await expect(card).toContainText("Showing the last known key list");
  await expect(card.locator(".issuedKey")).toBeVisible(); await card.getByRole("button",{ name:"Dismiss",exact:true }).click();
  const start = state.requests.length; state.failKeys = false;
  await card.getByRole("button", { name:"Retry key access" }).press("Enter");
  await expect(card.getByRole("button", { name:"Create key" })).toBeEnabled();
  await expect(card.locator(".issuedKey")).toHaveCount(0); expectReadsOnly(state.requests.slice(start));
  expect(state.requests.filter(r => r.method !== "GET")).toEqual([{ method:"POST", path:"/v1/session/credentials" }]);
});
