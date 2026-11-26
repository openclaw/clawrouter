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

async function catalogSelection(page: Page, query: string, provider: string) {
  await page.getByRole("navigation", { name: "console" }).getByRole("button", { name: "Catalog", exact: true }).press("Enter");
  const search = page.getByRole("textbox", { name: "search catalog" });
  await search.fill(query);
  const row = page.getByRole("button").filter({ has: page.getByText(provider, { exact: true }) });
  await row.press("Enter");
  await expect(page.locator(".inspectorHeader h2")).toHaveText(provider);
  return { search, play: page.getByRole("button", { name: "Try in playground" }) };
}

test("Catalog opens the exact selected model with its supported endpoint, without sending", async ({ page }) => {
  const { play } = await catalogSelection(page, "  TEST-MODEL/REPLY-PRO  ", "test-model");
  await expect(page.locator(".inspector").getByText("test-model/reply-pro", { exact: true })).toBeVisible();
  await play.press("Enter");
  await expect(page.getByRole("combobox", { name: "Model or route" })).toHaveValue("model:test-model/reply-pro");
  await expect(page.locator(".chatHeader strong")).toHaveText("test-model/reply-pro");
  await expect(page.getByText("/v1/playground/v1/responses", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Model or route" }).selectOption("model:test-model/reply-lite");
  await expect(page.locator(".chatHeader strong")).toHaveText("test-model/reply-lite");
  expect(await requestCount(page)).toBe(0);
});

test("Catalog does not turn an ambiguous model fragment into a model choice", async ({ page }) => {
  const { play } = await catalogSelection(page, "reply", "test-model");
  await play.press("Enter");
  await expect(page.getByRole("combobox", { name: "Model or route" })).toHaveValue("model:test-model/example");
  expect(await requestCount(page)).toBe(0);
});

test("Catalog honors a pinned service when the search names another provider's exact model", async ({ page }) => {
  const { play, search } = await catalogSelection(page, "test-service", "test-service");
  await search.fill("test-model/reply-pro");
  await expect(page.locator(".inspectorHeader h2")).toHaveText("test-service");
  await play.press("Enter");
  await expect(page.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue("test-service");
  await expect(page.getByRole("textbox", { name: "JSON request body" })).toBeVisible();
  expect(await requestCount(page)).toBe(0);
});

test("Catalog does not substitute a chat model for an exact unavailable model", async ({ page }) => {
  const { play } = await catalogSelection(page, "test-model/image", "test-model");
  await expect(play).toBeDisabled();
  await expect(page.locator(".inspector")).toContainText("Not available in Playground");
  expect(await requestCount(page)).toBe(0);
});

for (const blocked of ["denied", "not ready"] as const) {
  test(`Catalog keeps an exact match blocked when the service is ${blocked}`, async ({ page }) => {
    await page.route("**/v1/session", (route) => route.fulfill({ json: {
      authenticated: true, auth: "cloudflare_access", role: "user", email: "user@example.com",
      entitlements: { providers: entitlements.map((entry) => entry.provider !== "test-model" ? entry : {
        ...entry, allowed: blocked !== "denied", readiness: { ...entry.readiness, executable: blocked !== "not ready", reasons: ["Unavailable in this fixture."] },
      }) },
    } }));
    await page.reload();
    await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
    const { play } = await catalogSelection(page, "test-model/reply-pro", "test-model");
    await expect(play).toBeDisabled();
    expect(await requestCount(page)).toBe(0);
  });
}

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

test("malformed service JSON stays in the composer instead of becoming a gateway turn", async ({ page }) => {
  await page.getByRole("textbox", { name: "Message", exact: true }).press("Enter");
  await expect.poll(() => requestCount(page)).toBe(1);
  await complete(page, 0, "First reply");
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("test-service");
  const body = page.getByRole("textbox", { name: "JSON request body" });
  await body.fill('{"query": "trail conditions",}');
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(body).toHaveAccessibleDescription("Not sent. Check the JSON syntax at line 1, column 30.");
  await expect(body).toBeFocused();
  await expect(body).toHaveValue('{"query": "trail conditions",}');
  await expect(page.locator(".chatExchange")).toHaveCount(1);
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  expect(await requestCount(page)).toBe(1);

  await body.fill('{"query": "trail conditions"}');
  await expect(body).not.toHaveAttribute("aria-invalid", "true");
  expect(await requestCount(page)).toBe(1);
  await body.press("Enter");
  await expect.poll(() => requestCount(page)).toBe(2);
  await complete(page, 1, "Service reply");
  await expect(page.locator(".chatMessageAssistant .messageBody")).toHaveText(["First reply", "Service reply"]);
});

test("invalid model settings return focus to the editable field and keep the message", async ({ page }) => {
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const maxTokens = page.getByRole("textbox", { name: "Max tokens", exact: true });
  await message.press("Enter");
  await expect.poll(() => requestCount(page)).toBe(1);
  await complete(page, 0, "First reply");
  await page.getByRole("button", { name: "Close turn inspector" }).click();
  await maxTokens.fill("-12");
  await page.getByRole("button", { name: "Inspect assistant response" }).click();
  await message.fill("Summarize the weather.");
  await message.press("Enter");
  await expect(maxTokens).toBeFocused();
  await expect(maxTokens).toHaveAccessibleDescription(/Not sent.*whole number/);
  await expect(message).toHaveValue("Summarize the weather.");
  expect(await requestCount(page)).toBe(1);
  await maxTokens.fill("128");
  const temperature = page.getByRole("textbox", { name: "Temperature", exact: true });
  await temperature.fill("warm");
  await message.press("Enter");
  await expect(temperature).toBeFocused();
  await expect(temperature).toHaveAccessibleDescription(/Not sent.*number/);
  await expect(page.locator(".chatExchange")).toHaveCount(1);
  await temperature.fill("0.5");
  await message.press("Enter");
  await expect.poll(() => requestCount(page)).toBe(2);
  await complete(page, 1, "Next reply");
  await expect(page.locator(".chatMessageAssistant .messageBody")).toHaveText(["First reply", "Next reply"]);

  // An empty follow-up needs an explanation even when a previous turn is selected.
  await message.press("Enter");
  await expect(message).toHaveAccessibleDescription("Not sent. Enter a message.");
  expect(await requestCount(page)).toBe(2);
});

test("editing the message keeps validation on the unchanged model setting", async ({ page }) => {
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const maxTokens = page.getByRole("textbox", { name: "Max tokens" });
  const provider = page.getByRole("combobox", { name: "Provider", exact: true });
  await maxTokens.fill("-1");
  await message.fill("Check the route");
  await message.press("Enter");
  await expect(maxTokens).toBeFocused();
  await message.press("End");
  await page.keyboard.type(" again.");
  await expect(message).toBeFocused();
  await expect(message).toHaveValue("Check the route again.");
  await expect(maxTokens).toHaveAttribute("aria-invalid", "true");
  await expect(maxTokens).toHaveAccessibleDescription(/Not sent.*whole number/);
  await expect(page.getByRole("alert")).toBeVisible();
  await maxTokens.fill("128");
  await expect(maxTokens).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Switching away from model requests retires a model-only error, even on return.
  await maxTokens.fill("-1");
  await message.press("Enter");
  await expect(maxTokens).toHaveAttribute("aria-invalid", "true");
  await provider.selectOption("test-service");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await provider.selectOption("test-model");
  await expect(maxTokens).toHaveValue("-1");
  await expect(maxTokens).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".chatExchange")).toHaveCount(0);
  expect(await requestCount(page)).toBe(0);
});

test("a sent request with a gateway error remains inspectable", async ({ page }) => {
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Check route availability.");
  await message.press("Enter");
  await expect.poll(() => requestCount(page)).toBe(1);
  await page.evaluate(() => (window as TestWindow).playgroundRequests[0].resolve(new Response("Temporarily unavailable", { status: 503 })));
  await expect(page.locator(".chatMessageAssistant")).toContainText("Gateway error");
  await expect(page.locator(".chatMessageAssistant")).toContainText("Temporarily unavailable");
  await expect(page.locator(".inspectorTopline")).toContainText("503");
  await expect(page.locator(".composerDock [role=alert]")).toHaveCount(0);
});

for (const action of ["earlier turn", "same turn", "Request", "Response", "select text", "close", "none"] as const) {
  test(`completion after inspector action: ${action}`, async ({ page }) => {
    const provider = page.getByRole("combobox", { name: "Provider", exact: true });
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    const inspector = page.locator(".playgroundInspector");
    const serviceReply = "Garden inventory: " + "basil, mint, parsley; ".repeat(120) + "end of inventory";

    await message.fill("First model question");
    await message.press("Enter");
    await expect.poll(() => requestCount(page)).toBe(1);
    await complete(page, 0, "First model answer");
    await provider.selectOption("test-service");
    const body = page.getByRole("textbox", { name: "JSON request body" });
    await body.fill('{"query":"garden inventory"}');
    await body.press("Enter");
    await expect.poll(() => requestCount(page)).toBe(2);
    await complete(page, 1, serviceReply);
    await expect(inspector.locator(".debugPayload")).toContainText("garden inventory");

    await provider.selectOption("test-model");
    await message.fill("Pending model question");
    await message.press("Enter");
    await expect.poll(() => requestCount(page)).toBe(3);
    if (action === "earlier turn" || action === "same turn") {
      await page.getByRole("button", { name: "Inspect user message" }).nth(action === "earlier turn" ? 0 : 1).press("Enter");
    } else if (action === "select text") {
      await inspector.locator(".debugPayload").dblclick();
    } else if (action === "close") {
      await inspector.getByRole("button", { name: "Close turn inspector" }).press("Enter");
    } else if (action !== "none") {
      // Request is already active: activating it is still an explicit choice.
      await inspector.getByRole("button", { name: action, exact: true }).press("Enter");
    }

    if (action === "Response") {
      // Select the actual text a native Copy would use; a reply must not replace it.
      await inspector.locator(".debugPayload").evaluate((payload) => {
        const selection = window.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(payload);
        selection.removeAllRanges();
        selection.addRange(range);
      });
    }

    if (action === "close") {
      // Real request failures still belong in the transcript, not a reopened inspector.
      await page.evaluate(() => (window as TestWindow).playgroundRequests[2].resolve(new Response("Route unavailable", { status: 503 })));
      await expect(page.locator(".chatMessageAssistant").last()).toContainText("Gateway error");
      await expect(inspector.getByRole("heading", { name: "Conversation controls" })).toBeVisible();
      await expect(inspector.locator(".debugPayload")).toHaveCount(0);
    } else {
      await complete(page, 2, "Pending model answer");
      await expect(page.locator(".chatMessageAssistant").last()).toContainText("Pending model answer");
      const displayed = JSON.parse(await inspector.locator(".debugPayload").innerText());
      if (action === "Response") {
        expect(displayed).toEqual({ output_text: serviceReply });
        expect(JSON.parse(await page.evaluate(() => window.getSelection()!.toString()))).toEqual(displayed);
      }
      else if (action === "none" || action === "earlier turn") {
        expect(displayed.messages.at(-1).content).toBe(action === "none" ? "Pending model question" : "First model question");
      } else expect(displayed.body).toEqual({ query: "garden inventory" });
    }
    await expect(page.locator(".chatExchange")).toHaveCount(3);
    expect(await requestCount(page)).toBe(3);
    if (action === "close") {
      // Dismissal applied to the in-flight turn, not every future send.
      await message.fill("Next model question");
      await message.press("Enter");
      await expect.poll(() => requestCount(page)).toBe(4);
      await complete(page, 3, "Next model answer");
      await expect(inspector.locator(".debugPayload")).toContainText("Next model question");
    }
  });
}

test("opening the draft request preview during a send keeps it open", async ({ page }) => {
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Sent draft");
  await message.press("Enter");
  await expect.poll(() => requestCount(page)).toBe(1);
  await message.fill("Next draft");
  await page.locator(".requestDrawer summary").press("Space");
  const preview = page.locator(".requestDrawer pre");
  await expect(preview).toContainText("Next draft");
  await complete(page, 0, "Sent draft reply");
  await expect(page.locator(".chatMessageAssistant")).toContainText("Sent draft reply");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Next draft");
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
    manifestRoutes: provider.id === "test-service" ? 1 : 0, modelCount: provider.id === "test-model" ? 4 : 0,
    executable: true, verified: true, status: "verified", reasons: [],
  },
}));
const bootstrap: Record<string, unknown> = {
  "/v1/providers": { providers },
  "/v1/routes": {
    openaiCompatible: [{
      provider: "test-model", endpoints: ["/v1/chat/completions", "/v1/responses", "/v1/images/generations"],
      models: [
        { id: "test-model/example", capabilities: ["llm.chat"], endpoints: ["/v1/chat/completions"] },
        { id: "test-model/reply-lite", capabilities: ["llm.chat"], endpoints: ["/v1/chat/completions"] },
        { id: "test-model/reply-pro", capabilities: ["llm.responses"], endpoints: ["/v1/responses"] },
        { id: "test-model/image", capabilities: ["image.generation"], endpoints: ["/v1/images/generations"] },
      ],
    }],
    manifestProxy: [{ provider: "test-service", endpoint: "search", route: "/v1/proxy/test-service/search", methods: ["POST"] }],
  },
  "/v1/session": {
    authenticated: true, auth: "cloudflare_access", role: "user", email: "user@example.com", entitlements: { providers: entitlements },
  },
  "/v1/session/credentials": { credentials: [] },
  "/v1/session/usage": {
    policies: [], usage: {
      ledger: "ready", providers: [], daily: [], events: [],
      summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 },
    },
  },
};
