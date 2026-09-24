import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import type { AccessPolicy, AdminBootstrapResponse, UpstreamGrant } from "../src/ui-types";
import type { AccountCredentialView, GrantPoolReadiness } from "../../shared/contracts";

for (const action of ["Create account", "Connect with provider"]) {
  test(`early Add ${action} keeps its UUID through first inventory admission`, async ({ page }) => {
    const state = await openAccounts(page, { holdBootstrap: true, authorization: true });
    await page.getByRole("button", { name: "Add account", exact: true }).click();
    const reference = await page.getByLabel("account reference", { exact: true }).inputValue();
    const scope = page.getByRole("combobox", { name: "scope id", exact: true });
    await expect(scope).toHaveValue("");
    await page.getByLabel("fresh API key", { exact: true }).fill("synthetic-early");
    await page.getByLabel("label", { exact: true }).fill("early draft");
    await expect(button(page, action)).toBeDisabled();
    await submit(page); expect(state.writes).toHaveLength(0);
    await state.reads[0].route.fulfill({ json: state.reads[0].body });
    await expect(scope).toHaveValue("team_policy");
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("early draft");
    await expect(page.getByLabel("account reference", { exact: true })).toHaveValue(reference);
    await button(page, action).click();
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0].request().method()).toBe("POST");
    expect(new URL(state.writes[0].request().url()).pathname).toBe(`/v1/admin/upstream-grants/policies/team_policy/${reference}${action === "Connect with provider" ? "/authorize" : ""}`);
    await state.writes[0].fulfill({ status: 400, json: { error: { code: "invalid_upstream_grant", message: "synthetic rejection" } } });
  });
}

test("inventory-ready cannot enable strict writes while the exact owner read is held", async ({ page }) => {
  const state = await openAccounts(page, { holdOwner: true });
  await expect(button(page, "Save details")).toBeDisabled();
  await expect(page.locator(".inspector")).toContainText("Reading this account");
  await submit(page); expect(state.writes).toHaveLength(0);
  await state.ownerReads[0].route.fulfill({ json: state.ownerReads[0].body });
  await expect(button(page, "Save details")).toBeEnabled();
  await page.getByLabel("label", { exact: true }).fill("metadata only");
  await button(page, "Save details").click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].request().postDataJSON()).toEqual({ expectedCredentialGeneration: 1, label: "metadata only" });
  await commit(state, 0, owner(grant("account_a", { label: "metadata only" }), 2));
});

test("Add second account creates a new resource and metadata clears are explicit", async ({ page }) => {
  const state = await openAccounts(page);
  await button(page, "Add account").click();
  const reference = await page.getByLabel("account reference", { exact: true }).inputValue();
  expect(reference).toMatch(/^acct_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await page.getByLabel("fresh API key", { exact: true }).fill("synthetic-second");
  await page.getByLabel("label", { exact: true }).fill("Second account");
  await button(page, "Create account").click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].request().method()).toBe("POST");
  await commit(state, 0, owner(grant(reference, { label: "Second account", kind: "api_key", hasCredential: true, hasAccessToken: false, hasRefreshToken: false })));
  await expect(page.locator(".tableRow").filter({ hasText: "Account A" })).toBeVisible();
  await expect(page.locator(".tableRow").filter({ hasText: "Second account" })).toBeVisible();
  await expect(page.getByLabel("fresh API key", { exact: true })).toHaveCount(0);
  await page.getByLabel("label", { exact: true }).fill("");
  await button(page, "Save details").click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].request().postDataJSON()).toEqual({ expectedCredentialGeneration: 1, label: null });
  await commit(state, 1, owner(grant(reference, { label: null, kind: "api_key", hasCredential: true }), 2));
});

for (const action of ["Save details", "Revoke", "Refresh token", "Refresh quota"] as const) {
  test(`${action} shows canonical facts before held/failed metadata and preserves the next draft`, async ({ page }) => {
    const state = await openAccounts(page); state.holdBootstrap = true;
    await button(page, action).click(); await expect.poll(() => state.writes.length).toBe(1);
    await page.getByLabel("label", { exact: true }).fill("later draft");
    const saved = owner(action === "Revoke" ? revoked() : grant("account_a", { priority: 7 }), 2);
    await commit(state, 0, saved);
    await expect(page.locator('.tableRow.selected [data-label="state"]')).toHaveText(action === "Revoke" ? "revoked" : "usable");
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("later draft");
    await expect(button(page, "Save details")).toBeEnabled();
    await expect.poll(() => state.reads.length).toBe(1);
    await state.reads[0].route.fulfill({ status: 503, json: { error: { message: "reporting offline" } } });
    await expect(page.locator(".statusBar")).toContainText("Console data refresh failed");
    await expect(page.getByLabel("pool priority", { exact: true })).toHaveValue(String(saved.priority));
    await expect(button(page, "Save details")).toBeEnabled();
    expect(state.writes).toHaveLength(1);
  });
}

