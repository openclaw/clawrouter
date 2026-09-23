import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { currencyInput, errorMessage, knownPolicyProviders, optionalCurrencyMicros, optionalNumber, parseEligibleGrants, unique } from "../src/domain.ts";
import { consoleStatusPresentation } from "../src/status-display.ts";

// Run the actual owner without installing React; browser journeys cover rendering and events.
const hookSource = stripTypeScriptTypes(await readFile(new URL("../src/hooks/access/use-policy-admin.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export function usePolicyAdmin", "function usePolicyAdmin");
const config = await readFile(new URL("../src/ui-config.ts", import.meta.url), "utf8");
const defaultPolicy = evaluate(config.slice(config.indexOf("export const defaultPolicy"), config.indexOf("export const defaultAccess")), "defaultPolicy");
const rolePresets = evaluate(config.slice(config.indexOf("export const rolePresets"), config.indexOf("export const navItems")), "rolePresets");
const helpers = await readFile(new URL("../src/ui-helpers.ts", import.meta.url), "utf8");
const policyFormFromPolicy = new Function("currencyInput", `${stripTypeScriptTypes(helpers.slice(helpers.indexOf("export function policyFormFromPolicy"), helpers.indexOf("export function adminOverviewFromPolicies"))).replace("export function", "function")}\nreturn policyFormFromPolicy;`)(currencyInput);

test("bootstrap initializes once, preserves an early New draft, and clean selected rows reconcile", () => {
  const fixture = mount();
  fixture.render().policies.startNew();
  hydrate(fixture, [policy("policy_a")]);
  assert.equal(fixture.render().policies.selectedId, "");
  assert.equal(fixture.render().policies.form.policyId, "");
  fixture.render().policies.edit(policy("policy_a"));
  hydrate(fixture, [policy("policy_a", "updated")]);
  assert.equal(fixture.render().policies.form.tenantId, "updated");
});

test("initial hydration gates writes without retiring bootstrap or replacing an early New draft", async () => {
  const fixture = mount();
  const snapshot = fixture.render().captureHydration();
  fixture.render().policies.startNew();
  change(fixture, { policyId: "policy_a", allProviders: true, tenantId: "early-draft" });
  const save = fixture.render().policies.save(event);
  assert.equal(fixture.requests.length, 0);
  await save;
  await fixture.render().policies.revoke("policy_a");
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.render().captureHydration(), snapshot);
  assert.equal(fixture.render().policies.ready, false);
  assert.equal(fixture.render().policies.busy, false);
  assert.deepEqual(fixture.statuses, []);
  fixture.render().hydrate([policy("policy_a")], session, snapshot);
  assert.equal(fixture.render().policies.ready, true);
  assert.equal(fixture.render().policies.selectedId, "");
  assert.equal(fixture.render().policies.form.tenantId, "early-draft");
  assert.equal(fixture.render().policies.error, "");
  await fixture.render().policies.save(event);
  assert.equal(fixture.requests.length, 0);
  assert.match(fixture.render().policies.error, /already exists/);
  assert.equal(fixture.render().policies.items[0].tenantId, "default");
});

test("only admitted initial hydration enables writes, including a valid empty policy list", async () => {
  const fixture = mount();
  fixture.render().policies.startNew();
  change(fixture, { policyId: "policy_new", allProviders: true, tenantId: "early-draft" });
  const owner = fixture.render(), snapshot = owner.captureHydration();
  owner.hydrate([], session, null);
  owner.hydrate([], session, snapshot + 1);
  assert.equal(fixture.render().policies.ready, false);
  await owner.policies.save(event);
  assert.equal(fixture.requests.length, 0);
  owner.hydrate([], session, snapshot);
  assert.equal(fixture.render().policies.ready, true);
  assert.equal(fixture.render().policies.form.tenantId, "early-draft");
  const save = owner.policies.save(event); // Admission observes accepted hydration before rerender.
  assert.equal(fixture.requests.length, 1);
  fixture.requests[0].resolve(policy("policy_new", "early-draft"));
  await save;
  fixture.render().hydrate([], session, snapshot); // A retired read cannot unset readiness.
  assert.equal(fixture.render().policies.ready, true);
  assert.equal(fixture.render().policies.selectedId, "policy_new");
});

test("dirty drafts survive repeated hydration and discard reads the latest server row", () => {
  const fixture = ready();
  change(fixture, { tenantId: "draft" });
  hydrate(fixture, [policy("policy_a", "first-refresh"), policy("policy_b")]);
  hydrate(fixture, [policy("policy_a", "latest-refresh"), policy("policy_b")]);
  assert.equal(fixture.render().policies.form.tenantId, "draft");
  fixture.render().policies.discard();
  assert.equal(fixture.render().policies.form.tenantId, "latest-refresh");
  assert.equal(fixture.render().policies.dirty, false);
});

for (const destination of ["policy_b", "new", "same"]) {
  test(`a held policy A save commits its server response without replacing the ${destination} draft`, async () => {
    const fixture = ready();
    change(fixture, { tenantId: "submitted" });
    const operation = fixture.render().policies.save(event);
    if (destination === "policy_b") fixture.render().policies.edit(policy("policy_b"));
    if (destination === "new") fixture.render().policies.startNew();
    change(fixture, { tenantId: "later-edit" });
    fixture.requests[0].resolve(policy("policy_a", "canonical-response"));
    await operation;
    const current = fixture.render().policies;
    assert.equal(current.form.tenantId, "later-edit");
    assert.equal(current.selectedId, destination === "same" ? "policy_a" : destination === "new" ? "" : destination);
    assert.equal(current.dirty, true);
    assert.equal(current.items.find((item) => item.policyId === "policy_a").tenantId, "canonical-response");
    assert.equal(current.busy, false);
    assert.equal(fixture.refreshes, 1); // The held refresh does not own mutation admission.
  });
}

for (const action of ["save", "disable"]) {
  for (const replacement of ["clean reselection", "dirty reselection", "roundtrip reselection", "discard", "edited discard"]) {
    test(`${action} reconciles the ${replacement} replacement draft without rolling back its next save`, async () => {
      const fixture = ready();
      change(fixture, { tenantId: "submitted" });
      const operation = action === "save" ? fixture.render().policies.save(event) : fixture.render().policies.revoke("policy_a");
      if (replacement.includes("reselection")) {
        fixture.render().policies.edit(policy("policy_b"));
        fixture.render().policies.edit(policy("policy_a"));
      } else fixture.render().policies.discard();
      const dirty = replacement === "dirty reselection" || replacement === "edited discard";
      if (dirty) change(fixture, { tenantId: "later-draft" });
      if (replacement === "roundtrip reselection") {
        change(fixture, { tenantId: "temporary" });
        change(fixture, { tenantId: "default" });
      }
      assert.equal(fixture.render().policies.dirty, dirty);
      const canonical = { ...policy("policy_a", action === "save" ? "canonical" : "default"), enabled: action === "save" };
      fixture.requests[0].resolve(canonical);
      await operation;
      const expectedTenant = dirty ? "later-draft" : canonical.tenantId;
      assert.deepEqual(fixture.render().policies.selected, canonical);
      assert.equal(fixture.render().policies.form.tenantId, expectedTenant);
      assert.equal(fixture.render().policies.form.enabled, canonical.enabled);
      assert.equal(fixture.render().policies.dirty, dirty);
      hydrate(fixture, [canonical, policy("policy_b")]);
      assert.equal(fixture.render().policies.form.tenantId, expectedTenant);
      const nextSave = fixture.render().policies.save(event);
      const payload = JSON.parse(fixture.requests[1].init.body);
      assert.equal(payload.tenantId, expectedTenant);
      assert.equal(payload.enabled, canonical.enabled);
      fixture.requests[1].resolve({ ...canonical, tenantId: expectedTenant });
      await nextSave;
    });
  }
}

test("Disable preserves a newer enabled roundtrip in a reselected replacement draft", async () => {
  const fixture = ready();
  const operation = fixture.render().policies.revoke("policy_a");
  fixture.render().policies.edit(policy("policy_b"));
  fixture.render().policies.edit(policy("policy_a"));
  change(fixture, { enabled: false });
  change(fixture, { enabled: true });
  assert.equal(fixture.render().policies.dirty, false);
  const canonical = { ...policy("policy_a"), enabled: false };
  fixture.requests[0].resolve(canonical);
  await operation;
  assert.equal(fixture.render().policies.form.enabled, true);
  assert.equal(fixture.render().policies.dirty, true);
  hydrate(fixture, [canonical, policy("policy_b")]);
  assert.equal(fixture.render().policies.form.enabled, true);
  const nextSave = fixture.render().policies.save(event);
  assert.equal(JSON.parse(fixture.requests[1].init.body).enabled, true);
  fixture.requests[1].resolve(policy("policy_a"));
  await nextSave;
});

test("pre-write and during-write bootstrap snapshots cannot replace a committed row", async () => {
  const fixture = ready();
  const before = fixture.render().captureHydration();
  change(fixture, { tenantId: "submitted" });
  const operation = fixture.render().policies.save(event);
  const during = fixture.render().captureHydration();
  assert.equal(during, null);
  fixture.requests[0].resolve(policy("policy_a", "committed"));
  await operation;
  for (const snapshot of [before, during]) fixture.render().hydrate([policy("policy_a", "old")], session, snapshot);
  assert.equal(fixture.render().policies.form.tenantId, "committed");
  assert.equal(fixture.render().policies.selected.tenantId, "committed");
  hydrate(fixture, [policy("policy_a", "current")]);
  assert.equal(fixture.render().policies.form.tenantId, "current");
});

test("synchronous admission sends one write and a failed save keeps its draft for retry", async () => {
  const fixture = ready();
  change(fixture, { tenantId: "retry-me" });
  const hook = fixture.render();
  const first = hook.policies.save(event), duplicate = hook.policies.save(event);
  assert.equal(fixture.requests.length, 1);
  fixture.requests[0].reject(new Error("write unavailable"));
  await Promise.all([first, duplicate]);
  assert.equal(fixture.render().policies.form.tenantId, "retry-me");
  assert.equal(fixture.render().policies.dirty, true);
  assert.equal(fixture.render().policies.error, "write unavailable");
  assert.equal(fixture.render().policies.busy, false);
  const retry = fixture.render().policies.save(event);
  fixture.requests[1].resolve(policy("policy_a", "retry-me"));
  await retry;
  assert.equal(fixture.render().policies.error, "");
  assert.equal(fixture.render().policies.dirty, false);
});

for (const policyId of ["error_budget", "invalid_policy"]) {
  for (const action of ["save", "disable"]) {
    test(`${action} presents success for keyword policy ID ${policyId} before refresh settles`, async () => {
      const fixture = mount();
      hydrate(fixture, [policy(policyId)]);
      const operation = action === "save" ? fixture.render().policies.save(event) : fixture.render().policies.revoke(policyId);
      assert.equal(consoleStatusPresentation(fixture.statuses.at(-1), false).tone, "pending");
      const committed = { ...policy(policyId), enabled: action === "save" };
      fixture.requests[0].resolve(committed);
      await operation;
      assert.deepEqual(fixture.render().policies.selected, committed);
      assert.equal(fixture.render().policies.busy, false);
      assert.equal(fixture.render().policies.error, "");
      assert.equal(fixture.refreshes, 1); // Refresh stays unresolved in this fixture.
      assert.deepEqual(consoleStatusPresentation(fixture.statuses.at(-1), false), { tone: "success", label: "Connected", showBar: false });
      assert.equal(fixture.statuses.at(-1), action === "save" ? "saved policy" : "disabled policy");
    });
  }
}

for (const [policyId, message] of [["ready_policy", "policy unavailable"], ["saved_policy", "connected"]]) {
  for (const action of ["save", "disable"]) {
    test(`${action} rejection for ${policyId} stays visible after a later edit`, async () => {
      const fixture = mount();
      hydrate(fixture, [policy(policyId)]);
      const operation = action === "save" ? fixture.render().policies.save(event) : fixture.render().policies.revoke(policyId);
      change(fixture, { tenantId: "later-draft" });
      fixture.requests[0].reject(new Error(message));
      await operation;
      const current = fixture.render().policies;
      assert.equal(current.form.tenantId, "later-draft");
      assert.equal(current.dirty, true);
      assert.equal(current.error, "");
      assert.equal(current.busy, false);
      assert.equal(current.selected.tenantId, "default");
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.refreshes, 0);
      const status = fixture.statuses.at(-1);
      assert.deepEqual(consoleStatusPresentation(status, false), { tone: "error", label: "Needs attention", showBar: true });
      assert.ok(status.includes(action) && status.includes(policyId) && status.includes(message));
    });
  }
}

