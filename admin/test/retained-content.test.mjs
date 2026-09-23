import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Execute UsageScreen's actual state owner before its JSX; browser tests cover
// the two View entry points, Close controls, scoped requests and remounts.
const screen = await readFile(new URL("../src/screens/users-usage.tsx", import.meta.url), "utf8");
const start = screen.indexOf("export function UsageScreen(");
const end = screen.indexOf("  const activePolicies", start);
assert.ok(start >= 0 && end > start);
const source = stripTypeScriptTypes(`${screen.slice(start, end)}return { inspectContent, closeContent, retainedContent, contentError, contentLoading };\n}`)
  .replace("export function UsageScreen", "function UsageScreen");
const event = (ref) => ({ tenant_id: "fixture tenant", content_ref: ref });
const content = (requestId) => ({ requestId, body: { input: requestId } });

for (const outcome of ["success", "error"]) {
  for (const order of ["before", "after"]) {
    test(`an older ${outcome} settling ${order} the latest read cannot publish or finish its loading`, async () => {
      const fixture = mount();
      const old = fixture.render().inspectContent(event("first"));
      const latest = fixture.render().inspectContent(event("second"));
      assert.equal(fixture.requests[0].init.signal.aborted, true);
      assert.equal(fixture.requests[1].init.signal.aborted, false);
      if (order === "after") {
        fixture.requests[1].resolve(content("second"));
        await latest;
      }
      settle(fixture.requests[0], outcome, "first");
      await old;
      assert.equal(fixture.render().contentLoading, order === "before");
      assert.equal(fixture.render().contentError, "");
      assert.equal(fixture.render().retainedContent?.requestId ?? null, order === "before" ? null : "second");
      if (order === "before") {
        fixture.requests[1].resolve(content("second"));
        await latest;
      }
      assert.deepEqual(fixture.render().retainedContent, content("second"));
      assert.equal(fixture.render().contentLoading, false);
    });
  }

  test(`Close retires a pending ${outcome}, including reopening the same reference`, async () => {
    const fixture = mount();
    const old = fixture.render().inspectContent(event("same/ref"));
    assert.match(fixture.requests[0].path, /tenant=fixture%20tenant&ref=same%2Fref$/);
    fixture.render().closeContent();
    assert.equal(fixture.requests[0].init.signal.aborted, true);
    assert.equal(fixture.render().contentLoading, false);
    const reopened = fixture.render().inspectContent(event("same/ref"));
    settle(fixture.requests[0], outcome, "old incarnation");
    await old;
    assert.equal(fixture.render().contentLoading, true);
    assert.equal(fixture.render().retainedContent, null);
    assert.equal(fixture.render().contentError, "");
    fixture.requests[1].resolve(content("new incarnation"));
    await reopened;
    assert.deepEqual(fixture.render().retainedContent, content("new incarnation"));
  });

  test(`unmount aborts the request and prevents late ${outcome} state writes`, async () => {
    const fixture = mount();
    const pending = fixture.render().inspectContent(event("first"));
    fixture.unmount();
    const writes = fixture.writes;
    assert.equal(fixture.requests[0].init.signal.aborted, true);
    settle(fixture.requests[0], outcome, "first");
    await pending;
    assert.equal(fixture.writes, writes);
  });
}

test("a new selection clears old content and Close clears current errors", async () => {
  const fixture = mount();
  const first = fixture.render().inspectContent(event("first"));
  fixture.requests[0].resolve(content("first"));
  await first;
  const second = fixture.render().inspectContent(event("second"));
  assert.equal(fixture.render().retainedContent, null);
  fixture.requests[1].reject(new Error("content expired"));
  await second;
  assert.equal(fixture.render().contentError, "content expired");
  assert.equal(fixture.render().contentLoading, false);
  fixture.render().closeContent();
  assert.equal(fixture.render().retainedContent, null);
  assert.equal(fixture.render().contentError, "");
  assert.equal(fixture.render().contentLoading, false);
});

function settle(request, outcome, requestId) {
  if (outcome === "success") request.resolve(content(requestId));
  else request.reject(new Error(`${requestId} unavailable`));
}

function mount() {
  const slots = [], requests = [], cleanups = [];
  let cursor = 0, mounted = false, writes = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next) => { writes += 1; slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  };
  const useRef = (initial) => useState(() => ({ current: initial }))[0];
  const useEffect = (setup) => { if (!mounted) { const cleanup = setup(); if (cleanup) cleanups.push(cleanup); } };
  // Ignore cancellation deliberately: publication ownership must not depend on transport behavior.
  const request = (_origin, path, init) => new Promise((resolve, reject) => requests.push({ path, init, resolve, reject }));
  const UsageScreen = new Function("useState", "useRef", "useEffect", "useConsole", "window", "errorMessage", `${source}\nreturn UsageScreen;`)(useState, useRef, useEffect, () => ({ request }), { location: { origin: "https://console.example" } }, (error) => error.message);
  return {
    requests, get writes() { return writes; }, unmount: () => cleanups.forEach((cleanup) => cleanup()),
    render: () => { cursor = 0; const owner = UsageScreen({}); mounted = true; return owner; },
  };
}
