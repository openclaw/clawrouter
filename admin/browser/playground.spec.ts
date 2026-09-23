import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { embeddingCatalog, fixtureCatalog } from "./catalog-fixture";

interface PendingRequest {
  signal?: AbortSignal | null;
  url: string;
  body: Record<string, unknown>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

type TestWindow = Window & { playgroundRequests: PendingRequest[] };

let state: { catalog: ReturnType<typeof fixtureCatalog> | undefined; failSession: boolean; fallback: boolean; sessionReads: number; entitlementReads: number };

test.beforeEach(async ({ page }) => {
  state = { catalog: fixtureCatalog("user@example.com"), failSession: false, fallback: false, sessionReads: 0, entitlementReads: 0 };
  await page.addInitScript(() => {
    const requests: PendingRequest[] = [];
    (window as TestWindow).playgroundRequests = requests;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      if (url.pathname.startsWith("/v1/playground/")) {
        // Keep completion under test control, including a transport that ignores abort.
        return new Promise<Response>((resolve, reject) => requests.push({ signal: init?.signal, url: url.pathname, body: JSON.parse(String(init?.body)), resolve, reject }));
      }
      return originalFetch(input, init);
    };
  });
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/session") {
      state.sessionReads += 1;
      if (state.failSession) { await route.fulfill({ status: 503, body: "session reporting unavailable" }); return; }
    }
    if (path === "/v1/entitlements") state.entitlementReads += 1;
    const session = { authenticated: true, auth: "cloudflare_access", role: "user", email: "user@example.com", ...(state.fallback ? {} : { entitlements: { providers: entitlements, catalog: state.catalog } }) };
    const body = path === "/v1/session" ? session : path === "/v1/entitlements" ? { session, providers: entitlements, catalog: state.catalog } : bootstrap[path];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  await page.goto("/dashboard/playground");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await choose(page, "test-model", "chat completions", "test-model/example");
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
  await choose(page, "test-service", "search · JSON", "Custom JSON request");
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

test("Catalog Try sends the exact chosen operation and model", async ({ page }) => {
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page.locator(".tableRow").filter({ hasText: "test-model" }).click();
  await expect(page.getByRole("button", { name: "Try in playground" })).toBeDisabled();
  await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption({ label: "responses" });
  await page.getByRole("combobox", { name: "Model or request", exact: true }).selectOption({ label: "test-model/reasoning" });
  await page.getByRole("button", { name: "Try in playground" }).click();
  await expect(page.getByRole("combobox", { name: "Operation", exact: true })).toHaveValue(/responses/);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Exact offer");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(1);
  expect(await page.evaluate(() => {
    const { url, body } = (window as TestWindow).playgroundRequests[0]; return { url, body };
  })).toEqual({ url: "/v1/playground/v1/responses", body: { model: "test-model/reasoning", input: [{ role: "user", content: "Exact offer" }], instructions: "You are concise and useful.", max_output_tokens: 128 } });
  await complete(page, 0, "Exact reply");
});

test("the next-turn preview and dispatch use the same conversation after an explicit operation change", async ({ page }) => {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("First message");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(1);
  await complete(page, 0, "First reply");
  await choose(page, "test-model", "responses", "test-model/reasoning");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue here");
  await page.getByRole("button", { name: "Conversation controls" }).click();
  const preview = JSON.parse((await page.locator(".requestDrawer pre").textContent())!);
  expect(preview.input).toEqual([{ role: "user", content: "First message" }, { role: "assistant", content: "First reply" }, { role: "user", content: "Continue here" }]);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(2);
  expect(await page.evaluate(() => (window as TestWindow).playgroundRequests[1].body)).toEqual(preview);
  await complete(page, 1, "Next reply");
});

for (const change of ["blocked", "removed", "generation"] as const) {
  test(`a ${change} offer preserves selection and draft without dispatch or substitution`, async ({ page }) => {
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Keep this draft");
    const value = await page.getByRole("combobox", { name: "Model or request" }).inputValue();
    const provider = state.catalog!.providers[0];
    if (change === "blocked") {
      provider.offers[0] = { ...provider.offers[0], eligible: false, affordability: "exact-blocked", reasonCode: "budget_exhausted" };
      provider.models = provider.models.filter((model) => model.id !== "test-model/example");
    } else if (change === "removed") provider.offers.shift();
    else provider.offers[0].policyGeneration = "replacement-generation";
    await refreshCatalog(page);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Model or request" })).toHaveValue(value);
    await expect(message).toHaveValue("Keep this draft");
    await expect(page.locator(".composerDock")).toContainText(change === "blocked" ? "budget_exhausted" : "no longer available");
    await page.locator("form.chatPlayground").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect(page.locator(".chatMessageAssistant")).toContainText(change === "blocked" ? "budget_exhausted" : "no longer available");
    expect(await requestCount(page)).toBe(0);
    await expect(message).toHaveValue("Keep this draft");
  });
}

test("model providers expose native operations and null-model request forms", async ({ page }) => {
  await choose(page, "test-model", "embeddings · JSON", "test-model/embedding");
  const payload = page.getByRole("textbox", { name: "JSON request body", exact: true });
  await expect(payload).toHaveValue(/"model": "embedding"/);
  await payload.fill('{"model":"embedding","input":"fixture"}');
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(1);
  expect(await page.evaluate(() => {
    const { url, body } = (window as TestWindow).playgroundRequests[0]; return { url, body };
  })).toEqual({ url: "/v1/playground/proxy/test-model/embeddings", body: { method: "POST", pathParams: {}, body: { model: "embedding", input: "fixture" } } });
  await complete(page, 0, "embedding reply");
  await choose(page, "test-model", "embeddings · JSON", "Custom JSON request");
  await payload.fill('{"model":"opaque-model","input":"custom"}');
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

for (const provider of ["openai", "azure-openai"]) {
  test(`${provider} unified embeddings send the qualified model without manifest controls`, async ({ page }) => {
    state.catalog = embeddingCatalog("user@example.com");
    await refreshCatalog(page);
    const model = state.catalog.providers.find((item) => item.id === provider)!.models[0];
    await choose(page, provider, "embeddings", model.id);
    const payload = page.getByRole("textbox", { name: "JSON request body", exact: true });
    await expect(payload).toHaveValue(JSON.stringify({ model: model.id, input: "OpenClaw" }, null, 2));
    await expect(page.getByRole("combobox", { name: "Method", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "deployment", exact: true })).toHaveCount(0);
    const wrong = JSON.stringify({ model: model.upstream, input: "Keep this input" });
    await payload.fill(wrong);
    await page.locator("form.chatPlayground").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect(page.locator(".chatMessageAssistant")).toContainText("Request model differs from the selected offer");
    expect(await requestCount(page)).toBe(0);
    await expect(payload).toHaveValue(wrong);
    await payload.fill(JSON.stringify({ model: model.id, input: "Exact embedding" }));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => requestCount(page)).toBe(1);
    expect(await page.evaluate(() => {
      const { url, body } = (window as TestWindow).playgroundRequests[0]; return { url, body };
    })).toEqual({ url: "/v1/playground/v1/embeddings", body: { model: model.id, input: "Exact embedding" } });
    await complete(page, 0, "embedding reply");
  });
}

test("scoped path and body model conflicts preserve the draft without dispatch", async ({ page }) => {
  state.catalog = embeddingCatalog("user@example.com");
  await refreshCatalog(page);
  await choose(page, "azure-openai", "embeddings · JSON", "azure-openai/deployment");
  const payload = page.getByRole("textbox", { name: "JSON request body", exact: true });
  const deployment = page.getByRole("textbox", { name: "deployment", exact: true });
  await expect(deployment).toHaveValue("${deployment}");
  const wrongBody = '{"model":"other/model","input":"keep body"}';
  await payload.fill(wrongBody);
  await page.locator("form.chatPlayground").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator(".chatMessageAssistant").last()).toContainText("Request model differs from the selected offer");
  expect(await requestCount(page)).toBe(0);
  await expect(payload).toHaveValue(wrongBody);
  await page.getByRole("button", { name: "Conversation controls" }).click();
  await expect(deployment).toHaveValue("${deployment}");
  await payload.fill('{"model":"azure-openai/deployment","input":"keep path"}');
  await deployment.fill("other");
  await page.locator("form.chatPlayground").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator(".chatMessageAssistant")).toHaveCount(2);
  expect(await requestCount(page)).toBe(0);
  await page.getByRole("button", { name: "Conversation controls" }).click();
  await expect(deployment).toHaveValue("other");
  await deployment.fill("${deployment}");
  await payload.fill('{"input":"path only"}');
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(1);
  expect(await page.evaluate(() => (window as TestWindow).playgroundRequests[0].body)).toEqual({ method: "POST", pathParams: { deployment: "${deployment}" }, body: { input: "path only" } });
  await complete(page, 0, "scoped reply");
});