test("whole replacement starts empty, preserves pause and never carries previous account material", async ({ page }) => {
  const state = await openAccounts(page, { grants: [grant("account_a", { enabled: false, accountId: "old-account", expiresAt: "2030-01-01T00:00:00Z" })] });
  await button(page, "Prepare credential replacement").click();
  await expect(page.getByLabel("fresh access token", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("new refresh token (optional)", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("account id", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("expires at", { exact: true })).toHaveValue("");
  await button(page, "Replace credentials").click();
  await expect(page.getByRole("alert")).toContainText("fresh primary credential");
  expect(state.writes).toHaveLength(0);
  await page.getByLabel("fresh access token", { exact: true }).fill("synthetic-new");
  await button(page, "Replace credentials").click();
  await expect.poll(() => state.writes.length).toBe(1);
  const sent = state.writes[0].request().postDataJSON();
  expect(new URL(state.writes[0].request().url()).pathname).toMatch(/\/account_a\/replace$/);
  expect(sent).toMatchObject({ expectedCredentialGeneration: 1, accessToken: "synthetic-new", enabled: false, accountId: null, expiresAt: null });
  for (const field of ["refreshToken", "scopes", "subscription", "refresh"]) expect(sent[field]).toBeUndefined();
  await page.getByLabel("fresh access token", { exact: true }).fill("synthetic-next");
  await commit(state, 0, owner(grant("account_a", { enabled: false, hasRefreshToken: false }), 2));
  await expect(page.getByLabel("fresh access token", { exact: true })).toHaveValue("synthetic-next");
  await expect(button(page, "Replace credentials")).toBeVisible();
  await expect(page.locator('.tableRow.selected [data-label="state"]')).toHaveText("paused");
});

test("explicit refresh-token clear uses PATCH null and retains unedited metadata", async ({ page }) => {
  const state = await openAccounts(page);
  await page.getByRole("combobox", { name: "stored refresh token", exact: true }).selectOption("clear");
  await button(page, "Save details").click(); await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].request().postDataJSON()).toEqual({ expectedCredentialGeneration: 1, refreshToken: null });
  await commit(state, 0, owner(grant("account_a", { hasRefreshToken: false }), 2));
  await expect(button(page, "Refresh token")).toHaveCount(0);
});

test("409 preserves old CAS until exact GET and explicit review", async ({ page }) => {
  const state = await openAccounts(page);
  await page.getByLabel("label", { exact: true }).fill("unsaved");
  await button(page, "Save details").click(); await expect.poll(() => state.writes.length).toBe(1);
  const current = owner(grant("account_a", { label: "external" }), 9);
  state.owners.set(current.key, current);
  await state.writes[0].fulfill({ status: 409, json: { error: { code: "grant_generation_changed", message: "account changed", detail: { grant: current } } } });
  await expect(button(page, "Save details")).toBeDisabled();
  await expect(button(page, "Keep edits and use current version")).toHaveCount(0);
  await button(page, "Check account status").click();
  await expect(button(page, "Keep edits and use current version")).toBeVisible();
  await expect(page.getByLabel("label", { exact: true })).toHaveValue("unsaved");
  await submit(page); expect(state.writes).toHaveLength(1);
  await button(page, "Keep edits and use current version").click();
  await button(page, "Save details").click(); await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].request().postDataJSON()).toEqual({ expectedCredentialGeneration: 9, label: "unsaved" });
  await commit(state, 1, owner(grant("account_a", { label: "unsaved" }), 10));
});

test("lost create ACK retains UUID and secrets; checking it requires deliberate adoption", async ({ page }) => {
  const state = await openAccounts(page); state.holdBootstrap = true;
  await button(page, "Add account").click();
  const ref = await page.getByLabel("account reference", { exact: true }).inputValue();
  await page.getByLabel("fresh API key", { exact: true }).fill("synthetic-create");
  await page.getByLabel("label", { exact: true }).fill("new account");
  await button(page, "Create account").click(); await expect.poll(() => state.writes.length).toBe(1);
  const committed = owner(grant(ref, { kind: "api_key", label: "new account", hasCredential: true, hasAccessToken: false, hasRefreshToken: false }));
  state.owners.set(committed.key, committed);
  await state.writes[0].abort("failed");
  await expect(page.locator(".inspector")).toContainText("could not be confirmed");
  await expect(page.getByLabel("account reference", { exact: true })).toHaveValue(ref);
  await button(page, "Check account status").click();
  await expect(button(page, "Keep edits and use current version")).toBeVisible();
  await expect(page.getByLabel("fresh API key", { exact: true })).toHaveValue("synthetic-create");
  await expect(button(page, "Create account")).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  await button(page, "Use saved values (discard draft)").click();
  await expect(page.getByLabel("fresh API key", { exact: true })).toHaveCount(0);
  await expect(button(page, "Save details")).toBeEnabled();
  expect(state.writes).toHaveLength(1);
});

