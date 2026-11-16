import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deepSeekHeldFailure, deepSeekHeldPrefix, decodeDeepSeekHeldDiagnostic } from "../scripts/worker-test-failure-reporter.mjs";

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
  const calls = [], frames = [], cancelStarted = deferred(), barrierClosed = deferred();
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
    assert, Promise, deepSeekHeldFailure,
    AbortController: class { constructor() { this.signal = {}; } abort(reason) { callerReason = reason; calls.push("abort"); } },
    setTimeout(fn, delay) { assert.equal(delay, 45_000); timer = fn; return 1; },
    clearTimeout(id) { assert.equal(id, 1); calls.push("clearTimeout"); fail("timerFailure"); },
    abortBarrier: async () => { fail("setupFailure"); return barrier; },
    mkdtemp: async () => "synthetic-directory", tmpdir: () => "synthetic-root", join: (...parts) => parts.join("/"),
    loadHelper: async () => ({ startWorkerdFixture: async () => mf }),
    routerFixture: () => "synthetic-router", upstreamFixture: () => "synthetic-upstream", query: "synthetic",
    TextDecoder: class { decode(value) { return value; } },
    fetch: async url => ({ text: async () => url.endsWith("/seen") ? "seen" : "socket-closed" }),
    console: { log(label) { calls.push(label); if (options.reportFailures && Object.hasOwn(options.reportFailures, label)) throw options.reportFailures[label]; } },
    rm: async () => { calls.push("remove"); fail("removeFailure"); },
  };
  new Function(...Object.keys(bindings), (options.registrationSource ?? registration).replace(loader, "await loadHelper()"))(...Object.values(bindings));
  assert.equal(typeof callback, "function");
  return {
    result: outcome(callback({ diagnostic(frame) { calls.push("held.diagnostic"); fail("diagnosticFailure"); frames.push(frame); } })), calls, frames, cancelStarted: cancelStarted.promise, barrierClosed: barrierClosed.promise,
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
  assert.equal(actual.frames.length, 0, "no report before the original held cancellation joins");
  pending.reject(undefined);
  const result = await completion;
  assert.equal(result.failed, true);
  assert.ok(result.reason instanceof AggregateError);
  assert.equal(result.reason.errors.length, 2);
  assert.equal(result.reason.errors[0].message, "bounded DeepSeek ownership probe expired");
  assert.equal(result.reason.errors[1], undefined);
  assertOwned(actual);
});

// BEGIN standalone held diagnostic accounting tests.
function heldRecord(actual) {
  assert.equal(actual.frames.length, 1);
  assert.ok(actual.frames[0].startsWith(deepSeekHeldPrefix));
  const row = decodeDeepSeekHeldDiagnostic(JSON.parse(actual.frames[0].slice(deepSeekHeldPrefix.length)));
  assert.ok(row); return row;
}
for (const reason of [undefined, {}]) {
  for (const [fault, phase] of [["setupFailure", "setup"], ["readFailure", "upstream"], ["disposeFailure", "cleanup"]]) {
    test(`DeepSeek held diagnostic accounts ${fault} without inspecting its ${reason === undefined ? "undefined" : "defined"} reason`, async () => {
      const actual = run({ [fault]: reason }), result = await actual.result;
      assert.equal(result.failed, true); assert.equal(result.reason, reason);
      const row = heldRecord(actual); assert.equal(row.phase, phase); assert.equal(row.reasonDefined, reason !== undefined);
      assert.deepEqual(row.counts, [1, reason === undefined ? 1 : 0, 0, 0]);
    });
  }
}
test("DeepSeek held diagnostic first means accounting order, including original cancel and observer failures", async () => {
  const cancel = {}, actual = run({ cancelFailure: cancel, observerFailure: undefined, disposeFailure: undefined });
  const result = await actual.result; assert.deepEqual(result.reason.errors, [cancel, undefined, undefined]);
  const row = heldRecord(actual); assert.equal(row.phase, "cleanup"); assert.equal(row.reasonDefined, true); assert.deepEqual(row.counts, [3, 2, 0, 0]);
  assertOwned(actual);
});
test("DeepSeek held diagnostic separates earlier reporting failures and never replaces its write failure", async () => {
  const primary = {}, actual = run({ readFailure: primary, reportFailures: { "deepseek-held-cleanup": undefined } });
  assert.deepEqual((await actual.result).reason.errors, [primary, undefined]);
  assert.deepEqual(heldRecord(actual).counts, [1, 0, 1, 1]);
  const failed = run({ readFailure: primary, diagnosticFailure: undefined });
  assert.deepEqual((await failed.result).reason.errors, [primary, undefined]); assert.equal(failed.frames.length, 0);
  assertOwned(failed);
});
test("DeepSeek held diagnostic does not invent an original failure for a reporting-only failure", async () => {
  const actual = run({ reportFailures: { "deepseek-held-ownership": undefined } });
  assert.equal((await actual.result).reason, undefined); const row = heldRecord(actual);
  assert.equal(row.phase, null); assert.equal(row.failurePresent, false); assert.equal(row.reasonDefined, null); assert.deepEqual(row.counts, [0, 0, 1, 1]);
});
test("DeepSeek held successful accounting emits no diagnostic", async () => {
  const actual = run(); assert.equal((await actual.result).failed, false); assert.equal(actual.frames.length, 0); assertOwned(actual);
});
// END standalone held diagnostic accounting tests.

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

