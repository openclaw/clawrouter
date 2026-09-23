import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { extname } from "node:path";
import test from "node:test";
import { errorMessage } from "../src/domain.ts";
import { consoleStatusPresentation } from "../src/status-display.ts";

registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith(".") && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname) ? `${specifier}.ts` : specifier, context);
} });
const { DashboardRequestError } = await import("../src/dashboard-fetch.ts");

// Exercise the actual owner without a local React install; browser journeys cover events/rendering.
const source = stripTypeScriptTypes(await readFile(new URL("../src/hooks/access/use-upstream-admin.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export function useUpstreamAdmin", "function useUpstreamAdmin");
const config = await readFile(new URL("../src/ui-config.ts", import.meta.url), "utf8");
const defaultUpstreamGrant = evaluate(config.slice(config.indexOf("export const defaultUpstreamGrant"), config.indexOf("export const defaultAssignmentRule")), "defaultUpstreamGrant");
const helpers = await readFile(new URL("../src/ui-helpers.ts", import.meta.url), "utf8");
const helperSource = helpers.slice(helpers.indexOf("export function upstreamGrantFormFromGrant"), helpers.indexOf("export function assignmentRuleFormFromRule"))
  + helpers.slice(helpers.indexOf("export function demoGrantFromForm"), helpers.indexOf("export function demoRuleFromForm"));
const { upstreamGrantFormFromGrant, demoGrantFromForm, parseCredentialBundle } = evaluate(helperSource, "({ upstreamGrantFormFromGrant, demoGrantFromForm, parseCredentialBundle })");

for (const initialRows of [[], [grant()]]) {
  test(`initial ${initialRows.length ? "nonempty" : "empty"} hydration enables writes without losing an early draft`, async () => {
    const fixture = mount(), owner = fixture.render(), snapshot = owner.captureHydration();
    owner.upstream.startNew();
    change(fixture, { scope: "tenants", scopeId: "default", tokenRef: "created", credential: "synthetic-primary", label: "early draft" });
    const draft = fixture.render().upstream.form;
    await owner.upstream.save(event);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.statuses.length, 0);
    assert.equal(fixture.refreshes.length, 0);
    assert.equal(fixture.render().captureHydration(), snapshot);
    assert.equal(fixture.render().upstream.ready, false);
    hydrate(fixture, initialRows, snapshot);
    assert.equal(fixture.render().upstream.ready, true);
    assert.deepEqual(fixture.render().upstream.form, draft);
    assert.equal(fixture.render().upstream.selectedKey, "");
    const write = owner.upstream.save(event);
    assert.equal(fixture.requests.length, 1);
    fixture.requests[0].resolve(grant("created", { key: "oauth/tenants/default/created", scope: "tenants", scopeId: "default", kind: "api_key", hasCredential: true }));
    await write;
  });
}

test("missing or rejected initial hydration stays unready, including live mode on a demo-capable host", async () => {
  const fixture = mount(false, true), owner = fixture.render(), snapshot = owner.captureHydration();
  assert.equal(owner.upstream.ready, false);
  owner.upstream.startNew();
  change(fixture, { credential: "synthetic-primary" });
  hydrate(fixture, [], null);
  hydrate(fixture, [], snapshot + 1);
  fixture.current = false;
  hydrate(fixture, [], snapshot);
  fixture.current = true;
  await owner.upstream.save(event);
  assert.equal(fixture.render().upstream.ready, false);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.render().captureHydration(), snapshot);
  hydrate(fixture, [], snapshot);
  assert.equal(fixture.render().upstream.ready, true);
  assert.equal(fixture.render().upstream.form.credential, "synthetic-primary");
});