test("pending receipt survives stale/absent inventory; only existing repair and GET finalize its display", async ({ page }) => {
  const state = await openAccounts(page); state.holdBootstrap = true;
  await button(page, "Save details").click(); await expect.poll(() => state.writes.length).toBe(1);
  const pending = owner(grant("account_a", { label: "saved pending" }), 2, "pending");
  await commit(state, 0, pending, 202);
  await expect(page.locator(".inspector")).toContainText("Account publication pending.");
  await expect.poll(() => state.reads.length).toBe(1);
  state.reads[0].body.grants = [];
  await state.reads[0].route.fulfill({ json: state.reads[0].body });
  await expect(page.locator(".tableRow").filter({ hasText: "saved pending" })).toBeVisible();
  await button(page, "Check account status").click();
  await expect(page.locator(".inspector")).toContainText("Account publication pending.");
  expect(state.repairs).toHaveLength(0);
  await page.getByRole("region", { name: "account routing recovery" }).getByRole("button", { name: "Repair account publication" }).click();
  await expect.poll(() => state.repairs.length).toBe(1);
  expect(state.repairs[0]).toEqual({ cursor: null });
  await expect(page.locator(".inspector")).toContainText("Account publication pending.");
  await button(page, "Check account status").click();
  await expect(page.locator(".inspector")).not.toContainText("Account publication pending.");
  expect(state.writes).toHaveLength(1);
});

for (const code of ["grant_credential_missing", "grant_owner_initialization_required"]) {
  test(`legacy ${code} offers explicit fresh replacement, never automatic fallback`, async ({ page }) => {
    const state = await openAccounts(page, { ownerError: code });
    await expect(page.locator(".inspector")).toContainText("No automatic fallback");
    await expect(button(page, "Save details")).toBeDisabled();
    expect(state.writes).toHaveLength(0);
    await button(page, "Prepare legacy replacement").click();
    await page.getByLabel("fresh access token", { exact: true }).fill("synthetic-recovery");
    await button(page, "Replace legacy account").click(); await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0].request().method()).toBe("PUT");
    expect(new URL(state.writes[0].request().url()).search).toBe("?mode=replace");
    expect(state.writes[0].request().postDataJSON().expectedCredentialGeneration).toBeUndefined();
    state.ownerError = null;
    await commit(state, 0, owner(grant(), 2));
    await expect(button(page, "Save details")).toBeEnabled();
  });
}

test("legacy revoke failure does not turn later tombstone GET into an acknowledged success", async ({ page }) => {
  const state = await openAccounts(page);
  await button(page, "Revoke").click(); await expect.poll(() => state.writes.length).toBe(1);
  state.owners.set(grant().key, owner(revoked(), 2, "pending"));
  await state.writes[0].fulfill({ status: 503, json: { error: { code: "grant_publication_failed", message: "publication unavailable" } } });
  await button(page, "Check account status").click();
  await expect(page.locator('.tableRow.selected [data-label="state"]')).toHaveText("revoked");
  await expect(page.locator(".inspector")).toContainText("last write has no confirmed receipt");
  await expect(button(page, "Save details")).toBeDisabled();
  expect(state.writes).toHaveLength(1);
});

for (const destination of ["away and back", "new"] as const) {
  test(`late receipt cannot steal a ${destination} draft or its owner read`, async ({ page }) => {
    const state = await openAccounts(page); state.holdBootstrap = true;
    await button(page, "Save details").click(); await expect.poll(() => state.writes.length).toBe(1);
    if (destination === "new") await button(page, "Add account").click();
    else { await page.locator(".tableRow").filter({ hasText: "Account B" }).click(); await page.locator(".tableRow").filter({ hasText: "Account A" }).click(); }
    await page.getByLabel("label", { exact: true }).fill("later editor");
    await commit(state, 0, owner(grant("account_a", { label: "saved row" }), 2));
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("later editor");
    await expect(page.locator(".tableRow").filter({ hasText: "saved row" })).toBeVisible();
    if (destination === "new") await expect(button(page, "Create account")).toBeVisible();
  });
}

test("Save then keyboard Revoke holds admission independently of stale metadata", async ({ page }) => {
  const state = await openAccounts(page); state.holdBootstrap = true;
  await submit(page); await submit(page); await expect.poll(() => state.writes.length).toBe(1);
  await commit(state, 0, owner(grant(), 2));
  await expect(button(page, "Save details")).toBeEnabled(); await expect.poll(() => state.reads.length).toBe(1);
  await button(page, "Revoke").focus(); await page.keyboard.press("Enter");
  await expect.poll(() => state.writes.length).toBe(2);
  await state.reads[0].route.fulfill({ json: state.reads[0].body });
  await expect(button(page, "Save details")).toBeDisabled();
  await commit(state, 1, owner(revoked(), 3));
  await expect(button(page, "Revoke")).toBeDisabled();
  await expect(page.locator('.tableRow.selected [data-label="state"]')).toHaveText("revoked");
});

