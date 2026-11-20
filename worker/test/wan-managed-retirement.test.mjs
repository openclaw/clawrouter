import assert from "node:assert/strict";
import test from "node:test";
import { BodyLease, bodyBudgetCharged } from "../body-budget.ts";
import { HttpOperation } from "../http-operation.ts";
import { WanManagedOperation, readWanJson, preflightWanJson, assertWanHeaders,
  wanOperationCharge, wanRequestBytes, wanRecordBytes } from "../managed-media-json.ts";

const MiB = 1024 * 1024;
const encoder = new TextEncoder();
const deferred = () => Promise.withResolvers();
const headers = { "content-type": "application/json" };
function response(text, size = 1024) {
  const wire = encoder.encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === wire.length) { controller.close(); return; }
      const end = Math.min(offset + size, wire.length);
      controller.enqueue(wire.slice(offset, end)); offset = end;
    },
  }, { highWaterMark: 0 }), { headers });
}
async function parsed(source, maximum = MiB, control = false) {
  const owner = new WanManagedOperation(), operation = new HttpOperation();
  try {
    return await owner.track(readWanJson(source, maximum, { signal: operation.signal, registerInput: owner.registerInput, control }));
  } finally { operation.stop("complete"); await owner.finish(); }
}

// A native read can settle before its test acknowledgment. The finally barrier
// covers BOTH fulfillment and rejection, independently of the FIRST cancel ACK.
function heldSource({ invalidHeaders = false, rejectCleanup = false } = {}) {
  const read = deferred(), readAck = deferred(), cancel = deferred(), cancelAck = deferred();
  const body = new ReadableStream({
    pull() { read.resolve(); },
    cancel() { cancel.resolve(); return cancelAck.promise.then(() => { if (rejectCleanup) throw new Error("synthetic cleanup rejection"); }); },
  }, { highWaterMark: 0 });
  const nativeGetReader = body.getReader.bind(body);
  let releases = 0;
  body.getReader = options => {
    if (options?.mode === "byob") throw new TypeError("default reader fixture");
    const reader = nativeGetReader();
    return {
      async read() { try { return await reader.read(); } finally { await readAck.promise; } },
      cancel: reason => reader.cancel(reason),
      releaseLock() { releases++; reader.releaseLock(); },
    };
  };
  return { body, response: new Response(body, { headers: invalidHeaders ? { "content-type": "text/plain" } : headers }),
    read, readAck, cancel, cancelAck, releases: () => releases };
}

test("Wan admits one constant72MiB target, full-pool contention is atomic, and release is idempotent", async () => {
  const competing = new BodyLease(); assert.equal(competing.grow(12 * MiB), true);
  const owner = new WanManagedOperation(); assert.equal(bodyBudgetCharged(), 96 * MiB);
  const refused = new BodyLease(); assert.equal(refused.grow(MiB), false);
  assert.throws(() => new WanManagedOperation(), error => error.code === "server_overloaded");
  assert.equal(bodyBudgetCharged(), 96 * MiB);
  await owner.finish(); await owner.finish(); assert.equal(bodyBudgetCharged(), 24 * MiB);
  competing.release(); assert.equal(bodyBudgetCharged(), 0);
});

test("Wan preflights SIX-fold escaping before stringify, encoding or canonical sort", () => {
  const stringify = JSON.stringify;
  let called = 0;
  JSON.stringify = () => { called++; throw new Error("full serialization must not run"); };
  try {
    assert.equal(preflightWanJson({ prompt: "\u0000".repeat(100) }), 613);
    assert.throws(() => preflightWanJson({ prompt: "\u0000".repeat(12000) }), error => error.code === "invalid_wan_json");
    assert.equal(called, 0);
    assert.throws(() => preflightWanJson({ get secret() { throw new Error("getter invoked"); } }), error => error.code === "invalid_wan_json");
  } finally { JSON.stringify = stringify; }
  for (const value of [{ a: "é😀\ud800\n\\\"" }, { b: [-0, 1e21, true, false, null] }])
    assert.equal(preflightWanJson(value), encoder.encode(JSON.stringify(value)).length);
  assert.throws(() => assertWanHeaders(new Headers({ "x-large": "é".repeat(8192) })));
});