for (const [action, method, suffix] of [["save", "PUT", ""], ["revoke", "POST", "/revoke"], ["refresh", "POST", "/refresh"], ["refreshQuota", "POST", "/quota-refresh"]]) {
  test(`${action} publishes canonical facts and releases buttons before dependent metadata`, async () => {
    const fixture = ready(), before = fixture.render().captureHydration();
    const write = act(fixture, action);
    const during = fixture.render().captureHydration();
    assert.equal(during, null);
    assert.equal(fixture.render().upstream.busy, true);
    await act(fixture, "save");
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].init.method, method);
    assert.equal(fixture.requests[0].path, `/v1/admin/upstream-grants/policies/team_policy/account_a${suffix}`);
    const saved = action === "revoke" ? tombstone() : grant("account_a", { priority: 7, expiresAt: "2030-01-01T00:00:00Z", quotaStatus: "limited", hasRefreshToken: false });
    fixture.requests[0].resolve(saved);
    await write;
    assert.deepEqual(fixture.render().upstream.items[0], saved);
    assert.equal(fixture.render().upstream.selected.key, saved.key);
    assert.equal(fixture.render().upstream.form.enabled, saved.enabled);
    assert.equal(fixture.render().upstream.form.priority, String(saved.priority));
    assert.equal(fixture.render().upstream.busy, false);
    assert.equal(fixture.refreshes.length, 1);
    assert.equal(fixture.refreshes[0].owns(), true);
    const ownRead = fixture.render().captureHydration();
    assert.equal(ownRead, null);
    for (const snapshot of [before, during, ownRead]) hydrate(fixture, [grant()], snapshot);
    assert.deepEqual(fixture.render().upstream.items[0], saved);
    const status = fixture.statuses.at(-1);
    fixture.refreshes[0].resolve();
    await flush();
    assert.equal(fixture.render().upstream.busy, false);
    assert.equal(fixture.statuses.at(-1), status);
    for (const snapshot of [before, during, ownRead]) hydrate(fixture, [grant()], snapshot);
    assert.deepEqual(fixture.render().upstream.items[0], saved);
    hydrate(fixture, [grant("account_a", { label: "later independent read" })]);
    assert.equal(fixture.render().upstream.items[0].label, "later independent read");
  });
}

test("a second write supersedes held metadata, and its predecessor cannot release or resurrect it", async () => {
  const fixture = ready();
  const save = act(fixture, "save");
  fixture.requests[0].resolve(grant("account_a", { label: "saved" }));
  await save;
  const revoke = act(fixture, "revoke");
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.refreshes[0].owns(), false);
  fixture.refreshes[0].resolve();
  await flush();
  assert.equal(fixture.render().upstream.busy, true);
  assert.equal(fixture.render().captureHydration(), null);
  assert.equal(fixture.statuses.at(-1), "revoking upstream grant");
  await act(fixture, "save");
  assert.equal(fixture.requests.length, 2);
  fixture.requests[1].resolve(tombstone());
  await revoke;
  assert.equal(fixture.render().upstream.selected.revokedAt, tombstone().revokedAt);
  assert.equal(fixture.render().upstream.form.enabled, false);
  assert.equal(fixture.render().upstream.busy, false);
  assert.equal(fixture.refreshes[1].owns(), true);
  fixture.refreshes[1].resolve();
  await flush();
  assert.equal(fixture.render().upstream.selected.hasAccessToken, false);
});

test("captured callbacks admit only one write in the same turn without a render", async () => {
  const fixture = ready(), owner = fixture.render().upstream;
  const first = owner.save(event), duplicate = owner.save(event);
  assert.equal(fixture.requests.length, 1);
  fixture.requests[0].resolve(grant());
  await Promise.all([first, duplicate]);
  assert.equal(fixture.refreshes.length, 1);
});

test("canonical results use full scope identity and do not interpret account names as status", async () => {
  const fixture = mount();
  const policy = grant("invalid_error"), tenant = grant("invalid_error", { key: "oauth/tenants/team_policy/invalid_error", scope: "tenants", label: "Tenant account" });
  hydrate(fixture, [policy, tenant]);
  const write = act(fixture, "save");
  fixture.requests[0].resolve({ ...policy, priority: 7 });
  await write;
  assert.deepEqual(fixture.render().upstream.items.find((row) => row.key === tenant.key), tenant);
  assert.equal(fixture.render().upstream.selected.priority, 7);
  assert.equal(consoleStatusPresentation(fixture.statuses.at(-1), false).tone, "success");
  fixture.render().upstream.edit(tenant);
  const revoke = act(fixture, "revoke");
  assert.equal(fixture.requests[1].path, "/v1/admin/upstream-grants/tenants/team_policy/invalid_error/revoke");
  fixture.requests[1].resolve({ ...tenant, enabled: false, hasAccessToken: false, hasRefreshToken: false });
  await revoke;
  assert.equal(fixture.render().upstream.items.find((row) => row.key === policy.key).enabled, true);
  assert.equal(fixture.render().upstream.selected.enabled, false);
});