test("a pre-mutation bootstrap and its follow-up cannot erase a receipt or a later edit-back", async ({ page }) => {
  const state = await openAccounts(page); state.holdBootstrap = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.reads.length).toBe(1);
  await page.getByLabel("label", { exact: true }).fill("submitted");
  await button(page, "Save details").click(); await expect.poll(() => state.writes.length).toBe(1);
  await page.getByLabel("label", { exact: true }).fill("Account A");
  await commit(state, 0, owner(grant("account_a", { label: "submitted", priority: 7 }), 2));
  await expect(page.getByLabel("pool priority", { exact: true })).toHaveValue("7");
  await state.reads[0].route.fulfill({ json: state.reads[0].body });
  await expect.poll(() => state.reads.length).toBe(2);
  await state.reads[1].route.fulfill({ json: state.reads[1].body });
  await flush(page);
  await expect(page.getByLabel("label", { exact: true })).toHaveValue("Account A");
  await expect(page.getByLabel("pool priority", { exact: true })).toHaveValue("7");
  await expect(page.locator(".tableRow").filter({ hasText: "submitted" })).toBeVisible();
});

test("OAuth admission blocks writes, and failure releases only its own operation", async ({ page }) => {
  const state = await openAccounts(page, { authorization: true });
  await button(page, "Reconnect with provider").click(); await expect.poll(() => state.writes.length).toBe(1);
  for (const name of ["Save details", "Revoke", "Refresh token", "Refresh quota"]) await expect(button(page, name)).toBeDisabled();
  await submit(page); expect(state.writes).toHaveLength(1);
  await state.writes[0].fulfill({ status: 503, json: { error: { message: "authorization unavailable" } } });
  await expect(page.locator(".inspector")).toContainText("authorization unavailable");
  await expect(button(page, "Save details")).toBeEnabled();
});

test("same-role identity replacement retires pending account secrets, reads and response", async ({ page }) => {
  const state = await openAccounts(page);
  await button(page, "Prepare credential replacement").click();
  await page.getByLabel("fresh access token", { exact: true }).fill("synthetic-old");
  // Focus refresh is intentionally suppressed during a write. Admit this
  // session read first, then let its changed identity retire the held write.
  state.holdSession = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.sessionReads.length).toBe(1);
  await button(page, "Replace credentials").click(); await expect.poll(() => state.writes.length).toBe(1);
  state.holdSession = false; state.email = "second@example.com";
  await state.sessionReads[0].fulfill({ json: sessionResponse(state.email) });
  await expect(page.locator(".tenantSwitch strong")).toHaveText("second@example.com");
  await expect(page.getByLabel("fresh access token", { exact: true })).toHaveCount(0);
  await state.writes[0].fulfill({ json: { outcome: "committed", grant: owner(grant("account_a", { label: "retired identity response" }), 2) } });
  await flush(page);
  await expect(page.locator("body")).not.toContainText("retired identity response");
  await expect(page.locator("body")).not.toContainText("synthetic-old");
});

test("an old owner GET authentication failure cannot clear a new identity's replacement draft", async ({ page }) => {
  const state = await openAccounts(page, { holdOwner: true });
  state.holdOwner = false; state.email = "second@example.com";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator(".tenantSwitch strong")).toHaveText("second@example.com");
  await button(page, "Prepare credential replacement").click();
  await page.getByLabel("fresh access token", { exact: true }).fill("synthetic-second-draft");
  await state.ownerReads[0].route.fulfill({ status: 401, json: { error: { code: "admin_unauthorized", message: "old session expired" } } });
  await flush(page);
  await expect(page.locator(".tenantSwitch strong")).toHaveText("second@example.com");
  await expect(page.getByLabel("fresh access token", { exact: true })).toHaveValue("synthetic-second-draft");
  expect(state.writes).toHaveLength(0);
});

