import { expect, test, type Page } from "@playwright/test";
import { fixtureResponses } from "./fixtures/personal-usage";
import { demoCatalog } from "../src/demo-catalog";
import type { ProviderAccess, ProviderReadiness, RouteCatalog } from "../src/ui-types";

const searchPath = "/v1/proxy/tavily/search";
const pick = (page: Page) => page.getByRole("combobox", { name: "Provider", exact: true });
const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true });
const body = (page: Page) => page.getByRole("textbox", { name: "JSON request body" });
function access(provider: string, allowed: boolean, executable: boolean): ProviderAccess {
  const serviceKind = provider === "tavily" ? "search" : "model_provider";
  const readiness: ProviderReadiness = { id: provider, displayName: provider, class: "fixture", serviceKind,
    requiredConfig: [], optionalConfig: [], missingConfig: [], configPresent: true, connectionEnabled: executable,
    oauthGrantRequired: false, oauthGrantCount: 0, upstreamGrantCount: 0, openaiCompatible: serviceKind === "model_provider",
    manifestRoutes: 1, modelCount: 1, executable, verified: false, status: executable ? "configured" : "disabled",
    reasons: executable ? [] : ["Provider connection disabled."] };
  return { provider, displayName: provider, serviceKind, allowed, policies: allowed ? ["research"] : [], readiness };
}
async function fixture(page: Page) {
  const state = { members: [access("anthropic", false, true), access("openai", true, false), access("tavily", true, true)],
    fail: false, hold: null as Promise<void> | null, unexpected: [] as string[] };
  const routes: RouteCatalog = { openaiCompatible: ["anthropic", "openai"].map(provider => ({ provider, endpoints: ["/v1/chat/completions"],
    models: [{ id: provider + "/chat", capabilities: ["llm.chat"], endpoints: ["/v1/chat/completions"] }] })),
    manifestProxy: [{ provider: "tavily", endpoint: "search", route: searchPath, methods: ["POST"], requestFormat: "tavily.search" }] };
  await page.route("**/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET" || path.startsWith("/v1/admin/")) {
      state.unexpected.push(path); return route.fulfill({ status: 405, json: {} });
    }
    if (path === "/v1/session/avatar") return route.fulfill({ status: 204 });
    if (path === "/v1/routes") return route.fulfill({ json: routes });
    if (path === "/v1/providers") return route.fulfill({ json: { providers: state.members.map(a => ({ id: a.provider, display_name: a.displayName, service_kind: a.serviceKind, class: "fixture", capabilities: [] })) } });
    const session = { authenticated: true, role: "user", auth: "cloudflare_access", email: "member@example.com", tenantId: "research" };
    if (path === "/v1/session") return route.fulfill({ json: session });
    if (path === "/v1/entitlements") {
      await state.hold;
      return route.fulfill(state.fail ? { status: 503, json: { error: "Entitlements temporarily unavailable" } } : { json: { session, providers: state.members, policies: [] } });
    }
    return route.fulfill({ status: fixtureResponses[path] ? 200 : 404, json: fixtureResponses[path] ?? {} });
  });
  return { state, routes };
}

for (const from of ["Dashboard", "direct link"]) {
  test(`first Playground entry via ${from} opens the only eligible search service without sending`, async ({ page }) => {
    const { state } = await fixture(page);
    await page.goto(from === "Dashboard" ? "/" : "/dashboard/playground");
    if (from === "Dashboard") {
      await expect(page.locator(".servicePanel")).toContainText("1 of 2 usable");
      await page.getByRole("button", { name: "Open playground" }).press("Enter");
    }
    await expect(pick(page)).toHaveValue("tavily");
    await expect(page.locator(".chatHeader strong")).toHaveText("tavily / search");
    await expect(page.locator(".chatFacts")).toContainText("/v1/playground/proxy/tavily/search");
    expect(JSON.parse(await body(page).inputValue())).toEqual({ query: "OpenClaw", max_results: 1 });
    await expect(send(page)).toBeEnabled();
    expect(state.unexpected).toEqual([]);
  });
}

