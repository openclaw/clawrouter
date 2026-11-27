import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { accessFormFromUser, bindingFormFromBinding, bindingKey, errorMessage, optionalNumber, parseGroups, reconcileDirectUserBindings } from "../src/domain.ts";

// Exercise the principal hook owner; browser tests cover the actual binding panel.
const source = stripTypeScriptTypes(await readFile(new URL("../src/hooks/access/use-principal-admin.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
const config = await readFile(new URL("../src/ui-config.ts", import.meta.url), "utf8");
const defaults = stripTypeScriptTypes(config.slice(config.indexOf("export const defaultAccess"), config.indexOf("export const defaultUpstreamGrant"))).replace(/^export /gm, "");
const { defaultAccess, defaultBinding } = new Function(`${defaults}\nreturn { defaultAccess, defaultBinding };`)();
const binding = (principalId, priority = 100) => ({ policyId: "team", principalType: "group", principalId, priority, enabled: true });
const a = binding("team-a"), b = binding("team-b");
const event = { preventDefault() {} };

function mount() {
  const cells = [], requests = [], errors = [], statuses = [];
  let index = 0;
  const useState = initial => {
    const slot = index++;
    if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial;
    return [cells[slot], value => { cells[slot] = typeof value === "function" ? value(cells[slot]) : value; }];
  };
  const useRef = initial => cells[index++] ??= { current: initial };
  const hook = new Function("useState", "useRef", "accessFormFromUser", "bindingFormFromBinding", "bindingKey", "errorMessage", "optionalNumber", "parseGroups", "reconcileDirectUserBindings", "defaultAccess", "defaultBinding", "demo", `${source}\nreturn usePrincipalAdmin;`)
    (useState, useRef, accessFormFromUser, bindingFormFromBinding, bindingKey, errorMessage, optionalNumber, parseGroups, reconcileDirectUserBindings, defaultAccess, defaultBinding, { users: [], bindings: [], keys: [] });
  const dependencies = {
    allowDemo: false, demoMode: false, gatewayOrigin: "https://router.example", session: {},
    policies: [{ policyId: "team", enabled: true }], selectedPolicyId: "team",
    setPolicyError: value => errors.push(value), setStatus: value => statuses.push(value),
    request: (_origin, path, init) => new Promise((resolve, reject) => requests.push({ path, body: JSON.parse(init.body), resolve, reject })),
    refresh: async () => render().hydrate([], [a, b], false, "team"),
  };
  function render() { index = 0; return hook(dependencies); }
  render().hydrate([], [a, b], false, "team");
  return { render, requests, errors, statuses, dependencies };
}

function change(f, fields) { const owner = f.render(); owner.bindings.setForm({ ...owner.bindings.form, ...fields }); }

for (const selectOther of [false, true]) {
  test(`a binding save preserves later edits ${selectOther ? "to another binding" : "to the submitted binding"}`, async () => {
    const f = mount(), saving = f.render().bindings.save(event);
    if (selectOther) f.render().bindings.edit(b);
    change(f, { priority: "777" });
    f.requests[0].resolve({ ...a, priority: 123 });
    await saving;
    assert.equal(f.render().bindings.form.principalId, selectOther ? b.principalId : a.principalId);
    assert.equal(f.render().bindings.form.priority, "777");
    assert.equal(f.render().bindings.items.find(row => row.principalId === a.principalId).priority, 123);
    f.render().hydrate([], [a, b], false, "team");
    assert.equal(f.render().bindings.form.priority, "777");
  });
}

test("unchanged binding drafts adopt the receipt after a stale refresh", async () => {
  const f = mount(), saving = f.render().bindings.save(event);
  f.requests[0].resolve({ ...a, priority: 123 });
  await saving;
  assert.equal(f.render().bindings.form.priority, "123");
  assert.equal(f.render().bindings.items.find(row => row.principalId === a.principalId).priority, 123);
});

test("edits during reconciliation remain owned by the binding editor", async () => {
  const f = mount(), refresh = Promise.withResolvers();
  f.dependencies.refresh = () => refresh.promise;
  const saving = f.render().bindings.save(event);
  f.requests[0].resolve(a);
  await new Promise(resolve => setImmediate(resolve));
  change(f, { priority: "777" });
  f.render().hydrate([], [a, b], false, "team");
  refresh.resolve();
  await saving;
  assert.equal(f.render().bindings.form.priority, "777");
});

test("a failed refresh retains an acknowledged binding and canonical draft", async () => {
  const f = mount();
  f.dependencies.refresh = async () => { throw new Error("offline"); };
  const saving = f.render().bindings.save(event);
  f.requests[0].resolve({ ...a, priority: 123 });
  await saving;
  assert.equal(f.render().bindings.form.priority, "123");
  assert.equal(f.render().bindings.items.find(row => row.principalId === a.principalId).priority, 123);
  assert.match(f.statuses.at(-1), /saved binding.*refresh failed/);
});

test("a failed PUT keeps its draft for retry without attaching its error to another binding", async () => {
  const f = mount(), saving = f.render().bindings.save(event);
  f.render().bindings.edit(b);
  change(f, { priority: "777" });
  f.requests[0].reject(new Error("unavailable"));
  await saving;
  assert.equal(f.render().bindings.form.principalId, b.principalId);
  assert.equal(f.render().bindings.form.priority, "777");
  assert.equal(f.errors.at(-1), "");
  const retry = f.render().bindings.save(event);
  assert.equal(f.requests[1].body.principalId, b.principalId);
  f.requests[1].resolve({ ...b, priority: 777 });
  await retry;
});

test("new unsaved bindings survive foreground and background hydration", () => {
  const f = mount();
  f.render().bindings.startNew();
  change(f, { principalId: "new-team", priority: "777" });
  for (const background of [false, true]) f.render().hydrate([], [a, b], background, "team");
  assert.equal(f.render().bindings.selectedKey, "");
  assert.equal(f.render().bindings.form.principalId, "new-team");
  assert.equal(f.render().bindings.form.priority, "777");
});

test("an empty inventory stays refreshable until an explicit new binding is started", () => {
  const f = mount();
  f.render().hydrate([], [], false, "team");
  f.render().hydrate([], [b], false, "team");
  assert.equal(f.render().bindings.form.principalId, b.principalId);
  f.render().bindings.startNew();
  f.render().hydrate([], [a, b], false, "team");
  assert.equal(f.render().bindings.selectedKey, "");
  assert.equal(f.render().bindings.form.principalId, "");
});

test("clean bindings still reconcile and existing disable-only validation stays authoritative", async () => {
  const f = mount();
  f.render().hydrate([], [{ ...a, priority: 99 }], false, "team");
  assert.equal(f.render().bindings.form.priority, "99");
  f.dependencies.policies = [];
  change(f, { enabled: false });
  const saving = f.render().bindings.save(event), duplicate = f.render().bindings.save(event);
  assert.equal(f.requests.length, 1);
  await duplicate;
  assert.deepEqual(f.requests[0].body, { ...a, enabled: false, priority: 99 });
  f.requests[0].resolve({ ...a, enabled: false, priority: 99 });
  await saving;
  change(f, { priority: "1" });
  await f.render().bindings.save(event);
  assert.equal(f.requests.length, 1);
  assert.match(f.errors.at(-1), /available policy/);
});