for (const action of ["Refresh token", "Refresh quota", "Revoke"]) for (const outcome of ["conflict", "lost reply"]) {
  test(action + " preserves unresolved " + outcome + " metadata until explicit version review", async ({ page }) => {
    const state = await openAccounts(page);
    await button(page, "Prepare credential replacement").click();
    await page.getByLabel("fresh access token", { exact: true }).fill("synthetic-original-intent");
    await page.getByLabel("label", { exact: true }).fill("unresolved label");
    await page.getByText("Advanced account settings", { exact: true }).click();
    await page.getByLabel("routing weight", { exact: true }).fill("9");
    await assertGeometry(page, page.locator(".inspector"));
    await button(page, "Replace credentials").click();
    await expect.poll(() => state.writes.length).toBe(1);
    if (outcome === "conflict") await state.writes[0].fulfill({ status: 409, json: { error: { code: "grant_generation_changed", message: "changed", detail: { grant: owner(grant(), 2) } } } });
    else await state.writes[0].abort("failed");
    await expect(page.getByRole("region", { name: "account change review" })).toBeVisible();
    await button(page, action).click();
    await expect.poll(() => state.writes.length).toBe(2);
    await commit(state, 1, owner(action === "Revoke" ? revoked() : grant(), 3));
    await expect(button(page, "Keep edits and use current version")).toBeEnabled();
    await expect(button(page, "Replace credentials")).toBeDisabled();
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("unresolved label");
    await expect(page.getByLabel("routing weight", { exact: true })).toHaveValue("9");
    await expect(page.getByLabel("fresh access token", { exact: true })).toHaveValue(action === "Revoke" ? "" : "synthetic-original-intent");
    // The current owner facts are visible, but neither direct submit nor Pause
    // may skip the earlier edit's explicit version decision.
    await submit(page); expect(state.writes).toHaveLength(2);
    await expect(button(page, action === "Revoke" ? "Resume account" : "Pause account")).toBeDisabled();
    await assertGeometry(page, page.locator(".inspector"));
    const adopt = button(page, "Keep edits and use current version");
    await adopt.focus(); await page.keyboard.press("Enter");
    await expect(adopt).toHaveCount(0);
    if (action === "Revoke") await page.getByLabel("fresh access token", { exact: true }).fill("synthetic-after-revoke");
    await button(page, "Replace credentials").click();
    await expect.poll(() => state.writes.length).toBe(3);
    expect(state.writes[2].request().postDataJSON()).toMatchObject({ expectedCredentialGeneration: 3, label: "unresolved label", weight: 9 });
    await state.writes[2].fulfill({ status: 400, json: { error: { code: "invalid_upstream_grant", message: "synthetic stop" } } });
  });
}

for (const destination of ["other account", "new draft"]) for (const reply of ["lost", "committed"]) {
  test("Create A then " + destination + " preserves both identities after " + reply + " response", async ({ page }) => {
    const state = await openAccounts(page);
    state.holdBootstrap = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => state.reads.length).toBe(1);
    await button(page, "Add account").click();
    const ref = await page.getByLabel("account reference", { exact: true }).inputValue();
    await page.getByLabel("fresh API key", { exact: true }).fill("synthetic-request-a");
    await page.getByLabel("label", { exact: true }).fill("Requested A");
    await button(page, "Create account").click();
    await expect.poll(() => state.writes.length).toBe(1);
    const card = page.getByRole("region", { name: "Creation recovery " + ref, exact: true });
    await expect(card).toContainText("creation in progress");
    if (destination === "other account") await page.locator(".tableRow").filter({ hasText: "Account B" }).click();
    else await button(page, "Add account").click();
    await page.getByLabel("label", { exact: true }).fill("newer draft");
    const nextRef = await page.getByLabel("account reference", { exact: true }).inputValue();
    if (destination === "new draft") await page.getByLabel("fresh API key", { exact: true }).fill("synthetic-next-draft");
    const saved = owner(grant(ref, { kind: "api_key", label: "Requested A", hasCredential: true, hasAccessToken: false, hasRefreshToken: false }), 2, "pending");
    state.owners.set(saved.key, saved);
    if (reply === "lost") await state.writes[0].abort("failed");
    else await commit(state, 0, saved, 202);
    await expect.poll(() => state.reads.length).toBe(1);
    state.reads[0].body.grants = [];
    await state.reads[0].route.fulfill({ json: state.reads[0].body });
    await expect(page.getByLabel("account reference", { exact: true })).toHaveValue(nextRef);
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("newer draft");
    if (reply === "committed") {
      await expect(card).toHaveCount(0);
      await expect(page.locator(".tableRow").filter({ hasText: "Requested A" })).toBeVisible();
      return;
    }
    await expect(card).toContainText("creation unconfirmed");
    await assertGeometry(page, card);
    state.holdOwner = true;
    const check = card.getByRole("button", { name: /^(Check this account|Checking account…)$/ });
    await check.focus(); await page.keyboard.press("Enter");
    await assertPendingCheck(page, check, state, 1);
    expect(new URL(state.ownerReads[0].route.request().url()).pathname).toBe("/v1/admin/upstream-grants/policies/team_policy/" + ref);
    await state.ownerReads[0].route.fulfill({ json: state.ownerReads[0].body });
    state.holdOwner = false;
    await expect(check).toBeFocused();
    await expect(card).toContainText("publication pending");
    await expect(card).toContainText("creation unconfirmed");
    await expect(page.getByLabel("account reference", { exact: true })).toHaveValue(nextRef);
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("newer draft");
    if (destination === "new draft") await expect(page.getByLabel("fresh API key", { exact: true })).toHaveValue("synthetic-next-draft");
    expect(state.writes).toHaveLength(1);
    state.holdOwner = true;
    await page.keyboard.press("Enter");
    await expect.poll(() => state.ownerReads.length).toBe(2);
    const movedFocus = await tabAway(page, check);
    await state.ownerReads[1].route.fulfill({ json: state.ownerReads[1].body });
    state.holdOwner = false;
    await expect(check).toHaveText("Check this account");
    await expect.poll(() => movedFocus.evaluate(element => document.activeElement === element)).toBe(true);
    await movedFocus.dispose();
    await card.getByRole("button", { name: "Review this account", exact: true }).click();
    await expect(page.getByLabel("account reference", { exact: true })).toHaveValue(ref);
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("Requested A");
    await expect(button(page, "Save details")).toBeDisabled();
    await assertGeometry(page, page.locator(".inspector"));
    // Ordinary table selection must preserve the request marker too.
    await page.locator(".tableRow").filter({ hasText: "Account B" }).click();
    await page.locator(".tableRow").filter({ hasText: "Requested A" }).click();
    await expect(button(page, "Save details")).toBeDisabled();
    await expect(page.getByRole("region", { name: "account change review" })).toBeVisible();
    const discard = button(page, "Use saved values (discard draft)");
    await discard.focus(); await page.keyboard.press("Enter");
    await expect(card).toHaveCount(0);
    await expect(button(page, "Save details")).toBeEnabled();
    await expect(page.getByLabel("fresh API key", { exact: true })).toHaveCount(0);
    expect(state.writes).toHaveLength(1);
  });
}

