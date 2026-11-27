import { expect, test } from "@playwright/test";
import { fixtureResponses } from "./fixtures/personal-usage";

const model = "fixture/inventory";
const url = "/v1/playground/v1/chat/completions";
const provider = { id: "fixture", display_name: "Fixture", class: "test", service_kind: "model_provider", capabilities: [{ id: "llm.chat" }] };
const bootstrap: Record<string, unknown> = {
  ...fixtureResponses,
  "/v1/providers": { providers: [provider] },
  "/v1/routes": { openaiCompatible: [{ provider: provider.id, endpoints: ["/v1/chat/completions"], models: [{ id: model, capabilities: ["llm.chat"], endpoints: ["/v1/chat/completions"] }] }], manifestProxy: [] },
  "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "user", email: "member@example.com", entitlements: { providers: [{
    provider: provider.id, displayName: provider.display_name, serviceKind: provider.service_kind, allowed: true, policies: ["inventory"],
    readiness: { id: provider.id, executable: true, verified: true, status: "verified", reasons: [] },
  }] } },
};

// Literal response strings: converting these fixtures to Number would lose the distinction before transport.
const inventory = '{"item_ids":[9007199254740992,9007199254740993],"details":{"rate":0.123456789012345678901,"scale":1.00e+32},"output_text":"Two distinct inventory IDs."}';
const failure = '{"error":{"message":"Temporarily unavailable","detail":{"id":9007199254740993,"scale":1e400}}}';

for (const [status, contentType, source] of [
  [200, "application/json", inventory],
  [503, "application/problem+json", failure],
  [200, "text/plain", "Inventory ID 9007199254740993; rate 1.00e+32."],
] as const) {
  test(`Response inspection and native Copy preserve HTTP ${status} ${contentType}`, async ({ page, context }) => {
    let sends = 0;
    await page.route("**/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === url && route.request().method() === "POST") {
        sends++;
        return route.fulfill({ status, contentType, body: source });
      }
      if (path === "/v1/session/avatar") return route.fulfill({ status: 204 });
      return route.fulfill({ status: bootstrap[path] ? 200 : 404, json: bootstrap[path] ?? {} });
    });
    await page.goto("/dashboard/playground");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    // Editing before inventory arrives deliberately preserves a targetless draft.
    await expect(page.locator(".chatHeader strong")).toHaveText(model);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Read the inventory.");
    await message.press("Enter");
    const inspector = page.locator(".playgroundInspector");
    await expect(inspector.locator(".inspectorTopline")).toContainText(String(status));
    await inspector.getByRole("button", { name: "Response", exact: true }).press("Space");
    const payload = inspector.locator(".debugPayload");
    await expect(payload).toHaveJSProperty("textContent", source);
    await payload.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press("ControlOrMeta+c");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source);
    expect(sends).toBe(1);
  });
}