test("an old selection's failed save cannot attach its error to the new draft", async () => {
  const fixture = ready();
  const operation = fixture.render().policies.save(event);
  fixture.render().policies.edit(policy("policy_b"));
  change(fixture, { tenantId: "keep-b" });
  fixture.requests[0].reject(new Error("A failed"));
  await operation;
  assert.equal(fixture.render().policies.error, "");
  assert.equal(fixture.render().policies.form.tenantId, "keep-b");
  assert.match(fixture.statuses.at(-1), /policy_a.*A failed/);
});

test("a deleted selected policy stays selected and cannot be silently recreated", async () => {
  const fixture = ready();
  change(fixture, { tenantId: "preserved" });
  hydrate(fixture, [policy("policy_b")]);
  let current = fixture.render().policies;
  assert.equal(current.selectedId, "policy_a");
  assert.equal(current.missing, true);
  assert.equal(current.form.tenantId, "preserved");
  await current.save(event);
  assert.equal(fixture.requests.length, 0);
  assert.match(fixture.render().policies.error, /no longer available/);
  fixture.render().policies.discard();
  assert.equal(fixture.render().policies.missing, true);
  fixture.render().policies.startNew();
  current = fixture.render().policies;
  assert.equal(current.missing, false);
  assert.equal(current.selectedId, "");
});