test("Wan accepts full8MiB wire without whole encoded-copy or graph growth", async () => {
  const json = '{"model":"wan2.6-t2v","input":{"prompt":"synthetic"}}';
  const source = response(json + " ".repeat(wanRequestBytes - encoder.encode(json).length), 16 * 1024);
  source.headers.set("content-length", String(wanRequestBytes));
  const result = await parsed(source, wanRequestBytes);
  assert.equal(result.text.length, wanRequestBytes);
  assert.equal(result.body.input.prompt, "synthetic");
  assert.equal(source.body.locked, false); assert.equal(bodyBudgetCharged(), 0);
});

for (const [name, text] of [
  ["depth", '{"a":'.repeat(33) + '0' + '}'.repeat(33)],
  ["single decoded string", JSON.stringify({ a: "x".repeat(65537) })],
  ["discarded duplicate strings", '{' + Array.from({ length: 5 }, () => '"same":' + JSON.stringify("x".repeat(60000))).join(',') + '}'],
  ["object members", '{' + Array.from({ length: 129 }, (_, i) => JSON.stringify(String(i)) + ':0').join(',') + '}'],
  ["array elements", JSON.stringify({ a: Array(1025).fill(0) })],
  ["number work", '{"n":' + '1'.repeat(129) + '}'],
]) test(`Wan rejects ${name} BEFORE JSON.parse, retaining its physical reader until retired`, async () => {
  const parse = JSON.parse;
  let calls = 0;
  JSON.parse = () => { calls++; throw new Error("unbounded AST allocation"); };
  try { await assert.rejects(parsed(response(text)), error => error.code === "invalid_wan_json"); }
  finally { JSON.parse = parse; }
  assert.equal(calls, 0); assert.equal(bodyBudgetCharged(), 0);
});

for (const reads of [8192, 8193]) test(`Wan counts EMPTY and EOF reads: ${reads}`, async () => {
  let count = 0;
  const source = new Response(new ReadableStream({
    pull(controller) {
      count++;
      if (count === reads) controller.close();
      else controller.enqueue(count === 1 ? encoder.encode('{}') : new Uint8Array());
    },
  }, { highWaterMark: 0 }), { headers });
  if (reads === 8192) assert.deepEqual((await parsed(source)).body, {});
  else await assert.rejects(parsed(source), error => error.code === "invalid_wan_json");
  assert.equal(count, 8192); assert.equal(source.body.locked, false); assert.equal(bodyBudgetCharged(), 0);
});

test("Wan rejects oversized backing even when the visible chunk fits", async () => {
  let canceled = 0;
  const source = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(new ArrayBuffer(16385), 0, 1)); },
    cancel() { canceled++; },
  }, { highWaterMark: 0 }), { headers });
  await assert.rejects(parsed(source));
  assert.equal(canceled, 1); assert.equal(source.body.locked, false); assert.equal(bodyBudgetCharged(), 0);
});

for (const rejectCleanup of [false, true]) test(`Wan prompt abort joins original read AND FIRST cancel, cleanup rejection=${rejectCleanup}`, async () => {
  const source = heldSource({ rejectCleanup }), controller = new AbortController();
  const operation = new HttpOperation(controller.signal), owner = new WanManagedOperation();
  const physical = owner.track(readWanJson(source.response, MiB, { signal: operation.signal, registerInput: owner.registerInput }));
  const publicResult = operation.wait(physical);
  const rejected = assert.rejects(publicResult, error => error.message === "synthetic caller abort");
  await source.read.promise; controller.abort(new Error("synthetic caller abort"));
  await rejected; await source.cancel.promise;
  const retirement = owner.finish();
  assert.equal(bodyBudgetCharged(), wanOperationCharge); assert.equal(source.body.locked, true);
  const competing = new BodyLease(); assert.equal(competing.grow(13 * MiB), false);
  source.cancelAck.resolve(); await Promise.resolve();
  assert.equal(bodyBudgetCharged(), wanOperationCharge); assert.equal(source.body.locked, true);
  source.readAck.resolve(); await retirement;
  assert.equal(source.releases(), 1); assert.equal(bodyBudgetCharged(), 0);
  assert.equal(source.body.locked, false); await owner.finish(); assert.equal(source.releases(), 1);
});

