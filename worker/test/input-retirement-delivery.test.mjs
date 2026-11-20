import assert from "node:assert/strict";
import test from "node:test";
import { observeUsage } from "../proxy-response.ts";
import { HttpOperation } from "../http-operation.ts";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
function inertReplayFunctions() {
  const source = readFileSync(new URL("../proxy-response.ts", import.meta.url), "utf8");
  const input = readFileSync(new URL("../input-retirement.ts", import.meta.url), "utf8").replaceAll("export ", "");
  const replay = source.slice(source.indexOf("const replayRetirements ="), source.indexOf("export interface SseBoundaryCursor"));
  class InertStream { constructor(source, strategy) { this.source = source; this.strategy = strategy; } }
  class InertResponse { constructor(body, init) { this.body = body; Object.assign(this, init); } }
  return new Function("ReadableStream", "Response", stripTypeScriptTypes(input + replay, {mode:"transform"}) + ";return {replayInputOwner,replayResponse,replayRetirements};")(InertStream, InertResponse);
}
const replayDeferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
const replayTurns = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };

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
  await cancellation; // Notification must not wait for the held source cleanup.
  await started.promise;
  assert.equal((await observed.result).delivery, "canceled"); assert.equal(results, 1); assert.equal(released, false);
  assert.equal(source.locked, true); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  const competitor = new BodyLease(); assert.equal(competitor.grow(17 * 1024 * 1024), false); competitor.release();
  if (rejects) ack.reject(new Error("synthetic cleanup rejection")); else ack.resolve();
  await releasedCharge; await capturedRead; reader.releaseLock();
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

// BEGIN inert replay tail tests.
test("inert replay predecessor and outer retirement cannot bypass a held original cancel",async()=>{
  const {replayInputOwner}=inertReplayFunctions(), cancel=replayDeferred();let innerUnlocks=0,outerUnlocks=0,settled=false;
  const inner=replayInputOwner({cancel(){return cancel.promise;},releaseLock(){innerUnlocks++;}});
  const outer=replayInputOwner({cancel(reason){return inner.retire("cancel",reason);},releaseLock(){outerUnlocks++;}},inner.retired);
  const result=outer.retire("cancel");result.then(()=>{settled=true;});await replayTurns();assert.equal(settled,false);assert.equal(innerUnlocks,0);assert.equal(outerUnlocks,0);
  cancel.resolve();await result;assert.equal(innerUnlocks,1);assert.equal(outerUnlocks,1);
});
test("inert replay retains predecessor and outer release failures independently",async()=>{
  const {replayInputOwner}=inertReplayFunctions(), source=replayDeferred();let calls=0;
  const owner=replayInputOwner({cancel(){calls++;return Promise.resolve();},releaseLock(){throw undefined;}},source.promise);
  const retiring=owner.retire("cancel"), failure=retiring.catch(error=>error);source.reject(undefined);
  const error=await failure;assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[undefined,undefined]);assert.equal(calls,1);
});
// END inert replay tail tests.

// BEGIN inert observeUsage replay integration tests.
function inertReplayDeliveryFunctions() {
  const source = readFileSync(new URL("../proxy-response.ts", import.meta.url), "utf8");
  const input = readFileSync(new URL("../input-retirement.ts", import.meta.url), "utf8").replaceAll("export ", "");
  const usage = source.slice(source.indexOf("export function observeUsage("), source.indexOf("// Inspect only a bounded error prefix")).replace("export ", "");
  const replay = source.slice(source.indexOf("const replayRetirements ="), source.indexOf("export interface SseBoundaryCursor"));
  class InertStream {
    constructor(source) { this.source = source; source.start?.({ error() {} }); }
  }
  class InertResponse { constructor(body, init) { this.body = body; Object.assign(this, init); } }
  class InertDecoder { decode() { return ""; } }
  return new Function("ReadableStream", "Response", "TextDecoder", "ollamaChatFormat", stripTypeScriptTypes(input + replay + usage, { mode: "transform" }) + ";return {observeUsage,replayResponse,replayRetirements};")(InertStream, InertResponse, InertDecoder, "ollama.chat");
}
function inertDeliveryOperation() {
  return { signal: { aborted: false, addEventListener() {}, removeEventListener() {} }, cancel() {}, stop() {} };
}
const inertDeliveryResponse = body => ({ body, status: 200, statusText: "OK", headers: { get() { return ""; } } });