test("New and selection ask only for actual changes, and cancelled discard preserves the draft", () => {
  const fixture = ready();
  change(fixture, { tenantId: "temporary" });
  fixture.acceptDiscard = false;
  fixture.render().policies.edit(policy("policy_b"));
  fixture.render().policies.startNew();
  assert.equal(fixture.confirmations, 2);
  assert.equal(fixture.render().policies.form.tenantId, "temporary");
  change(fixture, { tenantId: "default" });
  assert.equal(fixture.render().policies.dirty, false);
  fixture.render().policies.startNew();
  assert.equal(fixture.confirmations, 2);
  change(fixture, { policyId: "new_policy" });
  fixture.render().policies.discard();
  assert.equal(fixture.render().policies.form.policyId, "");
  hydrate(fixture, [policy("policy_a")]);
  assert.equal(fixture.render().policies.form.policyId, "");
});

test("demo save and disable update canonical rows without losing an unsaved draft", async () => {
  const fixture = mount(true);
  assert.equal(fixture.render().policies.ready, true);
  change(fixture, { tenantId: "demo-saved" });
  await fixture.render().policies.save(event);
  assert.equal(fixture.render().policies.selected.tenantId, "demo-saved");
  assert.equal(fixture.render().policies.dirty, false);
  change(fixture, { tenantId: "demo-unsaved" });
  await fixture.render().policies.revoke("policy_a");
  assert.equal(fixture.render().policies.selected.enabled, false);
  assert.equal(fixture.render().policies.form.tenantId, "demo-unsaved");
  fixture.render().policies.discard();
  assert.equal(fixture.render().policies.form.enabled, false);
  assert.equal(fixture.demoRows[0].enabled, false);
  assert.equal(fixture.requests.length, 0);
});

