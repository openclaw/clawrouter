import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { AccessPolicy, FusionConfig, FusionReadiness } from "../src/ui-types";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-06T12:00:00.000Z"));
  await page.addInitScript(() => localStorage.setItem("clawrouter-theme", "light"));
});

test("dashboard is WCAG AA clean and visually stable", async ({ page }) => {
  await openDemo(page);
  await expect(page).toHaveScreenshot("dashboard.png", { animations: "disabled", fullPage: true });
  await expectA11yClean(page);
});

test("dashboard distinguishes unavailable prices from mixed and fully priced spend", async ({ page }) => {
  const summary = { requestCount: 2, successCount: 2, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0, unpricedRequestCount: 2 };
  const provider = { ...summary, provider: "openai" };
  const responses: Record<string, unknown> = {
    "/v1/providers": { providers: [] },
    "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
    "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "user", email: "user@example.com", entitlements: { providers: [] } },
    "/v1/session/credentials": { credentials: [] },
    "/v1/session/usage": { policies: [], usage: { ledger: "ready", summary, providers: [provider], daily: [], events: [] } },
  };
  await page.route("**/v1/**", async (route) => {
    const body = responses[new URL(route.request().url()).pathname];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  const spend = page.locator(".dashboardStats > div").filter({ has: page.getByText("accounted spend", { exact: true }) });
  for (const [unpriced, cost, label, value] of [
    [2, 0, "accounted spend", "Price unavailable"],
    [1, 1_000_000, "accounted spend", "$1.00 accounted; 1 unpriced"],
    [0, 1_000_000, "accounted spend", "$1.00"],
    [0, 0, "accounted spend", "$0.00"],
  ] as const) {
    summary.unpricedRequestCount = unpriced;
    summary.actualCostMicros = cost;
    Object.assign(provider, summary);
    await page.goto("/");
    await expect(spend.locator("span")).toHaveText(label);
    await expect(spend.locator("strong")).toHaveText(value);
    await expect(spend.locator("small")).toContainText("Last 30 days · May include estimates");
    await expect(page.locator(".providerChartValue small")).toHaveText(value);
    await expect(page.locator(".providerChartLegendMeta")).toHaveText("Requests · accounted spend · may include estimates");
  }
});

test("a provider without a cap still explains the other budget scopes", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  const budget = page.locator(".providerBudgetEditor");
  await expect(budget).toContainText("No cap at this scope");
  await expect(budget).toContainText("Provider-wide · UTC calendar month · Used includes reservations");
  await expect(budget).toContainText("Other policy or provider limits still apply");
});

test("Fusion preflight is WCAG AA clean and visually stable", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await page.getByRole("tab", { name: /Fusion/ }).click();
  await page.getByRole("button", { name: "Check readiness" }).click();
  await expect(page.getByRole("region", { name: "Fusion readiness" })).toBeVisible();
  // macOS text rasterization can vary by a handful of pixels with the pinned browser.
  await expect(page).toHaveScreenshot("fusion-readiness.png", { animations: "disabled", fullPage: true, maxDiffPixels: process.platform === "darwin" ? 10 : 0 });
  await expectA11yClean(page);
});

for (const adviserCount of [0, 4]) {
  test(`Fusion connectors stay between stages with ${adviserCount} advisers`, async ({ page, isMobile }) => {
    await openDemo(page);
    await page.getByRole("button", { name: "Access", exact: true }).click();
    await page.getByRole("tab", { name: /Fusion/ }).click();
    const advisers = ["local/adviser-one", "local/adviser-two", "local/adviser-three", "local/adviser-four"].slice(0, adviserCount);
    await page.getByRole("textbox", { name: "adviser models · one per line, maximum four" }).fill(advisers.join("\n"));
    await expect(page.locator(".fusionAdvisers strong")).toHaveText(advisers.length ? advisers : ["No advisers"]);
    await expectFusionConnectorsContained(page, isMobile ? "vertical" : "horizontal");
    await page.setViewportSize({ width: 320, height: 800 });
    await expectFusionConnectorsContained(page, "vertical");
  });
}