test("Wan header refusal remains prompt while FIRST cleanup ACK holds capacity and lock", async () => {
  const source = heldSource({ invalidHeaders: true }), owner = new WanManagedOperation();
  const operation = new HttpOperation();
  await assert.rejects(owner.track(readWanJson(source.response, MiB, { signal: operation.signal, registerInput: owner.registerInput })));
  await source.cancel.promise;
  const retirement = owner.finish();
  assert.equal(bodyBudgetCharged(), wanOperationCharge); assert.equal(source.body.locked, true);
  source.cancelAck.resolve(); await retirement;
  assert.equal(source.releases(), 1); assert.equal(bodyBudgetCharged(), 0);
});

test("Wan late fetch disposal retains the operation until physical cancellation retires", async () => {
  const late = deferred(), cleanup = deferred(), canceled = deferred();
  const source = new Response(new ReadableStream({ cancel() { canceled.resolve(); return cleanup.promise; } }), { headers });
  const operation = new HttpOperation(), owner = new WanManagedOperation();
  const pending = owner.fetch(late.promise, operation), rejected = assert.rejects(pending);
  operation.cancel(new Error("synthetic caller abort")); await rejected;
  const retirement = owner.finish(); late.resolve(source); await canceled.promise;
  assert.equal(bodyBudgetCharged(), wanOperationCharge); assert.equal(source.body.locked, true);
  cleanup.resolve(); await retirement;
  assert.equal(bodyBudgetCharged(), 0); assert.equal(source.body.locked, false);
});

for (const action of ["eof", "cancel", "unclaimed-abort"]) test(`Wan output retains charge through downstream ${action}`, async () => {
  const owner = new WanManagedOperation(), caller = new AbortController();
  const result = owner.publish({ result: "x".repeat(50000) }, 200, headers, caller.signal);
  const retirement = owner.finish();
  assert.equal(bodyBudgetCharged(), wanOperationCharge);
  if (action === "eof") assert.equal((await result.json()).result.length, 50000);
  else if (action === "cancel") { const reader = result.body.getReader(); await reader.read(); await reader.cancel(); reader.releaseLock(); }
  else caller.abort();
  await retirement; assert.equal(bodyBudgetCharged(), 0);
});

test("Wan whole-op tickets reserve three mandatory exchanges independently of the two physical slots", async () => {
  const owner = new WanManagedOperation();
  for (let i = 0; i < 4; i++) owner.beginControl(false)();
  const heldOrdinary = owner.beginControl(false);
  assert.throws(() => owner.beginControl(false));
  const heldMandatory = owner.beginControl(true);
  assert.throws(() => owner.beginControl(true));
  heldMandatory(); heldOrdinary();
  owner.beginControl(true)(); owner.beginControl(true)();
  assert.throws(() => owner.beginControl(false)); assert.throws(() => owner.beginControl(true));
  await owner.finish(); assert.equal(bodyBudgetCharged(), 0);
});

test("Wan bounded control accepts authoritative null, rejects larger records and preserves default reader ABI", async () => {
  assert.equal((await parsed(response('null'), wanRecordBytes, true)).body, null);
  await assert.rejects(parsed(response(JSON.stringify({ ignored: "x".repeat(16385) })), wanRecordBytes, true));
  assert.equal(bodyBudgetCharged(), 0);
});

test("Wan failed ordinary ACK keeps its physical slot while mandatory settlement can progress", async () => {
  const owner = new WanManagedOperation(), source = heldSource({ invalidHeaders: true });
  await assert.rejects(owner.controlJson({ action: "inspect" }, async () => source.response));
  await source.cancel.promise;
  assert.throws(() => owner.beginControl(false));
  assert.equal(bodyBudgetCharged(), wanOperationCharge); assert.equal(source.body.locked, true);
  assert.deepEqual(await owner.controlJson({ action: "freeze" }, async () => response('{"ok":true}'), true), { ok: true });
  assert.throws(() => owner.beginControl(false));
  source.cancelAck.resolve(); await owner.finish();
  assert.equal(source.releases(), 1); assert.equal(bodyBudgetCharged(), 0);
});