for (const demoMode of [false, true]) {
  test(`${demoMode ? "demo" : "authenticated"} tenant edit then Disable then Save keeps the policy disabled`, async () => {
    const fixture = demoMode ? mount(true) : ready();
    change(fixture, { tenantId: "keep-tenant-edit" });
    const disable = fixture.render().policies.revoke("policy_a");
    if (!demoMode) fixture.requests[0].resolve({ ...policy("policy_a"), enabled: false });
    await disable;
    assert.equal(fixture.render().policies.form.tenantId, "keep-tenant-edit");
    assert.equal(fixture.render().policies.form.enabled, false);
    assert.equal(fixture.render().policies.dirty, true);
    const save = fixture.render().policies.save(event);
    if (!demoMode) {
      const body = JSON.parse(fixture.requests[1].init.body);
      assert.equal(body.enabled, false);
      assert.equal(body.tenantId, "keep-tenant-edit");
      fixture.requests[1].resolve({ ...policy("policy_a", "keep-tenant-edit"), enabled: false });
    }
    await save;
    assert.equal(fixture.render().policies.selected.enabled, false);
    assert.equal(fixture.render().policies.selected.tenantId, "keep-tenant-edit");
    assert.equal(fixture.render().policies.dirty, false);
  });
}

test("Disable preserves a deliberately newer enabled-field round trip", async () => {
  const fixture = ready();
  const disable = fixture.render().policies.revoke("policy_a");
  change(fixture, { enabled: false });
  change(fixture, { enabled: true });
  fixture.requests[0].resolve({ ...policy("policy_a"), enabled: false });
  await disable;
  assert.equal(fixture.render().policies.form.enabled, true);
  assert.equal(fixture.render().policies.dirty, true);
  hydrate(fixture, [{ ...policy("policy_a"), enabled: false }]);
  assert.equal(fixture.render().policies.form.enabled, true);
  change(fixture, { enabled: false });
  assert.equal(fixture.render().policies.dirty, false);
});

