import { expect, test } from "@playwright/test";
import { fixtureResponses } from "./fixtures/personal-usage";

const provider = { id: "fixture", class: "test", display_name: "Fixture", service_kind: "model_provider", capabilities: [{ id: "llm.chat" }] };
const model = { id: "fixture/status", capabilities: ["llm.chat"], endpoints: ["/v1/chat/completions"] };
const bootstrap: Record<string, unknown> = {
  ...fixtureResponses,
  "/v1/providers": { providers: [provider] },
  "/v1/routes": { openaiCompatible: [{ provider: provider.id, endpoints: model.endpoints, models: [model] }], manifestProxy: [] },
  "/v1/session": { authenticated: true, role: "user", auth: "cloudflare_access", email: "member@example.com", entitlements: { providers: [{
    provider: provider.id, allowed: true, policies: ["fixture"], readiness: { id: provider.id, executable: true, verified: true, status: "verified", reasons: [] },
  }] } },
};

const bytes = [0, 255, 48];
const type = "application/octet-stream";
const size = type + " response (3 bytes)";
const textError = "Rate limit reached; try again later.";
const turns = [
  { status: 204, phrase: "", type: "", body: null, expected: "HTTP 204 No Content" },
  { status: 429, phrase: "", type: "text/plain", body: textError, expected: textError },
  { status: 200, phrase: "OK", type, body: bytes, expected: "HTTP 200 OK\n" + size },
  { status: 503, phrase: "", type, body: bytes, expected: "HTTP 503\n" + size },
  { status: 503, phrase: "", type, body: null, expected: "HTTP 503" },
  { status: 503, phrase: "Try Later", type, body: bytes, expected: "HTTP 503 Try Later\n" + size },
];

test("empty and binary response summaries follow the selected turn's HTTP status", async ({ page }) => {
  // Construct native Responses so the fixture controls whether a reason phrase exists.
  await page.addInitScript((responses) => {
    const original = window.fetch.bind(window);
    let index = 0;
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== "/v1/playground/v1/chat/completions") return original(input, init);
      const { status, phrase, type, body } = responses[index++];
      const headers = new Headers();
      if (type) headers.set("content-type", type);
      if (Array.isArray(body)) headers.set("content-disposition", 'attachment; filename="fixture.bin"');
      return Promise.resolve(new Response(Array.isArray(body) ? new Uint8Array(body) : body, { status, statusText: phrase, headers }));
    };
  }, turns);
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/session/avatar") return route.fulfill({ status: 204 });
    return route.fulfill({ status: bootstrap[path] ? 200 : 404, json: bootstrap[path] ?? {} });
  });
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.goto("/dashboard/playground");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const replies = page.getByRole("button", { name: "Inspect assistant response" });
  const inspector = page.locator(".playgroundInspector");
  for (const [i, turn] of turns.entries()) {
    await composer.fill(`Synthetic response ${i + 1}`);
    await composer.press("Enter");
    await expect(replies).toHaveCount(i + 1);
    // Check the literal summary, including any newline, rather than normalized text.
    expect.soft(await replies.nth(i).locator(".messageBody").textContent()).toBe(turn.expected);
  }
  await inspector.getByRole("button", { name: "Response", exact: true }).press("Space");
  for (const [i, turn] of [...turns.entries()].reverse()) {
    await replies.nth(i).press("Enter");
    await expect(inspector.locator(".inspectorTopline")).toContainText(String(turn.status));
    expect.soft(await inspector.locator(".debugPayload").textContent()).toBe(turn.expected);
  }
  await expect(replies).toHaveCount(turns.length);
  expect(downloads).toBe(0);
});
