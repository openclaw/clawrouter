import { expect, test } from "@playwright/test";
import { fixtureResponses } from "./fixtures/personal-usage";

const reference = "https://github.com/openclaw/clawrouter/blob/main/docs/api-reference.md#proxy-routes";

test("a member opens the public API reference without disclosing the console URL or leaving the selected route", async ({ page, context, baseURL }) => {
  const requests: string[] = [];
  const outboundHeaders: Record<string, string>[] = [];
  const origin = new URL(baseURL!).origin;
  await context.route("**/*", async route => {
    const request = route.request();
    if (new URL(request.url()).origin === origin) return route.continue();
    requests.push(request.url());
    outboundHeaders.push(await request.allHeaders());
    // Observe the browser navigation without contacting GitHub in CI.
    await route.fulfill({ contentType: "text/html", body: "<h1>Reference fixture</h1>" });
  });
  await page.goto("/dashboard/catalog?demo=user&fixture=private-console-context");
  const search = page.getByRole("textbox", { name: "search catalog" });
  const path = "/v1/proxy/tavily/search";
  await search.fill(path);
  await page.locator(".tableRow").press("Enter");
  const inspector = page.locator(".inspector");
  const link = inspector.getByRole("link", { name: "Proxy route API reference (opens in a new tab)" });
  await expect(inspector.getByRole("heading", { name: "Tavily" })).toBeVisible();
  await expect(link).toHaveAttribute("href", reference);
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  expect(requests).toEqual([]);
  const originalUrl = page.url();
  const opening = page.waitForEvent("popup");
  await page.keyboard.press("Enter");
  const popup = await opening;
  await expect(popup).toHaveURL(reference);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(requests).toEqual([reference.split("#")[0]]);
  expect(outboundHeaders[0].referer).toBeUndefined();
  expect(outboundHeaders[0].authorization).toBeUndefined();
  expect(outboundHeaders[0].cookie).toBeUndefined();
  await popup.close();
  await expect(page).toHaveURL(originalUrl);
  await expect(search).toHaveValue(path);
  await expect(inspector.getByRole("heading", { name: "Tavily" })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Try in playground" })).toBeEnabled();
});

test("a provider without published routes has no route reference", async ({ page }) => {
  await page.route("**/v1/**", route => {
    const path = new URL(route.request().url()).pathname;
    const body = path === "/v1/providers" ? { providers: [{ id: "unrouted", display_name: "Unrouted provider", class: "test", service_kind: "tool", capabilities: [] }] } : fixtureResponses[path];
    return route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  await page.goto("/dashboard/catalog");
  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("heading", { name: "Unrouted provider" })).toBeVisible();
  await expect(inspector.getByRole("link", { name: /Proxy route API reference/ })).toHaveCount(0);
});
