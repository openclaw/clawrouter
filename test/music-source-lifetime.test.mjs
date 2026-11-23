import assert from "node:assert/strict";
import test from "node:test";
import { createMusicSourceLifetime } from "./helpers/music-source-lifetime.mjs";

function fixture(mode) {
  const controller = new AbortController(), call = { aborted: false, canceled: false, expired: false }, timers = new Map(), tails = [];
  const runtime = {
    setTimeout(callback, delay) {
      assert.equal(delay, 120000);
      if (mode === "timer-undefined") throw undefined;
      const handle = {}; timers.set(handle, callback); return handle;
    },
    clearTimeout(handle) { if (mode === "clear-undefined") throw undefined; assert.ok(timers.delete(handle)); },
  };
  if (mode === "remove-undefined") {
    const original = controller.signal.removeEventListener;
    controller.signal.removeEventListener = function(...args) { Reflect.apply(original, this, args); throw undefined; };
  }
  const owner = createMusicSourceLifetime(controller.signal, call, { waitUntil(p) {
    tails.push(p); void p.catch(() => {}); if (mode === "tail-undefined") throw undefined;
  } }, 120000, runtime);
  return { owner, controller, call, timers, tails, fire() { for (const [handle, callback] of timers) { timers.delete(handle); callback(); } } };
}
const leaves = error => error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
async function joined(f) { await Promise.allSettled(f.tails); return f.owner.join(); }
function closed(f) {
  assert.equal(f.timers.size, 0); assert.equal(f.call.sourceLifetime.timerActive, false);
  assert.equal(f.call.sourceLifetime.pending, 0); assert.equal(f.call.sourceLifetime.finished, true);
}

test("held producer retains native timer until real abort and joins original callbacks", async () => {
  const f = fixture(); let settled = false; void f.owner.done.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false); assert.equal(f.timers.size, 1);
  f.controller.abort(new Error("caller")); await joined(f); closed(f);
  assert.equal(f.call.sourceLifetime.abortCalls, 1); assert.equal(f.call.sourceLifetime.abortReturned, 1);
  assert.equal(f.call.sourceLifetime.listenerActive, false); assert.equal(f.call.sourceLifetime.timer, "canceled");
  assert.equal(f.call.aborted, true); assert.equal(f.call.canceled, false); assert.equal(f.call.expired, false);
});

test("actual source cancel returns its retained original and never invents a signal abort", async () => {
  const f = fixture(), pending = f.owner.cancel();
  assert.equal(f.owner.callbacks[0], pending); assert.ok(f.owner.originals.includes(pending));
  assert.ok(f.tails.includes(pending)); assert.equal(f.call.sourceLifetime.cancelReturned, 0);
  await pending; await joined(f); closed(f);
  assert.equal(f.call.sourceLifetime.cancelReturned, 1); assert.equal(f.call.canceled, true); assert.equal(f.call.aborted, false);
});

test("abort then actual cancel retains both originals without rewriting the first outcome", async () => {
  const f = fixture(); f.controller.abort(); await f.owner.done;
  const pending = f.owner.cancel(); await pending; await joined(f); closed(f);
  assert.equal(f.call.sourceLifetime.terminal, "abort"); assert.equal(f.call.sourceLifetime.cancelReturned, 1);
});

for (const reason of [undefined, new Error("original producer failure")]) {
  test(`producer failure remains fatal (${reason === undefined ? "undefined" : "defined"}) and closes its timer`, async () => {
    const f = fixture();
    assert.equal(f.owner.fail(reason), f.owner.done);
    await assert.rejects(joined(f), error => leaves(error).includes(reason)); closed(f);
    assert.equal(f.call.sourceLifetime.listenerActive, false);
    assert.equal(f.call.sourceLifetime.terminal, "failed");
    assert.equal(f.call.aborted, false); assert.equal(f.call.canceled, false);
  });
}

for (const mode of ["expiry", "foreign-cancel", "duplicate-cancel", "foreign-event", "dispose"]) {
  test(`held source keeps ${mode} fatal and releases owned resources`, async () => {
    const f = fixture();
    if (mode === "expiry") f.fire();
    if (mode === "foreign-cancel") await assert.rejects(f.owner.cancel(new AbortController().signal));
    if (mode === "duplicate-cancel") { await f.owner.cancel(); await assert.rejects(f.owner.cancel()); }
    if (mode === "foreign-event") f.controller.signal.dispatchEvent(new Event("abort"));
    if (mode === "dispose") await assert.rejects(f.owner.dispose());
    await assert.rejects(joined(f), AggregateError); closed(f);
    assert.equal(f.call.sourceLifetime.listenerActive, false);
    if (mode !== "duplicate-cancel") assert.equal(f.call.canceled, false);
    if (mode === "expiry") { assert.equal(f.call.expired, true); assert.equal(f.call.aborted, false); }
  });
}

for (const mode of ["timer-undefined", "clear-undefined", "remove-undefined", "tail-undefined"]) {
  test(`held source retains original undefined ${mode} failure`, async () => {
    const f = fixture(mode);
    if (mode === "clear-undefined" || mode === "remove-undefined") f.controller.abort();
    if (mode === "clear-undefined") {
      await Promise.resolve(); await Promise.resolve();
      assert.equal(f.timers.size, 1, "failed cancellation cannot pretend the native timer stopped"); f.fire();
    }
    await assert.rejects(joined(f), error => leaves(error).includes(undefined)); closed(f);
  });
}

test("source watchdog rejects absent, nonfinite and increased budgets before acquiring resources", () => {
  for (const delay of [undefined, null, 0, -1, NaN, Infinity, 120001]) {
    let touched = false;
    assert.throws(() => createMusicSourceLifetime(new AbortController().signal, {}, { waitUntil() { touched = true; } }, delay,
      { setTimeout() { touched = true; }, clearTimeout() { touched = true; } }));
    assert.equal(touched, false);
  }
});