test("Fusion distinguishes unavailable request prices from an explicit zero tariff", async ({ page }) => {
  const { policy, fusion, call, responses } = fusionFixture();
  await page.route("**/v1/**", async (route) => {
    const body = responses[new URL(route.request().url()).pathname];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  await page.goto("/dashboard/access");
  await page.getByRole("tab", { name: /Fusion/ }).click();
  await expect(page.getByRole("combobox", { name: "readiness policy", exact: true })).toHaveValue(policy.policyId);
  await expect(page.getByRole("combobox", { name: "final synthesizer", exact: true })).toHaveValue(fusion.aggregatorModel);
  const checkReadiness = page.getByRole("button", { name: "Check readiness" });
  await expect(checkReadiness).toBeEnabled();
  const panel = page.getByRole("region", { name: "Fusion readiness" });
  for (const [basis, label] of [["unpriced_request", "Price unavailable"], ["policy_fixed", "$0.00"]] as const) {
    call.estimateBasis = basis;
    await checkReadiness.click();
    await expect(panel.locator(".fusionReadinessCalls b")).toHaveText(label);
    await expect(panel.locator(".fusionReadinessEstimate strong")).toHaveText(label);
  }
});

for (const action of ["preview", "save"] as const) {
  test(`Fusion ${action} failures show readable errors and preserve the draft without replay`, async ({ page }) => {
    const { policy, fusion, responses } = fusionFixture(["openai/gpt-4.1-mini"]);
    const writes: Array<{ path: string; method: string; body: unknown }> = [];
    const failurePath = action === "preview" ? "/v1/admin/fusion/preview" : "/v1/admin/fusion";
    const status = action === "preview" ? 409 : 503;
    const message = action === "preview" ? "The saved policy is ready for review." : "A connected profile is already saved.";
    await page.route("**/v1/**", async (route) => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() !== "GET") writes.push({ path, method: request.method(), body: request.postDataJSON() });
      if (path === failurePath) {
        await route.fulfill({ status, json: { error: { code: "fusion_fixture_rejected", message } } });
        return;
      }
      const body = responses[path];
      await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
    });
    await page.goto("/dashboard/access?resource=fusion");
    const panel = page.locator(".fusionInspector");
    await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
    await expect(panel.getByRole("combobox", { name: "readiness policy", exact: true })).toHaveValue(policy.policyId);
    const temperature = panel.getByRole("spinbutton", { name: "adviser temperature", exact: true });
    await temperature.fill("0.4");
    const draft = { ...fusion, temperature: 0.4 };
    const button = panel.getByRole("button", { name: action === "preview" ? "Check readiness" : "Save fusion model", exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    const expectedMessage = `Request failed (${status}): ${message}`;
    await expect(panel.getByRole("alert")).toHaveText(expectedMessage);
    await expect(page.locator(".connectionMeta strong")).toHaveText("Needs attention");
    await expect(page.locator(".statusBar-error")).toContainText(expectedMessage);
    await expect(button).toBeEnabled();
    await expect(temperature).toHaveValue("0.4");
    await expect(panel.getByRole("combobox", { name: "final synthesizer", exact: true })).toHaveValue(draft.aggregatorModel);
    await expect(panel.getByRole("textbox", { name: "adviser models · one per line, maximum four", exact: true })).toHaveValue(draft.adviserModels.join("\n"));
    // A later local edit remains possible without replaying the rejected request.
    await temperature.fill("0.6");
    await expect(temperature).toHaveValue("0.6");
    expect(writes).toEqual([
      { path: "/v1/admin/fusion/preview", method: "POST", body: { policyId: policy.policyId, config: draft } },
      ...(action === "save" ? [{ path: "/v1/admin/fusion", method: "PUT", body: draft }] : []),
    ]);
  });
}

test("keyboard focus remains visible", async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus-visible");
  await expect(focused).toBeVisible();
  const outline = await focused.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");
});

test("OpenAI grants explain the API-key path without offering unsupported browser Connect", async ({ page }) => {
  await page.goto("/dashboard/access?demo=1&resource=upstream");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.getByRole("combobox", { name: "provider", exact: true }).selectOption("openai");
  await expect(page.getByRole("button", { name: "Connect with provider" })).toHaveCount(0);
  await expect(page.getByText("OpenAI subscription Connect is unavailable in the bundled provider.")).toBeVisible();
  await expect(page.getByRole("link", { name: "OpenAI setup and subscription limits" })).toHaveAttribute("href", "https://github.com/openclaw/clawrouter/blob/main/docs/openai-subscriptions.md");
  await expect(page.getByRole("combobox", { name: "kind", exact: true })).toHaveValue("api_key");
  await expect(page.getByLabel("fresh API key", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled();
  await page.getByRole("combobox", { name: "kind", exact: true }).selectOption("subscription");
  await expect(page.getByRole("button", { name: "Connect with provider" })).toHaveCount(0);
  await expect(page.getByText("OpenAI subscription Connect is unavailable in the bundled provider.")).toBeVisible();
  await page.getByRole("combobox", { name: "provider", exact: true }).selectOption("anthropic");
  await expect(page.getByText("OpenAI subscription Connect is unavailable in the bundled provider.")).toHaveCount(0);
});

test("self-service keys reveal browser-generated material once and can be revoked", async ({ page }) => {
  await openDemo(page);
  const card = page.locator(".myKeysPanel");
  await card.getByRole("button", { name: "Create key" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(card.getByText("stored nowhere else")).toBeVisible();
  await expect(card.locator("code")).toHaveText(/^clawrouter-live-key_[0-9a-f]{16}-[0-9a-f]{48}$/);
  await expect(card.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(card.locator(".myKeysList article")).toHaveCount(1);
  await card.getByRole("button", { name: "Revoke" }).click();
  await expect(card.getByText(/revoked/)).toBeVisible();
  await expect(card.locator("code")).toHaveCount(0);
});

async function openDemo(page: Page) {
  await page.goto("/?demo=1");
  await expect(page.locator(".appShell")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function expectFusionConnectorsContained(page: Page, direction: "horizontal" | "vertical") {
  const geometry = await page.locator(".fusionTopology").evaluate((topology) => {
    const bounds = (element: Element | Range) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    return {
      topology: bounds(topology),
      stages: [".fusionInput", ".fusionAdvisers", ".fusionOutput"].map((selector) => bounds(topology.querySelector(selector)!)),
      connectors: Array.from(topology.querySelectorAll(".fusionArrow"), (connector) => {
        const glyph = document.createRange();
        glyph.selectNodeContents(connector);
        return { cell: bounds(connector), glyph: bounds(glyph) };
      }),
      viewportWidth: window.innerWidth,
    };
  });
  expect(geometry.topology.left).toBeGreaterThanOrEqual(0);
  expect(geometry.topology.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.connectors).toHaveLength(2);
  for (const [index, { cell, glyph }] of geometry.connectors.entries()) {
    // Measure the painted rectangles: layout dimensions alone miss a rotated cell.
    for (const [inner, outer] of [[cell, geometry.topology], [glyph, cell]]) {
      expect(inner.left).toBeGreaterThanOrEqual(outer.left - 1);
      expect(inner.top).toBeGreaterThanOrEqual(outer.top - 1);
      expect(inner.right).toBeLessThanOrEqual(outer.right + 1);
      expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 1);
    }
    const before = geometry.stages[index], after = geometry.stages[index + 1];
    if (direction === "vertical") {
      expect(cell.top).toBeGreaterThanOrEqual(before.bottom - 1);
      expect(cell.bottom).toBeLessThanOrEqual(after.top + 1);
    } else {
      expect(cell.left).toBeGreaterThanOrEqual(before.right - 1);
      expect(cell.right).toBeLessThanOrEqual(after.left + 1);
    }
  }
}

function fusionFixture(adviserModels: string[] = []) {
  const policy: AccessPolicy = {
    policyId: "fixture", enabled: true, providers: [], monthlyBudgetMicros: null, requestCostMicros: null, retainRequestContent: false,
    grantRouting: { strategy: "most_remaining", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} },
  };
  const fusion: FusionConfig = { version: 1, modelId: "clawrouter/fusion", enabled: true, adviserModels, aggregatorModel: "perplexity/sonar-pro", adviserTimeoutMs: 1000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 };
  const call: FusionReadiness["calls"][number] = { stage: "synthesizer", index: null, model: fusion.aggregatorModel, provider: "perplexity", policyAllowed: true, executable: true, verified: false, status: "unverified", reasons: [], estimatedReservationMicros: 0, estimateBasis: "unpriced_request" };
  const calls: FusionReadiness["calls"] = [...adviserModels.map((model, index) => ({ ...call, stage: "adviser" as const, index: index + 1, model, provider: model.split("/")[0] })), call];
  const preview: FusionReadiness = { policyId: policy.policyId, policyEnabled: true, configEnabled: true, executable: true, advertisable: true, readyAdviserCount: adviserModels.length, adviserCount: adviserModels.length, callCount: calls.length, estimatedReservationMicros: 0, budgetConfigured: false, budgetLedger: "unmetered", remainingBudgetMicros: null, budgetSufficientForAll: null, estimateNote: "Complete price unavailable.", calls };
  const responses: Record<string, unknown> = {
    "/v1/providers": { providers: [] }, "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
    "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: "admin@example.com", entitlements: { providers: [], catalog: { version: "clawrouter.client-catalog.v1", observedAt: "2026-07-06T12:00:00.000Z", scope: { authType: "access", credentialId: null, principalId: "admin@example.com" }, providers: [] } } },
    "/v1/session/credentials": { credentials: [] }, "/v1/session/usage": { policies: [] },
    "/v1/admin/bootstrap": { policies: [policy], credentials: [], connections: [], users: [], bindings: [], grants: [], rules: [], providers: [], tenants: [], overview: {}, fusion },
    "/v1/admin/fusion/preview": preview,
  };
  return { policy, fusion, call, responses };
}

async function expectA11yClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
}
