import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixtureCatalog } from "./catalog-fixture";

test("bootstrap authentication loss removes protected data before siblings or login discovery finish", async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await page.getByRole("textbox", { name: "tenant", exact: true }).fill("private-draft");
  const sibling = deferred(), login = deferred();
  state.waits.set("/v1/session/credentials", sibling.promise);
  state.waits.set("/v1", login.promise);
  state.replies.set("/v1/admin/bootstrap", authError("admin_unauthorized"));
  await focus(page);
  await signedOut(page);
  await expect(page.locator("body")).not.toContainText("admin@example.com");
  await expect.poll(() => state.requests.filter((item) => item.path === "/v1").length).toBe(1);
  sibling.release(); login.release();
});

for (const operation of ["create", "rotate", "revoke", "policy", "content"] as const) {
  test(`admin ${operation} authentication loss uses the same gate without replay`, async ({ page }) => {
    const state = await fixture(page);
    await open(page, operation === "content" ? "/dashboard/usage" : "/dashboard/access?resource=credentials");
    const path = operation === "create" ? "/v1/admin/credentials"
      : operation === "policy" ? "/v1/admin/policies/team_policy"
      : operation === "content" ? "/v1/admin/content"
      : `/v1/admin/credentials/owned_key/${operation}`;
    state.replies.set(path, authError("admin_unauthorized"));
    if (operation === "create") {
      await page.getByRole("textbox", { name: "credential id", exact: true }).fill("new_key");
      await page.getByRole("combobox", { name: "policy", exact: true }).selectOption("team_policy");
      await page.getByRole("button", { name: "Issue credential", exact: true }).click();
    } else if (operation === "policy") {
      await page.getByRole("tab", { name: /^Policies/ }).click();
      await page.getByRole("button", { name: "Save policy", exact: true }).click();
    } else if (operation === "content") await page.getByRole("button", { name: "View", exact: true }).click();
    else {
      await page.getByRole("button", { name: /owned_key.*proxy credential/ }).click();
      await page.getByRole("button", { name: operation === "rotate" ? "Rotate credential" : "Revoke credential", exact: true }).click();
    }
    await signedOut(page);
    state.replies.delete(path);
    await page.getByRole("button", { name: "Retry access" }).click();
    await connected(page);
    expect(state.requests.filter((item) => item.path === path)).toHaveLength(1);
    await expect(page.locator(".issuedKey code")).toHaveCount(0);
  });
}

test("recovery has its own probe and a delayed old session cannot replace the new identity", async ({ page }) => {
  const state = await fixture(page);
  await open(page, "/dashboard/access?resource=credentials");
  const oldSession = deferred();
  state.waits.set("/v1/session", oldSession.promise);
  await focus(page);
  await expect.poll(() => state.requests.filter((item) => item.path === "/v1/session").length).toBe(2);
  state.replies.set("/v1/admin/credentials/owned_key/revoke", authError("admin_unauthorized"));
  await page.getByRole("button", { name: /owned_key.*proxy credential/ }).click();
  await page.getByRole("button", { name: "Revoke credential", exact: true }).click();
  await signedOut(page);
  state.waits.delete("/v1/session");
  state.email = "second@example.com";
  await page.getByRole("button", { name: "Retry access" }).click();
  await connected(page);
  await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
  const oldResponse = page.waitForResponse("**/v1/session");
  oldSession.release();
  await oldResponse;
  await flush(page);
  await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
  await expect(page.locator("body")).not.toContainText("admin_unauthorized");
});

