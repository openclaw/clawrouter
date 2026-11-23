import assert from "node:assert/strict";
import test from "node:test";
import { types } from "node:util";
import { createMusicPassiveState, readMusicPassiveResponse, captureMusicPassiveState } from "./helpers/music-passive-state.mjs";

const protocol = createMusicPassiveState(types.isProxy);
const ready = id => ({ id, wait_entered: null, resolver_called: null, resolver_returned: null, wait_returned: null,
  matchingPosts: 0, waitCount: 0, cancelCalls: 0, failureCount: 0, timer: "unstarted", notification: "unstarted", task: "unstarted",
  cancelReturned: false, cancelWhilePending: false, expired: false, joined: false, mapRemoved: false, listenerRemoved: false, timerRejectionObject: null });
const call = id => ({ id, aborted: false, canceled: false, expired: false, sourceLifetime: { pending: 3, timerActive: true, listenerActive: true,
  timer: "pending", terminal: null, finished: false, cancelCalls: 0, cancelReturned: 0, abortCalls: 0, abortReturned: 0, faults: 0 } });
const origin = () => protocol.source(protocol.ids.map(call), ready, 23);
function router() {
  const ingresses = protocol.ids.map(id => ({ id, signal: new AbortController().signal, responseStatus: 500 }));
  const inputs = ingresses.map(ingress => ({ binding: { row: { id: ingress.id }, ingress }, effective: { signal: new AbortController().signal }, response: new Response(null, { status: 502 }) }));
  return { ingresses, inputs, freeze: () => protocol.local("readiness", "abort_body", 500, ingresses, inputs, 1024, 11) };
}
const timers = () => {
  const active = new Set(); return { active, setTimeout(fn, ms) { assert.equal(ms, 10000); active.add(fn); return fn; }, clearTimeout(fn) { active.delete(fn); } };
};

test("passive projection neither observes nor joins or cancels original work", () => {
  const originals = { then() { assert.fail("original promise touched"); }, join() { assert.fail("join"); }, cancel() { assert.fail("cancel"); } };
  const calls = protocol.ids.map(id => ({ ...call(id), originals, body: originals }));
  const before = JSON.stringify(calls), states = protocol.ids.map(ready);
  const captured = protocol.source(calls, id => states.find(r => r.id === id), 23);
  assert.equal(JSON.stringify(calls), before); assert.equal(calls[0].originals, originals);
  assert.equal(captured.rows[0].lifetime.pending, 3); assert.equal(captured.rows[0].readiness.wait_entered, null);
  assert.ok(Object.isFrozen(captured.rows[0].lifetime)); assert.ok(!Object.isFrozen(calls[0].sourceLifetime));
  calls[0].sourceLifetime.pending = 0; states[0].wait_entered = 1;
  assert.equal(captured.rows[0].lifetime.pending, 3); assert.equal(captured.rows[0].readiness.wait_entered, null);
});

test("local facts freeze before cross-Worker wait; first phase snapshot remains immutable", async () => {
  const r = router(), store = new Map(), faults = []; let resolve, reads = 0;
  const control = new Promise(done => { resolve = done; });
  const pending = captureMusicPassiveState(store, faults, "readiness", r.freeze, () => { reads++; r.ingresses[0].responseStatus = 200; return control; },
    (local, source, received) => protocol.compact(local, source, received, "native"), () => 35);
  assert.equal(reads, 1); assert.equal(store.get("readiness").origin, null); assert.equal(store.get("readiness").local.rows[0].responseStatus, 500);
  resolve(origin()); const record = await pending;
  assert.equal(record.hS, 500); assert.equal(record.localMs, 11); assert.equal(record.sourceMs, 23); assert.equal(record.receivedMs, 35);
  const first = store.get("readiness");
  await captureMusicPassiveState(store, faults, "readiness", () => assert.fail("recapture"), () => assert.fail("refetch"));
  assert.equal(store.get("readiness"), first); assert.deepEqual(faults, []);
});

test("snapshot faults, including undefined, remain separate from the original failure", async () => {
  for (const reason of [undefined, null, false, 0, new Error("observer")]) {
    const original = Object.freeze({ original: true }), store = new Map(), faults = [];
    const doOriginal = async () => {
      await captureMusicPassiveState(store, faults, "retirement", () => { throw reason; }, () => assert.fail("must freeze before fetch"));
      throw original;
    };
    await assert.rejects(doOriginal(), error => error === original);
    assert.deepEqual(faults, [reason]); assert.equal(store.get("retirement"), null);
  }
});

