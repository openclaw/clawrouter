import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-06T12:00:00.000Z"));
  await page.addInitScript(() => localStorage.setItem("clawrouter-theme", "light"));
});

test("dashboard is WCAG AA clean and visually stable", async ({ page }) => {
  await openDemo(page);
  await expect(page).toHaveScreenshot("dashboard.png", { animations: "disabled", fullPage: true });
  await expectA11yClean(page);
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
  await page.getByRole("button", { name: "New grant", exact: true }).click();
  await page.getByRole("combobox", { name: "provider", exact: true }).selectOption("openai");
  await expect(page.getByRole("button", { name: "Connect with provider" })).toHaveCount(0);
  await expect(page.getByText("OpenAI subscription Connect is unavailable in the bundled provider.")).toBeVisible();
  await expect(page.getByRole("link", { name: "OpenAI setup and subscription limits" })).toHaveAttribute("href", "https://github.com/openclaw/clawrouter/blob/main/docs/openai-subscriptions.md");
  await expect(page.getByRole("combobox", { name: "kind", exact: true })).toHaveValue("api_key");
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save grant" })).toBeEnabled();
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

async function expectA11yClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
}
