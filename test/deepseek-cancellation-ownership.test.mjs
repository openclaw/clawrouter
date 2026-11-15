import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./openclaw-deepseek-search.test.mjs", import.meta.url), "utf8");
const name = "DeepSeek held upstream joins original cancellation before teardown";
const start = source.indexOf(`test("${name}"`);
const end = source.indexOf('\ntest("actual OpenClaw DeepSeek', start);
assert.ok(start >= 0 && end > start);
const registration = source.slice(start, end);
const loader = 'await import("./helpers/workerd.mjs")';
assert.equal(registration.split(loader).length, 2);

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

const outcome = promise => promise.then(value => ({ failed: false, value }), reason => ({ failed: true, reason }));
const has = (options, name) => Object.hasOwn(options, name);

// Execute only the exact registration/callback with inert owners. No fixture
// module, Worker, socket, stream, native timer or dependency is instantiated.
function run(options = {}) {
  const calls = [], cancelStarted = deferred(), barrierClosed = deferred();
  let callback, timer, callerReason, originalCancel, subscriptions = 0, observerCalls = 0, receiver, args;
  const fail = key => { if (has(options, key)) throw options[key]; };
  const reader = {
    async read() { fail("readFailure"); return { value: '{"results":[' }; },
    cancel(...values) {
      calls.push("cancel"); receiver = this; args = values;
      cancelStarted.resolve(); fail("cancelThrow");
      originalCancel = options.pending?.promise ?? (has(options, "cancelFailure")
        ? Promise.reject(options.cancelFailure) : options.sameReason ? Promise.reject(values[0]) : Promise.resolve());
      const originalThen = originalCancel.then;
      originalCancel.then = function (...values) {
        subscriptions++; observerCalls++;
        assert.equal(this, originalCancel);
        const observed = Reflect.apply(originalThen, this, values);
        return has(options, "observerFailure") ? observed.then(() => { throw options.observerFailure; }) : observed;
      };
      return originalCancel;
    },
    releaseLock() { calls.push("unlock"); fail("unlockFailure"); },
  };
  const barrier = {
    origin: "https://control.example",
    state: () => ({ requests: 1, responseClosed: false, socketClosed: false, teardown: false }),
    async close() { calls.push("barrier.close"); barrierClosed.resolve(); fail("barrierFailure"); },
  };
  const upstream = { async fetch(url) {
    if (url.endsWith("/state")) { fail("bodyFailure"); return { json: async () => [{ finished: true, abort: {} }] }; }
    return { body: { getReader: () => reader } };
  } };
  const mf = { getWorker: async () => upstream, async dispose() { calls.push("dispose"); fail("disposeFailure"); } };
  const bindings = {
    test(actual, options, body) { assert.equal(actual, name); assert.equal(options.timeout, 60_000); callback = body; },
    assert, Promise,
    AbortController: class { constructor() { this.signal = {}; } abort(reason) { callerReason = reason; calls.push("abort"); } },
    setTimeout(fn, delay) { assert.equal(delay, 45_000); timer = fn; return 1; },
    clearTimeout(id) { assert.equal(id, 1); calls.push("clearTimeout"); fail("timerFailure"); },
    abortBarrier: async () => barrier,
    mkdtemp: async () => "synthetic-directory", tmpdir: () => "synthetic-root", join: (...parts) => parts.join("/"),
    loadHelper: async () => ({ startWorkerdFixture: async () => mf }),
    routerFixture: () => "synthetic-router", upstreamFixture: () => "synthetic-upstream", query: "synthetic",
    TextDecoder: class { decode(value) { return value; } },
    fetch: async url => ({ text: async () => url.endsWith("/seen") ? "seen" : "socket-closed" }),
    console: { log(label) { calls.push(label); if (options.reportFailures && Object.hasOwn(options.reportFailures, label)) throw options.reportFailures[label]; } },
    rm: async () => { calls.push("remove"); fail("removeFailure"); },
  };
  new Function(...Object.keys(bindings), registration.replace(loader, "await loadHelper()"))(...Object.values(bindings));
  assert.equal(typeof callback, "function");
  return {
    result: outcome(callback()), calls, cancelStarted: cancelStarted.promise, barrierClosed: barrierClosed.promise,
    expire: () => timer(), facts: () => ({ subscriptions, observerCalls, receiver, args, reader, callerReason }),
  };
}

function assertOwned(run) {
  const facts = run.facts();
  assert.equal(facts.receiver, facts.reader);
  assert.deepEqual(facts.args, [facts.callerReason]);
  assert.equal(run.calls.filter(value => value === "cancel").length, 1);
  assert.equal(facts.subscriptions, 1);
  assert.equal(facts.observerCalls, 1);
  assert.equal(run.calls.filter(value => value === "barrier.close").length, 1);
  assert.equal(run.calls.filter(value => value === "dispose").length, 1);
  assert.equal(run.calls.filter(value => value === "remove").length, 1);
}

