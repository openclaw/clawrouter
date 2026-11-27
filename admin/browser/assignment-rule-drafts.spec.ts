import { expect, test, type Page, type Route } from "@playwright/test";
import type { AssignmentRule } from "../src/ui-types";

const alpha = "alpha_team", beta = "beta_team";
const subject = (page: Page) => page.getByRole("textbox", { name: "subject", exact: true });
const id = (page: Page) => page.getByRole("textbox", { name: "rule id", exact: true });
const row = (page: Page, ruleId: string) => page.getByRole("button", { name: new RegExp(ruleId) });
const save = (page: Page) => page.getByRole("button", { name: "Save rule", exact: true });
const connected = (page: Page) => expect(page.locator(".connectionMeta strong")).toHaveText("Connected");

function rule(ruleId: string, subject: string, enabled = true): AssignmentRule {
  return { ruleId, version: 1, subject, enabled, kind: "email_domain", groups: [], policyIds: [], priority: 100,
    revokeOnLoss: true, provenance: "cloudflare_access", updatedAt: "2026-11-25T12:00:00Z", generatedGroup: `assignment.${ruleId}` };
}

async function fixture(page: Page) {
  const state = {
    email: "operator@example.test", rules: [rule(alpha, "alpha.example.test"), rule(beta, "beta.example.test", false)],
    holdRead: false, reads: [] as Route[], writes: [] as Route[],
    bootstrap() { return { rules: this.rules, policies: [], bindings: [], users: [], credentials: [], connections: [], grants: [],
      providers: [], tenants: [], overview: null, fusion: { enabled: false, adviserModels: [], aggregatorModel: "" } }; },
  };
  await page.route("**/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") { state.writes.push(route); return; }
    if (path === "/v1/admin/bootstrap" && state.holdRead) { state.reads.push(route); return; }
    const bodies: Record<string, unknown> = {
      "/v1/providers": { providers: [] }, "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": { authenticated: true, auth: "cloudflare_access", role: "admin", email: state.email, entitlements: { providers: [] } },
      "/v1/admin/usage": { policies: [], usage: { ledger: "ready", summary: { requestCount: 0, successCount: 0, errorCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostMicros: 0 }, providers: [], daily: [], events: [] } },
      "/v1/session/credentials": { credentials: [] }, "/v1/session/usage": { policies: [] }, "/v1/admin/bootstrap": state.bootstrap(),
    };
    await route.fulfill({ status: path in bodies ? 200 : 404, json: bodies[path] ?? {} });
  });
  await page.clock.setFixedTime(new Date("2026-11-26T12:00:00Z"));
  await page.goto("/dashboard/access?resource=assignments");
  await connected(page);
  await expect(id(page)).toHaveValue(alpha);
  return state;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function submit(page: Page, state: Fixture, ruleId = alpha) {
  await subject(page).fill("SUBMITTED.example.test");
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  const request = state.writes[0].request();
  expect(request.method()).toBe("PUT");
  expect(new URL(request.url()).pathname).toBe(`/v1/admin/assignment-rules/${ruleId}`);
  expect(request.postDataJSON()).toMatchObject({ subject: "SUBMITTED.example.test" });
}

async function acknowledge(state: Fixture, ruleId = alpha) {
  state.holdRead = true;
  const saved = { ...rule(ruleId, "submitted.example.test"), priority: 75, updatedAt: "2026-11-26T12:00:00Z" };
  await state.writes[0].fulfill({ json: saved });
  await expect.poll(() => state.reads.length).toBe(1);
  return saved;
}

test("saving A keeps B selected and editable through the PUT and foreground refresh", async ({ page }) => {
  const state = await fixture(page);
  await submit(page, state);
  await row(page, beta).click();
  await subject(page).fill("beta-draft.example.test");
  const saved = await acknowledge(state);
  await expect(id(page)).toHaveValue(beta);
  await expect(subject(page)).toHaveValue("beta-draft.example.test");
  await subject(page).fill("beta-later.example.test");
  state.rules = [saved, { ...state.rules[1], priority: 81, provenance: "directory sync" }];
  await state.reads[0].fulfill({ json: state.bootstrap() });
  await connected(page);
  await expect(row(page, alpha)).toContainText("submitted.example.test");
  await expect(row(page, beta)).toContainText("directory sync");
  await expect(row(page, beta)).toHaveClass(/selected/);
  await expect(id(page)).toHaveValue(beta);
  await expect(subject(page)).toHaveValue("beta-later.example.test");
  await expect(page.getByLabel("priority", { exact: true })).toHaveValue("81");
  await expect(page.getByLabel("provenance", { exact: true })).toHaveValue("directory sync");
  await expect(page.getByRole("combobox", { name: "state", exact: true })).toHaveValue("disabled");
  expect(state.writes).toHaveLength(1);
  await save(page).click();
  await expect.poll(() => state.writes.length).toBe(2);
  const second = state.writes[1].request();
  expect(new URL(second.url()).pathname).toBe("/v1/admin/assignment-rules/" + beta);
  expect(second.postDataJSON()).toMatchObject({ subject: "beta-later.example.test", priority: 81, provenance: "directory sync", enabled: false });
  state.holdRead = false;
  state.rules[1] = { ...state.rules[1], subject: "beta-later.example.test" };
  await state.writes[1].fulfill({ json: state.rules[1] });
  await connected(page);
});