for (const sent of [false, true]) {
  test(`${sent ? "sent" : "hashing"} credential work retains its proper ownership through reauthentication`, async ({ page }) => {
    const state = await fixture(page);
    if (!sent) await page.addInitScript(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (...args: Parameters<SubtleCrypto["digest"]>) => {
        await new Promise<void>((resolve) => { (window as TestWindow).releaseHash = resolve; });
        return digest(...args);
      };
    });
    await open(page, "/dashboard/access?resource=credentials");
    const auth = deferred(), mutation = deferred();
    state.replies.set("/v1/admin/bootstrap", authError("admin_unauthorized"));
    state.waits.set("/v1/admin/bootstrap", auth.promise);
    await focus(page);
    await expect.poll(() => state.requests.filter((item) => item.path === "/v1/admin/bootstrap").length).toBe(2);
    state.waits.set("/v1/admin/credentials", mutation.promise);
    await page.getByRole("textbox", { name: "credential id", exact: true }).fill("pending_key");
    await page.getByRole("combobox", { name: "policy", exact: true }).selectOption("team_policy");
    await page.getByRole("button", { name: "Issue credential", exact: true }).click();
    if (sent) await expect.poll(() => state.writes.length).toBe(1);
    else await expect.poll(() => page.evaluate(() => Boolean((window as TestWindow).releaseHash))).toBe(true);
    state.replies.delete("/v1/admin/bootstrap"); state.waits.delete("/v1/admin/bootstrap");
    auth.release();
    await signedOut(page);
    await page.getByRole("button", { name: "Retry access" }).click();
    await connected(page);
    await page.getByRole("combobox", { name: "policy", exact: true }).selectOption("team_policy");
    await expect(page.getByRole("button", { name: "Issue credential", exact: true })).toBeDisabled();
    if (sent) mutation.release();
    else await page.evaluate(() => (window as TestWindow).releaseHash!());
    await expect(page.getByRole("button", { name: "Issue credential", exact: true })).toBeEnabled();
    expect(state.writes).toHaveLength(sent ? 1 : 0);
    await expect(page.locator(".issuedKey code")).toHaveCount(0);
  });
}

