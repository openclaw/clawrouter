import { expect, test } from "@playwright/test";

for (const role of ["1", "user"]) {
  test(`Catalog opens the searched proxy route and sends its preset only on request (demo=${role})`, async ({ page }) => {
    const writes: string[] = [];
    page.on("request", (request) => { if (request.method() !== "GET") writes.push(request.url()); });
    await page.goto(`/?demo=${role}`);
    const nav = page.getByRole("navigation", { name: "console" });
    await nav.getByRole("button", { name: "Catalog", exact: true }).press("Enter");
    const search = page.getByRole("textbox", { name: "search catalog" });
    await search.fill("Tavily");
    const route = "/v1/proxy/tavily/search";
    await expect(page.locator(".inspector .facts")).toContainText(route);
    await search.fill("  " + route.toUpperCase() + "  ");
    await expect(page.locator(".tableRow .entityTitle")).toHaveText(["Tavily"]);
    await page.getByRole("button", { name: "Try in playground" }).press("Enter");
    await expect(page.locator(".chatHeader strong")).toHaveText("tavily / search");
    await expect(page.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue("tavily");
    const picker = page.getByRole("combobox", { name: "Model or route" });
    await expect(picker.locator("option:checked")).toHaveText("search (route)");
    const body = page.getByRole("textbox", { name: "JSON request body" });
    expect(JSON.parse(await body.inputValue())).toEqual({ query: "OpenClaw", max_results: 1 });
    await expect(page.getByText("/v1/playground/proxy/tavily/search", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Inspect assistant response" })).toHaveCount(0);
    // Only an explicit Send produces a turn. Demo traffic stays in the browser.
    await page.getByRole("button", { name: "Send", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Inspect assistant response" }).press("Enter");
    await expect(page.locator(".playgroundInspector .facts")).toContainText("/v1/playground/proxy/tavily/search");
    await expect(page.locator(".debugPayload")).toContainText('"query": "OpenClaw"');
    expect(writes).toEqual([]);
  });
}

test("a route search does not grant access or switch an explicitly inspected service", async ({ page }) => {
  await page.goto("/dashboard/catalog?demo=user");
  const search = page.getByRole("textbox", { name: "search catalog" });
  await search.fill("/v1/proxy/firecrawl/scrape");
  await expect(page.locator(".inspectorHeader h2")).toHaveText("Firecrawl");
  const play = page.getByRole("button", { name: "Try in playground" });
  await expect(play).toBeDisabled();
  await expect(page.locator(".outcomeCallout")).toContainText("denied");
  await page.locator(".tableRow").press("Enter");
  await search.fill("/v1/proxy/tavily/search");
  await expect(page.locator(".tableRow .entityTitle")).toHaveText(["Tavily"]);
  await expect(page.locator(".inspectorHeader")).toContainText("outside current filters");
  await expect(page.locator(".inspectorHeader h2")).toHaveText("Firecrawl");
  await expect(play).toBeDisabled();
});