test("Catalog retains a disabled operation selection when its entire provider disappears", async ({ page }) => {
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page.locator(".tableRow").filter({ hasText: "test-model" }).click();
  const operation = page.getByRole("combobox", { name: "Operation", exact: true });
  const model = page.getByRole("combobox", { name: "Model or request", exact: true });
  await operation.selectOption({ label: "responses" });
  await model.selectOption({ label: "test-model/reasoning" });
  const selection = { operation: await operation.inputValue(), model: await model.inputValue() };
  state.catalog!.providers = state.catalog!.providers.filter((item) => item.id !== "test-model");
  await refreshCatalog(page);
  await expect(page.locator(".tableRow").filter({ hasText: "test-model" })).toHaveCount(0);
  await expect(page.locator(".inspector")).toContainText("Selected provider unavailable");
  await expect(operation).toHaveValue(selection.operation);
  await expect(model).toHaveValue(selection.model);
  await expect(operation).toBeDisabled();
  await expect(model).toBeDisabled();
  await expect(page.getByRole("button", { name: "Try in playground" })).toBeDisabled();
  expect(await requestCount(page)).toBe(0);
});

test("explicit parameter conflicts preserve input while blank fields stay absent", async ({ page }) => {
  await choose(page, "test-model", "responses", "test-model/reasoning");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Do not discard me");
  const temperature = page.getByRole("textbox", { name: "Temperature", exact: true });
  await temperature.fill("0.7");
  await expect(page.locator(".composerDock")).toContainText("temperature field presence is not supported");
  await page.locator("form.chatPlayground").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator(".chatMessageAssistant")).toContainText("temperature field presence is not supported");
  expect(await requestCount(page)).toBe(0);
  await expect(message).toHaveValue("Do not discard me");
  await page.getByRole("button", { name: "Conversation controls" }).click();
  await expect(temperature).toHaveValue("0.7");
  await temperature.fill("");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(1);
  expect(await page.evaluate(() => Object.hasOwn((window as TestWindow).playgroundRequests[0].body, "temperature"))).toBe(false);
  await complete(page, 0, "reply");
});

