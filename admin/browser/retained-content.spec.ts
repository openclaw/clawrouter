import { expect, test, type Page } from "@playwright/test";

interface PendingContent {
  url: string;
  signal?: AbortSignal | null;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}
type TestWindow = Window & { contentRequests: PendingContent[] };

for (const outcome of ["success", "error"] as const) {
  for (const order of ["before", "after"] as const) {
    test(`an older ${outcome} ${order} a Fusion content reply cannot replace the latest selection`, async ({ page }) => {
      await open(page);
      await inspect(page, "ordinary-a", 1);
      await page.getByRole("button", { name: /Fusion ensemble/ }).click();
      await page.locator('[aria-label="Fusion recorded calls"]').getByRole("button", { name: "View", exact: true }).click();
      await expect.poll(() => requestCount(page)).toBe(2);
      expect(await aborted(page, 0)).toBe(true);
      expect(await page.evaluate(() => new URL((window as TestWindow).contentRequests[1].url).searchParams.get("ref"))).toBe("fusion-adviser");
      if (order === "after") await complete(page, 1, "fusion-current");
      await settle(page, 0, outcome, "ordinary-stale");
      const panel = page.locator(".retainedContentPanel");
      await expect(panel).not.toContainText("ordinary-stale");
      if (order === "before") {
        await expect(panel).toContainText("Loading retained request");
        await complete(page, 1, "fusion-current");
      }
      await expect(panel).toContainText("fusion-current");
      await expect(panel).not.toContainText("Loading retained request");
      await expect(panel.locator('[role="alert"]')).toHaveCount(0);
    });
  }

  test(`Close during a replacement read ignores its late ${outcome}`, async ({ page }) => {
    await open(page);
    await inspect(page, "ordinary-a", 1);
    await complete(page, 0, "previous-content");
    await inspect(page, "ordinary-b", 2);
    await expect(page.locator(".retainedContentPanel")).not.toContainText("previous-content");
    await expect(page.locator(".retainedContentPanel")).toContainText("Loading retained request");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    expect(await aborted(page, 1)).toBe(true);
    await settle(page, 1, outcome, "closed-content");
    await expect(page.locator(".retainedContentFeedback")).toHaveCount(0);
  });

  test(`Close and reopen of the same reference ignores the first ${outcome}`, async ({ page }) => {
    await open(page);
    await inspect(page, "ordinary-a", 1);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await inspect(page, "ordinary-a", 2);
    expect(await aborted(page, 0)).toBe(true);
    expect(await aborted(page, 1)).toBe(false);
    await settle(page, 0, outcome, "old-incarnation");
    await expect(page.locator(".retainedContentPanel")).toContainText("Loading retained request");
    await expect(page.locator(".retainedContentPanel")).not.toContainText("old-incarnation");
    await complete(page, 1, "new-incarnation");
    await expect(page.locator(".retainedContentPanel")).toContainText("new-incarnation");
  });
}

test("current content errors remain visible and can be closed", async ({ page }) => {
  await open(page);
  await inspect(page, "ordinary-a", 1);
  await settle(page, 0, "error", "content expired");
  await expect(page.locator(".retainedContentPanel")).toContainText("content expired");
  await expect(page.locator(".retainedContentPanel")).not.toContainText("Loading retained request");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".retainedContentFeedback")).toHaveCount(0);
});

test("leaving Usage retires its read before returning to a new inspector", async ({ page }) => {
  await open(page);
  await inspect(page, "ordinary-a", 1);
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  expect(await aborted(page, 0)).toBe(true);
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await inspect(page, "ordinary-b", 2);
  await complete(page, 1, "returned-content");
  await complete(page, 0, "departed-content");
  await expect(page.locator(".retainedContentPanel")).toContainText("returned-content");
  await expect(page.locator("body")).not.toContainText("departed-content");
});

test("identity replacement cannot publish a pending old content reply", async ({ page }) => {
  const state = await open(page);
  await inspect(page, "ordinary-a", 1);
  state.email = "second@example.com";
  state.subject = "second-subject";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
  expect(await aborted(page, 0)).toBe(true);
  await inspect(page, "ordinary-b", 2);
  await complete(page, 1, "new-identity-content");
  await complete(page, 0, "old-identity-content");
  await expect(page.locator(".retainedContentPanel")).toContainText("new-identity-content");
  await expect(page.locator("body")).not.toContainText("old-identity-content");
});

