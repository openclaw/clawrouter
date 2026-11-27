import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { sessionScopeKey } from "../src/session-scope.ts";
import { consoleStatusPresentation } from "../src/status-display.ts";

// Execute the session owner with queued state updates; browser journeys cover React integration.
const source = stripTypeScriptTypes(await readFile(new URL("../src/hooks/use-session.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export function useSession", "function useSession");
const emptySession = { authenticated: false, auth: "access", role: "user", email: null, tenantId: "default" };
const identity = { authenticated: true, auth: "cloudflare_access", role: "admin", email: "admin@example.com", tenantId: "default" };

for (const status of ["saving policy", "saved policy", "policy save failed (policy_a): unavailable", "issuing credential", "credential error: unavailable"]) {
  test(`a newer ${status} publication retires the older refresh before React renders`, () => {
    const fixture = mount();
    const session = fixture.render();
    const publish = session.captureStatusPublisher();
    session.setStatus(status);
    publish("connected");
    assert.equal(fixture.render().status, status);
  });
}

test("same-text writes and an ABA round trip still retire an older refresh", () => {
  const fixture = mount();
  const session = fixture.render();
  session.setStatus("saving policy");
  const sameText = session.captureStatusPublisher();
  session.setStatus("saving policy");
  sameText("connected");
  assert.equal(fixture.render().status, "saving policy");
  const roundTrip = session.captureStatusPublisher();
  session.setStatus("saved policy");
  session.setStatus("saving policy");
  roundTrip("connected");
  assert.equal(fixture.render().status, "saving policy");
});

test("functional updates retain Dispatch semantics, stable identity and synchronous ownership", () => {
  const fixture = mount();
  const session = fixture.render();
  const publish = session.captureStatusPublisher();
  session.setStatus((current) => `${current}; policy save failed`);
  publish("connected");
  assert.equal(fixture.render().status, "connected; policy save failed");
  assert.equal(fixture.render().setStatus, session.setStatus);

  session.setStatus((current) => current);
  const afterAdmission = session.captureStatusPublisher();
  fixture.render(); // The harness replays updater functions, as React may in Strict Mode.
  afterAdmission("connected");
  assert.equal(fixture.render().status, "connected");
});

for (const terminal of ["connected", "test-provider connected", "test-provider OAuth failed"]) {
  test(`an unchanged foreground publication preserves ${terminal}`, () => {
    const fixture = mount();
    const session = fixture.render();
    const publish = session.captureStatusPublisher();
    session.setRefreshError("");
    session.setLastUpdatedAt(123);
    publish(terminal);
    const current = fixture.render();
    assert.equal(current.status, terminal);
    assert.equal(current.refreshError, "");
    assert.equal(current.lastUpdatedAt, 123);
    session.setStatus("policy save failed (policy_a): unavailable");
    assert.equal(consoleStatusPresentation(fixture.render().status, false).showBar, true);
  });
}

test("accepted identity replacement and invalidation retire old publishers before rendering", () => {
  const fixture = mount();
  const session = fixture.render();
  const oldIdentity = session.captureStatusPublisher();
  session.accept({ ...identity, email: "second@example.com" }, false);
  oldIdentity("test-provider OAuth failed");
  assert.equal(fixture.render().status, "connected");
  assert.equal(fixture.render().setStatus, session.setStatus);
  const beforeSignOut = session.captureStatusPublisher();
  session.invalidate(session.captureScope());
  beforeSignOut("connected");
  assert.equal(fixture.render().status, "sign-in required");
});

test("same-identity metadata acceptance keeps the admitted publisher current", () => {
  const fixture = mount();
  const session = fixture.render();
  const publish = session.captureStatusPublisher();
  assert.equal(session.accept({ ...identity, groups: ["updated-group"] }, false), false);
  publish("test-provider OAuth failed");
  assert.equal(fixture.render().status, "test-provider OAuth failed");
});

function mount() {
  const slots = [], updates = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) {
      const slot = { value: typeof initial === "function" ? initial() : initial };
      slot.set = (next) => updates.push({ slot, next });
      slots[index] = slot;
    }
    return [slots[index].value, slots[index].set];
  };
  const useRef = (initial) => useState(() => ({ current: initial }))[0];
  const useMemo = (create, dependencies) => {
    const index = cursor++;
    if (!(index in slots) || dependencies.some((value, position) => !Object.is(value, slots[index].dependencies[position]))) slots[index] = { dependencies, value: create() };
    return slots[index].value;
  };
  const useCallback = (callback, dependencies) => useMemo(() => callback, dependencies);
  const window = { location: { origin: "https://console.example", pathname: "/dashboard/access", search: "", hash: "" } };
  const useSession = new Function("useState", "useRef", "useMemo", "useCallback", "window", "consoleStatusPresentation", "sessionScopeKey", "emptySession", "isLocalDemoAllowed", "initialViewFromPath", "adminViews", `${source}\nreturn useSession;`)(useState, useRef, useMemo, useCallback, window, consoleStatusPresentation, sessionScopeKey, emptySession, () => false, () => "policies", new Set(["policies"]));
  const render = () => {
    for (const { slot, next } of updates.splice(0)) {
      if (typeof next === "function") next(slot.value); // Discard the replay result.
      slot.value = typeof next === "function" ? next(slot.value) : next;
    }
    cursor = 0;
    return useSession();
  };
  render().accept(identity, false);
  return { render };
}