test("repeated uncertain creates retain separate recovery cards and Check errors stay off the active draft", async ({ page }, testInfo) => {
  if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 720 });
  const state = await openAccounts(page), refs: string[] = [];
  for (let index = 0; index < 2; index++) {
    await button(page, "Add account").click();
    refs.push(await page.getByLabel("account reference", { exact: true }).inputValue());
    await page.getByLabel("fresh API key", { exact: true }).fill("synthetic-create-" + index);
    await button(page, "Create account").click();
    await expect.poll(() => state.writes.length).toBe(index + 1);
    await button(page, "Add account").click();
    await state.writes[index].abort("failed");
    await expect(page.getByRole("region", { name: "Creation recovery " + refs[index], exact: true })).toContainText("creation unconfirmed");
  }
  expect(refs[0]).not.toBe(refs[1]);
  await page.getByLabel("fresh API key", { exact: true }).fill("synthetic-active-draft");
  await page.getByLabel("label", { exact: true }).fill("active draft");
  await page.getByText("Advanced account settings", { exact: true }).click();
  await page.getByLabel("pool priority", { exact: true }).fill("-1");
  await button(page, "Create account").click();
  const draftError = page.locator(".inspector").getByRole("alert");
  await expect(draftError).toContainText("priority must");
  for (const ref of refs) {
    const card = page.getByRole("region", { name: "Creation recovery " + ref, exact: true });
    const check = card.getByRole("button", { name: /^(Check this account|Checking account…)$/ });
    state.holdOwner = true;
    const beforeReads = state.ownerReads.length;
    await check.focus(); await page.keyboard.press("Enter");
    await assertPendingCheck(page, check, state, beforeReads + 1);
    await state.ownerReads[beforeReads].route.fulfill({ status: 404, json: { error: { code: "grant_credential_missing", message: "owner not initialized" } } });
    await expect(card.getByRole("alert")).toContainText("Account status could not be read");
    await expect(check).toBeFocused();
    await expect(draftError).toContainText("priority must");
    await expect(page.getByLabel("fresh API key", { exact: true })).toHaveValue("synthetic-active-draft");
    await expect(page.getByLabel("label", { exact: true })).toHaveValue("active draft");
    await assertGeometry(page, card);
    await check.focus(); await page.keyboard.press("Enter");
    await expect.poll(() => state.ownerReads.length).toBe(beforeReads + 2);
    const movedFocus = await tabAway(page, check);
    await state.ownerReads[beforeReads + 1].route.fulfill({ status: 404, json: { error: { code: "grant_credential_missing", message: "owner not initialized" } } });
    await expect(card.getByRole("alert")).toContainText("Account status could not be read");
    await expect.poll(() => movedFocus.evaluate(element => document.activeElement === element)).toBe(true);
    await movedFocus.dispose();
  }
  expect(state.writes).toHaveLength(2);
});

async function assertPendingCheck(page: Page, check: Locator, state: State, count: number) {
  await expect.poll(() => state.ownerReads.length).toBe(count);
  await expect(check).toHaveText("Checking account…");
  await expect(check).toBeFocused();
  await expect(check).toHaveAttribute("aria-disabled", "true");
  await expect(check).toHaveJSProperty("disabled", false);
  await expect(check).toHaveCSS("outline-style", "solid");
  await expect(check).toHaveCSS("cursor", "not-allowed");
  await page.keyboard.press("Enter"); await page.keyboard.press("Space");
  await flush(page);
  expect(state.ownerReads).toHaveLength(count);
}