test("typing the original baseline during a held save stays dirty against the committed baseline", async () => {
  const fixture = ready();
  change(fixture, { tenantId: "submitted-change" });
  const save = fixture.render().policies.save(event);
  change(fixture, { tenantId: "default" });
  assert.equal(fixture.render().policies.dirty, false);
  fixture.requests[0].resolve(policy("policy_a", "submitted-change"));
  await save;
  assert.equal(fixture.render().policies.form.tenantId, "default");
  assert.equal(fixture.render().policies.dirty, true);
  hydrate(fixture, [policy("policy_a", "submitted-change")]);
  assert.equal(fixture.render().policies.form.tenantId, "default");
  fixture.render().policies.discard();
  assert.equal(fixture.render().policies.form.tenantId, "submitted-change");
  assert.equal(fixture.render().policies.dirty, false);
});

test("a held create adopts its identity without losing later edits, so the next save updates it", async () => {
  const fixture = ready();
  fixture.render().policies.startNew();
  change(fixture, { policyId: "policy_new", allProviders: true, tenantId: "submitted" });
  const create = fixture.render().policies.save(event);
  change(fixture, { tenantId: "later-edit" });
  fixture.requests[0].resolve(policy("policy_new", "submitted"));
  await create;
  assert.equal(fixture.render().policies.selectedId, "policy_new");
  assert.equal(fixture.render().policies.form.tenantId, "later-edit");
  assert.equal(fixture.render().policies.dirty, true);
  const update = fixture.render().policies.save(event);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[1].path, "/v1/admin/policies/policy_new");
  assert.equal(JSON.parse(fixture.requests[1].init.body).tenantId, "later-edit");
  fixture.requests[1].resolve(policy("policy_new", "later-edit"));
  await update;
  assert.equal(fixture.render().policies.dirty, false);
});

