import { expect, test } from "@playwright/test";

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
