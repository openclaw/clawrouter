import { expect, test, type Page } from "@playwright/test";
import { fixtureNow, fixtureResponses } from "./fixtures/personal-usage";

async function expectReadableHeader(page: Page) {
  const labels = [page.locator(".pageTitle h1"), page.locator(".pageTitle p")];
  const controls = [page.locator(".connectionMeta"), page.getByRole("switch")];
  for (const label of labels) {
    for (const control of controls) {
      const [a, b] = await Promise.all([label.boundingBox(), control.boundingBox()]);
      if (!a || !b) throw new Error("Missing header label or control");
      expect(a.x + a.width <= b.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
  }
  for (const element of [...labels, ...controls]) await expect(element).toBeInViewport({ ratio: 1 });
}

test("phone header keeps page and connection labels readable through refresh failure", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.clock.setFixedTime(fixtureNow);
  let failUsage = false;
  await page.route("**/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/session/avatar") return route.fulfill({ status: 204 });
    if (failUsage && path === "/v1/session/usage") return route.fulfill({ status: 503, body: "Quota unavailable" });
    return route.fulfill({ status: path in fixtureResponses ? 200 : 404, json: fixtureResponses[path] ?? {} });
  });
  await page.goto("/dashboard/catalog");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await page.evaluate(() => document.fonts.ready);
  await expectReadableHeader(page);

  failUsage = true;
  await page.clock.setFixedTime(fixtureNow + 60_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".connectionMeta strong")).toHaveText("Needs attention");
  await expect(page.getByRole("status")).toContainText("Quota data may be out of date.");
  await expectReadableHeader(page);

  failUsage = false;
  const toggle = page.getByRole("switch");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectReadableHeader(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Retry refresh" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expectReadableHeader(page);
});
