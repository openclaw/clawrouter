import { expect, test } from "@playwright/test";
import type { ProviderAccess } from "../src/ui-types";
import { fixtureResponses } from "./fixtures/personal-usage";

for (const allowed of [false, true]) {
  test(`an unavailable member access check recovers to ${allowed ? "granted" : "denied"} without sending the draft`, async ({ page }) => {
    const provider = "research", model = "research/example", draft = "Keep this unsent draft.";
    const access: ProviderAccess = {
      provider, displayName: "Research", serviceKind: "model_provider", allowed, policies: allowed ? ["research_policy"] : [],
      readiness: {
        id: provider, displayName: "Research", serviceKind: "model_provider", class: "test", configPresent: true,
        requiredConfig: [], optionalConfig: [], missingConfig: [], oauthGrantRequired: false, oauthGrantCount: 0,
        upstreamGrantCount: 0, openaiCompatible: true, manifestRoutes: 0, modelCount: 1, executable: true, status: "verified", reasons: [],
      },
    };
    let unavailable = true;
    const writes: string[] = [];
    await page.route("**/v1/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET") {
        writes.push(path);
        return route.abort();
      }
      if (path === "/v1/session") return route.fulfill({ json: {
        authenticated: true, auth: "cloudflare_access", role: "user", email: "member@example.test",
        ...(unavailable ? { entitlementsError: "Temporarily unavailable" } : { entitlements: { providers: [access] } }),
      } });
      if (path === "/v1/entitlements") return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
      if (path === "/v1/providers") return route.fulfill({ json: { providers: [{ id: provider, display_name: "Research", class: "test", service_kind: "model_provider", capabilities: [] }] } });
      if (path === "/v1/routes") return route.fulfill({ json: { openaiCompatible: [{ provider, endpoints: ["/v1/chat/completions"], models: [{ id: model, capabilities: ["llm.chat"], endpoints: ["/v1/chat/completions"] }] }], manifestProxy: [] } });
      return route.fulfill({ status: path in fixtureResponses ? 200 : 404, json: fixtureResponses[path] ?? {} });
    });
    await page.goto("/dashboard/playground");
    const composer = page.locator(".composerDock"), message = page.getByRole("textbox", { name: "Message", exact: true });
    const send = composer.getByRole("button", { name: "Send", exact: true });
    const unknown = "Your access to this provider couldn’t be verified. You can keep editing your draft.";
    const retry = page.getByRole("button", { name: "Retry refresh" });
    await expect(retry).toBeEnabled();
    await expect(composer.getByText(unknown, { exact: true })).toBeVisible();
    await expect(send).toBeDisabled();
    await message.fill(draft);
    await message.press("Enter");
    await expect(message).toHaveValue(draft);

    unavailable = false;
    await retry.press("Enter");
    await expect(retry).toHaveCount(0);
    await expect(composer.getByText(unknown, { exact: true })).toHaveCount(0);
    if (allowed) {
      await expect(send).toBeEnabled();
      await expect(composer).not.toContainText("not granted");
    } else {
      await expect(composer).toContainText("not granted");
      await expect(send).toBeDisabled();
      await message.press("Enter");
    }
    await expect(message).toHaveValue(draft);
    await expect(page.locator(".chatExchange")).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}
