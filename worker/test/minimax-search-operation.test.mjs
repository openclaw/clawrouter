import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { MiniMaxSearchOperation, readSearchJson, searchJsonBytes, inspectSearchJson, assertSearchHeaders } = await import("../minimax-search-operation.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const MiB = 1024 * 1024, headers = { "content-type": "application/json" };
const owner = signal => new MiniMaxSearchOperation(new Request("https://router.example.invalid/search", { signal }), 10000);
function response(text, size = 16384) {
  const wire = new TextEncoder().encode(text); let at = 0;
  return new Response(new ReadableStream({ pull(c) { if (at === wire.length) { c.close(); return; }
    const end = Math.min(at + size, wire.length); c.enqueue(wire.slice(at, end)); at = end;
  } }, { highWaterMark: 0 }), { headers });
}
function held(invalid = false, reject = false) {
  const read = Promise.withResolvers(), readAck = Promise.withResolvers(), cancel = Promise.withResolvers(), cancelAck = Promise.withResolvers();
  let cancels = 0, unlocks = 0;
  const body = new ReadableStream({ pull() { read.resolve(); }, cancel() { cancels++; cancel.resolve(); return cancelAck.promise.then(() => { if (reject) throw new Error("synthetic cleanup rejection"); }); } }, { highWaterMark: 0 });
  const get = body.getReader.bind(body); body.getReader = options => {
    if (options?.mode === "byob") throw new TypeError("default fixture");
    const reader = get(); return { async read() { try { return await reader.read(); } finally { await readAck.promise; } },
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
  const source = new Response(new ReadableStream({ pull(c) { const n = reads++; if (n < empty) c.enqueue(new Uint8Array()); else if (n === empty) c.enqueue(new TextEncoder().encode("{}")); else c.close(); } }, { highWaterMark: 0 }), { headers });
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
test("Search backing size is enforced even for a tiny view", async () => {
  const operation = owner(); const source = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(new ArrayBuffer(16385), 0, 2)); c.close(); } }), { headers });
  await assert.rejects(operation.track(readSearchJson(source, operation.operation.signal, "native", operation.registerInput)));
  await operation.finish(); assert.equal(bodyBudgetCharged(), 0);
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
  const tasks = releases.map(release => operation.controlJson({ op: "ordinary" }, async () => { calls++; if (calls === 4) started.resolve(); await release.promise; return Response.json({ ok: true }); }));
  await started.promise; const fifth = operation.controlJson({ op: "queued" }, async () => { calls++; return Response.json({ ok: true }); });
  assert.equal(calls, 4);
  assert.deepEqual(await operation.controlJson({ op: "mandatory" }, async () => Response.json({ ok: true }), true), { ok: true });
  releases[0].resolve(); await fifth; assert.equal(calls, 5); for (const release of releases) release.resolve();
  await Promise.all(tasks); await operation.finish(); assert.equal(bodyBudgetCharged(), 0);
});
test("Search nonrefundable22 ordinary and10 mandatory caps deny BEFORE fetch construction", async () => {
  const operation = owner(); let calls = 0;
  const run = mandatory => operation.controlJson({}, async () => { calls++; return Response.json({}); }, mandatory);
  for (let i = 0; i < 22; i++) await run(false);
  await assert.rejects(run(false)); assert.equal(calls, 22);
  for (let i = 0; i < 10; i++) await run(true);
  await assert.rejects(run(true)); assert.equal(calls, 32); await operation.finish(); assert.equal(bodyBudgetCharged(), 0);
});
test("Search failed mandatory predecessor keeps its slot through cleanup before fallback", async () => {
  const operation = owner(), h = held(true), started = Promise.withResolvers(); let fallback = false;
  const first = operation.controlJson({}, async () => { started.resolve(); return h.response; }, true);
  const failed = assert.rejects(first); await started.promise; await h.cancel.promise;
  const next = operation.controlJson({}, async () => { fallback = true; return Response.json({}); }, true);
  assert.equal(fallback, false); assert.equal(bodyBudgetCharged(), 72 * MiB);
  h.cancelAck.resolve(); h.readAck.resolve(); await failed; await next; await operation.finish(); assert.equal(bodyBudgetCharged(), 0);
});