test("equal updatedAt is not a version that can override a confirmed mutation", async () => {
  const fixture = mount(), old = grant("account_a", { updatedAt: "2026-09-01T00:00:00Z" });
  hydrate(fixture, [old]);
  const snapshot = fixture.render().captureHydration(), write = act(fixture, "save");
  fixture.requests[0].resolve({ ...old, priority: 7 });
  await write;
  fixture.refreshes[0].resolve();
  await flush();
  hydrate(fixture, [old], snapshot);
  assert.equal(fixture.render().upstream.selected.priority, 7);
});

test("Save preserves later edits back to the old baseline and clears only acknowledged unchanged secrets", async () => {
  const fixture = ready();
  change(fixture, { label: "submitted", accessToken: "synthetic-submitted", refreshToken: "synthetic-refresh" });
  const write = act(fixture, "save");
  change(fixture, { label: "Account A", accessToken: "synthetic-next" });
  fixture.requests[0].resolve(grant("account_a", { label: "submitted" }));
  await write;
  const form = fixture.render().upstream.form;
  assert.equal(form.label, "Account A");
  assert.equal(form.accessToken, "synthetic-next");
  assert.equal(form.refreshToken, "");
  const next = act(fixture, "save");
  assert.equal(JSON.parse(fixture.requests[1].init.body).accessToken, "synthetic-next");
  fixture.requests[1].resolve(grant());
  await next;
  assert.equal(fixture.render().upstream.form.accessToken, "");
});

test("editing a submitted secret away and back keeps that new intent for the next Save", async () => {
  const fixture = ready();
  change(fixture, { accessToken: "synthetic-submitted" });
  const write = act(fixture, "save");
  change(fixture, { accessToken: "synthetic-intermediate" });
  change(fixture, { accessToken: "synthetic-submitted" });
  fixture.requests[0].resolve(grant());
  await write;
  const next = act(fixture, "save");
  assert.equal(JSON.parse(fixture.requests[1].init.body).accessToken, "synthetic-submitted");
  fixture.requests[1].resolve(grant());
  await next;
});

for (const action of ["refresh", "refreshQuota"]) {
  test(`${action} preserves earlier and later unsaved metadata and secret inputs`, async () => {
    const fixture = ready();
    change(fixture, { label: "unsaved label", accessToken: "synthetic-draft", refreshToken: "synthetic-refresh-draft" });
    const write = act(fixture, action);
    change(fixture, { weight: "3", refreshToken: "synthetic-later-refresh" });
    fixture.requests[0].resolve(grant("account_a", { expiresAt: "2030-01-01T00:00:00Z", label: "remote label", quotaStatus: "limited" }));
    await write;
    const owner = fixture.render().upstream;
    assert.equal(owner.form.label, "unsaved label");
    assert.equal(owner.form.accessToken, "synthetic-draft");
    assert.equal(owner.form.refreshToken, "synthetic-later-refresh");
    assert.equal(owner.form.weight, "3");
    assert.equal(owner.form.expiresAt, "2030-01-01T00:00:00Z");
    assert.equal(owner.selected.quotaStatus, "limited");
    assert.equal(fixture.requests[0].init.body, undefined);
    const next = act(fixture, "save"), body = JSON.parse(fixture.requests[1].init.body);
    assert.equal(body.accessToken, "synthetic-draft");
    assert.equal(body.refreshToken, "synthetic-later-refresh");
    assert.equal(body.label, "unsaved label");
    fixture.requests[1].resolve(grant());
    await next;
  });
}

for (const later of [false, true]) {
  test(`Revoke consumes prior enabled/secret intent and ${later ? "preserves" : "does not invent"} later replacement intent`, async () => {
    const fixture = ready();
    change(fixture, { label: "unsaved label", accessToken: "synthetic-before" });
    const write = act(fixture, "revoke");
    if (later) {
      change(fixture, { enabled: false, accessToken: "synthetic-next" });
      change(fixture, { enabled: true });
    }
    fixture.requests[0].resolve(tombstone());
    await write;
    assert.equal(fixture.render().upstream.form.label, "unsaved label");
    assert.equal(fixture.render().upstream.form.enabled, later);
    assert.equal(fixture.render().upstream.form.accessToken, later ? "synthetic-next" : "");
    assert.equal(fixture.render().upstream.selected.enabled, false);
    assert.equal(fixture.render().upstream.selected.hasAccessToken, false);
  });
}