function workerJoinFixture() {
  const record = { path: "/v1/native/deepseek/v1/tools/search", returned: deferred(), pending: [], failures: [] };
  record.returned.resolve();
  const proof = { terminal: deferred(), reads: [], cancels: [], observers: [], failures: [], readCalls: 0, cancelCalls: 0,
    activeReads: 0, eof: false, canceled: false, readRejected: false, unlocked: true, source: { locked: false }, physical: { locked: false } };
  proof.terminal.resolve();
  const records = [record], requests = new Map([["ds_abort", records]]), inputs = new Map([["ds_abort", proof]]);
  const begin = source.indexOf("const joinOwners = new Map();");
  const end = source.indexOf("\nexport default", begin);
  assert.ok(begin >= 0 && end > begin);
  const join = new Function("requests", "inputs", "bodyBudgetCharged", source.slice(begin, end) + ";return join;")(requests, inputs, () => 0);
  const observerBegin = source.indexOf("function retainDeepSeekObserver(");
  const observerEnd = source.indexOf("\nconst policy", observerBegin);
  const retain = new Function(source.slice(observerBegin, observerEnd) + ";return retainDeepSeekObserver;")();
  return { join: () => join("ds_abort"), record, records, requests, inputs, proof, retain };
}

function countedPromise() {
  const pending = deferred(), subscribed = deferred();
  const then = pending.promise.then;
  let count = 0;
  pending.promise.then = function (...args) {
    assert.equal(this, pending.promise);
    count++; subscribed.resolve();
    return Reflect.apply(then, this, args);
  };
  return { ...pending, subscribed: subscribed.promise, count: () => count };
}

for (const reason of [undefined, new Error("synthetic request work failure")]) {
  test(`DeepSeek Worker joins held original cancellation after ${reason === undefined ? "undefined" : "defined"} waitUntil rejection`, async () => {
    const f = workerJoinFixture(), cancel = countedPromise();
    f.record.pending.push(Promise.reject(reason));
    f.proof.cancels.push(cancel.promise); f.proof.cancelCalls++;
    const first = f.join(); assert.equal(f.join(), first);
    let finished = false;
    const completion = outcome(first).then(value => { finished = true; return value; });
    await cancel.subscribed;
    await Promise.resolve();
    assert.equal(finished, false);
    cancel.resolve();
    assert.deepEqual(await completion, { failed: true, reason });
    assert.equal(cancel.count(), 1);
    assert.deepEqual(await outcome(f.join()), { failed: true, reason });
    assert.equal(cancel.count(), 1);
  });
}

test("DeepSeek Worker retains independent undefined, cancel and observer failures without flattening", async () => {
  const f = workerJoinFixture(), cancel = {}, observer = new AggregateError([undefined], "synthetic observer");
  f.record.pending.push(Promise.reject(undefined));
  f.proof.cancels.push(Promise.reject(cancel)); f.proof.cancelCalls++;
  f.retain(f.proof, Promise.reject(observer));
  f.proof.failures.push(undefined);
  const result = await outcome(f.join());
  assert.equal(result.failed, true);
  assert.deepEqual(result.reason.errors, [undefined, cancel, observer, undefined]);
});