test("DeepSeek diagnostic fulfills only after its original successful cancellation and cleanup", async () => {
  const actual = run();
  assert.deepEqual(await actual.result, { failed: false, value: undefined });
  assertOwned(actual);
});

for (const failure of [undefined, new Error("synthetic cancel rejection")]) {
  test(`DeepSeek diagnostic retains ${failure === undefined ? "undefined" : "defined"} cancel rejection when all assertions succeed`, async () => {
    const actual = run({ cancelFailure: failure });
    assert.deepEqual(await actual.result, { failed: true, reason: failure });
    assertOwned(actual);
  });
}

test("DeepSeek diagnostic does not exempt cancellation with its caller reason", async () => {
  const actual = run({ sameReason: true });
  const result = await actual.result;
  assert.equal(result.failed, true);
  assert.equal(result.reason, actual.facts().callerReason);
  assertOwned(actual);
});

test("DeepSeek diagnostic preserves body, cancel, cleanup and reporting failures in order", async () => {
  const primary = {}, barrier = {}, disposal = {}, remove = {}, report = {};
  let getters = 0;
  Object.defineProperty(primary, "name", { get() { getters++; throw new Error("must not inspect errors"); } });
  const actual = run({ bodyFailure: primary, cancelFailure: undefined, barrierFailure: barrier, disposeFailure: disposal,
    removeFailure: remove, reportFailures: { "deepseek-held-cleanup": report, "deepseek-held-failures": undefined } });
  const result = await actual.result;
  assert.equal(result.failed, true);
  assert.ok(result.reason instanceof AggregateError);
  assert.deepEqual(result.reason.errors, [primary, undefined, barrier, disposal, remove, report, undefined]);
  assert.equal(getters, 0);
  assertOwned(actual);
});

test("DeepSeek diagnostic waits for its pending original cancel after the bounded body fails", async () => {
  const pending = deferred();
  const actual = run({ pending });
  let finished = false;
  const completion = actual.result.then(value => { finished = true; return value; });
  await actual.cancelStarted;
  actual.expire();
  await actual.barrierClosed;
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(actual.calls.includes("dispose"), false);
  pending.reject(undefined);
  const result = await completion;
  assert.equal(result.failed, true);
  assert.ok(result.reason instanceof AggregateError);
  assert.equal(result.reason.errors.length, 2);
  assert.equal(result.reason.errors[0].message, "bounded DeepSeek ownership probe expired");
  assert.equal(result.reason.errors[1], undefined);
  assertOwned(actual);
});

for (const failure of [undefined, new Error("synthetic observer rejection")]) {
  test(`DeepSeek diagnostic retains ${failure === undefined ? "undefined" : "defined"} observer failure and completes cleanup`, async () => {
    const actual = run({ observerFailure: failure });
    assert.deepEqual(await actual.result, { failed: true, reason: failure });
    assertOwned(actual);
  });
}

for (const cancelFailure of [undefined, new Error("synthetic original cancel rejection")]) {
  for (const observerFailure of [undefined, new Error("synthetic observer-tail rejection")]) {
    test(`DeepSeek diagnostic retains ${cancelFailure === undefined ? "undefined" : "defined"} original and ${observerFailure === undefined ? "undefined" : "defined"} observer rejections`, async () => {
      const actual = run({ cancelFailure, observerFailure });
      const result = await actual.result;
      assert.equal(result.failed, true);
      assert.ok(result.reason instanceof AggregateError);
      assert.deepEqual(result.reason.errors, [cancelFailure, observerFailure]);
      assertOwned(actual);
    });
  }
}

for (const failure of [undefined, new Error("synthetic synchronous cancel failure")]) {
  test(`DeepSeek diagnostic does not retry ${failure === undefined ? "undefined" : "defined"} synchronous cancel failure`, async () => {
    const actual = run({ cancelThrow: failure });
    assert.deepEqual(await actual.result, { failed: true, reason: failure });
    assert.equal(actual.calls.filter(value => value === "cancel").length, 1);
    assert.equal(actual.calls.filter(value => value === "unlock").length, 1);
    assert.equal(actual.facts().observerCalls, 0);
    assert.ok(actual.calls.includes("dispose") && actual.calls.includes("remove"));
  });
}

test("DeepSeek diagnostic cancels once on an earlier body failure and retains cleanup rejection", async () => {
  const actual = run({ readFailure: undefined, cancelFailure: undefined });
  const result = await actual.result;
  assert.equal(result.failed, true);
  assert.deepEqual(result.reason.errors, [undefined, undefined]);
  assertOwned(actual);
});

test("DeepSeek diagnostic reporting failure cannot skip successful original cleanup", async () => {
  const actual = run({ reportFailures: { "deepseek-held-ownership": undefined } });
  assert.deepEqual(await actual.result, { failed: true, reason: undefined });
  assertOwned(actual);
});
