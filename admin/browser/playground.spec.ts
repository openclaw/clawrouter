import { expect, test, type Page } from "@playwright/test";

interface PendingRequest {
  signal?: AbortSignal | null;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

type TestWindow = Window & { playgroundRequests: PendingRequest[] };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const requests: PendingRequest[] = [];
    (window as TestWindow).playgroundRequests = requests;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      if (url.pathname.startsWith("/v1/playground/")) {
        // Keep completion under test control, including a transport that ignores abort.
        return new Promise<Response>((resolve, reject) => requests.push({ signal: init?.signal, resolve, reject }));
      }
      return originalFetch(input, init);
    };
  });
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = bootstrap[path];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  await page.goto("/dashboard/playground");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(page.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue("test-model");
});

test("playground admits one request and preserves the next draft", async ({ page }) => {
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("First message");
  await page.locator("form.chatPlayground").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect.poll(() => requestCount(page)).toBe(1);
  await expect(message).toHaveValue("");
  await message.fill("Next message");
  await message.press("Enter");
  await page.locator("form.chatPlayground").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await requestCount(page)).toBe(1);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await complete(page, 0, "First reply");
  await expect(page.locator(".chatMessageAssistant .messageBody")).toHaveText("First reply");
  await expect(message).toHaveValue("Next message");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

for (const outcome of ["response", "error"] as const) {
  test(`new chat aborts its request and ignores a late ${outcome}`, async ({ page }) => {
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Old conversation");
    await message.press("Enter");
    await expect.poll(() => requestCount(page)).toBe(1);
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    expect(await page.evaluate(() => (window as TestWindow).playgroundRequests[0].signal?.aborted)).toBe(true);
    await message.fill("New conversation");
    await message.press("Enter");
    await expect.poll(() => requestCount(page)).toBe(2);
    await message.fill("Next draft");
    if (outcome === "response") await complete(page, 0, "Old reply");
    else await page.evaluate(async () => {
      (window as TestWindow).playgroundRequests[0].reject(new Error("Old request failed"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await expect(page.locator(".chatExchange")).toHaveCount(0);
    await expect(message).toHaveValue("Next draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await complete(page, 1, "New reply");
    await expect(page.locator(".chatExchange")).toHaveCount(1);
    await expect(page.locator(".chatMessageAssistant .messageBody")).toHaveText("New reply");
    await expect(message).toHaveValue("Next draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  });
}

test("service requests share admission without clearing their editable payload", async ({ page }) => {
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("test-service");
  const payload = page.getByRole("textbox", { name: "JSON request body", exact: true });
  await payload.fill('{"query":"first"}');
  await payload.press("Enter");
  await expect.poll(() => requestCount(page)).toBe(1);
  await expect(payload).toHaveValue('{"query":"first"}');
  await payload.fill('{"query":"next"}');
  await page.locator("form.chatPlayground").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await requestCount(page)).toBe(1);
  await complete(page, 0, "Service reply");
  await expect(page.locator(".chatMessageAssistant .messageBody")).toHaveText("Service reply");
  await expect(payload).toHaveValue('{"query":"next"}');
});

function requestCount(page: Page) {
  return page.evaluate(() => (window as TestWindow).playgroundRequests.length);
}

async function complete(page: Page, index: number, text: string) {
  await page.evaluate(async ({ index, text }) => {
    (window as TestWindow).playgroundRequests[index].resolve(new Response(JSON.stringify({ output_text: text }), {
      headers: { "content-type": "application/json", "x-clawrouter-content-retention": "off" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }, { index, text });
}

const providers = ["test-model", "test-service"].map((id) => ({
  id, display_name: id, class: "test", service_kind: "model_provider", capabilities: [{ id: "llm.chat" }],
}));
const entitlements = providers.map((provider) => ({
  provider: provider.id, displayName: provider.id, serviceKind: provider.service_kind, allowed: true, policies: ["test_policy"],
  readiness: {
    id: provider.id, displayName: provider.id, class: "test", serviceKind: provider.service_kind,
    requiredConfig: [], optionalConfig: [], missingConfig: [], configPresent: true,
    oauthGrantRequired: false, oauthGrantCount: 0, openaiCompatible: provider.id === "test-model",
    manifestRoutes: 0, modelCount: 1, executable: true, verified: true, status: "verified", reasons: [],
  },
}));
const bootstrap: Record<string, unknown> = {
  "/v1/providers": { providers },
  "/v1/routes": {
    openaiCompatible: [{
      provider: "test-model", endpoints: ["/v1/chat/completions"],
      models: [{ id: "test-model/example", capabilities: ["llm.chat"], endpoints: ["/v1/chat/completions"] }],
    }],
    manifestProxy: [{ provider: "test-service", endpoint: "search", route: "/v1/proxy/test-service/search", methods: ["POST"] }],
  },
  "/v1/session": {
    authenticated: true, auth: "access", role: "user", email: "user@example.com", entitlements: { providers: entitlements },
  },
  "/v1/session/credentials": { credentials: [] },
  "/v1/session/usage": {
    policies: [], usage: {
      ledger: "ready", providers: [], daily: [], events: [],
      summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 },
    },
  },
};
