import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Exercise the owner hook without a dependency install; browser tests cover React rendering.
const source = stripTypeScriptTypes(await readFile(new URL("../src/hooks/use-usage.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export function useUsage", "function useUsage");
const snapshot = { ledger: "ready", summary: { requestCount: 7, actualCostMicros: 2_000_000 }, providers: [], daily: [], events: [] };
const empty = { ...snapshot, ledger: "unavailable", summary: { requestCount: 0, actualCostMicros: 0 } };

test("failed first read stays unknown and a retry clears the error", async () => {
  const fixture = mount();
  let hook = fixture.render();
  const failed = hook.refreshLedger("https://console.example");
  fixture.requests[0].reject(new Error("ledger offline"));
  await failed;
  hook = fixture.render();
  assert.equal(hook.loaded, false);
  assert.equal(hook.updatedAt, null);
  assert.match(hook.error, /ledger offline/);

  const retry = hook.refreshLedger("https://console.example");
  fixture.requests[1].resolve({ policies: [], usage: snapshot });
  await retry;
  hook = fixture.render();
  assert.equal(hook.loaded, true);
  assert.equal(hook.stale, false);
  assert.equal(hook.error, "");
  assert.equal(hook.snapshot, snapshot);
  assert.equal(typeof hook.updatedAt, "number");
});

test("a failed background read retains the last successful snapshot and its time", async () => {
  const fixture = mount();
  fixture.render().hydrate([{ policyId: "team" }], snapshot);
  const before = fixture.render();
  const refresh = before.refreshLedger("https://console.example");
  assert.equal(before.refreshLedger("https://console.example"), refresh);
  assert.equal(fixture.requests.length, 1);
  fixture.requests[0].reject(new Error("ledger offline"));
  await refresh;
  const after = fixture.render();
  assert.equal(after.snapshot, before.snapshot);
  assert.equal(after.rows, before.rows);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.loaded, true);
  assert.equal(after.stale, true);
  assert.match(after.error, /ledger offline/);
});

test("an off-screen edit invalidates freshness without discarding the last snapshot", async () => {
  const fixture = mount();
  fixture.render().hydrate([{ policyId: "team" }], snapshot);
  const before = fixture.render();
  const oldRead = before.refreshLedger("https://console.example");
  before.invalidate();
  const stale = fixture.render();
  assert.equal(stale.loaded, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.updatedAt, before.updatedAt);
  assert.equal(stale.snapshot, snapshot);
  assert.equal(stale.error, "");
  const refresh = stale.refreshLedger("https://console.example");
  assert.notEqual(refresh, oldRead);
  fixture.requests[0].resolve({ policies: [], usage: empty });
  await oldRead;
  assert.equal(fixture.render().stale, true);
  assert.equal(fixture.render().snapshot, snapshot);
  assert.equal(fixture.render().refreshLedger("https://console.example"), refresh);
  fixture.requests[1].resolve({ policies: [], usage: empty });
  await refresh;
  assert.equal(fixture.render().stale, false);
});

test("unmount retires metadata failure ownership and the next lifetime starts unknown", () => {
  const previous = mount();
  const oldFailure = previous.render().captureRefreshFailure();
  previous.unmount();
  const fixture = mount();
  let hook = fixture.render();
  oldFailure("old bootstrap failed");
  assert.equal(previous.render().error, "");
  assert.equal(fixture.render().error, "");
  hook.captureRefreshFailure()("current bootstrap failed");
  hook = fixture.render();
  assert.equal(hook.loaded, false);
  assert.equal(hook.updatedAt, null);
  assert.equal(hook.error, "current bootstrap failed");
});

test("metadata failure retains an idle last-good snapshot as stale", () => {
  const fixture = mount();
  fixture.render().hydrate([{ policyId: "team" }], snapshot);
  const before = fixture.render();
  before.captureRefreshFailure()("bootstrap failed");
  const after = fixture.render();
  assert.equal(after.snapshot, before.snapshot);
  assert.equal(after.rows, before.rows);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.loaded, true);
  assert.equal(after.stale, true);
  assert.equal(after.error, "bootstrap failed");
});

for (const capture of ["before read", "while pending"]) {
  for (const outcome of ["resolve", "reject"]) {
    test(`metadata failure yields to ledger ${outcome} captured ${capture}`, async () => {
      const fixture = mount();
      fixture.render().hydrate([{ policyId: "team" }], snapshot);
      const hook = fixture.render();
      let metadataFailure = hook.captureRefreshFailure();
      const read = hook.refreshLedger("https://console.example");
      if (capture === "while pending") metadataFailure = hook.captureRefreshFailure();
      assert.equal(hook.refreshLedger("https://console.example"), read);
      assert.equal(fixture.requests.length, 1);
      const next = { ...snapshot, summary: { ...snapshot.summary, requestCount: 42 } };
      fixture.requests[0][outcome](outcome === "resolve" ? { policies: [], usage: next } : new Error("ledger failed"));
      await read;
      const before = fixture.render();
      metadataFailure("bootstrap failed later");
      const after = fixture.render();
      assert.equal(after.snapshot, before.snapshot);
      assert.equal(after.updatedAt, before.updatedAt);
      assert.equal(after.stale, outcome === "reject");
      assert.equal(after.error, outcome === "reject" ? "Usage ledger unavailable: ledger failed" : "");
    });
  }
}

for (const outcome of ["resolve", "reject"]) {
  test(`unmount ignores a retired lifetime's late ${outcome} without affecting the new owner`, async () => {
    const previous = mount();
    let hook = previous.render();
    hook.hydrate([{ policyId: "first" }], snapshot);
    const oldRead = hook.refreshLedger("https://console.example");
    previous.unmount();
    const fixture = mount();
    hook = fixture.render();
    assert.equal(hook.loaded, false);
    assert.equal(hook.updatedAt, null);
    assert.deepEqual(hook.rows, []);
    assert.equal(hook.error, "");
    const currentRead = hook.refreshLedger("https://console.example");
    previous.requests[0][outcome](outcome === "resolve" ? { policies: [{ policyId: "first" }], usage: snapshot } : new Error("old failure"));
    await oldRead;
    hook = fixture.render();
    assert.equal(hook.loaded, false);
    assert.equal(hook.error, "");
    assert.equal(hook.refreshLedger("https://console.example"), currentRead);
    fixture.requests[0].resolve({ policies: [{ policyId: "second" }], usage: snapshot });
    await currentRead;
    assert.deepEqual(fixture.render().rows, [{ policyId: "second" }]);
  });
}

function mount() {
  const slots = [], requests = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  };
  const useRef = (initial) => useState(() => ({ current: initial }))[0];
  let mounted = false, cleanup;
  const useEffect = (setup) => { if (!mounted) { mounted = true; cleanup = setup(); } };
  const request = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
  const settled = async (load) => {
    try { return { ok: true, value: await load() }; }
    catch (error) { return { ok: false, error: error.message }; }
  };
  const useUsage = new Function("useState", "useRef", "useEffect", "demo", "emptyUsageSnapshot", "settled", `${source}\nreturn useUsage;`)(useState, useRef, useEffect, {}, empty, settled);
  return { requests, unmount: () => cleanup?.(), render: () => { cursor = 0; return useUsage(false, request); } };
}
