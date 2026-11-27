import { expect, test, type Page } from "@playwright/test";
import { fixtureNow, fixtureResponses } from "./fixtures/personal-usage";

const nav = (page: Page) => page.getByRole("navigation", { name: "console" });
const item = (page: Page, name: string) => nav(page).getByRole("button", { name, exact: true });

for (const role of ["user", "admin"] as const) {
  test(role + " navigation keeps the current page and keyboard focus together through history", async ({ page }) => {
    const demo = role === "user" ? "?demo=user" : "?demo=1";
    const end = role === "user" ? "My usage" : "Access";
    const lastPath = role === "user" ? "my-usage" : "access";
    async function expectPage(name: string, path: string) {
      await expect(page).toHaveURL(url => url.pathname === "/dashboard/" + path && url.search === demo);
      await expect(page.getByRole("heading", { name, level: 1, exact: true })).toBeVisible();
      await expect(nav(page).locator('[aria-current="page"]')).toHaveText(name);
    }
    await page.goto("/dashboard/home" + demo);
    await item(page, "Catalog").click(); // Ordinary pointer navigation is unchanged.
    await expectPage("Catalog", "catalog");
    await item(page, "Playground").focus();
    await page.keyboard.press("Enter");
    await item(page, end).focus();
    await page.keyboard.press("Enter");
    await expectPage(end, lastPath);

    await page.goBack();
    await expect(item(page, "Playground")).toBeFocused();
    await expectPage("Playground", "playground");
    await page.keyboard.press("Enter"); // Must not jump back to the page just left.
    await page.goForward();
    await expect(item(page, end)).toBeFocused();
    await expectPage(end, lastPath);

    // A keyboard user exploring a different nav item hasn't activated it.
    await item(page, "Catalog").focus();
    await page.goBack();
    await expectPage("Playground", "playground");
    await expect(item(page, "Catalog")).toBeFocused();
    await page.reload();
    await expectPage("Playground", "playground");
    if (role === "user") await expect(item(page, "Access")).toHaveCount(0);
  });
}

test("background refresh leaves a focused catalog editor and its draft alone", async ({ page }) => {
  await page.clock.setFixedTime(fixtureNow);
  await page.route("**/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/session/avatar") return route.fulfill({ status: 204 });
    return route.fulfill({ status: path in fixtureResponses ? 200 : 404, json: fixtureResponses[path] ?? {} });
  });
  await page.goto("/dashboard/catalog");
  const stamp = page.locator(".connectionMeta time");
  await expect(stamp).toHaveAttribute("datetime", new Date(fixtureNow).toISOString());
  const search = page.getByRole("textbox", { name: "search catalog" });
  await search.fill("work in progress");
  const later = fixtureNow + 60_000;
  await page.clock.setFixedTime(later);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(stamp).toHaveAttribute("datetime", new Date(later).toISOString());
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("work in progress");
  await expect(nav(page).locator('[aria-current="page"]')).toHaveText("Catalog");
});

test.describe("Catalog launch return focus", () => {
  test.use({ hasTouch: true });
  const launch = (page: Page) => page.getByRole("button", { name: "Try in playground", exact: true });
  const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true, level: 1 });

  async function openTavily(page: Page) {
    await page.goto("/dashboard/catalog?demo=user");
    await page.getByRole("textbox", { name: "search catalog" }).fill("tavily");
    await expect(page.locator(".inspectorHeader h2")).toHaveText("Tavily");
  }

  test("Back restores the same keyboard launch action without moving the viewport", async ({ page }) => {
    await openTavily(page);
    // Tab out of the only result, as a member navigating the filtered Catalog would.
    await page.locator(".tableRow").press("Tab");
    await expect(launch(page)).toBeFocused();
    const sourceScroll = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Enter");
    await expect(heading(page, "Playground")).toBeVisible();
    for (let visit = 0; visit < 2; visit++) {
      await page.goBack();
      await expect(heading(page, "Catalog")).toBeVisible();
      await expect(page.locator(".inspectorHeader h2")).toHaveText("Tavily");
      await expect(launch(page)).toBeFocused();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(sourceScroll);
      await page.goForward();
      await expect(heading(page, "Playground")).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Inspect assistant response" })).toHaveCount(0);
  });

  test("only the Catalog entry that launched Playground restores its action", async ({ page }) => {
    await openTavily(page);
    await launch(page).press("Enter");
    await expect(heading(page, "Playground")).toBeVisible();
    await item(page, "Catalog").press("Enter");
    await expect(launch(page)).toBeEnabled();
    await item(page, "Playground").press("Enter"); // Same Catalog URL and service, different departure.
    await page.getByRole("combobox", { name: "Provider", exact: true }).focus();
    await page.goBack();
    await expect(heading(page, "Catalog")).toBeVisible();
    await expect(launch(page)).not.toBeFocused();
    await page.goBack();
    await expect(heading(page, "Playground")).toBeVisible();
    await page.goBack();
    await expect(launch(page)).toBeFocused();
  });

  test("a Catalog history entry cannot focus another service's launch action", async ({ page }) => {
    await openTavily(page);
    await launch(page).press("Enter");
    await expect(heading(page, "Playground")).toBeVisible();
    await item(page, "Catalog").press("Enter"); // A second entry with the same URL.
    const search = page.getByRole("textbox", { name: "search catalog" });
    await search.fill("OpenAI");
    await page.locator(".tableRow").filter({ has: page.getByText("OpenAI", { exact: true }) }).press("Enter");
    await expect(page.locator(".inspectorHeader h2")).toHaveText("OpenAI");
    await page.goBack();
    await expect(heading(page, "Playground")).toBeVisible();
    await page.goBack(); // The launch from this Catalog entry was for Tavily.
    await expect(heading(page, "Catalog")).toBeVisible();
    await expect(page.locator(".inspectorHeader h2")).toHaveText("OpenAI");
    await expect(launch(page)).toBeEnabled();
    await expect(launch(page)).not.toBeFocused();
  });

  test("returning after a touch launch does not move focus to the action", async ({ page }) => {
    await openTavily(page);
    await launch(page).tap();
    await expect(heading(page, "Playground")).toBeVisible();
    await page.goBack();
    await expect(heading(page, "Catalog")).toBeVisible();
    await expect(launch(page)).not.toBeFocused();
  });
});
