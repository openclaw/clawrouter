import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { extname } from "node:path";
import test from "node:test";
import { errorMessage } from "../src/domain.ts";
import { consoleStatusPresentation } from "../src/status-display.ts";
import * as accounts from "../src/account-credentials.ts";

registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { DashboardRequestError } = await import("../src/dashboard-fetch.ts");

// Actual hook, native Node-only state adapter; browser tests own rendering/events.
const source = stripTypeScriptTypes(await readFile(new URL("../src/hooks/access/use-upstream-admin.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export function useUpstreamAdmin", "function useUpstreamAdmin");
const config = await readFile(new URL("../src/ui-config.ts", import.meta.url), "utf8");
const defaultUpstreamGrant = new Function(`${stripTypeScriptTypes(config.slice(config.indexOf("export const defaultUpstreamGrant"), config.indexOf("export const defaultAssignmentRule"))).replaceAll("export ", "")}; return defaultUpstreamGrant;`)();

for (const providersArrived of [false, true]) for (const initialRows of [[], [grant()]]) {
  test(`first inventory initializes untouched defaults and retains a unique early Add identity: ${providersArrived}/${initialRows.length}`, async () => {
    const f = mount(), available = f.providers;
    f.policies = []; f.selectedPolicyId = ""; if (!providersArrived) f.providers = [];
    const snapshot = f.render().captureHydration();
    f.render().upstream.startNew();
    change(f, { credential: "synthetic-early", label: "early draft", keepWarm: true });
    const id = f.render().upstream.form.tokenRef;
    assert.match(id, /^acct_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    f.providers = available; f.policies = [{ policyId: "team_policy" }];
    hydrate(f, initialRows, snapshot);
    const form = f.render().upstream.form;
    assert.equal(form.scopeId, "team_policy"); assert.equal(form.provider, "test-provider");
    assert.equal(form.tokenRef, id); assert.equal(form.credential, "synthetic-early"); assert.equal(form.keepWarm, true);
    assert.equal(f.render().upstream.selectedKey, "");
    const writing = act(f, "save");
    assert.equal(f.writes[0].path, accounts.accountPath(form));
    assert.equal(f.writes[0].init.method, "POST");
    const saved = view(grant(id, { kind: "api_key", hasCredential: true }));
    respond(f, 0, saved); await writing;
    f.render().upstream.startNew();
    assert.notEqual(f.render().upstream.form.tokenRef, id);
    assert.equal(f.render().upstream.items.find(row => row.tokenRef === id).hasCredential, true);
  });
}

test("rejected reads do not consume defaults; accepted empty inventory does", async () => {
  const f = mount(); f.providers = []; f.policies = []; f.selectedPolicyId = "";
  const snapshot = f.render().captureHydration();
  f.render().upstream.startNew(); change(f, { credential: "synthetic-early" });
  for (const rejected of [null, snapshot + 1]) hydrate(f, [], rejected);
  f.current = false; hydrate(f, [], snapshot); f.current = true;
  assert.equal(f.render().upstream.ready, false);
  f.render().hydrate([], "", [], snapshot);
  const empty = f.render().upstream.form;
  f.providers = providers; f.policies = [{ policyId: "team_policy" }];
  hydrate(f, [grant()]);
  assert.deepEqual(f.render().upstream.form, empty);
  await act(f, "save"); await act(f, "authorize");
  assert.equal(f.writes.length, 0);
  assert.match(f.render().upstream.error, /scope and provider are required/);
});

test("first defaults preserve deliberate identity edits, then never follow reordered inventories", () => {
  for (const edits of [[{ scope: "tenants", scopeId: "tenant_x" }], [{ scope: "tenants", scopeId: "default" }, { scope: "policies", scopeId: "" }], [{ provider: "chosen" }], [{ provider: "other" }, { provider: "test-provider" }]]) {
    const f = mount(); f.policies = []; f.selectedPolicyId = "";
    f.render().upstream.startNew();
    for (const edit of edits) change(f, edit);
    change(f, { label: "draft", credential: "synthetic-primary" });
    const before = f.render().upstream.form, marked = new Set(edits.flatMap(edit => Object.keys(edit)));
    hydrate(f, [grant()]);
    assert.deepEqual(f.render().upstream.form, { ...before, scopeId: before.scope === "policies" && !marked.has("scopeId") ? "team_policy" : before.scopeId, provider: marked.has("provider") ? before.provider : "test-provider" });
    const accepted = f.render().upstream.form;
    f.providers = [{ id: "other" }]; hydrate(f, []);
    assert.deepEqual(f.render().upstream.form, accepted);
  }
});

test("inventory cannot admit strict writes before the selected owner GET", async () => {
  const f = mount(); f.holdReads = true; hydrate(f, [grant()]);
  assert.equal(f.reads.length, 1);
  assert.equal(f.render().upstream.generation, null);
  await act(f, "save"); await act(f, "pause");
  assert.equal(f.writes.length, 0);
  assert.equal(f.render().upstream.busy, true);
  f.reads[0].resolve(view(grant(), 4)); await flush();
  assert.equal(f.render().upstream.generation, 4);
  change(f, { label: "edit" });
  const write = act(f, "save");
  assert.deepEqual(body(f, 0), { label: "edit", expectedCredentialGeneration: 4 });
  respond(f, 0, view(grant("account_a", { label: "edit" }), 5)); await write;
});

for (const destination of ["other", "away-back", "new", "scope"]) {
  test(`late owner GET cannot admit a different editor: ${destination}`, async () => {
    const f = mount(); f.holdReads = true; hydrate(f, [grant(), grant("account_b")]);
    if (destination === "new") f.render().upstream.startNew();
    else if (destination === "scope") f.current = false;
    else { f.render().upstream.edit(accounts.accountFromInventory(grant("account_b"))); if (destination === "away-back") f.render().upstream.edit(accounts.accountFromInventory(grant())); }
    change(f, { label: "new draft" });
    f.reads[0].resolve(view(grant(), 7)); await flush();
    assert.equal(f.render().upstream.generation, null);
    assert.equal(f.render().upstream.form.label, "new draft");
    if (destination === "other" || destination === "away-back") {
      assert.equal(f.reads.length, 2);
      f.reads[1].resolve(view(destination === "other" ? grant("account_b") : grant(), 8)); await flush();
      assert.equal(f.render().upstream.generation, 8);
    }
  });
}

for (const action of ["save", "pause", "revoke", "refresh", "refreshQuota"]) {
  test(`${action} publishes its own contract before metadata and survives missing/stale bootstrap`, async () => {
    const f = await ready(), snapshot = f.render().captureHydration();
    const write = act(f, action);
    assert.equal(f.render().captureHydration(), null);
    await act(f, "save"); assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].init.method, ["save", "pause"].includes(action) ? "PATCH" : "POST");
    const saved = view(action === "revoke" ? tombstone() : grant("account_a", { enabled: action !== "pause", priority: 7 }), 2, "pending");
    respond(f, 0, saved); await write; await flush();
    assert.equal(f.render().upstream.selected.priority, saved.priority);
    assert.equal(f.render().upstream.form.enabled, saved.enabled);
    assert.equal(f.render().upstream.busy, false);
    assert.equal(f.statuses.at(-1).includes("account_a"), false);
    assert.equal(consoleStatusPresentation(f.statuses.at(-1), false).tone, "success");
    hydrate(f, [grant()], snapshot);
    finishMetadata(f); await flush();
    hydrate(f, [grant("account_a", { label: "stale", selectedCount: 19 })]);
    assert.equal(f.render().upstream.selected.priority, saved.priority);
    assert.equal(f.render().upstream.selected.observations.selectedCount, 19);
    hydrate(f, []);
    assert.equal(f.render().upstream.selected.priority, saved.priority);
  });
}

test("pending publication changes at the same generation only through ordered owner reads", async () => {
  const f = await ready(), writing = act(f, "save");
  respond(f, 0, view(grant(), 2, "pending")); await writing; finishMetadata(f); await flush();
  hydrate(f, [grant()]);
  assert.equal(f.render().upstream.selected.publication, "pending");
  f.owners.set(grant().key, view(grant(), 2, "ready"));
  await f.render().upstream.inspect();
  assert.equal(f.render().upstream.selected.publication, "ready");
  assert.equal(f.render().upstream.needsReview, false);
  f.owners.set(grant().key, view(grant(), 2, "pending"));
  await f.render().upstream.inspect();
  assert.equal(f.render().upstream.selected.publication, "pending");
});

test("a newer owner read shows facts but does not advance an unreviewed CAS baseline", async () => {
  const f = await ready(); change(f, { label: "dirty" });
  f.owners.set(grant().key, view(grant("account_a", { label: "external", priority: 7 }), 9));
  await f.render().upstream.inspect();
  assert.equal(f.render().upstream.generation, 1);
  assert.equal(f.render().upstream.selected.credentialGeneration, 9);
  assert.equal(f.render().upstream.form.label, "dirty");
  await act(f, "save"); assert.equal(f.writes.length, 0);
  f.render().upstream.reviewCurrent();
  assert.equal(f.render().upstream.generation, 9);
  const write = act(f, "save");
  assert.deepEqual(body(f, 0), { label: "dirty", expectedCredentialGeneration: 9 });
  respond(f, 0, view(grant(), 10)); await write;
});

test("a second write supersedes metadata; predecessor cleanup cannot release it", async () => {
  const f = await ready(), first = act(f, "save");
  respond(f, 0, view(grant(), 2)); await first;
  const second = act(f, "revoke");
  assert.equal(f.refreshes[0].owns(), false);
  f.refreshes[0].resolve(); await flush();
  assert.equal(f.render().upstream.busy, true);
  assert.equal(f.render().captureHydration(), null);
  await act(f, "save"); assert.equal(f.writes.length, 2);
  respond(f, 1, view(tombstone(), 3)); await second; await flush();
  assert.equal(f.render().upstream.selected.enabled, false);
});

test("a bare receipt publishes before its held owner read, then schedules metadata after that read", async () => {
  const f = await ready(); f.holdReads = true;
  const write = act(f, "revoke"); respond(f, 0, view(tombstone(), 2)); await flush();
  assert.equal(f.render().upstream.selected.revokedAt, tombstone().revokedAt);
  assert.equal(f.render().upstream.generation, null);
  assert.equal(f.refreshes.length, 0);
  assert.equal(f.render().upstream.busy, true);
  f.reads.at(-1).resolve(view(tombstone(), 2)); await write;
  assert.equal(f.render().upstream.generation, 2);
  assert.equal(f.refreshes.length, 1);
  assert.equal(f.refreshes[0].owns(), true);
});

test("a new mutation retires legacy metadata queued behind an older controller read", async () => {
  const f = await ready(); let release;
  f.metadataGate = new Promise(resolve => { release = resolve; });
  const first = act(f, "refresh"); respond(f, 0, view(grant(), 2)); await first;
  assert.equal(f.refreshes.length, 0);
  const next = act(f, "save"); respond(f, 1, view(grant(), 3)); await next;
  release(); await flush();
  assert.equal(f.refreshes.length, 1);
  assert.equal(f.refreshes[0].owns(), true);
  assert.equal(f.render().upstream.generation, 3);
});

test("starting a new draft during a post-receipt read keeps metadata recovery without adopting the read", async () => {
  const f = await ready(); f.holdReads = true;
  const write = act(f, "refresh"); respond(f, 0, view(grant(), 2)); await flush();
  f.render().upstream.startNew(); change(f, { label: "new draft" });
  f.reads.at(-1).resolve(view(grant(), 2)); await write;
  assert.equal(f.render().upstream.generation, null);
  assert.equal(f.render().upstream.selectedKey, "");
  assert.equal(f.render().upstream.form.label, "new draft");
  assert.equal(f.refreshes.length, 1);
  assert.equal(f.refreshes[0].owns(), true);
});

test("captured callbacks share synchronous mutation admission", async () => {
  const f = await ready(), owner = f.render().upstream;
  const first = owner.save(event), duplicate = owner.save(event);
  assert.equal(f.writes.length, 1);
  respond(f, 0, view(grant(), 2)); await Promise.all([first, duplicate]);
  assert.equal(f.refreshes.length, 1);
});

test("full scoped identity and keyword account names do not become outcomes", async () => {
  const policy = grant("invalid_error"), tenant = grant("invalid_error", { key: "oauth/tenants/team_policy/invalid_error", scope: "tenants" });
  const f = await ready(false, [policy, tenant]), write = act(f, "save");
  respond(f, 0, view({ ...policy, priority: 7 }, 2)); await write;
  assert.equal(f.render().upstream.items.find(row => row.key === tenant.key).priority, 100);
  assert.equal(consoleStatusPresentation(f.statuses.at(-1), false).tone, "success");
});

test("metadata keeps primary secrets; explicit replacement starts with fresh material", async () => {
  const f = await ready(); change(f, { label: "", accountId: "", expiresAt: "", removeRefreshToken: true });
  const write = act(f, "save");
  assert.equal(body(f, 0).refreshToken, null);
  assert.equal(body(f, 0).accessToken, undefined);
  respond(f, 0, view(grant("account_a", { label: null, hasRefreshToken: false }), 2)); await write;
  f.render().upstream.startReplace();
  assert.equal(f.render().upstream.form.accessToken, "");
  assert.equal(f.render().upstream.form.refreshToken, "");
  assert.equal(f.render().upstream.form.accountId, "");
  await act(f, "save"); assert.equal(f.writes.length, 1);
  assert.match(f.render().upstream.error, /fresh primary/);
});

test("replacement receipt clears only acknowledged unchanged secrets and preserves edit-back", async () => {
  const f = await ready(); f.render().upstream.startReplace();
  change(f, { label: "submitted", accessToken: "synthetic-submitted", refreshToken: "synthetic-refresh" });
  const write = act(f, "save");
  change(f, { label: "Account A", accessToken: "synthetic-intermediate" });
  change(f, { accessToken: "synthetic-submitted" });
  respond(f, 0, view(grant("account_a", { label: "submitted" }), 2)); await write;
  assert.equal(f.render().upstream.form.label, "Account A");
  assert.equal(f.render().upstream.form.accessToken, "synthetic-submitted");
  assert.equal(f.render().upstream.form.refreshToken, "");
  const next = act(f, "save");
  assert.equal(body(f, 1).accessToken, "synthetic-submitted");
  assert.equal(body(f, 1).label, "Account A");
  respond(f, 1, view(grant(), 3)); await next;
  assert.equal(f.render().upstream.form.accessToken, "");
});

for (const action of ["refresh", "refreshQuota", "pause"]) {
  test(`${action} preserves earlier and later unsaved inputs`, async () => {
    const f = await ready(); f.render().upstream.startReplace();
    change(f, { label: "dirty", accessToken: "synthetic-draft", refreshToken: "synthetic-refresh" });
    const write = act(f, action);
    change(f, { weight: "3", refreshToken: "synthetic-later" });
    respond(f, 0, view(grant("account_a", { enabled: action !== "pause", expiresAt: "2030-01-01T00:00:00Z" }), 2)); await write; await flush();
    assert.equal(f.render().upstream.form.label, "dirty");
    assert.equal(f.render().upstream.form.accessToken, "synthetic-draft");
    assert.equal(f.render().upstream.form.refreshToken, "synthetic-later");
    assert.equal(f.render().upstream.form.weight, "3");
  });
}

for (const later of [false, true]) {
  test(`revoke consumes old secret/state intent and preserves later intent: ${later}`, async () => {
    const f = await ready(); f.render().upstream.startReplace();
    change(f, { label: "dirty", accessToken: "synthetic-old", enabled: false });
    const write = act(f, "revoke");
    if (later) change(f, { enabled: true, accessToken: "synthetic-next" });
    respond(f, 0, view(tombstone(), 2)); await write; await flush();
    assert.equal(f.render().upstream.form.enabled, later);
    assert.equal(f.render().upstream.form.accessToken, later ? "synthetic-next" : "");
    assert.equal(f.render().upstream.form.label, "dirty");
    finishMetadata(f); await flush(); hydrate(f, [grant()]);
    assert.equal(f.render().upstream.selected.enabled, false);
    assert.equal(f.render().upstream.form.enabled, later);
  });
}

for (const destination of ["other", "away-back", "new"]) {
  test(`pending receipt updates its row without stealing ${destination} draft/baseline`, async () => {
    const f = await ready(), write = act(f, "save");
    if (destination === "new") f.render().upstream.startNew();
    else { f.render().upstream.edit(accounts.accountFromInventory(grant("account_b"))); if (destination === "away-back") f.render().upstream.edit(accounts.accountFromInventory(grant())); }
    change(f, { label: "later editor" }); f.holdReads = true;
    const selection = f.render().upstream.selectedKey;
    respond(f, 0, view(grant("account_a", { label: "saved" }), 2)); await flush();
    assert.equal(f.render().upstream.form.label, "later editor");
    assert.equal(f.render().upstream.selectedKey, selection);
    assert.equal(f.render().upstream.generation, null);
    assert.equal(f.render().upstream.items.find(row => row.key === grant().key).label, "saved");
    if (destination !== "new") {
      const pending = f.reads.at(-1);
      pending.resolve([...f.owners.values()].find(row => accounts.accountPath(row) === pending.path));
    }
    await write;
  });
}

test("same Add receipt adopts its resource while preserving later details", async () => {
  const f = await ready(); f.render().upstream.startNew();
  change(f, { credential: "synthetic-new", label: "submitted" });
  const form = f.render().upstream.form, write = act(f, "save");
  change(f, { scopeId: "another", label: "blocked retarget" });
  assert.equal(f.render().upstream.form.scopeId, form.scopeId);
  change(f, { label: "later" });
  respond(f, 0, view(grant(form.tokenRef, { kind: "api_key", hasCredential: true, label: "submitted" }))); await write;
  assert.equal(f.render().upstream.selectedKey, accounts.accountKey(form));
  assert.equal(f.render().upstream.form.credential, "");
  assert.equal(f.render().upstream.form.label, "later");
  const next = act(f, "save");
  assert.deepEqual(body(f, 1), { label: "later", expectedCredentialGeneration: 1 });
  respond(f, 1, view(grant(form.tokenRef, { kind: "api_key", hasCredential: true }), 2)); await next;
});

for (const code of ["grant_generation_changed", "grant_reconnect_required", "grant_generation_exhausted"]) {
  test(`typed conflict ${code} preserves baseline/draft and requires exact GET + deliberate adoption`, async () => {
    const f = await ready(); change(f, { label: "dirty" });
    const write = act(f, "save"), current = view(grant("account_a", { label: "external" }), 8);
    f.writes[0].reject(failure(409, code, { grant: current })); await write;
    assert.equal(f.render().upstream.generation, 1);
    assert.equal(f.render().upstream.canReview, false);
    f.render().upstream.reviewCurrent(); await act(f, "save");
    assert.equal(f.writes.length, 1);
    f.owners.set(grant().key, current); await f.render().upstream.inspect();
    assert.equal(f.render().upstream.generation, 1);
    assert.equal(f.render().upstream.form.label, "dirty");
    f.render().upstream.reviewCurrent();
    assert.equal(f.render().upstream.generation, 8);
    assert.equal(f.render().upstream.form.label, "dirty");
  });
}

test("wrong-identity conflict detail cannot enter the account collection", async () => {
  const f = await ready(), write = act(f, "save");
  f.writes[0].reject(failure(409, "grant_generation_changed", { grant: view(grant("wrong")) })); await write;
  assert.equal(f.render().upstream.items.some(row => row.tokenRef === "wrong"), false);
});

test("changed provider facts require explicit discard instead of applying an old credential draft", async () => {
  const f = await ready(); f.render().upstream.startReplace();
  change(f, { accessToken: "synthetic-old-provider" });
  f.owners.set(grant().key, view(grant("account_a", { provider: "another-provider" }), 2));
  await f.render().upstream.inspect();
  f.render().upstream.reviewCurrent();
  assert.equal(f.render().upstream.generation, 1);
  assert.match(f.render().upstream.error, /provider or credential kind changed/);
  assert.equal(f.render().upstream.form.accessToken, "synthetic-old-provider");
  f.render().upstream.reviewCurrent(true);
  assert.equal(f.render().upstream.form.provider, "another-provider");
  assert.equal(f.render().upstream.form.accessToken, "");
});

test("lost create response keeps known UUID and secrets; pure GET never replays or acknowledges it", async () => {
  const f = await ready(); f.render().upstream.startNew();
  change(f, { credential: "synthetic-new", label: "submitted" });
  const form = f.render().upstream.form, write = act(f, "save");
  f.owners.set(accounts.accountKey(form), view(grant(form.tokenRef, { kind: "api_key", hasCredential: true, label: "submitted" })));
  change(f, { label: "later" }); f.writes[0].reject(new Error("lost reply")); await write;
  assert.equal(f.render().upstream.form.tokenRef, form.tokenRef);
  await f.render().upstream.inspect();
  assert.equal(f.reads.at(-1).path, accounts.accountPath(form));
  assert.equal(f.render().upstream.form.credential, "synthetic-new");
  assert.equal(f.render().upstream.form.label, "later");
  assert.equal(f.render().upstream.generation, null);
  await act(f, "save"); assert.equal(f.writes.length, 1);
  f.render().upstream.reviewCurrent();
  assert.equal(f.render().upstream.mode, "replace");
  assert.equal(f.render().upstream.form.credential, "synthetic-new");
  const replacement = act(f, "save");
  assert.equal(f.writes[1].path, accounts.accountPath(form) + "/replace");
  respond(f, 1, view(grant(form.tokenRef, { kind: "api_key", hasCredential: true }), 2)); await replacement;
});

test("lost replacement response preserves later secrets and edit-back through GET and inventory", async () => {
  const f = await ready(); f.render().upstream.startReplace();
  change(f, { label: "submitted", accessToken: "synthetic-submitted", refreshToken: "synthetic-refresh" });
  const write = act(f, "save"); change(f, { label: "Account A", accessToken: "synthetic-later" });
  f.writes[0].reject(new Error("lost reply")); await write;
  f.owners.set(grant().key, view(grant("account_a", { label: "submitted" }), 2));
  await f.render().upstream.inspect();
  hydrate(f, [grant()]); hydrate(f, []);
  assert.equal(f.render().upstream.form.label, "Account A");
  assert.equal(f.render().upstream.form.accessToken, "synthetic-later");
  assert.equal(f.render().upstream.form.refreshToken, "synthetic-refresh");
  assert.equal(f.render().upstream.uncertain, true);
  f.render().upstream.reviewCurrent(true);
  assert.equal(f.render().upstream.form.accessToken, "");
  assert.equal(f.render().upstream.form.label, "submitted");
});

for (const code of ["grant_credential_missing", "grant_owner_initialization_required"]) {
  test(`legacy ${code} has deliberate fresh-primary PUT or revoke, never fallback`, async () => {
    const f = mount(); f.readError = failure(code === "grant_credential_missing" ? 404 : 409, code);
    hydrate(f, [grant()]); await flush();
    assert.equal(f.render().upstream.inspection, "legacy");
    await act(f, "save"); assert.equal(f.writes.length, 0);
    f.render().upstream.startReplace(true);
    assert.equal(f.render().upstream.form.accessToken, "");
    await act(f, "save"); assert.equal(f.writes.length, 0);
    change(f, { accessToken: "synthetic-recovery" });
    const write = act(f, "save");
    assert.equal(f.writes[0].init.method, "PUT");
    assert.match(f.writes[0].path, /\?mode=replace$/);
    assert.equal(body(f, 0).expectedCredentialGeneration, undefined);
    f.readError = null;
    respond(f, 0, view(grant(), 1)); await write; await flush();
    assert.equal(f.render().upstream.generation, 1);
  });
}

for (const status of [409, 503]) test(`legacy revoke ${status} remains uncertain even when a later GET sees its tombstone`, async () => {
  const f = await ready(), write = act(f, "revoke");
  f.owners.set(grant().key, view(tombstone(), 2, "pending"));
  f.writes[0].reject(failure(status, "grant_attachment_changed")); await write;
  await f.render().upstream.inspect();
  assert.equal(f.render().upstream.selected.revokedAt, tombstone().revokedAt);
  assert.equal(f.render().upstream.uncertain, true);
  assert.equal(f.render().upstream.generation, 1);
  assert.equal(f.writes.length, 1);
});

test("a malformed or mismatched strict receipt is unconfirmed, never another account", async () => {
  for (const response of [grant(), { outcome: "committed", grant: view(grant("wrong")) }]) {
    const f = await ready(), write = act(f, "save");
    f.writes[0].resolve(response); await write;
    assert.match(f.render().upstream.error, /could not be confirmed/);
    assert.equal(f.render().upstream.items.some(row => row.tokenRef === "wrong"), false);
  }
});

for (const outcome of ["success", "failure"]) {
  test(`retired auth scope suppresses late write ${outcome}, status and metadata`, async () => {
    const f = await ready(), before = f.render().upstream.items, write = act(f, "save"), statuses = f.statuses.length;
    f.current = false;
    if (outcome === "success") respond(f, 0, view(grant("account_a", { label: "old identity" }), 2));
    else f.writes[0].reject(new Error("old failure"));
    await write;
    assert.deepEqual(f.render().upstream.items, before);
    assert.equal(f.statuses.length, statuses); assert.equal(f.refreshes.length, 0);
  });
}

test("scope retirement fences metadata; fresh controller remains independent", async () => {
  const f = await ready(), write = act(f, "save");
  respond(f, 0, view(grant(), 2)); await write;
  const snapshot = f.render().captureHydration(); f.current = false;
  assert.equal(f.refreshes[0].owns(), false); finishMetadata(f); await flush();
  hydrate(f, [grant("account_a", { label: "old" })], snapshot);
  assert.equal(f.render().upstream.selected.label, "Account A");
  assert.equal((await ready()).render().upstream.busy, false);
});

test("OAuth navigation keeps admission; failure/retirement never replays authorization", async () => {
  const f = await ready(true), owner = f.render().upstream, authorization = owner.authorize();
  await Promise.all([owner.save(event), owner.revoke(owner.selected), owner.refresh(owner.selected), owner.refreshQuota(owner.selected), owner.authorize()]);
  assert.equal(f.writes.length, 1);
  f.writes[0].resolve({ authorizationUrl: "https://provider.example/authorize" }); await authorization;
  assert.deepEqual(f.navigations, ["https://provider.example/authorize"]);
  assert.equal(f.render().upstream.busy, true);
  for (const retired of [false, true]) {
    const other = await ready(true), pending = act(other, "authorize");
    other.current = !retired;
    other.writes[0].reject(new Error("authorization unavailable")); await pending;
    assert.equal(other.navigations.length, 0);
    assert.equal(other.refreshes.length, 0);
    if (!retired) assert.equal(other.render().upstream.busy, false);
  }
});

test("OAuth initial/validation/navigation failures preserve admission invariants", async () => {
  const f = mount(false, true); f.render().upstream.startNew();
  await act(f, "authorize"); assert.equal(f.writes.length, 0);
  hydrate(f, []); change(f, { priority: "-1" }); await act(f, "authorize");
  assert.match(f.render().upstream.error, /priority must/);
  change(f, { priority: "100" }); f.navigationError = new Error("navigation denied");
  const pending = act(f, "authorize");
  f.writes[0].resolve({ authorizationUrl: "https://provider.example/authorize" }); await pending;
  assert.equal(f.render().upstream.busy, false);
  assert.match(f.render().upstream.error, /navigation denied/);
});

test("demo pause/revoke/reconnect uses the same explicit modes and keeps pause", async () => {
  const f = mount(true); hydrate(f, [grant()]); await flush();
  assert.equal(f.render().upstream.generation, 1, f.render().upstream.error);
  await act(f, "pause"); assert.equal(f.render().upstream.selected.enabled, false, f.render().upstream.error);
  await act(f, "revoke"); assert.equal(f.render().upstream.selected.hasAccessToken, false);
  f.render().upstream.startReplace(); await act(f, "save");
  assert.match(f.render().upstream.error, /fresh primary/);
  change(f, { accessToken: "synthetic-new" }); await act(f, "save");
  assert.equal(f.render().upstream.selected.enabled, false);
  assert.equal(f.render().upstream.selected.hasAccessToken, true);
  assert.equal(f.render().upstream.form.accessToken, "");
  assert.equal(f.writes.length, 0);
});

const event = { preventDefault() {} }, providers = [{ id: "test-provider" }];
function grant(tokenRef = "account_a", values = {}) {
  return { key: `oauth/team_policy/${tokenRef}`, scope: "policies", scopeId: "team_policy", tokenRef, version: 1, kind: "subscription", provider: "test-provider", label: "Account A", tokenType: "Bearer", scopes: [],
    enabled: true, priority: 100, weight: 1, hasCredential: false, credentialFields: [], hasAccessToken: true, hasRefreshToken: true, refreshConfigured: true, usable: true,
    selectedCount: 0, quotaStatus: "unknown", quotaWindows: [], revokedAt: null, expiresAt: null, accountId: null, subscription: null, ...values };
}
function view(row = grant(), generation = 1, publication = "ready") { return { ...accounts.demoAccountView(accounts.accountFromInventory(row)), credentialGeneration: generation, publication }; }
function tombstone() { return grant("account_a", { enabled: false, usable: false, hasAccessToken: false, hasRefreshToken: false, revokedAt: "2026-09-01T00:00:00Z" }); }
function failure(status, code, detail) { return new DashboardRequestError(JSON.stringify({ error: { code, message: code, detail } }), status); }
function change(f, values) { f.render().upstream.setForm(current => ({ ...current, ...values })); }
function hydrate(f, rows, snapshot = f.render().captureHydration()) { f.render().hydrate(rows, "team_policy", providers, snapshot); }
function act(f, action) { const owner = f.render().upstream; return owner[action](action === "save" ? event : owner.selected); }
function body(f, index) { return JSON.parse(f.writes[index].init.body); }
function respond(f, index, saved) {
  f.owners.set(saved.key, saved);
  const write = f.writes[index], strict = write.init.method === "PATCH" || write.init.method === "POST" && Boolean(write.init.body);
  write.resolve(strict ? { outcome: "committed", grant: saved } : { ...grant(saved.tokenRef), ...saved });
}
function finishMetadata(f) { for (const refresh of f.refreshes) refresh.resolve(); }
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
async function ready(authorization = false, rows = [grant(), grant("account_b")]) {
  const f = mount(false, authorization); for (const row of rows) f.owners.set(row.key, view(row));
  hydrate(f, rows); await flush(); return f;
}
function mount(demoMode = false, authorization = false) {
  const slots = []; let cursor = 0;
  const useState = initial => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], next => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const f = { writes: [], reads: [], statuses: [], refreshes: [], navigations: [], navigationError: null, current: true, holdReads: false, readError: null, metadataGate: null,
    owners: new Map([[grant().key, view(grant())], [grant("account_b").key, view(grant("account_b"))]]),
    providers: authorization ? [{ ...providers[0], auth: { authorization: { grantKind: "subscription" } } }] : providers,
    policies: [{ policyId: "team_policy" }], selectedPolicyId: "team_policy" };
  const request = (_origin, path, init) => new Promise((resolve, reject) => {
    const item = { path, init, resolve, reject };
    if (init?.method && init.method !== "GET") f.writes.push(item);
    else {
      f.reads.push(item);
      if (!f.holdReads) {
        if (f.readError) reject(f.readError);
        else { const row = [...f.owners.values()].find(row => accounts.accountPath(row) === path); row ? resolve(row) : reject(failure(404, "grant_credential_missing")); }
      }
    }
  });
  const window = { location: { assign(url) { if (f.navigationError) throw f.navigationError; f.navigations.push(url); } } };
  const injected = { useState, useRef, DashboardRequestError, errorMessage, defaultUpstreamGrant, demo: { upstreamGrants: [grant()] }, window, ...accounts };
  const hook = new Function(...Object.keys(injected), `${source}\nreturn useUpstreamAdmin;`)(...Object.values(injected));
  f.render = () => { cursor = 0; return hook({ request, isCurrent: () => f.current, allowDemo: demoMode, gatewayOrigin: "https://console.example", demoMode,
    providers: f.providers, policies: f.policies, selectedPolicyId: f.selectedPolicyId, setStatus: value => f.statuses.push(value),
    refresh: async owns => { await f.metadataGate; if (owns()) await new Promise(resolve => f.refreshes.push({ owns, resolve })); } }); };
  return f;
}