async function tabAway(page: Page, check: Locator) {
  await page.keyboard.press("Tab");
  await expect(check).not.toBeFocused();
  const target = await page.evaluateHandle(() => document.activeElement);
  expect(await target.evaluate(element => element !== document.body)).toBe(true);
  return target;
}

async function assertGeometry(page: Page, panel: Locator) {
  await expect(panel).toBeVisible();
  const controls = panel.locator("button");
  const geometry = await panel.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const bounds = (target: Element) => {
      const { left, right, top, bottom } = target.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    const buttons = [...element.querySelectorAll("button")].filter(button => button.getClientRects().length > 0).map(button => ({ label: button.textContent, ...bounds(button) }));
    const alerts = [...element.querySelectorAll<HTMLElement>(".inlineError")].map(alert => {
      const message = alert.querySelector<HTMLElement>("span")!;
      return { ...bounds(alert), message: { ...bounds(message), scrollWidth: message.scrollWidth, clientWidth: message.clientWidth } };
    });
    const overlap = buttons.some((a, i) => buttons.slice(i + 1).some(b => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)));
    return { checks: { pageFits: document.documentElement.scrollWidth <= window.innerWidth, panelFits: rect.left >= 0 && rect.right <= window.innerWidth,
      controlsFit: buttons.every(button => button.left >= rect.left && button.right <= rect.right), overlap,
      alertsFit: alerts.every(alert => alert.left >= rect.left && alert.right <= rect.right),
      errorTextFits: alerts.every(alert => alert.message.left >= alert.left && alert.message.right <= alert.right && alert.message.scrollWidth <= alert.message.clientWidth) },
      bounds: { panel: bounds(element), buttons, alerts } };
  });
  expect(geometry.checks, JSON.stringify(geometry.bounds)).toEqual({ pageFits: true, panelFits: true, controlsFit: true, overlap: false, alertsFit: true, errorTextFits: true });
  for (const control of await controls.all()) {
    if (!await control.isVisible() || !await control.isEnabled()) continue;
    await control.scrollIntoViewIfNeeded();
    await control.focus();
    await expect(control).toBeFocused();
  }
}