test("eligible chat stays preferred over search; a deliberate Catalog service draft survives later navigation and refresh", async ({ page }) => {
  const { state } = await fixture(page);
  state.members[0] = access("anthropic", true, true);
  state.members[1] = access("openai", true, true);
  await page.goto("/dashboard/playground"); await expect(pick(page)).toHaveValue("openai");
  await page.getByRole("button", { name: "Catalog", exact: true }).press("Enter");
  await page.getByRole("textbox", { name: "search catalog" }).fill("tavily");
  await page.getByRole("button", { name: "Try in playground" }).press("Enter");
  await body(page).fill('{"query":"keep me"}');
  await page.getByRole("button", { name: "Dashboard", exact: true }).press("Enter");
  const refreshed = page.waitForResponse(r => new URL(r.url()).pathname === "/v1/entitlements");
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await refreshed;
  await page.getByRole("button", { name: "Open playground" }).press("Enter");
  await expect(pick(page)).toHaveValue("tavily"); await expect(body(page)).toHaveValue('{"query":"keep me"}');
  expect(state.unexpected).toEqual([]);
});

test("a failed or denied entitlement read does not unlock a fresh target", async ({ page }) => {
  const { state } = await fixture(page);
  state.fail = true;
  await page.goto("/dashboard/playground"); await expect(page.getByRole("button", { name: "Retry refresh" })).toBeVisible();
  await expect(send(page)).toBeDisabled(); await expect(body(page)).toHaveCount(0);
  state.fail = false; state.members = state.members.map(a => access(a.provider, false, true));
  await page.getByRole("button", { name: "Retry refresh" }).press("Enter");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected"); await expect(send(page)).toBeDisabled();
  expect(state.unexpected).toEqual([]);
});

for (const typed of [false, true]) {
  test(`late entitlements initialize only an untouched draft (typed=${typed})`, async ({ page }) => {
    const { state } = await fixture(page);
    let release!: () => void;
    state.hold = new Promise<void>(resolve => { release = resolve; });
    const pending = page.waitForRequest("**/v1/entitlements"); await page.goto("/dashboard/playground"); await pending;
    const prompt = page.getByRole("textbox", { name: "Message", exact: true });
    try { await expect(send(page)).toBeDisabled(); if (typed) await prompt.fill("Keep my unsent draft"); }
    finally { release(); }
    await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
    if (typed) { await expect(prompt).toHaveValue("Keep my unsent draft"); await expect(send(page)).toBeDisabled(); }
    else { await expect(pick(page)).toHaveValue("tavily"); await expect(send(page)).toBeEnabled(); }
    expect(state.unexpected).toEqual([]);
  });
}

for (const allowed of [true, false]) {
  test(`an early edit can explicitly select the sole model before a late ${allowed ? "grant" : "denial"}`, async ({ page }) => {
    const { state, routes } = await fixture(page);
    routes.openaiCompatible = routes.openaiCompatible.filter(route => route.provider === "openai");
    routes.manifestProxy = [];
    state.members = [access("openai", allowed, true)];
    const inventory = Promise.withResolvers<void>();
    const entitlement = Promise.withResolvers<void>();
    state.hold = entitlement.promise;
    await page.route("**/v1/routes", async route => { await inventory.promise; await route.fallback(); });
    const pending = page.waitForRequest("**/v1/routes");
    const picker = page.getByRole("combobox", { name: "Model or route" });
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    const heading = page.locator(".chatHeader strong");
    try {
      await page.goto("/dashboard/playground");
      await pending;
      await message.fill("Keep this draft");
      await message.press("Enter"); // No dispatch, and nothing queued to replay.
      inventory.resolve();
      await expect(picker.getByRole("option", { name: "chat", exact: true })).toHaveCount(1);
      await expect(heading).toHaveText("Select a model");
      await expect(picker.locator("option:checked")).toHaveText("Select a model or route");
      await expect(send(page)).toBeDisabled();

      await picker.press("ArrowDown");
      await expect(heading).toHaveText("openai/chat");
      await expect(picker).toHaveValue("model:openai/chat");
      await expect(picker).toBeFocused();
      await expect(send(page)).toBeDisabled(); // Selecting a model doesn't grant access.
      entitlement.resolve();
      await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
      await expect(message).toHaveValue("Keep this draft");
      if (allowed) await expect(send(page)).toBeEnabled();
      else await expect(send(page)).toBeDisabled();
      await expect(page.getByRole("button", { name: "Inspect assistant response" })).toHaveCount(0);
      expect(state.unexpected).toEqual([]);
    } finally { inventory.resolve(); entitlement.resolve(); }
  });
}

