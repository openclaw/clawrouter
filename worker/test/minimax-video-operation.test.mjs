import assert from "node:assert/strict";
import test from "node:test";
import { byteBody, jsonResponse } from "./minimax-search-byte-fixture.mjs";
const { MiniMaxVideoOperation, readVideoJson, readVideoFileBytes, videoJsonBytes } = await import("../minimax-video-operation.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const MiB = 1024 * 1024, tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();

test("Hailuo fixed96 admission is before intake; failure has no read or job", async () => {
  const competitor = new BodyLease(); let owner, reads = 0;
  const request = new Request("https://router.example", { method: "POST", duplex: "half", body: new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 }) });
  try {
    assert.equal(competitor.grow(MiB), true); assert.equal(bodyBudgetCharged(), 2 * MiB);
    assert.throws(() => new MiniMaxVideoOperation("create", request), { code: "server_overloaded" });
    assert.equal(reads, 0); assert.equal(bodyBudgetCharged(), 2 * MiB); competitor.release();
    owner = new MiniMaxVideoOperation("create"); assert.equal(bodyBudgetCharged(), 96 * MiB);
    assert.equal(competitor.grow(MiB), false); assert.equal(bodyBudgetCharged(), 96 * MiB);
  } finally { competitor.release(); await request.body.cancel(); await owner?.finish(); }
  assert.equal(bodyBudgetCharged(), 0);
});