test("failed cross-Worker observation retains frozen local facts and marks source unknown", async () => {
  const store = new Map(), faults = [], r = router();
  const record = await captureMusicPassiveState(store, faults, "readiness", r.freeze,
    async () => { r.ingresses[0].responseStatus = 200; throw undefined; },
    (local, source, received, count) => protocol.compact(local, source, received, "native", count), () => 30);
  assert.deepEqual(faults, [undefined]); assert.equal(record.hS, 500); assert.equal(record.charged, 1024);
  assert.equal(record.sourceMs, null); assert.equal(record.stateFaults, 1); assert.equal(record.hL, null); assert.equal(record.hR, null);
  assert.equal(store.get("readiness").local.rows[0].responseStatus, 500);
  await captureMusicPassiveState(store, faults, "readiness", () => assert.fail("do not replace first failure"));
  assert.deepEqual(faults, [undefined]);
});

test("exact original ingress identity and branded signals, not matching labels, bind local state", () => {
  const r = router(); assert.equal(r.freeze().rows[0].ingressAborted, false);
  r.inputs[0].binding.ingress = { ...r.ingresses[0] };
  assert.throws(r.freeze, /invalid passive/);
  r.inputs[0].binding.ingress = r.ingresses[0];
  r.inputs[0].effective.signal = { aborted: false }; assert.throws(r.freeze);
  r.inputs[0].effective.signal = new AbortController().signal;
  r.ingresses.push(r.ingresses[0]); assert.throws(r.freeze, /invalid passive/);
});

test("status observation does not clone, read or replace original response", () => {
  const response = new Response("held", { status: 503 });
  Object.defineProperty(response, "clone", { value: () => assert.fail("clone") });
  Object.defineProperty(response, "body", { get() { assert.fail("body"); } });
  assert.equal(protocol.responseStatus(response), 503);
  let invoked = false; Object.defineProperty(response, "status", { get() { invoked = true; return 200; } });
  assert.throws(() => protocol.responseStatus(response)); assert.equal(invoked, false);
});

test("missing, foreign, extra, getter and proxy source inputs reject without invoking accessors", () => {
  const mutations = [
    v => { delete v.rows[0].lifetime; }, v => { v.rows.pop(); }, v => { v.rows.reverse(); },
    v => { v.rows[0].id = "foreign"; }, v => { v.rows[0].lifetime.pending = undefined; },
    v => { v.rows[0].lifetime.terminal = "fulfilled"; }, v => { v.rows[0].readiness.id = "abort_body"; },
    v => { v.rows[0].readiness.failureCount = 1001; }, v => { v.extra = true; },
    v => { v.rows[0].lifetime[Symbol("foreign")] = true; },
  ];
  for (const mutate of mutations) { const v = structuredClone(origin()); mutate(v); assert.throws(() => protocol.validateSource(v)); }
  let accesses = 0; const v = structuredClone(origin());
  Object.defineProperty(v.rows[0], "lifetime", { get() { accesses++; throw undefined; } });
  assert.throws(() => protocol.validateSource(v));
  assert.throws(() => protocol.validateSource(new Proxy(origin(), { ownKeys() { accesses++; throw undefined; } })));
  assert.equal(accesses, 0);
  assert.throws(() => protocol.source([call("abort_headers"), call("abort_headers")], ready, 0));
  assert.throws(() => protocol.source([call("abort_headers")], id => ({ ...ready(id), id: "foreign" }), 0));
});

test("unstarted cases are explicitly absent; missing rows cannot impersonate absence", () => {
  const s = protocol.source([], ready, 0), l = protocol.local("retirement", "none", null, [], [], 0, 0);
  const record = protocol.compact(l, s, 1, "manifest");
  for (const p of ["h", "b", "d"]) { assert.equal(record[p + "L"], null); assert.equal(record[p + "I"], null); assert.equal(record[p + "R"], 0); }
  assert.throws(() => protocol.compact({ ...l, rows: [] }, s, 1, "manifest"));
  assert.throws(() => protocol.compact({ ...l, caseId: "abort_body" }, s, 1, "manifest"));
  assert.throws(() => protocol.compact(l, s, 1, "foreign"));
});

test("maximum typed counters fit 640B records and 8KiB state response", () => {
  const calls = protocol.ids.map(id => {
    const c = call(id); c.sourceLifetime = { pending: 1000, timerActive: true, listenerActive: true, timer: "expired", terminal: "expired", finished: true,
      cancelCalls: 1000, cancelReturned: 1000, abortCalls: 1000, abortReturned: 1000, faults: 1000 };
    c.aborted = c.canceled = c.expired = c.sourceReturnReached = true; return c;
  });
  const s = protocol.source(calls, id => ({ ...ready(id), wait_entered: 1, resolver_called: 2, resolver_returned: 3, wait_returned: 4,
    matchingPosts: 1000, waitCount: 1000, failureCount: 1000, timer: "rejected", notification: "rejected", task: "rejected", expired: true, joined: true, mapRemoved: true, listenerRemoved: true }), 1_000_000_000);
  const l = { ...router().freeze(), atMs: 1_000_000_000, charged: 1_000_000_000 };
  const record = protocol.compact(l, s, 1_000_000_000, "manifest");
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 640); assert.ok(Buffer.byteLength(protocol.bounded(s)) <= 8192);
  assert.equal(record.hL, 1023); assert.equal(record.hT, 20); assert.equal(record.hR, 16383);
  assert.throws(() => protocol.bounded({ excess: "x".repeat(8192) }));
});