for (const destination of ["other selection", "away and back", "new incarnation", "new identity"]) {
  test(`a pending result updates its row without stealing ${destination}`, async () => {
    const fixture = ready();
    const write = act(fixture, "save");
    if (destination === "other selection" || destination === "away and back") fixture.render().upstream.edit(grant("account_b"));
    if (destination === "away and back") fixture.render().upstream.edit(grant());
    if (destination === "new incarnation" || destination === "new identity") fixture.render().upstream.startNew();
    change(fixture, { label: "later editor", ...(destination === "new identity" ? { tokenRef: "new_target" } : {}) });
    const expected = fixture.render().upstream.form, selection = fixture.render().upstream.selectedKey;
    fixture.requests[0].resolve(grant("account_a", { label: "saved row" }));
    await write;
    assert.equal(fixture.render().upstream.items.find((row) => row.key === grant().key).label, "saved row");
    assert.deepEqual(fixture.render().upstream.form, expected);
    assert.equal(fixture.render().upstream.selectedKey, selection);
  });
}

for (const [action, dirtyLabel] of [["save", false], ["save", true], ["revoke", false], ["refresh", false], ["refreshQuota", false]]) {
  test(`${action} reconciles untouched fields after reselection${dirtyLabel ? " with a dirty replacement label" : ""}`, async () => {
    const fixture = ready();
    if (action === "save") change(fixture, { enabled: false });
    const write = act(fixture, action);
    fixture.render().upstream.edit(grant("account_b"));
    fixture.render().upstream.edit(grant());
    if (dirtyLabel) {
      change(fixture, { label: "intermediate" });
      change(fixture, { label: "Account A" });
    }
    const canonical = { ...(action === "revoke" ? tombstone() : grant()), enabled: action === "save" || action === "revoke" ? false : true, expiresAt: "2030-01-01T00:00:00Z", label: "confirmed account" };
    fixture.requests[0].resolve(canonical);
    await write;
    assert.equal(fixture.render().upstream.form.enabled, canonical.enabled);
    assert.equal(fixture.render().upstream.form.expiresAt, canonical.expiresAt);
    assert.equal(fixture.render().upstream.form.label, dirtyLabel ? "Account A" : canonical.label);
    change(fixture, { label: "next label" });
    const next = act(fixture, "save"), body = JSON.parse(fixture.requests[1].init.body);
    assert.equal(body.enabled, canonical.enabled);
    assert.equal(body.expiresAt, canonical.expiresAt);
    fixture.requests[1].resolve({ ...canonical, label: "next label" });
    await next;
  });
}

test("reselected editor preserves explicit enabled roundtrips and replacement secrets", async () => {
  const fixture = ready();
  change(fixture, { enabled: false });
  const write = act(fixture, "save");
  fixture.render().upstream.edit(grant("account_b"));
  fixture.render().upstream.edit(grant());
  change(fixture, { enabled: false, accessToken: "synthetic-replacement" });
  change(fixture, { enabled: true });
  fixture.requests[0].resolve(grant("account_a", { enabled: false }));
  await write;
  assert.equal(fixture.render().upstream.form.enabled, true);
  assert.equal(fixture.render().upstream.form.accessToken, "synthetic-replacement");
  const next = act(fixture, "save"), body = JSON.parse(fixture.requests[1].init.body);
  assert.equal(body.enabled, true);
  assert.equal(body.accessToken, "synthetic-replacement");
  fixture.requests[1].resolve(grant());
  await next;
});

test("same-New save adopts its identity while preserving later edits for the next save", async () => {
  const fixture = ready();
  fixture.render().upstream.startNew();
  change(fixture, { tokenRef: "created", credential: "synthetic-new", label: "submitted" });
  const create = act(fixture, "save");
  change(fixture, { label: "later edit" });
  fixture.requests[0].resolve(grant("created", { kind: "api_key", hasCredential: true, label: "submitted" }));
  await create;
  assert.equal(fixture.render().upstream.selectedKey, "oauth/team_policy/created");
  assert.equal(fixture.render().upstream.form.credential, "");
  assert.equal(fixture.render().upstream.form.label, "later edit");
  const update = act(fixture, "save");
  assert.equal(fixture.requests[1].path, "/v1/admin/upstream-grants/policies/team_policy/created");
  assert.equal(JSON.parse(fixture.requests[1].init.body).label, "later edit");
  assert.equal(JSON.parse(fixture.requests[1].init.body).credential, undefined);
  fixture.requests[1].resolve(grant("created", { kind: "api_key", hasCredential: true, label: "later edit" }));
  await update;
});

