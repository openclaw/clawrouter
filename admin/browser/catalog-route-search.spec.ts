import { expect, test } from "@playwright/test";

test("a member can find a later published proxy model by keyboard without changing its Playground target or pinned selection", async ({ page, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 760 });
  await page.goto("/dashboard/catalog?demo=user");
  const search = page.getByRole("textbox", { name: "search catalog" });
  const titles = page.locator(".tableRow .entityTitle");
  const inspector = page.locator(".inspector");
  const model = "google/gemini-3.8-flash-lite-tts";
  await search.focus();
  await page.keyboard.type(model);
  await expect(titles).toHaveText(["Google Gemini"]);
  await expect(inspector.locator(".inspectorHeader h2")).toHaveText("Google Gemini");
  await expect(inspector.locator(".facts")).toContainText(model + " · Not available in Playground");
  await expect(inspector.getByRole("button", { name: "Try in playground" })).toBeDisabled();
  await expect(page.locator(".catalogMeta span")).toHaveText("1 usable · 1 granted · 0 blocked");

  await search.fill("Tavily");
  await page.locator(".tableRow").press("Enter");
  await search.fill(model);
  await expect(titles).toHaveText(["Google Gemini"]);
  await expect(inspector.locator(".inspectorHeader h2")).toHaveText("Tavily");
  await expect(inspector.locator(".inspectorHeader")).toContainText("outside current filters");
  await search.fill("google/nonexistent-catalog-model");
  await expect(titles).toHaveCount(0);
});

for (const demo of ["1", "user"]) {
  test(`a route from the Catalog inspector finds its service (demo=${demo})`, async ({ page }) => {
    await page.goto(`/dashboard/catalog?demo=${demo}`);
    const search = page.getByRole("textbox", { name: "search catalog" });
    const titles = page.locator(".tableRow .entityTitle");
    await search.fill("Tavily");
    await page.locator(".tableRow").filter({ has: page.getByText("Tavily", { exact: true }) }).click();
    const routes = await page.locator(".facts dt").filter({ hasText: /^routes$/ }).locator("+ dd").innerText();
    const extract = "/v1/proxy/tavily/extract";
    expect(routes.split(", ")).toContain(extract);
    await search.fill(extract);
    await expect(titles).toHaveText(["Tavily"]);

    const kinds = page.getByRole("group", { name: "service kind" });
    await expect(kinds.getByRole("button", { name: /^all/ }).locator("span")).toHaveText("1");
    await kinds.getByRole("button", { name: /^model/ }).first().click();
    await expect(titles).toHaveCount(0);
    await expect(search).toHaveValue(extract);
    await kinds.getByRole("button", { name: /^all/ }).click();
    await expect(titles).toHaveText(["Tavily"]);
    await expect(page.locator(".inspectorHeader h2")).toHaveText("Tavily");
  });
}