function button(page: Page, name: string) { return page.getByRole("button", { name, exact: true }); }
async function submit(page: Page) { await page.locator(".inspector form").evaluate((form: HTMLFormElement) => form.requestSubmit()); }
async function flush(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
function grant(tokenRef = "account_a", values: Partial<UpstreamGrant> = {}): UpstreamGrant {
  return { key: `oauth/team_policy/${tokenRef}`, scope: "policies", scopeId: "team_policy", tokenRef, kind: "subscription", provider: "test-provider", label: tokenRef === "account_b" ? "Account B" : "Account A", version: 1, tokenType: "Bearer", scopes: [], enabled: true, priority: 100, weight: 1, hasCredential: false, credentialFields: [], hasAccessToken: true, hasRefreshToken: true, refreshConfigured: true, usable: true, selectedCount: 0, quotaStatus: "unknown", quotaWindows: [], revokedAt: null, ...values };
}
function revoked() { return grant("account_a", { enabled: false, usable: false, hasAccessToken: false, hasRefreshToken: false, revokedAt: "2026-09-01T00:00:00Z" }); }
function sessionResponse(email: string) { return { authenticated: true, auth: "cloudflare_access", role: "admin", email, tenantId: "default", entitlements: { providers: [] } }; }
function owner(row: UpstreamGrant, credentialGeneration = 1, publication: AccountCredentialView["publication"] = "ready"): AccountCredentialView {
  const { selectedCount: _selected, lastSelectedAt: _last, quotaStatus: _status, quotaObservedAt: _observed, cooldownUntil: _cooldown, quotaSource: _source, lastProviderSignal: _signal, quotaWindows: _windows, ...safe } = row;
  return { ...safe, credentialGeneration, publication, refreshTokenUrl: null, clientIdConfig: null, clientSecretConfig: null };
}
type State = Awaited<ReturnType<typeof openAccounts>>;
async function commit(state: State, index: number, saved: AccountCredentialView, status = 200) {
  state.owners.set(saved.key, saved);
  const route = state.writes[index], method = route.request().method(), path = new URL(route.request().url()).pathname;
  const strict = method === "PATCH" || method === "POST" && !/\/(revoke|refresh|quota-refresh|authorize)$/.test(path);
  await route.fulfill({ status, json: strict ? { outcome: "committed", grant: saved } : { ...grant(saved.tokenRef), ...saved } });
}

async function openAccounts(page: Page, options: { holdBootstrap?: boolean; holdOwner?: boolean; ownerError?: string; authorization?: boolean; grants?: UpstreamGrant[] } = {}) {
  const grants = options.grants ?? [grant(), grant("account_b")];
  const state = { writes: [] as Route[], reads: [] as { route: Route; body: AdminBootstrapResponse }[], ownerReads: [] as { route: Route; body: AccountCredentialView | undefined }[], sessionReads: [] as Route[], holdSession: false,
    owners: new Map(grants.map(row => [row.key, owner(row)])), repairs: [] as unknown[], grants, holdBootstrap: options.holdBootstrap ?? false, holdOwner: options.holdOwner ?? false, ownerError: options.ownerError ?? null as string | null, email: "admin@example.com" };
  const policy: AccessPolicy = { policyId: "team_policy", enabled: true, providers: [], tenantId: "default", retainRequestContent: false, grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} } };
  const readiness: GrantPoolReadiness = { revision: 1, baseline: "existing", acceptedAt: "2026-09-23T00:00:00Z", phase: "complete", cursor: null, scanRevision: 1, scanned: grants.length, issues: [], overflow: false, activatedAt: "2026-09-23T00:00:00Z" };
  const bootstrap: AdminBootstrapResponse = { policies: [policy], grants, credentials: [], connections: [], users: [], bindings: [], rules: [], providers: [], tenants: [],
    overview: { policiesTotal: 1, policiesActive: 1, tenantsTotal: 1, keysTotal: 0, keysActive: 0, providerCount: 1, openaiCompatibleProviders: 0, manifestRoutes: 0, monthlyBudgetMicros: 0, requestCostMicros: 0 },
    fusion: { version: 1, modelId: "clawrouter/fusion", enabled: false, adviserModels: [], aggregatorModel: "", adviserTimeoutMs: 10_000, maxOutputTokens: 100, maxInputChars: 1000, maxProposalChars: 1000, temperature: 0.7 } };
  await page.route("**/v1/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (path === "/v1/admin/grant-pools/repair") {
      expect(method).toBe("POST"); state.repairs.push(route.request().postDataJSON());
      for (const [key, row] of state.owners) state.owners.set(key, { ...row, publication: "ready" });
      return route.fulfill({ json: { readiness, outcomes: [], cursor: null } });
    }
    if (method !== "GET") {
      expect(path).toMatch(/^\/v1\/admin\/upstream-grants\/(policies|tenants)\/[^/]+\/[^/]+(?:\/(replace|revoke|refresh|quota-refresh|authorize))?$/);
      state.writes.push(route); return;
    }
    if (path.startsWith("/v1/admin/upstream-grants/")) {
      const body = structuredClone([...state.owners.values()].find(row => path === `/v1/admin/upstream-grants/${row.scope}/${encodeURIComponent(row.scopeId)}/${encodeURIComponent(row.tokenRef)}`));
      if (state.holdOwner) { state.ownerReads.push({ route, body }); return; }
      if (state.ownerError || !body) return route.fulfill({ status: state.ownerError === "grant_owner_initialization_required" ? 409 : 404, json: { error: { code: state.ownerError ?? "grant_credential_missing", message: "owner not initialized" } } });
      return route.fulfill({ json: body });
    }
    if (path === "/v1/admin/bootstrap" && state.holdBootstrap) { state.reads.push({ route, body: structuredClone(bootstrap) }); return; }
    if (path === "/v1/session" && state.holdSession) { state.sessionReads.push(route); return; }
    const responses: Record<string, unknown> = {
      "/v1/providers": { providers: [{ id: "test-provider", display_name: "Test Provider", class: "test", service_kind: "model_provider", capabilities: [], ...(options.authorization ? { auth: { authorization: { grantKind: "subscription" } } } : {}), quota: { probes: [{ grantKinds: ["subscription"], requiresRefreshToken: false }] } }] },
      "/v1/routes": { openaiCompatible: [], manifestProxy: [] },
      "/v1/session": sessionResponse(state.email),
      "/v1/session/usage": { policies: [] }, "/v1/session/credentials": { credentials: [] }, "/v1/admin/bootstrap": bootstrap, "/v1/admin/grant-pools/readiness": readiness,
    };
    await route.fulfill({ status: responses[path] ? 200 : 404, json: responses[path] ?? {} });
  });
  await page.goto("/dashboard/access?resource=upstream");
  if (options.holdBootstrap) await expect.poll(() => state.reads.length).toBe(1);
  else {
    await expect(page.locator(".connectionMeta strong")).toHaveText("Connected");
    if (options.holdOwner) await expect.poll(() => state.ownerReads.length).toBe(1);
    else if (options.ownerError) await expect(page.locator(".inspector")).toContainText("No initialized account owner");
    else await expect(button(page, "Save details")).toBeEnabled();
  }
  return state;
}