test("content authentication loss still clears the protected console without replay", async ({ page }) => {
  await open(page);
  await inspect(page, "ordinary-a", 1);
  await page.evaluate(() => (window as TestWindow).contentRequests[0].resolve(new Response(JSON.stringify({ error: { code: "admin_unauthorized", message: "sign-in required" } }), { status: 401, headers: { "content-type": "application/json" } })));
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".retainedContentFeedback")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry access", exact: true }).click();
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  expect(await requestCount(page)).toBe(1);
  await expect(page.locator(".retainedContentFeedback")).toHaveCount(0);
});

async function inspect(page: Page, id: string, count: number) {
  await page.locator(".usageTablePanel .tableRow").filter({ hasText: id }).getByRole("button", { name: "View", exact: true }).click();
  await expect.poll(() => requestCount(page)).toBe(count);
}

function requestCount(page: Page) {
  return page.evaluate(() => (window as TestWindow).contentRequests.length);
}

function aborted(page: Page, index: number) {
  return page.evaluate((index) => (window as TestWindow).contentRequests[index].signal?.aborted, index);
}

async function settle(page: Page, index: number, outcome: "success" | "error", text: string) {
  if (outcome === "success") await complete(page, index, text);
  else {
    await page.evaluate(({ index, text }) => (window as TestWindow).contentRequests[index].reject(new Error(text)), { index, text });
    await flush(page);
  }
}

async function complete(page: Page, index: number, text: string) {
  await page.evaluate(({ index, text }) => {
    (window as TestWindow).contentRequests[index].resolve(new Response(JSON.stringify({ requestId: text, occurredAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, provider: "fixture", capability: "llm.chat", body: { input: text } }), { headers: { "content-type": "application/json" } }));
  }, { index, text });
  await flush(page);
}

async function flush(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function open(page: Page) {
  const state = { email: "admin@example.com", subject: "first-subject" };
  await page.addInitScript(() => {
    const requests: PendingContent[] = [];
    (window as TestWindow).contentRequests = requests;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      if (url.pathname === "/v1/admin/content") {
        // Intentionally ignore abort so the real inspector must fence late settlements.
        return new Promise<Response>((resolve, reject) => requests.push({ url: url.href, signal: init?.signal, resolve, reject }));
      }
      return originalFetch(input, init);
    };
  });
  const event = (id: string) => ({ id, type: "request", request_id: id, occurred_at_ms: Date.now(), tenant_id: "fixture-tenant", provider: "fixture", capability: "llm.chat", status: "success", status_code: 200, reserved_cost_micros: 0, actual_cost_micros: 0, content_retained: true, content_ref: id });
  const usage = { ledger: "ready", providers: [], daily: [], summary: { requestCount: 4, successCount: 4, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 }, events: [
    event("ordinary-a"), event("ordinary-b"),
    { ...event("fusion-adviser"), compound_request_id: "fusion", compound_request_stage: "fusion_adviser", compound_request_index: 1, compound_request_size: 2 },
    { ...event("fusion-final"), content_retained: false, compound_request_id: "fusion", compound_request_stage: "fusion_synthesizer", compound_request_index: null, compound_request_size: 2 },
  ] };
  const fusion = { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "fixture/model", adviserTimeoutMs: 1000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 };
  await page.route("**/v1**", async (route) => {
    const responses: Record<string, unknown> = {
      "/v1": { endpoints: {} },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: state.email, subject: state.subject, tenantId: "fixture-tenant", groups: [], entitlements: { providers: [] } },
      "/v1/providers": { providers: [] }, "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session/credentials": { credentials: [] }, "/v1/session/usage": { policies: [], usage },
      "/v1/admin/usage": { policies: [], usage },
      "/v1/admin/bootstrap": { policies: [], credentials: [], connections: [], users: [], bindings: [], grants: [], rules: [], providers: [], tenants: [], overview: null, fusion },
    };
    const body = responses[new URL(route.request().url()).pathname];
    await route.fulfill({ status: body ? 200 : 404, json: body ?? {} });
  });
  await page.goto("/dashboard/usage");
  await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
  await expect(page.locator(".usageTablePanel .tableRow").filter({ hasText: "ordinary-a" })).toBeVisible();
  return state;
}