for (const destination of ["new incarnation", "other identity", "other selection"]) {
  test(`a held create cannot adopt the ${destination}`, async () => {
    const fixture = ready();
    fixture.render().policies.startNew();
    change(fixture, { policyId: "policy_new", allProviders: true, tenantId: "submitted" });
    const create = fixture.render().policies.save(event);
    if (destination === "new incarnation") fixture.render().policies.startNew();
    if (destination === "other selection") fixture.render().policies.edit(policy("policy_b"));
    change(fixture, { policyId: destination === "other selection" ? "policy_b" : destination === "other identity" ? "policy_other" : "policy_new", tenantId: "different-draft" });
    fixture.requests[0].resolve(policy("policy_new", "submitted"));
    await create;
    assert.equal(fixture.render().policies.selectedId, destination === "other selection" ? "policy_b" : "");
    assert.equal(fixture.render().policies.form.tenantId, "different-draft");
    assert.equal(fixture.render().policies.form.policyId, destination === "other selection" ? "policy_b" : destination === "other identity" ? "policy_other" : "policy_new");
  });
}

const event = { preventDefault() {} };
const session = { tenantId: "default", role: "admin", authenticated: true };
function policy(policyId, tenantId = "default") { return { policyId, tenantId, enabled: true, providers: [], retainRequestContent: false, grantRouting: { strategy: "priority", stickiness: "none", failover: true, staleState: "allow", staleAfterSeconds: 300, switchAtUsedPercent: 90, hysteresisPercent: 10, eligibleGrants: {} } }; }
function evaluate(source, name) { return new Function(`${stripTypeScriptTypes(source).replace("export const", "const")}\nreturn ${name};`)(); }
function change(fixture, value) { fixture.render().policies.setForm((current) => ({ ...current, ...value })); }
function hydrate(fixture, rows) { const hook = fixture.render(); hook.hydrate(rows, session, hook.captureHydration()); }
function ready() { const fixture = mount(); hydrate(fixture, [policy("policy_a"), policy("policy_b")]); return fixture; }

function mount(demoMode = false) {
  const slots = [], requests = [], statuses = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  };
  const useRef = (initial) => useState(() => ({ current: initial }))[0];
  const fixture = { requests, statuses, refreshes: 0, confirmations: 0, acceptDiscard: true, demoRows: [] };
  const window = { confirm: () => { fixture.confirmations += 1; return fixture.acceptDiscard; } };
  const request = (_origin, path, init) => new Promise((resolve, reject) => requests.push({ path, init, resolve, reject }));
  const usePolicyAdmin = new Function("useState", "useRef", "window", "demo", "defaultPolicy", "rolePresets", "policyFormFromPolicy", "currencyInput", "errorMessage", "knownPolicyProviders", "optionalCurrencyMicros", "optionalNumber", "parseEligibleGrants", "unique", `${hookSource}\nreturn usePolicyAdmin;`)(useState, useRef, window, { keys: [policy("policy_a")] }, defaultPolicy, rolePresets, policyFormFromPolicy, currencyInput, errorMessage, knownPolicyProviders, optionalCurrencyMicros, optionalNumber, parseEligibleGrants, unique);
  fixture.render = () => {
    cursor = 0;
    return usePolicyAdmin({ request, allowDemo: demoMode, gatewayOrigin: "https://console.example", session, demoMode, providers: [], credentials: [], routes: {}, setStatus: (status) => statuses.push(status), refresh: () => { fixture.refreshes += 1; return new Promise(() => {}); }, syncDemoAdmin: (rows) => { fixture.demoRows = rows; } });
  };
  return fixture;
}
