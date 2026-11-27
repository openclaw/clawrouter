import { expect, test, type Page } from "@playwright/test";

const summary = (page: Page) => page.locator(".requestDrawer summary");
const preview = (page: Page) => page.getByRole("region", { name: "Draft request payload" });
const message = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });

async function openMemberDraft(page: Page) {
  const writes: string[] = [];
  await page.route("**/v1/**", route => {
    if (route.request().method() !== "GET") writes.push(route.request().method());
    return route.fulfill({ status: 204 });
  });
  await page.goto("/dashboard/playground?demo=user");
  await message(page).fill("Unsent member draft");
  return writes;
}

for (const key of ["Enter", "Space"]) {
  test(`${key} then immediate Tab reaches the native disclosure's preview`, async ({ page }) => {
    const writes = await openMemberDraft(page);
    const toggle = summary(page);
    // Observe the native open transition before the later toggle event; a fast
    // Tab can run in this window. Do not delay the key or dispatch toggle ourselves.
    const observation = await page.locator(".requestDrawer").evaluateHandle(details => {
      const seen = { hasTabStopAtOpen: false, textAtNextKey: "" };
      const observer = new MutationObserver(() => {
        if (!details.hasAttribute("open")) return;
        seen.hasTabStopAtOpen = !!details.querySelector('pre[tabindex="0"]');
        observer.disconnect();
      });
      observer.observe(details, { attributes: true, attributeFilter: ["open"] });
      details.addEventListener("keydown", event => {
        if (event instanceof KeyboardEvent && event.key === "ArrowDown") {
          seen.textAtNextKey = (event.target as HTMLElement).textContent ?? "";
        }
      }, true);
      return seen;
    });
    await toggle.focus();
    await page.keyboard.press(key);
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowDown");
    const observed = await observation.jsonValue();
    expect(observed.hasTabStopAtOpen).toBe(true);
    expect(observed.textAtNextKey).toContain("Unsent member draft");
    await expect(preview(page)).toBeFocused();
    await expect(preview(page)).toContainText("Unsent member draft");
    await page.keyboard.press("Shift+Tab");
    await expect(toggle).toBeFocused();
    await page.keyboard.press(key);
    await expect(page.locator(".requestDrawer")).not.toHaveAttribute("open", "");
    await expect(toggle).toBeFocused();
    await expect(preview(page)).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(page.locator(".requestDrawer pre")).not.toBeFocused();
    await expect(message(page)).toHaveValue("Unsent member draft");
    expect(writes).toEqual([]);
  });
}

test("pointer disclosure leaves focus with the member; reopened preview traverses in both directions", async ({ page }) => {
  const writes = await openMemberDraft(page);
  const toggle = summary(page);
  await toggle.click();
  await expect(preview(page)).toContainText("Unsent member draft");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(preview(page)).toBeFocused();
  await toggle.click();
  await expect(preview(page)).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await message(page).fill("Changed while collapsed");
  await expect(page.locator(".requestDrawer pre")).toHaveText("");
  await toggle.press("Enter");
  await expect(preview(page)).toContainText("Changed while collapsed");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(preview(page)).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(preview(page)).toBeFocused();
  expect(writes).toEqual([]);
});
