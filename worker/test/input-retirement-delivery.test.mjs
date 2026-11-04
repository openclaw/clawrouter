import assert from "node:assert/strict";
import test from "node:test";
import { observeUsage } from "../proxy-response.ts";
import { HttpOperation } from "../http-operation.ts";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

for (const cause of ["abort", "downstream"]) for (const rejects of [false, true]) test(`delivery result precedes held ${cause} retirement, cleanup rejects=${rejects}`, async () => {
  const entered = deferred(), ack = deferred(), started = deferred(); let cancels = 0, results = 0, released = false;
  const signal = new AbortController();
  const source = new ReadableStream({ pull() { entered.resolve(); }, cancel() { cancels++; started.resolve(); return ack.promise; } }, { highWaterMark: 0 });
  const lease = new BodyLease(); assert.equal(lease.grow(32 * 1024 * 1024), true);
  const observed = observeUsage(new Response(source), new HttpOperation(signal.signal));
  const reader = observed.response.body.getReader(); const read = reader.read(); const capturedRead = read.catch(error => error);
  observed.result.then(() => { results++; });
  const releasedCharge = observed.retired.then(() => { released = true; lease.release(); });
  await entered.promise;
  const cancellation = cause === "downstream" ? reader.cancel("synthetic downstream cancel") : (signal.abort(new Error("synthetic abort")), Promise.resolve());
  await started.promise;
  assert.equal((await observed.result).delivery, "canceled"); assert.equal(results, 1); assert.equal(released, false);
  assert.equal(source.locked, true); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  const competitor = new BodyLease(); assert.equal(competitor.grow(17 * 1024 * 1024), false); competitor.release();
  if (rejects) ack.reject(new Error("synthetic cleanup rejection")); else ack.resolve();
  await cancellation; await releasedCharge; await capturedRead; reader.releaseLock();
  assert.equal(cancels, 1); assert.equal(results, 1); assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), 0);
});
test("native terminal data does not retire delivery before actual EOF", async () => {
  let controller, cancels = 0, retired = false;
  const source = new ReadableStream({ start(c) { controller = c; }, cancel() { cancels++; } }, { highWaterMark: 0 });
  const observed = observeUsage(new Response(source, { headers: { "content-type": "text/event-stream" } }));
  observed.retired.then(() => { retired = true; });
  const reader = observed.response.body.getReader(); const first = reader.read();
  controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); assert.equal((await first).done, false);
  assert.equal(retired, false); assert.equal(source.locked, true);
  const last = reader.read(); controller.close(); assert.equal((await last).done, true);
  await observed.retired; assert.equal((await observed.result).delivery, "complete"); assert.equal(cancels, 0); assert.equal(source.locked, false);
  reader.releaseLock();
});

test("delivery retirement joins an active inspection after prompt abort without late output", async () => {
  const inspection = deferred(), entered = deferred(); const abort = new AbortController();
  let calls = 0, results = 0, released = false;
  const source = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"value":1}\n\n')); } }, { highWaterMark: 0 });
  const lease = new BodyLease(); assert.equal(lease.grow(32 * 1024 * 1024), true);
  const observed = observeUsage(new Response(source, { headers: { "content-type": "text/event-stream" } }), new HttpOperation(abort.signal), {
    async push() { calls++; entered.resolve(); await inspection.promise; }, async end() {},
  });
  const retired = observed.retired.then(() => { released = true; lease.release(); });
  observed.result.then(() => { results++; });
  const reader = observed.response.body.getReader(); const read = assert.rejects(reader.read(), /synthetic abort/);
  await entered.promise; abort.abort(new Error("synthetic abort")); await read;
  assert.equal((await observed.result).delivery, "canceled");
  assert.equal(released, false); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  inspection.resolve(); await retired; reader.releaseLock();
  assert.equal(calls, 1); assert.equal(results, 1); assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), 0);
});