for (const operation of ["fusion", "oauth"] as const) {
  test(`late ${operation} response cannot cause an external side effect after session loss`, async ({ page }) => {
    const state = await fixture(page);
    let redirects = 0;
    await page.route("https://provider.example/**", async (route) => { redirects += 1; await route.abort(); });
    await open(page, `/dashboard/access?resource=${operation === "fusion" ? "fusion" : "upstream"}`);
    const auth = deferred(), operationReply = deferred();
    state.replies.set("/v1/admin/bootstrap", authError("admin_unauthorized"));
    state.waits.set("/v1/admin/bootstrap", auth.promise);
    await focus(page);
    await expect.poll(() => state.requests.filter((item) => item.path === "/v1/admin/bootstrap").length).toBe(2);
    const path = operation === "fusion" ? "/v1/admin/fusion/preview" : "/v1/admin/upstream-grants/policies/team_policy/test-model/authorize";
    state.waits.set(path, operationReply.promise);
    await page.getByRole("button", { name: operation === "fusion" ? "Save fusion model" : "Connect with provider", exact: true }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    auth.release();
    await signedOut(page);
    const response = page.waitForResponse((item) => new URL(item.url()).pathname === path);
    operationReply.release();
    await response;
    await flush(page);
    expect(state.writes).toHaveLength(1);
    expect(redirects).toBe(0);
    await signedOut(page);
  });
}

for (const replacement of ["same", "other"] as const) {
  for (const kind of ["api_key", "subscription"] as const) {
    test(`${replacement} identity recovery clears ${kind} secrets and policy drafts even if bootstrap fails`, async ({ page }) => {
      const state = await fixture(page);
      await open(page);
      await page.getByRole("textbox", { name: "tenant", exact: true }).fill("private-policy-draft");
      await page.getByRole("tab", { name: /^Upstream/ }).click();
      await page.getByRole("combobox", { name: "kind", exact: true }).selectOption(kind);
      const labels = kind === "api_key" ? ["API key", "credential bundle JSON"] : ["access token", "refresh token"];
      for (const label of labels) await page.getByLabel(label, { exact: true }).fill(`private-${label}`);
      state.replies.set("/v1/admin/bootstrap", authError("admin_unauthorized"));
      await focus(page);
      await signedOut(page);
      state.replies.set("/v1/admin/bootstrap", { status: 503, body: "reporting unavailable" });
      if (replacement === "other") state.email = "second@example.com";
      await page.getByRole("button", { name: "Retry access" }).click();
      await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
      await expect(page.locator(".statusBar")).toContainText("reporting unavailable");
      await expect(page.getByRole("textbox", { name: "tenant", exact: true })).not.toHaveValue("private-policy-draft");
      await page.getByRole("tab", { name: /^Upstream/ }).click();
      await page.getByRole("combobox", { name: "kind", exact: true }).selectOption(kind);
      for (const label of labels) await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
    });
  }
}

test("retained request content is destroyed by identity replacement despite a failed new bootstrap", async ({ page }) => {
  const state = await fixture(page);
  await open(page, "/dashboard/usage");
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.locator(".retainedContentPanel")).toContainText("private-request-body");
  state.email = "second@example.com";
  state.replies.set("/v1/admin/bootstrap", { status: 503, body: "reporting unavailable" });
  await focus(page);
  await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
  await expect(page.locator(".statusBar")).toContainText("reporting unavailable");
  await expect(page.locator(".retainedContentPanel")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("private-request-body");
});

for (const mode of ["model", "service"] as const) {
  for (const replacement of ["same", "other"] as const) {
    test(`${replacement} identity recovery clears ${mode} Playground data and cancels its old request`, async ({ page }) => {
      const state = await fixture(page);
      await page.addInitScript(() => {
        const requests: PlaygroundRequest[] = [];
        (window as TestWindow).playgroundRequests = requests;
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
          if (url.pathname.startsWith("/v1/playground/")) return new Promise<Response>((resolve) => requests.push({ signal: init?.signal, resolve }));
          return originalFetch(input, init);
        };
      });
      await open(page, "/dashboard/playground");
      await choosePlayground(page, mode);
      const message = page.getByRole("textbox", { name: mode === "model" ? "Message" : "JSON request body", exact: true });
      await message.fill(mode === "model" ? "private-history" : '{"query":"private-history"}');
      await message.press("Enter");
      await expect.poll(() => page.evaluate(() => (window as TestWindow).playgroundRequests!.length)).toBe(1);
      await completePlayground(page, 0, "private-response");
      await expect(page.locator(".chatMessageAssistant")).toContainText("private-response");
      if (mode === "model") {
        await page.locator(".composerInspect").click();
        await page.getByRole("textbox", { name: "System instructions", exact: true }).fill("private-system");
      }
      const auth = deferred();
      state.replies.set("/v1/admin/bootstrap", authError("admin_unauthorized"));
      state.waits.set("/v1/admin/bootstrap", auth.promise);
      await focus(page);
      await expect.poll(() => state.requests.filter((item) => item.path === "/v1/admin/bootstrap").length).toBe(2);
      await message.fill(mode === "model" ? "private-pending" : '{"query":"private-pending"}');
      await message.press("Enter");
      await expect.poll(() => page.evaluate(() => (window as TestWindow).playgroundRequests!.length)).toBe(2);
      if (mode === "model") await message.fill("private-next-draft");
      auth.release();
      await signedOut(page);
      expect(await page.evaluate(() => (window as TestWindow).playgroundRequests![1].signal?.aborted)).toBe(true);
      state.replies.delete("/v1/admin/bootstrap"); state.waits.delete("/v1/admin/bootstrap");
      if (replacement === "other") state.email = "second@example.com";
      await page.getByRole("button", { name: "Retry access" }).click();
      await connected(page);
      await expect(page.locator(".chatExchange")).toHaveCount(0);
      await choosePlayground(page, mode);
      await expect(message).not.toHaveValue(/private-/);
      if (mode === "model") {
        await page.locator(".composerInspect").click();
        await expect(page.getByRole("textbox", { name: "System instructions", exact: true })).not.toHaveValue("private-system");
      }
      await completePlayground(page, 1, "private-late-response");
      await expect(page.locator(".chatExchange")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("private-");
    });
  }
}

test("a delayed old catalog cannot replace a recovered identity's selection", async ({ page }) => {
  const state = await fixture(page);
  await open(page, "/dashboard/playground");
  await choosePlayground(page, "model");
  const oldCatalog = deferred();
  const oldSession = { authenticated: true, auth: "cloudflare_access", role: "admin", email: state.email, subject: state.subject, groups: state.groups, tenantId: "default" };
  state.replies.set("/v1/session", { status: 200, json: oldSession });
  state.replies.set("/v1/entitlements", { status: 200, json: { session: oldSession, providers: [], catalog: fixtureCatalog(state.email, "team_policy") } });
  state.waits.set("/v1/entitlements", oldCatalog.promise);
  await focus(page);
  await expect.poll(() => state.requests.filter((item) => item.path === "/v1/entitlements").length).toBe(1);
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await page.getByRole("tab", { name: /^Credentials/ }).click();
  await page.getByRole("button", { name: /owned_key.*proxy credential/ }).click();
  state.replies.set("/v1/admin/credentials/owned_key/revoke", authError("admin_unauthorized"));
  await page.getByRole("button", { name: "Revoke credential", exact: true }).click();
  await signedOut(page);
  state.replies.delete("/v1/session");
  state.email = "second@example.com";
  await page.getByRole("button", { name: "Retry access" }).click();
  await connected(page);
  await page.getByRole("button", { name: "Playground", exact: true }).click();
  await choosePlayground(page, "model");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("New identity draft");
  const late = page.waitForResponse("**/v1/entitlements");
  oldCatalog.release();
  await late; await flush(page);
  await expect(message).toHaveValue("New identity draft");
  await expect(page.getByRole("combobox", { name: "Model or request" })).toHaveValue(/second@example.com/);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("global admin readiness cannot override a blocked personal offer", async ({ page }) => {
  const state = await fixture(page);
  await open(page, "/dashboard/playground");
  await choosePlayground(page, "model");
  const catalog = fixtureCatalog(state.email, "team_policy");
  catalog.providers[0].offers[0] = { ...catalog.providers[0].offers[0], eligible: false, affordability: "exact-blocked", reasonCode: "provider_budget_exhausted" };
  state.replies.set("/v1/session", { status: 200, json: { authenticated: true, auth: "cloudflare_access", role: "admin", email: state.email, subject: state.subject, tenantId: "default", groups: state.groups, entitlements: { providers: [], catalog } } });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Preserved personal draft");
  await focus(page);
  await expect.poll(() => state.requests.filter((item) => item.path === "/v1/admin/bootstrap").length).toBe(2);
  await expect(page.locator(".composerDock")).toContainText("provider_budget_exhausted");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Preserved personal draft");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
});

test("same-identity group refresh preserves drafts while a changed public subject starts a new lifetime", async ({ page }) => {
  const state = await fixture(page);
  await open(page);
  await page.getByRole("textbox", { name: "tenant", exact: true }).fill("subject-owned-draft");
  await page.getByRole("switch", { name: "Light mode", exact: true }).click();
  const previousRefresh = await page.locator(".connectionMeta time").getAttribute("datetime");
  state.groups = ["new-group"];
  await focus(page);
  await expect(page.locator(".connectionMeta time")).not.toHaveAttribute("datetime", previousRefresh!);
  await expect(page.getByRole("textbox", { name: "tenant", exact: true })).toHaveValue("subject-owned-draft");
  state.subject = "second-subject";
  await focus(page);
  await expect(page.getByRole("textbox", { name: "tenant", exact: true })).not.toHaveValue("subject-owned-draft");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
});

for (const failure of [
  { status: 403, json: { error: { code: "access_admin_required" } } },
  { status: 403, json: { error: { code: "access_csrf_required" } } },
  { status: 401, body: "admin_unauthorized" },
  { status: 401, json: { message: "admin_unauthorized" } },
  { status: 401, json: { error: { code: "other_failure" } } },
  { status: 503, body: "reporting unavailable" },
]) {
  test(`non-authentication failure preserves the identity and draft: ${JSON.stringify(failure)}`, async ({ page }) => {
    const state = await fixture(page);
    await open(page);
    await page.getByRole("textbox", { name: "tenant", exact: true }).fill("retained-draft");
    state.replies.set("/v1/admin/policies/team_policy", failure);
    await page.getByRole("button", { name: "Save policy", exact: true }).click();
    await expect(page.locator(".statusBar")).toBeVisible();
    await expect(page.locator(".inspector .inlineError")).toBeVisible();
    await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
    await expect(page.getByRole("textbox", { name: "tenant", exact: true })).toHaveValue("retained-draft");
    await expect(page.locator(".loginShell")).toHaveCount(0);
  });
}

test("login success does not expose protected data until a fresh browser session is accepted", async ({ page }) => {
  const state = await fixture(page);
  state.local = true;
  state.replies.set("/v1/session", authError("access_session_required"));
  await page.goto("/dashboard/access");
  await signedOut(page);
  const token = page.getByLabel("admin token", { exact: true });
  await expect(token).toBeVisible();
  for (const [status, message] of [[401, "invalid admin token"], [429, "too many sign-in attempts"]] as const) {
    state.replies.set("/v1/session/login", { status, json: { error: { code: "login_invalid" } } });
    await token.fill("synthetic-login-token");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator(".loginShell")).toContainText(message);
  }
  state.replies.delete("/v1/session/login");
  state.replies.set("/v1/session", { status: 200, json: {} });
  const session = deferred();
  state.waits.set("/v1/session", session.promise);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checking access" })).toBeVisible();
  await expect(token).toHaveValue("");
  await expect(page.locator(".appShell")).toHaveCount(0);
  session.release();
  await expect(page.locator(".loginShell")).toContainText("did not return a verified browser session");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  state.replies.delete("/v1/session"); state.waits.delete("/v1/session");
  await page.getByRole("button", { name: "Retry access" }).focus();
  await page.keyboard.press("Enter");
  await connected(page);
});

test("managed sign-in offers reload and invalid successful responses never open the console", async ({ page }) => {
  const state = await fixture(page);
  state.replies.set("/v1/session", authError("access_session_required"));
  await page.goto("/dashboard/access");
  await signedOut(page);
  await expect(page.getByRole("button", { name: "Reload to sign in" })).toBeVisible();
  await expect(page.getByLabel("admin token", { exact: true })).toHaveCount(0);
  for (const session of [{}, { authenticated: false }, { authenticated: true, auth: "admin_token", email: "admin@example.com", role: "admin" }]) {
    state.replies.set("/v1/session", { status: 200, json: session });
    await page.getByRole("button", { name: "Retry access" }).click();
    await expect(page.locator(".loginShell")).toContainText("did not return a verified browser session");
    await expect(page.locator(".appShell")).toHaveCount(0);
  }
});

interface PlaygroundRequest { signal?: AbortSignal | null; resolve: (response: Response) => void }
type TestWindow = Window & { releaseHash?: () => void; playgroundRequests?: PlaygroundRequest[] };
type Reply = { status: number; json?: unknown; body?: string };
function authError(code: string): Reply { return { status: 401, json: { error: { code, message: "Sign-in required" } } }; }
function deferred() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function focus(page: Page) { await page.evaluate(() => window.dispatchEvent(new Event("focus"))); }
async function flush(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function connected(page: Page) { await expect(page.locator(".connectionMeta strong")).toHaveText("Connected"); }
async function open(page: Page, path = "/dashboard/access") { await page.goto(path); await connected(page); }
async function signedOut(page: Page) { await expect(page.locator(".loginShell")).toContainText("Sign-in required"); await expect(page.locator(".appShell")).toHaveCount(0); }
async function completePlayground(page: Page, index: number, text: string) {
  await page.evaluate(({ index, text }) => (window as TestWindow).playgroundRequests![index].resolve(new Response(JSON.stringify({ output_text: text }), { headers: { "content-type": "application/json" } })), { index, text });
  await flush(page);
}

async function choosePlayground(page: Page, mode: "model" | "service") {
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption(mode === "model" ? "test-model" : "test-service");
  await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption({ label: mode === "model" ? "chat completions" : "search · JSON" });
  await page.getByRole("combobox", { name: "Model or request", exact: true }).selectOption({ label: mode === "model" ? "test-model/example" : "Custom JSON request" });
}

async function fixture(page: Page) {
  const state = {
    email: "admin@example.com", subject: "first-subject", groups: [] as string[], local: false,
    requests: [] as { path: string; method: string }[], writes: [] as { path: string; method: string }[],
    replies: new Map<string, Reply>(), waits: new Map<string, Promise<void>>(),
  };
  const policy = { policyId: "team_policy", enabled: true, providers: [], tenantId: "default", retainRequestContent: false, grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} } };
  const providers = [{ id: "test-model", display_name: "Test model", class: "test", service_kind: "model_provider", capabilities: [{ id: "llm.chat" }], auth: { authorization: { grantKind: "oauth" } } }, { id: "test-service", display_name: "Test service", class: "test", service_kind: "search", capabilities: [{ id: "search.web" }] }];
  const readiness = { id: "test-model", displayName: "Test model", class: "test", serviceKind: "model_provider", requiredConfig: [], optionalConfig: [], missingConfig: [], configPresent: true, oauthGrantRequired: false, oauthGrantCount: 0, openaiCompatible: true, manifestRoutes: 0, modelCount: 1, executable: true, verified: true, status: "verified", reasons: [] };
  const access = providers.map((provider) => ({ provider: provider.id, displayName: provider.display_name, serviceKind: provider.service_kind, allowed: true, policies: [policy.policyId], readiness: { ...readiness, id: provider.id, displayName: provider.display_name, serviceKind: provider.service_kind } }));
  const fusion = { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: ["test-model/example"], aggregatorModel: "test-model/example", adviserTimeoutMs: 10000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 };
  const usage = { ledger: "ready", providers: [], daily: [], summary: { requestCount: 1, successCount: 1, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 }, events: [{ id: "event", type: "request", request_id: "retained", occurred_at_ms: Date.now(), tenant_id: "default", provider: "test-model", capability: "llm.chat", status: "success", status_code: 200, reserved_cost_micros: 0, actual_cost_micros: 0, content_retained: true, content_ref: "request-content" }] };
  const credentials = [{ credentialId: "owned_key", policyId: policy.policyId, principalId: state.email, enabled: true, active: true }];
  await page.route("**/v1**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    state.requests.push({ path, method });
    if (method !== "GET") state.writes.push({ path, method });
    const session = { authenticated: true, auth: state.local ? "local" : "cloudflare_access", role: "admin", email: state.email, subject: state.subject, groups: state.groups, tenantId: "default", entitlements: { providers: access, catalog: fixtureCatalog(state.email, policy.policyId) } };
    const responses: Record<string, unknown> = {
      "/v1": { endpoints: state.local ? { sessionLogin: "/v1/session/login" } : {} },
      "/v1/session": session, "/v1/session/login": { ok: true },
      "/v1/providers": { providers },
      "/v1/routes": { openaiCompatible: [{ provider: "test-model", endpoints: ["/v1/chat/completions"], models: [{ id: "test-model/example", capabilities: ["llm.chat"], endpoints: ["/v1/chat/completions"] }] }], manifestProxy: [{ provider: "test-service", endpoint: "search", route: "/v1/proxy/test-service/search", methods: ["POST"] }] },
      "/v1/session/credentials": { credentials },
      "/v1/session/usage": { policies: [{ ...policy, budget: { configured: false, ledger: "ready" } }], usage },
      "/v1/admin/usage": { policies: [{ ...policy, budget: { configured: false, ledger: "ready" } }], usage },
      "/v1/admin/bootstrap": { policies: [policy], credentials, connections: [], users: [], bindings: [], grants: [], rules: [], providers: access.map((item) => item.readiness), tenants: [], overview: null, fusion },
      "/v1/admin/fusion/preview": { executable: true, calls: [], policyId: policy.policyId },
      "/v1/admin/upstream-grants/policies/team_policy/test-model/authorize": { authorizationUrl: "https://provider.example/authorize" },
      "/v1/admin/content": { requestId: "retained", occurredAtMs: Date.now(), expiresAtMs: Date.now() + 60000, provider: "test-model", capability: "llm.chat", body: { input: "private-request-body" } },
    };
    if (method === "POST" && path === "/v1/admin/credentials") {
      const body = request.postDataJSON();
      responses[path] = { credentialId: body.credentialId, policyId: body.policyId, principalId: body.principalId, enabled: true, active: true };
    }
    // Each request captures its old identity/result before the test releases it.
    const response = structuredClone(state.replies.get(path) ?? { status: responses[path] ? 200 : 404, json: responses[path] ?? {} });
    const wait = state.waits.get(path);
    if (wait) await wait;
    await route.fulfill(response);
  });
  return state;
}