test("DeepSeek Worker registration failure cannot skip a later original", async () => {
  const f = workerJoinFixture(), cancel = countedPromise();
  f.record.pending.push({ get then() { throw undefined; } });
  f.proof.cancels.push(cancel.promise); f.proof.cancelCalls++;
  let finished = false;
  const result = outcome(f.join()).then(value => { finished = true; return value; });
  await cancel.subscribed; await Promise.resolve();
  assert.equal(finished, false);
  cancel.resolve();
  assert.deepEqual(await result, { failed: true, reason: undefined });
});

test("DeepSeek Worker fixed point includes tails appended by an already attached observer", async () => {
  const f = workerJoinFixture(), read = countedPromise(), cancel = countedPromise(), tail = deferred(), failure = {};
  f.proof.reads.push(read.promise); f.proof.readCalls++;
  const observer = read.promise.then(() => {
    f.proof.cancels.push(cancel.promise); f.proof.cancelCalls++;
    f.record.pending.push(Promise.reject(failure));
    f.retain(f.proof, tail.promise);
  });
  f.retain(f.proof, observer);
  let finished = false;
  const result = outcome(f.join()).then(value => { finished = true; return value; });
  read.resolve({ done: true });
  await cancel.subscribed; await Promise.resolve();
  assert.equal(finished, false);
  cancel.resolve(); await Promise.resolve();
  assert.equal(finished, false);
  tail.resolve();
  assert.deepEqual(await result, { failed: true, reason: failure });
  assert.equal(read.count(), 2); // Existing source observer plus one join subscription.
  assert.equal(cancel.count(), 1);
});

test("DeepSeek Worker successful join cannot cache acceptance over a later cancel rejection", async () => {
  const f = workerJoinFixture(), read = countedPromise(), cancel = countedPromise();
  f.proof.reads.push(read.promise); f.proof.readCalls++;
  const first = f.join(); assert.equal(first, f.join());
  read.resolve({ done: true });
  assert.equal((await first).retired, true);
  assert.equal(read.count(), 1);
  f.proof.cancels.push(cancel.promise); f.proof.cancelCalls++;
  const second = outcome(f.join()); cancel.reject(undefined);
  assert.deepEqual(await second, { failed: true, reason: undefined });
  assert.deepEqual(await outcome(f.join()), { failed: true, reason: undefined });
  assert.equal(read.count(), 1); assert.equal(cancel.count(), 1);
});

test("DeepSeek Worker preserves its distinct read-rejection oracle but a late cancel alias is fatal", async () => {
  const f = workerJoinFixture(), read = countedPromise(), reason = {};
  f.proof.reads.push(read.promise); f.proof.readCalls++; f.proof.readRejected = true;
  const first = f.join(); read.reject(reason);
  assert.deepEqual((await first).readResults, ["rejected"]);
  f.proof.cancels.push(read.promise); f.proof.cancelCalls++;
  assert.deepEqual(await outcome(f.join()), { failed: true, reason });
  assert.equal(read.count(), 1);
});

test("DeepSeek Worker reentrant self-join fails after independent cancellation settles", async () => {
  const f = workerJoinFixture(), cancel = countedPromise();
  let reentrant;
  f.record.pending.push({ then(resolve) {
    reentrant = f.join(); f.record.pending.push(reentrant);
    return Promise.resolve().then(() => resolve());
  } });
  f.proof.cancels.push(cancel.promise); f.proof.cancelCalls++;
  const first = f.join(); assert.equal(reentrant, first);
  let finished = false;
  const result = outcome(first).then(value => { finished = true; return value; });
  await cancel.subscribed; await Promise.resolve(); assert.equal(finished, false);
  cancel.resolve();
  const failure = await result;
  assert.equal(failure.failed, true);
  assert.match(failure.reason.message, /cannot own itself/);
});

test("DeepSeek Worker retains original cancellation and its failed join observer", async () => {
  const f = workerJoinFixture(), original = {}, observer = {};
  const promise = Promise.reject(original), then = promise.then;
  promise.then = function (...args) { return Reflect.apply(then, this, args).then(() => { throw observer; }); };
  f.proof.cancels.push(promise); f.proof.cancelCalls++;
  const result = await outcome(f.join());
  assert.equal(result.failed, true);
  assert.deepEqual(result.reason.errors, [original, observer]);
});