for (const identity of ["scope", "scopeId", "tokenRef", "provider", "kind"]) {
  test(`changing New ${identity} and changing it back retires a pending save's editor ownership`, async () => {
    const fixture = ready();
    fixture.render().upstream.startNew();
    change(fixture, { tokenRef: "created", credential: "synthetic-new" });
    const original = fixture.render().upstream.form;
    const create = act(fixture, "save");
    change(fixture, { [identity]: identity === "scope" ? "tenants" : identity === "kind" ? "oauth" : "other" });
    change(fixture, { [identity]: original[identity], label: "replacement draft" });
    fixture.requests[0].resolve(grant("created", { kind: "api_key", hasCredential: true }));
    await create;
    assert.equal(fixture.render().upstream.selectedKey, "");
    assert.equal(fixture.render().upstream.form.credential, "synthetic-new");
    assert.equal(fixture.render().upstream.form.label, "replacement draft");
  });
}

for (const failure of [new DashboardRequestError('{"error":{"message":"invalid grant"}}', 400), new DashboardRequestError("unavailable", 503), new Error("connection closed")]) {
  test(`failed write releases admission and gates reconciliation: ${failure.message}`, async () => {
    const fixture = ready();
    change(fixture, { label: "retained draft" });
    const before = fixture.render().upstream.items;
    const write = act(fixture, "save");
    fixture.requests[0].reject(failure);
    await write;
    assert.deepEqual(fixture.render().upstream.items, before);
    assert.equal(fixture.render().upstream.form.label, "retained draft");
    assert.equal(fixture.render().upstream.busy, false);
    assert.match(fixture.render().upstream.error, failure.status === 400 ? /invalid grant/ : /could not be confirmed/);
    assert.equal(fixture.refreshes[0].owns(), true);
    const next = act(fixture, "revoke");
    assert.equal(fixture.refreshes[0].owns(), false);
    fixture.requests[1].resolve(tombstone());
    await next;
  });
}

test("mismatched result is unconfirmed and never inserted as a different account", async () => {
  const fixture = ready(), write = act(fixture, "save");
  fixture.requests[0].resolve(grant("wrong_account"));
  await write;
  assert.equal(fixture.render().upstream.items.some((item) => item.tokenRef === "wrong_account"), false);
  assert.match(fixture.render().upstream.error, /could not be confirmed/);
});

for (const outcome of ["success", "failure"]) {
  test(`scope replacement blocks late ${outcome} publication and refresh`, async () => {
    const fixture = ready(), before = fixture.render().upstream.items, write = act(fixture, "save");
    const statuses = fixture.statuses.length;
    fixture.current = false;
    if (outcome === "success") fixture.requests[0].resolve(grant("account_a", { label: "old identity" }));
    else fixture.requests[0].reject(new Error("old failure"));
    await write;
    assert.deepEqual(fixture.render().upstream.items, before);
    assert.equal(fixture.statuses.length, statuses);
    assert.equal(fixture.refreshes.length, 0);
    assert.equal(fixture.render().upstream.error, "");
    assert.equal(mount().render().upstream.items.length, 0);
  });
}

test("scope replacement during metadata refresh retires its predicate and late hydration", async () => {
  const fixture = ready(), write = act(fixture, "save");
  fixture.requests[0].resolve(grant("account_a", { label: "confirmed" }));
  await write;
  const snapshot = fixture.render().captureHydration(), statuses = fixture.statuses.length;
  fixture.current = false;
  assert.equal(fixture.refreshes[0].owns(), false);
  fixture.refreshes[0].resolve();
  await flush();
  hydrate(fixture, [grant("account_a", { label: "retired read" })], snapshot);
  assert.equal(fixture.render().upstream.selected.label, "confirmed");
  assert.equal(fixture.statuses.length, statuses);
  const replacement = ready(), next = act(replacement, "save");
  replacement.requests[0].resolve(grant());
  await next;
  assert.equal(replacement.render().upstream.busy, false);
});