for (const sourceUndefined of [false, true]) for (const releaseUndefined of [false, true]) {
  test(`inert observeUsage retains mapped source/release failures ${sourceUndefined}/${releaseUndefined}`, async () => {
    const { observeUsage, replayRetirements } = inertReplayDeliveryFunctions();
    const source = replayDeferred(), read = replayDeferred(), cancel = replayDeferred();
    const sourceError = sourceUndefined ? undefined : {}, releaseError = releaseUndefined ? undefined : {}, reason = {};
    let releases = 0, cancels = 0, reads = 0, settled = false;
    const reader = {
      read() { assert.equal(this, reader); reads++; return read.promise; },
      cancel(value) { assert.equal(this, reader); assert.equal(value, reason); cancels++; return cancel.promise; },
      releaseLock() { assert.equal(this, reader); releases++; throw releaseError; },
    };
    const body = { getReader() { assert.equal(this, body); return reader; } };
    replayRetirements.set(body, source.promise);
    const observed = observeUsage(inertDeliveryResponse(body), inertDeliveryOperation());
    const result = observed.retired.then(() => ({ fulfilled: true }), error => ({ fulfilled: false, error }));
    void result.then(() => { settled = true; });
    const pulling = observed.response.body.source.pull({ enqueue() { assert.fail("late delivery"); } });
    assert.equal(observed.response.body.source.cancel(reason), undefined);
    observed.response.body.source.cancel({});
    assert.equal((await observed.result).delivery, "canceled");
    assert.equal(reads, 1); assert.equal(cancels, 1);
    source.reject(sourceError); await replayTurns();
    assert.equal(settled, false); assert.equal(releases, 0);
    cancel.reject({}); await replayTurns(); // Existing async cancel suppression is unchanged.
    assert.equal(settled, false); assert.equal(releases, 0);
    read.resolve({ done: true }); await pulling;
    const outcome = await result;
    assert.equal(outcome.fulfilled, false); assert.ok(outcome.error instanceof AggregateError);
    assert.deepEqual(outcome.error.errors, [sourceError, releaseError]);
    assert.equal(releases, 1); assert.equal(cancels, 1);
  });
}

test("inert observeUsage joins the actual published replay tail before delivery release", async () => {
  const { observeUsage, replayResponse } = inertReplayDeliveryFunctions();
  const read = replayDeferred(), cancel = replayDeferred();
  let rawReleases = 0, deliveryReleases = 0, cancels = 0, settled = false;
  const raw = { read() { assert.equal(this, raw); return read.promise; }, cancel(reason) { assert.equal(this, raw); assert.equal(reason, undefined); cancels++; return cancel.promise; }, releaseLock() { rawReleases++; } };
  const replay = replayResponse(inertDeliveryResponse({}), raw, [], false);
  // Inert delivery reader forwards only the original producer callback; no native stream is constructed.
  const rawPull = replay.body.source.pull({ enqueue() { assert.fail("late replay"); } });
  const deliveryReader = { cancel(reason) { return replay.body.source.cancel(reason); }, releaseLock() { deliveryReleases++; } };
  replay.body.getReader = () => deliveryReader;
  const observed = observeUsage(replay, inertDeliveryOperation());
  observed.retired.then(() => { settled = true; });
  observed.response.body.source.cancel();
  cancel.resolve(); await replayTurns();
  assert.equal(settled, false); assert.equal(rawReleases, 0); assert.equal(deliveryReleases, 0);
  read.reject(undefined); await rawPull; await observed.retired;
  assert.equal(rawReleases, 1); assert.equal(deliveryReleases, 1); assert.equal(cancels, 1);
});

test("inert observeUsage leaves unmapped cancellation policy and release failure unchanged", async () => {
  const { observeUsage } = inertReplayDeliveryFunctions();
  const releaseError = {}; let releases = 0, cancels = 0;
  const reader = { cancel() { cancels++; throw undefined; }, releaseLock() { releases++; throw releaseError; } };
  const observed = observeUsage(inertDeliveryResponse({ getReader() { return reader; } }), inertDeliveryOperation());
  const result = observed.retired.then(() => assert.fail("release failure lost"), error => error);
  observed.response.body.source.cancel();
  assert.equal(await result, releaseError); assert.equal(cancels, 1); assert.equal(releases, 1);
});
// END inert observeUsage replay integration tests.
