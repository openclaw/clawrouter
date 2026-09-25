import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test("Access tabs wrap focus and activate associated panels only with Enter or Space", async ({ page }) => {
  await openDemo(page);
  const list = page.getByRole("tablist", { name: "access resources" });
  const policies = tab(page, "Policies"), fusion = tab(page, "Fusion");
  const associations = await list.getByRole("tab").evaluateAll((tabs) => tabs.map((item) => {
    const panel = document.getElementById(item.getAttribute("aria-controls")!);
    return { tab: item.id, panel: panel?.id, role: panel?.getAttribute("role"), label: panel?.getAttribute("aria-labelledby") };
  }));
  expect(associations).toHaveLength(6);
  expect(new Set(associations.flatMap((item) => [item.tab, item.panel])).size).toBe(12);
  for (const item of associations) expect(item).toMatchObject({ role: "tabpanel", label: item.tab });
  await policies.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(fusion).toBeFocused();
  await expect(policies).toHaveAttribute("aria-selected", "true");
  await expect(list.locator('[tabindex="0"]')).toHaveCount(1);
  await expect(fusion).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("ArrowRight");
  await expect(policies).toBeFocused();
  await page.keyboard.press("End");
  await expect(fusion).toBeFocused();
  await page.keyboard.press("Home");
  await expect(policies).toBeFocused();

  for (const [index, name] of ["Policies", "Credentials", "Bindings", "Upstream", "Assignments", "Fusion"].entries()) {
    if (index) await page.keyboard.press("ArrowRight");
    await expect(tab(page, name)).toBeFocused();
    await page.keyboard.press(index % 2 ? "Space" : "Enter");
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toHaveCount(1);
    await expect(page.getByRole("tabpanel", { name: new RegExp(`^${name}`) })).toBeVisible();
    await expect(page.locator('.accessPanel[hidden]')).toHaveCount(5);
    await expect(page.locator('.accessPanel[hidden] > *')).toHaveCount(0);
    await expect(tab(page, name)).toHaveAttribute("aria-controls", associations[index].panel!);
    expect((await new AxeBuilder({ page }).include(".accessWorkspace").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  }
});

test("Tab exits to the selected later panel after Home focuses an earlier tab", async ({ page }) => {
  await openDemo(page, "fusion");
  const policies = tab(page, "Policies"), fusion = tab(page, "Fusion");
  const panel = page.getByRole("tabpanel", { name: /^Fusion/ });
  await fusion.focus();
  await page.keyboard.press("Home");
  await expect(policies).toBeFocused();
  await expect(policies).toHaveAttribute("tabindex", "0");
  await expect(fusion).toHaveAttribute("tabindex", "-1");
  await expect(fusion).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect(panel).toBeFocused();
  expect(await panel.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Shift+Tab");
  await expect(fusion).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("tablist").locator(":focus")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(fusion).toBeFocused();
  // Programmatic focus must update the same roving stop as keyboard/pointer focus.
  await tab(page, "Bindings").focus();
  await expect(tab(page, "Bindings")).toHaveAttribute("tabindex", "0");
  await expect(fusion).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("Tab");
  await expect(panel).toBeFocused();
});

test("320px tab focus reveals horizontally without moving the page and leaves vertical keys native", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await openDemo(page);
  await tab(page, "Policies").focus();
  const scrollY = await page.evaluate(() => window.scrollY);
  for (const key of ["End", "ArrowLeft", "Home", "ArrowLeft", "ArrowRight"]) {
    await page.keyboard.press(key);
    const geometry = await page.getByRole("tablist").evaluate((list) => {
      const focused = document.activeElement!.getBoundingClientRect(), bounds = list.getBoundingClientRect();
      return { left: focused.left, right: focused.right, start: bounds.left + list.clientLeft, end: bounds.left + list.clientLeft + list.clientWidth, scrollLeft: list.scrollLeft };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.start - 1);
    expect(geometry.right).toBeLessThanOrEqual(geometry.end + 1);
    if (key === "End") expect(geometry.scrollLeft).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    await expect(tab(page, "Policies")).toHaveAttribute("aria-selected", "true");
  }
  expect(await tab(page, "Policies").evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  // Finish native scrolling before reversing direction; first movement is not completion.
  const down = await pressVerticalKeyAndWaitForScrollEnd(page, "ArrowDown");
  expect(down).toBeGreaterThan(scrollY);
  const up = await pressVerticalKeyAndWaitForScrollEnd(page, "ArrowUp");
  expect(up).toBeLessThan(down);
  await expect(tab(page, "Policies")).toBeFocused();
  await expect(tab(page, "Policies")).toHaveAttribute("aria-selected", "true");
});

test("keyboard resource activation preserves an upstream draft without sending it", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/v1/") && request.method() !== "GET") writes.push(request.method()); });
  await openDemo(page, "upstream");
  await page.getByRole("button", { name: "New grant", exact: true }).click();
  await page.getByRole("combobox", { name: "provider", exact: true }).selectOption("openai");
  await page.getByRole("textbox", { name: "token reference", exact: true }).fill("keyboard_draft");
  await page.getByRole("textbox", { name: "label", exact: true }).fill("Unsent keyboard draft");
  await page.getByLabel("API key", { exact: true }).fill("demo-primary-fixture");
  await tab(page, "Upstream").focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tabpanel", { name: /^Fusion/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "token reference", exact: true })).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Space");
  await expect(tab(page, "Upstream")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "token reference", exact: true })).toHaveValue("keyboard_draft");
  await expect(page.getByRole("textbox", { name: "label", exact: true })).toHaveValue("Unsent keyboard draft");
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("demo-primary-fixture");
  expect(writes).toEqual([]);
});

function tab(page: Page, name: string) { return page.getByRole("tab", { name: new RegExp(`^${name}`) }); }
async function openDemo(page: Page, resource = "policies") {
  await page.route("**/v1/**", (route) => route.fulfill({ status: 503, body: "Demo fixture" }));
  await page.goto(`/dashboard/access?demo=1&resource=${resource}`);
  await expect(page.getByRole("tab", { selected: true })).toHaveText(new RegExp(`^${resource}`, "i"));
  await expect(page.getByRole("tabpanel")).toBeVisible();
}

async function pressVerticalKeyAndWaitForScrollEnd(page: Page, key: "ArrowDown" | "ArrowUp"): Promise<number> {
  const scroll = await page.evaluateHandle(() => {
    const controller = new AbortController();
    const state = { y: null as number | null, stop: () => controller.abort() };
    document.addEventListener("scrollend", (event) => {
      if (event.target === document) state.y = window.scrollY;
    }, { signal: controller.signal });
    return state;
  });
  let succeeded = false;
  try {
    await page.keyboard.press(key);
    await expect.poll(() => scroll.evaluate((state) => state.y)).not.toBeNull();
    const y = await scroll.evaluate((state) => state.y!);
    succeeded = true;
    return y;
  } finally {
    const cleanup = scroll.evaluate((state) => state.stop()).finally(() => scroll.dispose());
    // A closed page during failure must not replace the original assertion or action error.
    if (succeeded) await cleanup;
    else await cleanup.catch(() => {});
  }
}