test("DeepSeek Worker rejects removed ownership while still draining captured originals", async () => {
  const f = workerJoinFixture(), cancel = countedPromise();
  f.proof.cancels.push(cancel.promise); f.proof.cancelCalls++;
  const result = outcome(f.join());
  await cancel.subscribed;
  f.proof.cancels.length = 0;
  cancel.resolve();
  const failure = await result;
  assert.equal(failure.failed, true);
  assert.match(failure.reason.message, /ledger changed/);
});

test("DeepSeek Worker records original waitUntil registration failure before joining", async () => {
  const f = workerJoinFixture(), pending = countedPromise();
  const start = source.indexOf("const ctx = { waitUntil(promise)");
  const end = source.indexOf("\n    try { return await worker.fetch", start);
  const context = { waitUntil(promise) { assert.equal(promise, pending.promise); throw undefined; } };
  const ctx = new Function("record", "context", source.slice(start, end) + ";return ctx;")(f.record, context);
  let threw = false;
  try { ctx.waitUntil(pending.promise); } catch (error) { threw = true; assert.equal(error, undefined); }
  assert.equal(threw, true); assert.equal(f.record.pending[0], pending.promise);
  let finished = false;
  const result = outcome(f.join()).then(value => { finished = true; return value; });
  await pending.subscribed; await Promise.resolve(); assert.equal(finished, false);
  pending.resolve(); assert.deepEqual(await result, { failed: true, reason: undefined });
});

test("DeepSeek Worker retains exact read/cancel callback promises without changing native call operands", async () => {
  const read = deferred(), cancel = deferred(), inputs = new Map(), reason = {};
  let callbacks, reads = 0, cancels = 0, unlocks = 0;
  const reader = {
    read(...args) { assert.equal(this, reader); assert.deepEqual(args, []); reads++; return read.promise; },
    cancel(...args) { assert.equal(this, reader); assert.deepEqual(args, [reason]); cancels++; return cancel.promise; },
    releaseLock() { assert.equal(this, reader); unlocks++; },
    get closed() { throw new Error("no new closed observation"); },
  };
  const physical = { getReader: () => reader, locked: false };
  const bindings = {
    globalThis: {}, ids: ["ds_abort"], inputs, deferred, fixtureEnv: {}, policy: () => ({}),
    budgetStatus: async () => ({ spentMicros: 750 }),
    rawFetch: async () => ({ body: physical, status: 200, headers: {} }),
    refuse: message => { throw new Error(message); },
    Request: class { constructor(input) { return input; } },
    Response: class { constructor(body) { this.body = body; } },
    ReadableStream: class { constructor(source, options) { callbacks = source; assert.equal(options.highWaterMark, 0); this.locked = false; } },
  };
  const observerStart = source.indexOf("function retainDeepSeekObserver(");
  const observerEnd = source.indexOf("\nconst policy", observerStart);
  const fetchStart = source.indexOf("globalThis.fetch = async");
  const fetchEnd = source.indexOf("\nconst joinOwners", fetchStart);
  const fetch = new Function(...Object.keys(bindings), source.slice(observerStart, observerEnd) + source.slice(fetchStart, fetchEnd) + ";return globalThis.fetch;")(...Object.values(bindings));
  await fetch({ url: "https://api.deepseek.com/v1/tools/search", method: "POST", headers: { get: () => "Bearer managed-ds_abort" } });
  const proof = inputs.get("ds_abort");
  const errors = [];
  const pull = callbacks.pull({ error: error => errors.push(error), close() {}, enqueue() {} });
  const cancellation = callbacks.cancel(reason);
  assert.equal(proof.reads[0], read.promise); assert.equal(proof.cancels[0], cancel.promise);
  assert.equal(proof.observers[0], pull); assert.equal(proof.observers[2], cancellation);
  read.reject(undefined); await pull;
  assert.deepEqual(errors, [undefined]);
  cancel.resolve(); await cancellation;
  await Promise.all(proof.observers);
  assert.equal(reads, 1); assert.equal(cancels, 1); assert.equal(unlocks, 1);
});