for (const path of ["unchanged", "same editor", "reopened A"] as const) {
  test(`canonical A and later edits survive a stale refresh: ${path}`, async ({ page }) => {
    const state = await fixture(page);
    await submit(page, state);
    if (path === "reopened A") { await row(page, beta).click(); await row(page, alpha).click(); }
    if (path !== "unchanged") await subject(page).fill("later.example.test");
    // A synthetic second submit bypasses the disabled button, not the production handler.
    await subject(page).evaluate(input => input.closest("form")!.requestSubmit());
    await acknowledge(state);
    await subject(page).evaluate(input => input.closest("form")!.requestSubmit());
    await state.reads[0].fulfill({ json: state.bootstrap() }); // old reporting snapshot, not an acknowledgement
    await connected(page);
    await expect(row(page, alpha)).toHaveClass(/selected/);
    await expect(row(page, alpha)).toContainText("submitted.example.test");
    await expect(page.getByLabel("priority", { exact: true })).toHaveValue("75");
    await expect(subject(page)).toHaveValue(path === "unchanged" ? "submitted.example.test" : "later.example.test");
    expect(state.writes).toHaveLength(1);
  });
}

test("a rejected PUT and a later refresh retain both submitted and subsequent edits", async ({ page }) => {
  const state = await fixture(page);
  await submit(page, state);
  await page.getByLabel("groups", { exact: true }).fill("later-group");
  await state.writes[0].fulfill({ status: 503, json: { error: { message: "rule save unavailable" } } });
  await expect(page.locator(".inspector .inlineError")).toContainText("rule save unavailable");
  state.holdRead = true;
  await page.clock.setFixedTime(new Date("2026-11-26T12:01:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.reads.length).toBe(1);
  state.rules[0] = { ...state.rules[0], priority: 56 };
  await state.reads[0].fulfill({ json: state.bootstrap() });
  await expect(page.getByLabel("priority", { exact: true })).toHaveValue("56");
  await expect(subject(page)).toHaveValue("SUBMITTED.example.test");
  await expect(page.getByLabel("groups", { exact: true })).toHaveValue("later-group");
  expect(state.writes).toHaveLength(1);
});

for (const draft of ["existing", "new"] as const) {
  test(`failed refresh and retry preserve the ${draft} draft without replay`, async ({ page }) => {
    const state = await fixture(page);
    await submit(page, state);
    await row(page, beta).click();
    await subject(page).fill("unsaved.example.test");
    const saved = await acknowledge(state);
    await state.reads[0].fulfill({ status: 503, body: "reporting unavailable" });
    await expect(page.locator(".statusBar")).toContainText("reporting unavailable");
    await expect(row(page, alpha)).toContainText(saved.subject);
    await expect(subject(page)).toHaveValue("unsaved.example.test");
    if (draft === "new") {
      await page.getByRole("button", { name: "New rule" }).click();
      await id(page).fill("gamma_team"); await subject(page).fill("unsaved.example.test");
    }
    await page.getByRole("button", { name: "Retry refresh" }).click();
    await expect.poll(() => state.reads.length).toBe(2);
    await subject(page).fill("edited-during-retry.test");
    // Even a successful retry can return older reporting data.
    await state.reads[1].fulfill({ json: state.bootstrap() });
    await connected(page);
    await expect(id(page)).toHaveValue(draft === "new" ? "gamma_team" : beta);
    await expect(subject(page)).toHaveValue("edited-during-retry.test");
    await expect(row(page, alpha)).toContainText(saved.subject);
    expect(state.writes).toHaveLength(1);
  });
}

test("a new rule becomes selected on its own acknowledgement", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "New rule" }).click();
  await id(page).fill("gamma_team");
  await submit(page, state, "gamma_team");
  const saved = await acknowledge(state, "gamma_team");
  await state.reads[0].fulfill({ json: state.bootstrap() });
  await connected(page);
  await expect(row(page, saved.ruleId)).toHaveClass(/selected/);
  await expect(id(page)).toHaveAttribute("readonly", "");
  await expect(subject(page)).toHaveValue(saved.subject);
  expect(state.writes).toHaveLength(1);
});

test("editing a pending new rule's ID leaves it a separate editable draft", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "New rule" }).click();
  await id(page).fill("gamma_team");
  await submit(page, state, "gamma_team");
  await id(page).fill("delta_team");
  await subject(page).fill("delta-draft.example.test");
  const saved = await acknowledge(state, "gamma_team");
  await state.reads[0].fulfill({ json: state.bootstrap() });
  await connected(page);
  await expect(row(page, saved.ruleId)).toContainText(saved.subject);
  await expect(page.locator(".tableRow.selected")).toHaveCount(0);
  await expect(id(page)).toHaveValue("delta_team");
  await expect(id(page)).not.toHaveAttribute("readonly", "");
  await expect(subject(page)).toHaveValue("delta-draft.example.test");
  expect(state.writes).toHaveLength(1);
});

test("a delayed PUT does not publish into a replacement identity", async ({ page }) => {
  const state = await fixture(page);
  state.holdRead = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.reads.length).toBe(1);
  await submit(page, state);
  await state.reads[0].fulfill({ status: 401, json: { error: { code: "admin_unauthorized" } } });
  await expect(page.getByRole("button", { name: "Retry access" })).toBeVisible();
  state.email = "second@example.test"; state.holdRead = false;
  state.rules = [rule("other_team", "other.example.test")];
  await page.getByRole("button", { name: "Retry access" }).click();
  await expect(id(page)).toHaveValue("other_team");
  await subject(page).fill("second-draft.example.test");
  const response = page.waitForResponse(r => r.request().method() === "PUT");
  await state.writes[0].fulfill({ json: rule(alpha, "submitted.example.test") });
  await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await connected(page);
  await expect(page.locator(".tenantSwitch strong")).toHaveText(state.email);
  await expect(subject(page)).toHaveValue("second-draft.example.test");
  await expect(row(page, alpha)).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});