test("Hailuo JSON preflight counts escaped UTF8 and all occurrences before serialization", () => {
  assert.equal(videoJsonBytes({ a: "\u0000" }), Buffer.byteLength(JSON.stringify({ a: "\u0000" })));
  assert.throws(() => videoJsonBytes({ a: "\u0000".repeat(16384) }));
  assert.throws(() => videoJsonBytes({ a: Array(512).fill(null) }));
  let value = {}; for (let i = 0; i < 17; i++) value = { a: value }; assert.throws(() => videoJsonBytes(value));
});
test("Hailuo non-BYOB producer denies before first acquisition and joins FIRST cancel", async () => {
  const ack = deferred(), owner = new MiniMaxVideoOperation("poll"); let reads = 0, cancels = 0;
  const source = new ReadableStream({ pull() { reads++; }, cancel() { cancels++; return ack.promise; } }, { highWaterMark: 0 });
  const response = new Response(source, { headers: { "content-type": "application/json" } });
  const reading = readVideoJson(response, owner.controlSignal, "control", owner.registerInput);
  await assert.rejects(reading); assert.equal(reads, 0); assert.equal(cancels, 1); assert.equal(source.locked, true);
  const finish = owner.finish(); await tick(); assert.equal(bodyBudgetCharged(), 96 * MiB);
  ack.resolve(); await finish; assert.equal(source.locked, false); assert.equal(bodyBudgetCharged(), 0);
});
for (const rejectCleanup of [false, true]) test(`Hailuo original read/FIRST cancel independently held; rejection=${rejectCleanup}`, async () => {
  const owner = new MiniMaxVideoOperation("poll"), source = byteBody('{"ok":true}'), entered = deferred(), readAck = deferred(), cancelAck = deferred();
  const response = new Response(source, { headers: { "content-type": "application/json" } });
  const get = source.getReader.bind(source); let cancels = 0, unlocks = 0;
  source.getReader = options => { const reader = get(options); return {
    async read(...args) { try { return await reader.read(...args); } finally { entered.resolve(); await readAck.promise; } },
    async cancel(reason) { cancels++; await reader.cancel(reason); await cancelAck.promise; if (rejectCleanup) throw new Error("cleanup rejected"); },
    releaseLock() { unlocks++; reader.releaseLock(); },
  }; };
  const input = readVideoJson(response, owner.controlSignal, "control", owner.registerInput); void input.catch(() => undefined);
  await entered.promise; owner.operation.stop("upstream", new Error("synthetic cancellation"));
  const finish = owner.finish(); void finish.catch(() => undefined); await tick();
  assert.equal(cancels, 1); assert.equal(unlocks, 0); assert.equal(source.locked, true); assert.equal(bodyBudgetCharged(), 96 * MiB);
  cancelAck.resolve(); await tick(); assert.equal(unlocks, 0); assert.equal(bodyBudgetCharged(), 96 * MiB);
  readAck.resolve(); await assert.rejects(input);
  if (rejectCleanup) await assert.rejects(finish, { code: "minimax_video_cleanup_failed" }); else await finish;
  assert.equal(cancels, 1); assert.equal(unlocks, 1); assert.equal(bodyBudgetCharged(), 0);
});
test("Hailuo bodyless mandatory refusal retires its slot before the next bounded attempt", async () => {
  const owner = new MiniMaxVideoOperation("create");
  await assert.rejects(owner.controlJson({ action: "dispatch" }, async () => new Response(null, { status: 503 }), true));
  assert.deepEqual(await owner.controlJson({ action: "freeze" }, async () => jsonResponse({ frozen: true }), true), { frozen: true });
  await owner.finish(); assert.equal(bodyBudgetCharged(), 0);
});
test("Hailuo all32 nonrefundable tickets retain a fixed charge; over-budget never starts", async () => {
  const owner = new MiniMaxVideoOperation("poll"); let fetches = 0;
  const maximum = { a: "x".repeat(16380), b: "x".repeat(16380), c: Array(508).fill(null) }, retained = [];
  const text = JSON.stringify(maximum), wire = text + " ".repeat(65536 - Buffer.byteLength(text));
  for (let i = 0; i < 32; i++) {
    const value = await owner.controlJson(maximum, async () => { fetches++; return new Response(byteBody(wire), { headers: { "content-type": "application/json", "content-length": "65536" } }); }, i >= 22);
    retained.push(value); assert.equal(value.c.length, 508); assert.equal(bodyBudgetCharged(), 96 * MiB);
  }
  await assert.rejects(owner.controlJson({}, async () => { fetches++; return jsonResponse({}); }, true));
  assert.equal(fetches, 32); assert.equal(retained.length, 32); await owner.finish(); assert.equal(bodyBudgetCharged(), 0);
});
test("Hailuo whole file accumulator persists through bounded-view downstream cancellation", async () => {
  const owner = new MiniMaxVideoOperation("file"), source = new Response(byteBody(new Uint8Array(16 * MiB)), { headers: { "content-type": "video/mp4" } });
  const bytes = await readVideoFileBytes(source, 16 * MiB, owner.controlSignal, owner.registerInput);
  assert.equal(bytes.buffer.byteLength, 16 * MiB); assert.equal(source.body.locked, false);
  const output = owner.publishFile(bytes, { "content-type": "video/mp4" }), finish = owner.finish();
  const reader = output.body.getReader(), part = await reader.read(); assert.equal(part.value.byteLength, 16384);
  assert.equal(bodyBudgetCharged(), 96 * MiB); await reader.cancel(); reader.releaseLock(); await finish; assert.equal(bodyBudgetCharged(), 0);
});
test("Hailuo unclaimed JSON output remains subject to the ORIGINAL deadline", async () => {
  const owner = new MiniMaxVideoOperation("poll", undefined, 10);
  const response = owner.publish({ ok: true }, 200, { "content-type": "application/json" });
  const finish = owner.finish(); assert.equal(bodyBudgetCharged(), 96 * MiB);
  await finish; await assert.rejects(response.text()); assert.equal(bodyBudgetCharged(), 0);
});

test("Hailuo mandatory slot progresses while all four ordinary FIRST cancellations remain held", async () => {
  const owner = new MiniMaxVideoOperation("poll"), release = deferred(), entered = Array.from({ length: 4 }, deferred);
  let ordinary = 0, mandatory = 0, cancels = 0;
  const inputs = entered.map((ready, i) => owner.controlJson({ i }, async () => {
    ordinary++; return new Response(new ReadableStream({ type: "bytes", pull() { ready.resolve(); },
      cancel() { cancels++; return release.promise; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  }));
  for (const pending of inputs) void pending.catch(() => undefined);
  try {
    await Promise.all(entered.map(item => item.promise)); owner.operation.cancel(new Error("controlled cancellation"));
    await tick(); assert.equal(ordinary, 4); assert.equal(cancels, 4);
    const result = await owner.controlJson({ action: "managed_observe" }, async () => { mandatory++; return jsonResponse({ observed: true }); }, true);
    assert.deepEqual(result, { observed: true }); assert.equal(mandatory, 1); assert.equal(bodyBudgetCharged(), 96 * MiB);
  } finally { release.resolve(); await Promise.allSettled(inputs); await owner.finish(); }
  assert.equal(bodyBudgetCharged(), 0);
});
