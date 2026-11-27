import { expect, test } from "@playwright/test";

type CopyProbe = Window & { nativeCopies: string[] };

for (const format of ["JSON", "cURL"] as const) {
  test(`Select All and native Copy stay inside the focused ${format} preview`, async ({ page }) => {
    // Observe native copy events on synthetic data without reading or writing the system clipboard.
    await page.addInitScript(() => {
      const copies = (window as CopyProbe).nativeCopies = [] as string[];
      document.addEventListener("copy", event => {
        if (!event.defaultPrevented) copies.push(document.getSelection()?.toString() ?? "");
        event.preventDefault();
      });
    });
    const writes: string[] = [];
    await page.route("**/v1/**", route => {
      if (route.request().method() !== "GET") writes.push(route.request().method());
      return route.fulfill({ status: 204 });
    });
    await page.goto("/dashboard/playground?demo=user");
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    if (format === "cURL") {
      // The existing turn inspector's Response mode also selects the cURL draft preview.
      await message.fill("One local demo turn.");
      await message.press("Enter");
      await page.getByRole("button", { name: "Response", exact: true }).press("Enter");
      await page.getByRole("button", { name: "Conversation controls" }).press("Enter");
    }
    const draft = "Compare the blue garden tools.";
    await message.fill(draft);
    const summary = page.locator(".requestDrawer summary");
    const preview = page.getByRole("region", { name: "Draft request payload" });
    await summary.press("Enter");
    await expect(preview).toContainText(draft);
    const shown = await preview.innerText();
    expect(shown).toMatch(format === "JSON" ? /^\{/ : /^curl -X POST /);
    await summary.press("Tab");
    await expect(preview).toBeFocused();

    const copies: string[] = [];
    for (const modifier of ["Control", "Meta"]) {
      await page.evaluate(() => document.getSelection()?.removeAllRanges());
      await page.keyboard.press(modifier + "+a");
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(shown);
      for (let repeat = 0; repeat < 2; repeat++) {
        await page.keyboard.press("ControlOrMeta+c");
        copies.push(shown);
        expect(await page.evaluate(() => (window as CopyProbe).nativeCopies)).toEqual(copies);
        await expect(preview).toBeFocused();
      }
    }

    // The shell and composer still own their normal selection and keyboard navigation.
    await page.keyboard.press("Shift+Tab");
    await expect(summary).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    expect(await page.evaluate(() => document.getSelection()?.toString())).toContain("ClawRouter");
    await summary.press("Space");
    await expect(preview).toHaveCount(0);
    await message.press("ControlOrMeta+a");
    expect(await message.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe(draft);
    expect(writes).toEqual([]);
  });
}
