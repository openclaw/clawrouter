import { expect, test, type Page } from "@playwright/test";

const provider = (page: Page) => page.getByRole("combobox", { name: "Provider", exact: true });
const body = (page: Page) => page.getByRole("textbox", { name: "JSON request body" });
const exchanges = (page: Page) => page.locator(".chatExchange");
const draft = '{ "urls": ["https://example.com/second-guide"] }';
const invalid = '{ "urls": ["https://example.com/second-guide"], }';

for (const corrected of [false, true]) {
  test(`returning to a service keeps the ${corrected ? "corrected" : "invalid"} unsent body`, async ({ page }) => {
    await page.goto("/dashboard/playground?demo=user");
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Model draft");
    await provider(page).selectOption("tavily");
    // Complete one synthetic turn, then start a different, unsent request.
    await body(page).fill('{"urls":["https://example.com/first-guide"]}');
    await body(page).press("Enter");
    await expect(exchanges(page)).toHaveCount(1);
    await body(page).fill(invalid);
    await body(page).press("Enter");
    await expect(body(page)).toHaveAccessibleDescription(/Not sent/);
    if (corrected) await body(page).fill(draft);

    await provider(page).selectOption("openai");
    await expect(message).toHaveValue("Model draft");
    await message.press("Tab");
    await expect(provider(page)).toBeFocused();
    await provider(page).press("t"); // Native select type-ahead: Tavily.
    await expect(page.locator(".chatHeader strong")).toHaveText("tavily / extract");
    await expect(body(page)).toHaveValue(corrected ? draft : invalid);
    await expect(exchanges(page)).toHaveCount(1);
    if (!corrected) {
      await body(page).press("Enter");
      await expect(body(page)).toHaveAccessibleDescription(/Not sent/);
      await expect(body(page)).toBeFocused();
      await expect(exchanges(page)).toHaveCount(1);
      await body(page).fill(draft);
    }
    await body(page).press("Enter");
    await expect(exchanges(page)).toHaveCount(2);
    expect(JSON.parse(await page.locator(".debugPayload").innerText()).body).toEqual(JSON.parse(draft));
  });
}

test("return to an edited Catalog route; a different service gets its own preset", async ({ page }) => {
  await page.goto("/dashboard/catalog?demo=user");
  await page.getByRole("textbox", { name: "search catalog" }).fill("/v1/proxy/tavily/search");
  await page.getByRole("button", { name: "Try in playground" }).press("Enter");
  const search = '{ "query": "Field guide", "max_results": 7 }';
  await body(page).fill(search);
  await provider(page).selectOption("openai");
  await provider(page).selectOption("tavily");
  await expect(page.locator(".chatHeader strong")).toHaveText("tavily / search");
  await expect(body(page)).toHaveValue(search);

  const picker = page.getByRole("combobox", { name: "Model or route" });
  await picker.selectOption({ label: "extract" });
  expect(JSON.parse(await body(page).inputValue())).toEqual({ urls: ["https://example.com"] });
  await body(page).fill(draft);
  await provider(page).selectOption("openai");
  await provider(page).selectOption("firecrawl");
  await expect(body(page)).not.toHaveValue(draft);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(exchanges(page)).toHaveCount(0);
});
