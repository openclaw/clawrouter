import { expect, type Page } from "@playwright/test";

/** Reach legacy diagnostics through the same disclosure as an administrator. */
export async function openLegacyUsage(page: Page) {
  const summary = page.getByText("Authoritative allowances and legacy diagnostics", { exact: true });
  await expect(summary).toBeVisible();
  const disclosure = summary.locator("..");
  if (!await disclosure.evaluate(element => element.hasAttribute("open"))) await summary.click();
  await expect(disclosure).toHaveAttribute("open");
}
