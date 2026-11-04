import assert from "node:assert/strict";
import test from "node:test";
import { inputRetirement } from "../input-retirement.ts";
import { readNativeJson } from "../native-json.ts";
import { readGoogleJson } from "../google-json.ts";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const fail = () => { throw new Error("invalid JSON response"); };
const charge = () => { const lease = new BodyLease(); assert.equal(lease.grow(32 * 1024 * 1024), true); return lease; };
const busy = () => { const other = new BodyLease(); assert.equal(other.grow(17 * 1024 * 1024), false); other.release(); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024); };

for (const rejects of [false, true]) test(`input retirement joins independent read, FIRST cancellation and source tail, cleanup rejection=${rejects}`, async () => {
  const reading = deferred(), cancellation = deferred(), source = deferred();
  let cancels = 0, unlocks = 0, releases = 0;
  const lease = charge();
  const input = inputRetirement({ cancel() { cancels++; return cancellation.promise; }, releaseLock() { unlocks++; } }, source.promise);
  const pending = input.read(() => reading.promise);
  const retiring = input.retire("cancel", "synthetic abort");
  assert.equal(input.retire("cancel", "second reason"), retiring);
  assert.equal(input.retire("eof"), retiring);
  const held = input.retired.then(() => { releases++; lease.release(); });
  assert.equal(cancels, 1); busy();
  if (rejects) cancellation.reject(new Error("synthetic cleanup rejection")); else cancellation.resolve();
  await turn(); assert.equal(unlocks, 0); busy();
  reading.resolve({ done: true }); await pending; await turn(); assert.equal(unlocks, 0); busy();
  source.resolve(); await held; await retiring;
  assert.equal(unlocks, 1); assert.equal(releases, 1); assert.equal(bodyBudgetCharged(), 0);
});
test("input retirement publishes its first promise before synchronous cancel re-entry", async () => {
  let input, nested, calls = 0, unlocks = 0;
  input = inputRetirement({ cancel() { calls++; nested = input.retire("cancel"); return Promise.resolve(); }, releaseLock() { unlocks++; } });
  const first = input.retire("cancel"); assert.equal(first, nested); await first;
  assert.equal(calls, 1); assert.equal(unlocks, 1);
});
test("input retirement preserves read failures and rejects concurrent or retired reads", async () => {
  const read = deferred(); let starts = 0, cancels = 0;
  const input = inputRetirement({ cancel: async () => { cancels++; }, releaseLock() {} });
  const pending = input.read(() => { starts++; return read.promise; });
  const rejected = assert.rejects(pending, /synthetic read failure/);
  await assert.rejects(input.read(() => { starts++; return Promise.resolve(); }), /already reading/);
  read.reject(new Error("synthetic read failure")); await rejected;
  await input.retire("cancel"); await assert.rejects(input.read(() => { starts++; return Promise.resolve(); }), /retired/);
  assert.equal(starts, 1); assert.equal(cancels, 1);
});
test("actual EOF retires without cancellation; native terminal alone requires cancellation", async () => {
  let cancels = 0, unlocks = 0;
  const eof = inputRetirement({ cancel: async () => { cancels++; }, releaseLock() { unlocks++; } });
  assert.equal((await eof.read(async () => ({ done: true }))).done, true); await eof.retire("eof");
  const terminal = inputRetirement({ cancel: async () => { cancels++; }, releaseLock() { unlocks++; } });
  assert.equal((await terminal.read(async () => ({ done: false, value: "[DONE]" }))).done, false); await terminal.retire("cancel");
  assert.equal(cancels, 1); assert.equal(unlocks, 2);
});

for (const [name, read] of [["native", readNativeJson], ["Google", readGoogleJson]]) {
  for (const refusal of ["header", "size", "abort"]) test(`${name} JSON ${refusal} retains capacity through FIRST cancel cleanup`, async () => {
    const started = deferred(), ack = deferred(), entered = deferred(); let cancels = 0, reads = 0, settled = false;
    const signal = new AbortController();
    const source = new ReadableStream({ pull(c) {
      reads++; entered.resolve();
      if (refusal === "size") c.enqueue(new TextEncoder().encode('{"tooLarge":"xxxxxxxx"}'));
    }, cancel() { cancels++; started.resolve(); return ack.promise; } }, { highWaterMark: 0 });
    const lease = charge();
    const response = new Response(source, { headers: { "content-type": refusal === "header" ? "text/plain" : "application/json" } });
    const reading = read(response, signal.signal, 8, () => assert.fail("invalid input must not reach observation"), fail)
      .finally(() => { settled = true; lease.release(); });
    const result = assert.rejects(reading, /invalid JSON response/);
    if (refusal === "abort") { await entered.promise; signal.abort(new Error("synthetic abort")); }
    await started.promise; await turn();
    assert.equal(settled, false); assert.equal(source.locked, true); assert.equal(cancels, 1); busy();
    if (refusal === "header") assert.equal(reads, 0);
    signal.abort(); ack.resolve(); await result;
    assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), 0);
  });
  test(`${name} JSON preserves parser rejection and retires its EOF lock`, async () => {
    let cancels = 0;
    const source = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"broken":')); c.close(); }, cancel() { cancels++; } });
    await assert.rejects(read(new Response(source, { headers: { "content-type": "application/json" } }), new AbortController().signal, 1024, () => assert.fail(), fail), /invalid JSON response/);
    assert.equal(source.locked, false); assert.equal(cancels, 0);
  });
  test(`${name} JSON cancellation rejection still waits for cleanup before releasing its lock`, async () => {
    const ack = deferred(), started = deferred();
    const source = new ReadableStream({ cancel() { started.resolve(); return ack.promise; } });
    const result = assert.rejects(read(new Response(source), new AbortController().signal, 1024, () => assert.fail(), fail), /invalid JSON response/);
    await started.promise; assert.equal(source.locked, true); ack.reject(new Error("synthetic cleanup rejection"));
    await result; assert.equal(source.locked, false);
  });
}

test("failed source retirement cannot certify the chain or release its charge", async () => {
  const source = deferred(); let unlocked = 0, released = false;
  const lease = charge();
  const input = inputRetirement({ cancel: async () => undefined, releaseLock() { unlocked++; } }, source.promise);
  const capacity = input.retired.then(() => { released = true; lease.release(); });
  const failure = assert.rejects(capacity, /source lock still owned/);
  const retiring = input.retire("cancel"); const rejected = assert.rejects(retiring, /source lock still owned/);
  source.reject(new Error("source lock still owned")); await failure; await rejected;
  assert.equal(unlocked, 1); assert.equal(released, false); busy();
  // Fixture-owned charge cleanup does not certify the failed production chain.
  lease.release();
});

test("synchronous cancellation inside read start still joins that actual read", async () => {
  const read = deferred(); let unlocked = 0, retiring;
  const input = inputRetirement({ cancel: async () => undefined, releaseLock() { unlocked++; } });
  const pending = input.read(() => { retiring = input.retire("cancel"); return read.promise; });
  await turn(); assert.equal(unlocked, 0);
  read.resolve({ done: true }); await pending; await retiring;
  assert.equal(unlocked, 1);
});