test("Wan late ACK keeps its slot until the original late body cancellation settles", async () => {
  const owner = new WanManagedOperation(), caller = new AbortController(), late = deferred(), cleanup = deferred(), canceled = deferred();
  const result = owner.controlJson({}, () => late.promise, false, caller.signal), failure = assert.rejects(result);
  caller.abort(new Error("synthetic abort")); await failure;
  assert.throws(() => owner.beginControl(false));
  assert.deepEqual(await owner.controlJson({}, async () => response('{}'), true), {});
  late.resolve(new Response(new ReadableStream({ cancel() { canceled.resolve(); return cleanup.promise; } }), { headers }));
  await canceled.promise; const retired = owner.finish();
  assert.equal(bodyBudgetCharged(), wanOperationCharge); assert.throws(() => owner.beginControl(false));
  cleanup.resolve(); await retired; assert.equal(bodyBudgetCharged(), 0);
});

test("Wan preflights the whole scope scan without spending or narrowing tickets", async () => {
  const owner = new WanManagedOperation();
  assert.throws(() => owner.requireOrdinary(6));
  owner.requireOrdinary(5);
  for (let i = 0; i < 5; i++) owner.beginControl(false)();
  assert.throws(() => owner.requireOrdinary(1));
  for (let i = 0; i < 3; i++) owner.beginControl(true)();
  await owner.finish(); assert.equal(bodyBudgetCharged(), 0);
});

test("Wan native control spends one transport ticket and reads1MiB instead of an ACK envelope", async () => {
  const owner = new WanManagedOperation(), operation = new HttpOperation();
  const text = '{"output":{"task_id":"synthetic","task_status":"RUNNING"}}';
  const source = await owner.nativeResponse(async () => response(text + " ".repeat(MiB - text.length), 16 * 1024), operation.signal);
  const value = (await readWanJson(source, MiB, { signal: operation.signal, registerInput: owner.registerInput })).body;
  assert.equal(value.output.task_id, "synthetic");
  for (let i = 0; i < 4; i++) owner.beginControl(false)();
  assert.throws(() => owner.beginControl(false)); operation.stop("complete");
  await owner.finish(); assert.equal(bodyBudgetCharged(), 0);
});

for (const [kind, ordinary, mandatory] of [["create", 5, 3], ["poll", 7, 1], ["collector", 8, 0]])
  test(`Wan ${kind} reserves its exact share of eight nonrefundable tickets`, async () => {
    const owner = new WanManagedOperation(kind); owner.requireOrdinary(ordinary);
    for (let i = 0; i < ordinary; i++) owner.beginControl(false)();
    assert.throws(() => owner.beginControl(false));
    for (let i = 0; i < mandatory; i++) owner.beginControl(true)();
    assert.throws(() => owner.beginControl(true));
    await owner.finish(); assert.equal(bodyBudgetCharged(), 0);
  });

test("Wan native transport retains its slot through FIRST cancel and original read independently", async () => {
  const owner = new WanManagedOperation("poll"), source = heldSource(), caller = new AbortController(), operation = new HttpOperation(caller.signal);
  const native = await owner.nativeResponse(async () => source.response, operation.signal);
  const reading = owner.track(readWanJson(native, MiB, { signal: operation.signal, registerInput: owner.registerInput }));
  const failed = assert.rejects(operation.wait(reading));
  await source.read.promise; caller.abort(new Error("synthetic abort")); await failed; await source.cancel.promise;
  assert.throws(() => owner.beginControl(false)); owner.beginControl(true)();
  const retirement = owner.finish(); source.cancelAck.resolve(); await Promise.resolve();
  assert.equal(bodyBudgetCharged(), wanOperationCharge); assert.equal(source.body.locked, true);
  source.readAck.resolve(); await retirement;
  assert.equal(source.releases(), 1); assert.equal(bodyBudgetCharged(), 0);
});