test("service-only inventory initializes a model-bearing proxy preset using its real body field", async ({ page }) => {
  const { state, routes } = await fixture(page);
  routes.openaiCompatible = [];
  state.members = [access("cohere", true, true)];
  routes.manifestProxy = [{ provider: "cohere", endpoint: "embed", route: "/v1/proxy/cohere/embed", methods: ["POST"],
    requestFormat: "cohere.embed", models: [{ id: "cohere/embed-english", capabilities: ["llm.embeddings"] }] }];
  await page.goto("/dashboard/playground"); await expect(pick(page)).toHaveValue("cohere");
  await expect(page.locator(".modelPicker option:checked")).toHaveText("embed-english");
  expect(JSON.parse(await body(page).inputValue()).model).toBe("cohere/embed-english"); await expect(send(page)).toBeEnabled(); expect(state.unexpected).toEqual([]);
});

test("a failed refresh blocks an existing service draft without selecting a newly available chat on retry", async ({ page }) => {
  const { state } = await fixture(page);
  await page.goto("/dashboard/playground");
  await expect(pick(page)).toHaveValue("tavily");
  await body(page).fill('{"query":"unsent research"}');
  state.fail = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const retry = page.getByRole("button", { name: "Retry refresh" });
  await expect(retry).toBeVisible();
  await expect(body(page)).toHaveValue('{"query":"unsent research"}');
  await expect(send(page)).toBeDisabled();
  state.fail = false;
  state.members = [access("openai", true, true), access("tavily", false, true)];
  await retry.press("Enter");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(pick(page)).toHaveValue("tavily");
  await expect(body(page)).toHaveValue('{"query":"unsent research"}');
  await expect(send(page)).toBeDisabled();
  expect(state.unexpected).toEqual([]);
});

test("the bundled Tavily routes open a model-free request when the member has no usable chat model", async ({ page }) => {
  const { state, routes } = await fixture(page);
  const bundled = demoCatalog().routes;
  Object.assign(routes, bundled);
  state.members = [access("tavily", true, true)];
  await page.goto("/dashboard/playground");
  await expect(pick(page)).toHaveValue("tavily");
  const endpoint = await page.locator(".chatFacts dd").last().innerText();
  const active = bundled.manifestProxy.find(route => route.route.replace("/v1/proxy/", "/v1/playground/proxy/") === endpoint);
  expect(active?.provider).toBe("tavily");
  await expect(page.locator(".chatHeader strong")).toHaveText("tavily / " + active!.endpoint);
  const selected = page.locator(".modelPicker option:checked");
  await expect(selected).toHaveAttribute("value", `service:${active!.provider}:${active!.endpoint}:${active!.route}`);
  await expect(selected).toHaveText(active!.endpoint + " (route)");
  expect(JSON.parse(await body(page).inputValue())).not.toHaveProperty("model");
  await expect(send(page)).toBeEnabled();
  expect(state.unexpected).toEqual([]);
});
