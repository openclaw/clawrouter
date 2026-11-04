import assert from "node:assert/strict";
import test from "node:test";
import { ownMiniMaxImageInput } from "../minimax-image-input.ts";
import { readNativeJson } from "../native-json.ts";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";

test("MiniMax image input holds its reader and charge through a delayed cancellation acknowledgement", async () => {
  let cancelStarted, acknowledge;
  const started = new Promise(resolve => { cancelStarted = resolve; });
  const ack = new Promise(resolve => { acknowledge = resolve; });
  const source = new ReadableStream({ pull() {}, cancel() { cancelStarted(); return ack; } }, { highWaterMark: 0 });
  const lease = new BodyLease(); assert.equal(lease.grow(32 * 1024 * 1024), true);
  const input = ownMiniMaxImageInput(new Response(source)); const reader = input.response.body.getReader();
  const pending = reader.read(); let released = false;
  const retirement = input.retire("fixture abort").then(() => { lease.release(); released = true; });
  await started;
  assert.equal(released, false); assert.equal(source.locked, true); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  acknowledge(); await retirement; assert.equal((await pending).done, true);
  reader.releaseLock(); await input.retire(); assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), 0);
});
test("MiniMax image input preserves exact bytes and headers, retires at EOF without source cancellation", async () => {
  let copies = 0, cancels = 0;
  const bytes = new TextEncoder().encode('{"image":"fixture"}');
  const source = new ReadableStream({ pull(c) { copies++; c.enqueue(bytes); c.close(); }, cancel() { cancels++; } }, { highWaterMark: 0 });
  const input = ownMiniMaxImageInput(new Response(source, { headers: { "content-type": "application/json", "content-length": String(bytes.length) } }));
  assert.equal(copies, 0); assert.equal(source.locked, true);
  assert.deepEqual(new Uint8Array(await input.response.arrayBuffer()), bytes); await input.retire(); await input.retire();
  assert.equal(copies, 1); assert.equal(cancels, 0); assert.equal(source.locked, false); assert.equal(input.response.headers.get("content-length"), String(bytes.length));
});
test("MiniMax image input pre-read discard is single-use and waits for physical cleanup", async () => {
  let reads = 0, cancels = 0;
  const source = new ReadableStream({ pull() { reads++; }, async cancel() { cancels++; } }, { highWaterMark: 0 });
  const input = ownMiniMaxImageInput(new Response(source)); await input.retire(); await input.retire();
  assert.equal(reads, 0); assert.equal(cancels, 1); assert.equal(source.locked, false);
});

test("MiniMax image input rejects a read failure after a complete-looking JSON prefix", async () => {
  let reads = 0, observed = false;
  const source = new ReadableStream({ pull(controller) {
    if (++reads === 1) controller.enqueue(new TextEncoder().encode('{"data":[]}'));
    else controller.error(new Error("fixture source failure"));
  } }, { highWaterMark: 0 });
  const input = ownMiniMaxImageInput(new Response(source, { headers: { "content-type": "application/json" } }));
  await assert.rejects(readNativeJson(input.response, new AbortController().signal, 1024,
    () => { observed = true; }, () => { throw new Error("invalid image input"); }), /invalid image input/);
  await input.retire();
  assert.equal(observed, false); assert.equal(source.locked, false); assert.equal(reads, 2);
});
test("MiniMax image input retains charge through a pre-read JSON refusal cleanup", async () => {
  let reads = 0, cancelStarted, acknowledge;
  const started = new Promise(resolve => { cancelStarted = resolve; });
  const ack = new Promise(resolve => { acknowledge = resolve; });
  const source = new ReadableStream({ pull() { reads++; }, cancel() { cancelStarted(); return ack; } }, { highWaterMark: 0 });
  const lease = new BodyLease(); assert.equal(lease.grow(32 * 1024 * 1024), true);
  const input = ownMiniMaxImageInput(new Response(source, { headers: { "content-type": "text/plain" } }));
  await assert.rejects(readNativeJson(input.response, new AbortController().signal, 1024,
    () => assert.fail("invalid MIME must not parse"), () => { throw new Error("invalid image input"); }), /invalid image input/);
  let released = false;
  const retirement = input.retire().then(() => { lease.release(); released = true; });
  await started;
  assert.equal(reads, 0); assert.equal(released, false); assert.equal(source.locked, true); assert.equal(bodyBudgetCharged(), 64 * 1024 * 1024);
  acknowledge(); await retirement;
  assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), 0);
});
