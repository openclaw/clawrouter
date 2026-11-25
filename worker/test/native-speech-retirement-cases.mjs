import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");

export function registerNativeSpeechRetirementCases({ native, response }) {
  for (const mode of ["headers", "abort", "cleanup-rejection"]) test(`source retirement holds capacity through ${mode}, including reentrant cancellation`, { timeout: 5000 }, async t => {
    const ready = Promise.withResolvers(), canceled = Promise.withResolvers(), cleanup = Promise.withResolvers();
    const abort = new AbortController(), baseline = bodyBudgetCharged();
    let cancels = 0, completed = false;
    const source = new ReadableStream({
      pull() { ready.resolve(); },
      cancel() { cancels++; abort.abort(); canceled.resolve(); return cleanup.promise; },
    }, { highWaterMark: 0 });
    const prepared = native(), lease = prepared.acquire();
    t.after(() => { cleanup.resolve(); lease.release(); });
    const result = prepared.read(response(mode === "headers" ? { "content-type": "application/json" } : {}, source), abort.signal)
      .finally(() => { completed = true; lease.release(); });
    const rejected = assert.rejects(result);
    if (mode !== "headers") { await ready.promise; abort.abort(); }
    await canceled.promise; await new Promise(setImmediate);
    assert.equal(cancels, 1); assert.equal(completed, false); assert.equal(source.locked, true);
    assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
    const competing = new BodyLease();
    assert.equal(competing.grow(17 * 1024 * 1024), false); competing.release();
    if (mode === "cleanup-rejection") cleanup.reject(new Error("synthetic cleanup rejection")); else cleanup.resolve();
    await rejected;
    assert.equal(cancels, 1); assert.equal(source.locked, false);
    assert.equal(bodyBudgetCharged(), baseline);
    lease.release(); assert.equal(bodyBudgetCharged(), baseline);
  });

  test("a rejected counting transform retains its original pipe until source cancellation settles", { timeout: 5000 }, async t => {
    const canceled = Promise.withResolvers(), cleanup = Promise.withResolvers();
    let sent = false, complete = false, cancels = 0;
    const source = new ReadableStream({
      pull(controller) { if (!sent) { sent = true; controller.enqueue("invalid binary chunk"); } },
      cancel() { cancels++; canceled.resolve(); return cleanup.promise; },
    }, { highWaterMark: 0 });
    const prepared = native(), baseline = bodyBudgetCharged(), lease = prepared.acquire();
    t.after(() => { cleanup.resolve(); lease.release(); });
    const result = prepared.read(response({}, source), new AbortController().signal)
      .finally(() => { complete = true; lease.release(); });
    const rejected = assert.rejects(result);
    await canceled.promise; await new Promise(setImmediate);
    assert.equal(complete, false); assert.equal(source.locked, true); assert.equal(cancels, 1);
    assert.equal(bodyBudgetCharged(), baseline + 64 * 1024 * 1024);
    cleanup.reject(new Error("synthetic source cleanup rejection")); await rejected;
    assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), baseline); assert.equal(cancels, 1);
  });
}