test("initial and empty catalogs are actionable, and unknown refreshes never invent choices", async ({ page }) => {
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue("");
  await expect(page.locator(".composerDock")).toContainText("Choose a provider, operation and model or request");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  state.catalog!.providers = [];
  await refreshCatalog(page);
  await expect(page.locator(".composerDock")).toContainText("No configured services are assigned");
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.locator(".servicePanel")).toContainText("No services assigned");
  await page.getByRole("button", { name: "Playground", exact: true }).click();
  state.catalog = undefined;
  await refreshCatalog(page);
  await expect(page.locator(".composerDock")).toContainText("Catalog unavailable");
  await expect(page.getByRole("combobox", { name: "Provider", exact: true }).locator("option")).toHaveCount(1);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.locator(".servicePanel")).toContainText("Catalog unavailable");
  await expect(page.locator(".servicePanel")).not.toContainText("No services assigned");
});

test("operation selectors remain labeled and fit the viewport in both themes", async ({ page }) => {
  for (const theme of ["light", "dark"]) {
    const toggle = page.getByRole("switch", { name: "Light mode", exact: true });
    if ((await page.locator("html").getAttribute("data-theme")) !== theme) await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const name of ["Provider", "Operation", "Model or request"]) await expect(page.getByRole("combobox", { name, exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  }
});

test("the entitlements fallback supplies scoped offers and failed session refresh blocks a retained draft", async ({ page }) => {
  state.fallback = true;
  await page.reload();
  await expect.poll(() => state.entitlementReads).toBe(1);
  await choose(page, "test-model", "chat completions", "test-model/example");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Retain during reporting failure");
  state.failSession = true;
  await refreshCatalog(page);
  await expect(page.locator(".composerDock")).toContainText("Catalog unavailable");
  await expect(message).toHaveValue("Retain during reporting failure");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  state.failSession = false;
  await refreshCatalog(page);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(message).toHaveValue("Retain during reporting failure");
});

async function choose(page: Page, provider: string, operation: string, model: string) {
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption(provider);
  await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption({ label: operation });
  await page.getByRole("combobox", { name: "Model or request", exact: true }).selectOption({ label: model });
}

async function refreshCatalog(page: Page) {
  const count = state.sessionReads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.sessionReads).toBe(count + 1);
}

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
    manifestProxy: [
      { provider: "test-service", endpoint: "search", route: "/v1/proxy/test-service/search", methods: ["POST"] },
      { provider: "test-model", endpoint: "embeddings", route: "/v1/proxy/test-model/embeddings", methods: ["POST"], requestFormat: "openai.embeddings" },
      { provider: "openai", endpoint: "embeddings", route: "/v1/proxy/openai/embeddings", methods: ["POST"], requestFormat: "openai.embeddings" },
      { provider: "azure-openai", endpoint: "embeddings", route: "/v1/proxy/azure-openai/embeddings", methods: ["POST"], pathParams: ["deployment"], requestFormat: "openai.embeddings" },
    ],
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