test("control fetch consumes only its bounded state response and closes its own resources", async () => {
  const runtime = timers(); let requested;
  const result = await readMusicPassiveResponse(async (url, options) => {
    requested = { url, options }; return Response.json(origin());
  }, "https://fixture.example/passive-state", protocol, runtime);
  assert.deepEqual(result, origin()); assert.equal(requested.url, "https://fixture.example/passive-state");
  assert.equal(requested.options.method, "GET"); assert.equal(requested.options.redirect, "error"); assert.equal(requested.options.signal.aborted, false);
  assert.equal(runtime.active.size, 0);
});

test("control failures retain original and independent falsey cleanup errors", async () => {
  await assert.rejects(readMusicPassiveResponse(async () => { throw undefined; }, "https://fixture.example/passive-state", protocol, {
    setTimeout() { return 1; }, clearTimeout() { throw 0; },
  }), error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === undefined && error.errors[1] === 0);
  const runtime = timers();
  for (const response of [new Response(null, { status: 500 }), new Response("x".repeat(8193)), new Response('{"atMs":0,"atMs":1,"rows":[]}'),
    new Response('{"atMs":0,"rows":[]}'), new Response(new Uint8Array([255]))]) {
    await assert.rejects(readMusicPassiveResponse(async () => response, "https://fixture.example/passive-state", protocol, runtime), AggregateError);
    assert.equal(response.body?.locked ?? false, false); assert.equal(runtime.active.size, 0);
  }
});

test("the existing control deadline aborts only its own fetch and retains failure", async () => {
  let timer, canceled, originalSignal = new AbortController().signal;
  const pending = readMusicPassiveResponse(async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), "https://fixture.example/passive-state", protocol, {
    setTimeout(fn, ms) { assert.equal(ms, 10000); timer = fn; return fn; }, clearTimeout(fn) { canceled = fn; },
  });
  timer(); await assert.rejects(pending, AggregateError);
  assert.equal(canceled, timer); assert.equal(originalSignal.aborted, false);
});

test("original control read/cancel/closed/release failures stay independent and ordered", async () => {
  const readReason = undefined, cancelReason = null, closedReason = false, releaseReason = 0;
  const order = []; let rejectClosed, finishCancel;
  const closed = new Promise((_resolve, reject) => { rejectClosed = reject; });
  const cancel = new Promise(resolve => { finishCancel = resolve; });
  const reader = { closed, async read() { order.push("read"); throw readReason; },
    async cancel() { order.push("cancel"); await cancel; throw cancelReason; },
    releaseLock() { order.push("release"); throw releaseReason; } };
  const response = new Response(null); Object.defineProperty(response, "body", { value: { getReader: () => reader } });
  let settled = false;
  const pending = readMusicPassiveResponse(async () => response, "https://fixture.example/passive-state", protocol, {
    setTimeout() { return 1; }, clearTimeout() { order.push("clear"); },
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 10 && !order.includes("cancel"); i++) await Promise.resolve();
  assert.deepEqual(order, ["read", "cancel"]); assert.equal(settled, false);
  finishCancel(); for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(settled, false); assert.deepEqual(order, ["read", "cancel"]);
  rejectClosed(closedReason);
  await assert.rejects(pending, error => error instanceof AggregateError && error.errors.length === 4
    && error.errors[0] === readReason && error.errors[1] === cancelReason && error.errors[2] === closedReason && error.errors[3] === releaseReason);
  assert.deepEqual(order, ["read", "cancel", "release", "clear"]);
});

test("successful EOF still joins the exact control closed Promise before release and timer cleanup", async () => {
  let finishClosed; const order = [], bytes = new TextEncoder().encode(JSON.stringify(origin())); let read = 0;
  const reader = { closed: new Promise(resolve => { finishClosed = resolve; }),
    async read() { return read++ ? { done: true } : { done: false, value: bytes }; },
    cancel() { assert.fail("no success cancellation"); }, releaseLock() { order.push("release"); } };
  const response = new Response(null); Object.defineProperty(response, "body", { value: { getReader: () => reader } });
  const pending = readMusicPassiveResponse(async () => response, "https://fixture.example/passive-state", protocol, {
    setTimeout() { return 1; }, clearTimeout() { order.push("clear"); },
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(order, []); finishClosed(); assert.deepEqual(await pending, origin());
  assert.deepEqual(order, ["release", "clear"]);
});

test("bad control HTTP status still cancels and joins its own body", async () => {
  let canceled = 0; const runtime = timers();
  const response = new Response(new ReadableStream({ cancel() { canceled++; } }), { status: 503 });
  await assert.rejects(readMusicPassiveResponse(async () => response, "https://fixture.example/passive-state", protocol, runtime), AggregateError);
  assert.equal(canceled, 1); assert.equal(response.body.locked, false); assert.equal(runtime.active.size, 0);
});
