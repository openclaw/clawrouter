import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { byteResponse, jsonResponse } from "./minimax-search-byte-fixture.mjs";
const { MiniMaxSearchOperation, readSearchJson, searchJsonBytes, inspectSearchJson, assertSearchHeaders } = await import("../minimax-search-operation.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const MiB = 1024 * 1024, headers = { "content-type": "application/json" };
const owner = signal => new MiniMaxSearchOperation(new Request("https://router.example.invalid/search", { signal }), 10000);
const response = (text, size = 16384) => byteResponse(text, { headers });
function held(invalid = false, reject = false) {
  const read = Promise.withResolvers(), readAck = Promise.withResolvers(), cancel = Promise.withResolvers(), cancelAck = Promise.withResolvers();
  let cancels = 0, unlocks = 0;
  const body = new ReadableStream({ type: "bytes", pull() { read.resolve(); }, cancel() { cancels++; cancel.resolve(); return cancelAck.promise.then(() => { if (reject) throw new Error("synthetic cleanup rejection"); }); } }, { highWaterMark: 0 });
  const get = body.getReader.bind(body); body.getReader = options => {
    const reader = get(options); return { async read(...args) { try { return await reader.read(...args); } finally { await readAck.promise; } },
      cancel: reason => reader.cancel(reason), releaseLock() { unlocks++; reader.releaseLock(); } };
  };
  return { response: new Response(body, { headers: invalid ? { "content-type": "text/plain" } : headers }), body, read, readAck, cancel, cancelAck,
    cancels: () => cancels, unlocks: () => unlocks };
}
test("Search target36 admits72 and atomic contention with24; no eager work on failure", async () => {
  const competitor = new BodyLease(); assert.equal(competitor.grow(12 * MiB), true);
  const operation = owner(); assert.equal(bodyBudgetCharged(), 96 * MiB); assert.throws(() => owner(), e => e.code === "server_overloaded");
  await operation.finish(); await operation.finish(); assert.equal(bodyBudgetCharged(), 24 * MiB); competitor.release(); assert.equal(bodyBudgetCharged(), 0);
});
test("Search preflights escaped bytes, duplicate occurrences, depth, scalar and header counts before full serialization", () => {
  const saved = JSON.stringify; let calls = 0;
  JSON.stringify = () => { calls++; throw new Error("must preflight first"); };
  try { assert.equal(searchJsonBytes({ q: "\u0000".repeat(100) }), 608); assert.throws(() => searchJsonBytes({ q: "\u0000".repeat(3000) })); assert.equal(calls, 0);
    assert.throws(() => searchJsonBytes({ get q() { throw new Error("getter accessed"); } }));
  } finally { JSON.stringify = saved; }
  for (const text of ['{' + '"a":0,'.repeat(128) + '"a":1}', '['.repeat(17) + '0' + ']'.repeat(17), JSON.stringify({ q: "x".repeat(4097) })]) assert.throws(() => inspectSearchJson(text));
  const many = new Headers(Array.from({ length: 33 }, (_, i) => [`x-${i}`, "v"])); assert.throws(() => assertSearchHeaders(many, true));
  assert.throws(() => assertSearchHeaders(new Headers({ x: "x".repeat(4096) }), true));
});
for (const profile of ["control", "input", "native"]) test(`Search complete ${profile} wire maximum and bounded shape`, async () => {
  const cap = profile === "control" ? 16384 : profile === "input" ? 65536 : MiB;
  const operation = owner();
  assert.deepEqual(await operation.track(readSearchJson(response("{}" + " ".repeat(cap - 2)), operation.operation.signal, profile, operation.registerInput)), {});
  await operation.finish(); assert.equal(bodyBudgetCharged(), 0);
});
for (const empty of [8190, 8191]) test(`Search ${empty + 2} reads INCLUDING empty and EOF`, async () => {
  let reads = 0; const operation = owner();
  const source = response("{}");
  const get = source.body.getReader.bind(source.body);
  source.body.getReader = options => {
    const reader = get(options);
    return { read(view) { reads++; return reads <= empty ? Promise.resolve({ value: new Uint8Array(view.buffer, 0, 0), done: false }) : reader.read(view); },
      cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock() };
  };
  const pending = operation.track(readSearchJson(source, operation.operation.signal, "control", operation.registerInput));
  if (empty === 8190) assert.deepEqual(await pending, {}); else await assert.rejects(pending);
  await operation.finish(); assert.equal(bodyBudgetCharged(), 0);
});
for (const reject of [false, true]) test(`Search FIRST cancellation and original pending read retire independently (cleanup rejection=${reject})`, async () => {
  const controller = new AbortController(), operation = owner(controller.signal), h = held(false, reject);
  let input;
  const pending = operation.track(readSearchJson(h.response, operation.operation.signal, "native", (i, r) => { input = i; operation.registerInput(i, r); }));
  const publicResult = operation.operation.wait(pending); const failure = assert.rejects(publicResult);
  await h.read.promise; controller.abort(); await failure; await h.cancel.promise;
  void input.retire("cancel").catch(() => undefined); assert.equal(h.cancels(), 1);
  let finished = false; const retirement = operation.finish().then(() => { finished = true; });
  assert.equal(bodyBudgetCharged(), 72 * MiB); assert.equal(h.body.locked, true);
  h.cancelAck.resolve(); await Promise.resolve(); assert.equal(finished, false); assert.equal(h.body.locked, true);
  h.readAck.resolve(); await retirement; assert.equal(h.unlocks(), 1); assert.equal(h.body.locked, false); assert.equal(bodyBudgetCharged(), 0);
  if (reject) await assert.rejects(input.retired, /synthetic cleanup/);
});
test("Search header rejection keeps FIRST cleanup and lock after prompt public failure", async () => {
  const operation = owner(), h = held(true);
  const rejection = assert.rejects(operation.track(readSearchJson(h.response, operation.operation.signal, "native", operation.registerInput)));
  await h.cancel.promise; await rejection; assert.equal(bodyBudgetCharged(), 72 * MiB); assert.equal(h.body.locked, true);
  const finished = operation.finish(); h.cancelAck.resolve(); h.readAck.resolve(); await finished;
  assert.equal(h.cancels(), 1); assert.equal(h.unlocks(), 1); assert.equal(bodyBudgetCharged(), 0);
});
test("Search unqualified default reader denies BEFORE acquiring any returned backing", async () => {
  const operation = owner(); let reads = 0, cancels = 0;
  const body = new ReadableStream({ pull() { reads++; throw new Error("must not read"); }, cancel() { cancels++; } }, { highWaterMark: 0 });
  await assert.rejects(operation.track(readSearchJson(new Response(body, { headers }), operation.operation.signal, "native", operation.registerInput)));
  await operation.finish(); assert.equal(reads, 0); assert.equal(cancels, 1); assert.equal(body.locked, false); assert.equal(bodyBudgetCharged(), 0);
});
test("Search late response disposal joins FIRST cancel; no second attempt", async () => {
  const abort = new AbortController(), operation = owner(abort.signal), arrival = Promise.withResolvers(), h = held(true);
  let posts = 0; await operation.reserveProvider(); const pending = operation.providerFetch(() => { posts++; return arrival.promise; });
  const publicFailure = assert.rejects(operation.operation.wait(pending)); abort.abort(); await publicFailure;
  const finished = operation.finish(); arrival.resolve(h.response); await h.cancel.promise;
  assert.equal(bodyBudgetCharged(), 72 * MiB); assert.equal(h.body.locked, true); h.cancelAck.resolve(); h.readAck.resolve();
  await finished; assert.equal(posts, 1); assert.equal(h.cancels(), 1); assert.equal(h.unlocks(), 1); assert.equal(bodyBudgetCharged(), 0);
});
test("Search four ordinary slots gate construction; mandatory slot progresses independently", async () => {
  const operation = owner(), releases = Array.from({ length: 4 }, () => Promise.withResolvers()), started = Promise.withResolvers();
  let calls = 0;
  const tasks = releases.map(release => operation.controlJson({ op: "ordinary" }, async () => { calls++; if (calls === 4) started.resolve(); await release.promise; return jsonResponse({ ok: true }); }));
  await started.promise; const fifth = operation.controlJson({ op: "queued" }, async () => { calls++; return jsonResponse({ ok: true }); });
  assert.equal(calls, 4);
  assert.deepEqual(await operation.controlJson({ op: "mandatory" }, async () => jsonResponse({ ok: true }), true), { ok: true });
  releases[0].resolve(); await fifth; assert.equal(calls, 5); for (const release of releases) release.resolve();
  await Promise.all(tasks); await operation.finish(); assert.equal(bodyBudgetCharged(), 0);
});
test("Search nonrefundable22 ordinary and10 mandatory caps deny BEFORE fetch construction", async () => {
  const operation = owner(); let calls = 0;
  const maximum = { first: "x".repeat(4096), second: "y".repeat(4070), values: Array(124).fill(null) };
  const wire = JSON.stringify(maximum);
  const run = mandatory => operation.controlJson(maximum, async () => { calls++; return response(wire + " ".repeat(16384 - wire.length)); }, mandatory);
  for (let i = 0; i < 22; i++) await run(false);
  await assert.rejects(run(false)); assert.equal(calls, 22);
  for (let i = 0; i < 10; i++) await run(true);
  await assert.rejects(run(true)); assert.equal(calls, 32); await operation.finish(); assert.equal(bodyBudgetCharged(), 0);
});
test("Search failed mandatory predecessor keeps its slot through cleanup before fallback", async () => {
  const operation = owner(), h = held(true), started = Promise.withResolvers(); let fallback = false;
  const first = operation.controlJson({}, async () => { started.resolve(); return h.response; }, true);
  const failed = assert.rejects(first); await started.promise; await h.cancel.promise;
  const next = operation.controlJson({}, async () => { fallback = true; return jsonResponse({}); }, true);
  assert.equal(fallback, false); assert.equal(bodyBudgetCharged(), 72 * MiB);
  h.cancelAck.resolve(); h.readAck.resolve(); await failed; await next; await operation.finish(); assert.equal(bodyBudgetCharged(), 0);
});
test("Search serial finalization attempts all four original legs even when the first fallback fails", async () => {
  const { settleBudget } = await import("../accounting.ts");
  const operation = owner(), seen = [];
  const env = { BUDGET_LEDGER: { idFromName: n => n, get: name => ({ async fetch() { seen.push(name); return jsonResponse({ error: "synthetic" }, { status: 503 }); } }) },
    USAGE_QUEUE: { async send(message) { seen.push("queue:" + message.ledger.objectName); if (message.ledger.objectName === "leg0") throw new Error("synthetic queue refusal"); } } };
  const reservation = { reservedMicros: 700, reservations: Array.from({ length: 4 }, (_, i) => ({ objectName: "leg" + i, reservationId: "reserve" + i })) };
  await assert.rejects(operation.track(settleBudget(env, reservation, 700, operation)), /synthetic queue refusal/);
  assert.deepEqual(seen, ["leg0", "queue:leg0", "leg1", "queue:leg1", "leg2", "queue:leg2", "leg3", "queue:leg3"]);
  await operation.finish(); assert.equal(bodyBudgetCharged(), 0);
});
test("Search bodyless mandatory reply retires its slot BEFORE existing fallback", async () => {
  const { settleBudget } = await import("../accounting.ts");
  const operation = owner(); let calls = 0, queued = 0;
  const env = { BUDGET_LEDGER: { idFromName: n => n, get: () => ({ async fetch() { calls++; return new Response(null, { status: 503 }); } }) },
    USAGE_QUEUE: { async send() { queued++; } } };
  await operation.track(settleBudget(env, { reservedMicros: 700, reservations: [{ objectName: "leg", reservationId: "r" }] }, 700, operation));
  assert.equal(calls, 1); assert.equal(queued, 1); await operation.finish(); assert.equal(bodyBudgetCharged(), 0);
});
test("Search original deadline remains live through unclaimed downstream retirement", async t => {
  const { observeUsage } = await import("../proxy-response.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = new MiniMaxSearchOperation(new Request("https://router.example.invalid/search"), 100);
  const observed = observeUsage(response("{}"), operation.operation, undefined, "minimax.search", undefined, { tokens: null, outcome: "success" });
  operation.track(observed.retired); const finished = operation.finish();
  assert.equal(bodyBudgetCharged(), 72 * MiB); t.mock.timers.tick(100);
  assert.equal((await observed.result).delivery, "failed"); await finished; assert.equal(bodyBudgetCharged(), 0);
});
for (const reject of [false, true]) test(`Search post-abort mandatory late reader has a bounded execution signal and separate cleanup (${reject})`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController(), operation = owner(controller.signal), arrival = Promise.withResolvers(), h = held(false, reject);
  controller.abort(); let physicalSignal, input;
  const register = operation.registerInput;
  operation.registerInput = (i, r) => { input = i; register(i, r); };
  const pending = operation.controlJson({}, async (_body, signal) => { physicalSignal = signal; return arrival.promise; }, true);
  const rejected = assert.rejects(pending);
  await Promise.resolve(); await Promise.resolve(); arrival.resolve(h.response); await h.read.promise;
  assert.equal(physicalSignal.aborted, false); t.mock.timers.tick(30000); await h.cancel.promise;
  assert.equal(physicalSignal.aborted, true); assert.equal(bodyBudgetCharged(), 72 * MiB); assert.equal(h.body.locked, true);
  h.cancelAck.resolve(); await Promise.resolve(); assert.equal(h.body.locked, true);
  h.readAck.resolve(); await rejected;
  if (reject) await assert.rejects(input.retired, /synthetic cleanup/); else await input.retired;
  await operation.finish(); assert.equal(h.cancels(), 1); assert.equal(h.unlocks(), 1); assert.equal(bodyBudgetCharged(), 0);
});