test("initial hydration respects an early New draft and later refresh preserves unsaved fields", () => {
  const fixture = mount();
  fixture.render().upstream.startNew();
  change(fixture, { label: "early draft" });
  hydrate(fixture, [grant()]);
  assert.equal(fixture.render().upstream.selectedKey, "");
  assert.equal(fixture.render().upstream.form.label, "early draft");
  fixture.render().upstream.edit(grant());
  change(fixture, { label: "dirty" });
  hydrate(fixture, [grant("account_a", { label: "remote", priority: 4 })]);
  assert.equal(fixture.render().upstream.form.label, "dirty");
  assert.equal(fixture.render().upstream.form.priority, "4");
});

test("demo pause/revoke requires a fresh primary and retains pause after replacement", async () => {
  const fixture = mount(true);
  change(fixture, { enabled: false });
  await act(fixture, "save");
  assert.equal(fixture.render().upstream.selected.hasAccessToken, true);
  await act(fixture, "revoke");
  assert.equal(fixture.render().upstream.selected.hasAccessToken, false);
  await act(fixture, "save");
  assert.match(fixture.render().upstream.error, /requires a new primary/);
  change(fixture, { accessToken: "synthetic-replacement" });
  await act(fixture, "save");
  assert.equal(fixture.render().upstream.selected.enabled, false);
  assert.equal(fixture.render().upstream.selected.hasAccessToken, true);
  assert.equal(fixture.render().upstream.form.accessToken, "");
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.refreshes.length, 0);
});

const event = { preventDefault() {} };
const providers = [{ id: "test-provider" }];
function grant(tokenRef = "account_a", values = {}) { return { key: `oauth/team_policy/${tokenRef}`, scope: "policies", scopeId: "team_policy", tokenRef, kind: "subscription", provider: "test-provider", label: "Account A", version: 1, tokenType: "Bearer", scopes: [], enabled: true, priority: 100, weight: 1, hasCredential: false, credentialFields: [], hasAccessToken: true, hasRefreshToken: true, refreshConfigured: true, usable: true, selectedCount: 0, quotaStatus: "unknown", quotaWindows: [], revokedAt: null, ...values }; }
function tombstone() { return grant("account_a", { enabled: false, usable: false, hasAccessToken: false, hasRefreshToken: false, revokedAt: "2026-09-01T00:00:00Z" }); }
function evaluate(value, result) { return new Function(`${stripTypeScriptTypes(value).replaceAll("export ", "")}\nreturn ${result};`)(); }
function change(fixture, values) { fixture.render().upstream.setForm((current) => ({ ...current, ...values })); }
function hydrate(fixture, rows, snapshot = fixture.render().captureHydration()) { fixture.render().hydrate(rows, "team_policy", providers, snapshot); }
function ready() { const fixture = mount(); hydrate(fixture, [grant(), grant("account_b")]); return fixture; }
function act(fixture, action) { const owner = fixture.render().upstream; return owner[action](action === "save" ? event : owner.selected); }
async function flush() { await new Promise((resolve) => setImmediate(resolve)); }

function mount(demoMode = false, allowDemo = demoMode) {
  const slots = [], requests = [], statuses = [], refreshes = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  };
  const useRef = (initial) => useState(() => ({ current: initial }))[0];
  const fixture = { requests, statuses, refreshes, current: true };
  const request = (_origin, path, init) => new Promise((resolve, reject) => requests.push({ path, init, resolve, reject }));
  const useUpstreamAdmin = new Function("useState", "useRef", "DashboardRequestError", "errorMessage", "defaultUpstreamGrant", "demo", "demoGrantFromForm", "parseCredentialBundle", "upstreamGrantFormFromGrant", `${source}\nreturn useUpstreamAdmin;`)(useState, useRef, DashboardRequestError, errorMessage, defaultUpstreamGrant, { upstreamGrants: [grant()] }, demoGrantFromForm, parseCredentialBundle, upstreamGrantFormFromGrant);
  fixture.render = () => {
    cursor = 0;
    return useUpstreamAdmin({ request, isCurrent: () => fixture.current, allowDemo, gatewayOrigin: "https://console.example", demoMode, providers, policies: [{ policyId: "team_policy" }], selectedPolicyId: "team_policy", setStatus: (value) => statuses.push(value), refresh: (owns) => new Promise((resolve) => refreshes.push({ owns, resolve })) });
  };
  return fixture;
}
