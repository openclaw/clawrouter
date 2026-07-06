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
  await expect(page).toHaveScreenshot("fusion-readiness.png", { animations: "disabled", fullPage: true });
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

async function openDemo(page: Page) {
  await page.goto("/?demo=1");
  await expect(page.locator(".appShell")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function expectA11yClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
}
