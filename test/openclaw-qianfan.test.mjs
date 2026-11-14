import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const provider = snapshot.providers.find(provider => provider.id === "qianfan");
const endpoint = provider.endpoints.find(endpoint => endpoint.request_format === "openai.chat_completions");
const models = ["deepseek-v4-pro", "ernie-5.1", "ernie-5.0", "deepseek-v3.2", "ernie-5.0-thinking-preview"];
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const charged = [...models.map((_, i) => `qianfan_card${i}`), "qianfan_high", "qianfan_max", "qianfan_image2", "qianfan_image4", "qianfan_catalog", "qianfan_observed", "qianfan_error", "qianfan_cancel"];
const modelFor = id => /^qianfan_(?:card|image)([0-4])$/.test(id) ? models[Number(id.at(-1))] : models[0];
const ids = [...charged, "qianfan_unpriced", "qianfan_foreign", "qianfan_empty"];

// One implementation: compile only the closed, test-owned observer section.
// This loads no SDK imports and does not execute the native consumer locally.
const sdkText = readFileSync(new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url), "utf8");
const observerStart = sdkText.indexOf("type OriginalOperation ="), observerEnd = sdkText.indexOf("// END ORIGINAL LIFETIME OBSERVERS");
assert.ok(observerStart >= 0 && observerEnd > observerStart);
const observerCode = stripTypeScriptTypes(sdkText.slice(observerStart, observerEnd));
const { preserveFailures, createRequestBindings, createLifetimeObserver, createCancelReceiptReceiver, cancelReceiptLine } = new Function(observerCode + "; return { preserveFailures, createRequestBindings, createLifetimeObserver, createCancelReceiptReceiver, cancelReceiptLine };")();
const grantSecret = id => "fixture-upstream-" + id;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test("Qianfan observer retains original receiver, operands, acquisition, reader and release products", async () => {
  const lifetime = createLifetimeObserver(), release = deferred(), owner = { id: "card0" }, receiver = {};
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([7])); controller.close(); } }));
  const result = { response, release() { assert.equal(this, result); return release.promise; } }, args = [{ signal: new AbortController().signal }];
  const acquired = Promise.resolve(result);
  assert.equal(lifetime.guard(function (...actual) { assert.equal(this, receiver); assert.equal(actual[0], args[0]); return acquired; }, receiver, args, owner), acquired);
  assert.equal(await acquired, result); assert.equal(result.response, response);
  const reader = response.body.getReader(), closed = reader.closed;
  assert.equal(lifetime.readers[0].closed, closed);
  const first = reader.read(); assert.equal(lifetime.operations.at(-1).pending, first);
  assert.deepEqual(await first, { done: false, value: new Uint8Array([7]) });
  assert.deepEqual(await reader.read(), { done: true, value: undefined }); await closed; reader.releaseLock();
  let done = false; const joined = lifetime.join().then(() => { done = true; }); await nextTurn(); assert.equal(done, false);
  assert.equal(result.release(), release.promise); await nextTurn(); assert.equal(done, false);
  release.resolve(); await joined;
  assert.equal(lifetime.readers[0].eof, true); assert.equal(response.body.locked, false);
  await lifetime.restore(); assert.equal(Object.hasOwn(response.body, "getReader"), false);
});

test("Qianfan pending original read, cancellation and release cannot become retirement", async () => {
  const cancellation = deferred(), release = deferred(), lifetime = createLifetimeObserver(), owner = { id: "cancel" };
  const response = new Response(new ReadableStream({ cancel() { return cancellation.promise; } }, { highWaterMark: 0 }));
  const result = { response, release() { return release.promise; } }, acquired = Promise.resolve(result);
  lifetime.guard(() => acquired, null, [], owner); await acquired;
  const reader = response.body.getReader(), reading = reader.read();
  const readingOp = lifetime.operations.at(-1); assert.equal(readingOp.pending, reading);
  let joined = false; const join = lifetime.join().then(() => { joined = true; }); await nextTurn(); assert.equal(joined, false);
  const cancel = reader.cancel("synthetic caller reason"); assert.equal(lifetime.operations.at(-1).pending, cancel);
  assert.equal((await reading).done, true); reader.releaseLock(); assert.equal(result.release(), release.promise);
  await nextTurn(); assert.equal(joined, false); cancellation.resolve(); await cancel;
  await nextTurn(); assert.equal(joined, false); release.resolve(); await join;
  await lifetime.restore();
});

test("Qianfan dynamic joins retain work registered during original completion", async () => {
  const lifetime = createLifetimeObserver(), first = deferred(), later = deferred();
  lifetime.watch("handler", first.promise, {}, () => lifetime.watch("waitUntil", later.promise, {}));
  let done = false; const join = lifetime.join().then(() => { done = true; }); first.resolve();
  await nextTurn(); assert.equal(done, false); later.resolve(); await join;
  assert.equal(lifetime.summary().settled, 2);
});

test("Qianfan original read, closed, cancel and release rejections remain hard including undefined", async () => {
  for (const reason of [undefined, new Error("synthetic original failure")]) {
    const lifetime = createLifetimeObserver(), controller = new AbortController(), owner = { signal: controller.signal };
    const response = new Response(new ReadableStream({ start(stream) { stream.error(reason); } }));
    const result = { response, release() { return Promise.reject(reason); } }, acquired = Promise.resolve(result);
    lifetime.guard(() => acquired, null, [], owner); await acquired;
    const reader = response.body.getReader(), reading = reader.read(), cancellation = reader.cancel(reason), releasing = result.release();
    await Promise.allSettled([reading, cancellation, releasing]);
    reader.releaseLock(); controller.abort(reason);
    await assert.rejects(lifetime.join(), error => error instanceof AggregateError && error.errors.length === 4 && error.errors.every(value => value === reason));
    const read = lifetime.operations.find(op => op.kind === "reader.read"); assert.equal(read.signalAtReject.aborted, false);
    await lifetime.restore();
  }
});

test("Qianfan foreign and already signaled read errors receive no cancellation waiver", async () => {
  for (const matching of [false, true]) {
    const lifetime = createLifetimeObserver(), controller = new AbortController(), originalReason = new Error("original abort"), foreign = new Error("unrelated read");
    controller.abort(originalReason); const reason = matching ? originalReason : foreign;
    const body = new ReadableStream({ start(stream) { stream.error(reason); } }), owner = { signal: controller.signal };
    lifetime.response(new Response(body), owner); const reader = body.getReader(); await Promise.allSettled([reader.read(), reader.closed]); reader.releaseLock();
    await assert.rejects(lifetime.join(), error => error.errors.length === 2 && error.errors.every(value => value === reason));
    await lifetime.restore();
  }
});

test("Qianfan synchronous cancellation and release throws preserve original undefined", async () => {
  const lifetime = createLifetimeObserver(), body = new ReadableStream({ start(stream) { stream.close(); } });
  const response = new Response(body);
  const nativeReader = body.getReader(); await nativeReader.read(); await nativeReader.closed;
  nativeReader.cancel = function () { assert.equal(this, nativeReader); throw undefined; };
  const nativeGet = body.getReader; body.getReader = () => nativeReader;
  const result = { response, release() { assert.equal(this, result); throw undefined; } };
  lifetime.response(result.response, {});
  const observed = result.response.body.getReader(); assert.equal(observed, nativeReader);
  let cancelThrew = false; try { observed.cancel(); } catch (error) { cancelThrew = true; assert.equal(error, undefined); }
  assert.equal(cancelThrew, true); observed.releaseLock();
  const original = result.release; lifetime.patch(result, "release", function (...args) { return lifetime.invoke("release", original, this, args, {}); });
  let releaseThrew = false; try { result.release(); } catch (error) { releaseThrew = true; assert.equal(error, undefined); }
  assert.equal(releaseThrew, true); await assert.rejects(lifetime.join(), error => error.errors.length === 2 && error.errors.every(value => value === undefined));
  await lifetime.restore(); body.getReader = nativeGet;
});

test("Qianfan observer failure preserves acquisition result and fails later qualification", async () => {
  const lifetime = createLifetimeObserver(), response = new Response("synthetic"), result = Object.freeze({ response, release() { return Promise.resolve(); } });
  const acquired = Promise.resolve(result); assert.equal(lifetime.guard(() => acquired, null, [], {}), acquired); assert.equal(await acquired, result);
  await assert.rejects(lifetime.join(), AggregateError); await lifetime.restore();
});

test("Qianfan bindings use effective headers and separate catalog from inference", () => {
  const bindings = createRequestBindings(), origin = "https://fixture.example";
  const catalog = bindings.expect("catalog", "catalog", origin + "/models", "GET", "fixture-catalog");
  const chat = bindings.expect("catalog", "chat", origin + "/chat", "POST", "fixture-chat");
  assert.throws(() => bindings.expect("catalog", "chat", origin + "/chat", "POST", "fixture-chat"));
  const request = new Request(origin + "/models", { headers: { authorization: "Bearer fixture-catalog" } });
  assert.throws(() => bindings.claim(request, { headers: {} }, "catalog"));
  assert.throws(() => bindings.claim(request, undefined, "chat"));
  assert.equal(bindings.claim(request, undefined, "catalog"), catalog);
  assert.throws(() => bindings.claim(request, undefined, "catalog"));
  assert.equal(bindings.claim(origin + "/chat", { method: "POST", headers: { authorization: "Bearer fixture-chat" } }, "chat"), chat); bindings.verify();
});

test("Qianfan cleanup attempts disposal and removal independently preserving every failure", async () => {
  const calls = [], primary = undefined, dispose = new Error("synthetic disposal"), restore = new Error("synthetic restoration");
  await assert.rejects(preserveFailures(() => { throw primary; }, [
    () => { calls.push("dispose"); throw dispose; }, () => { calls.push("rm"); }, () => { calls.push("restore"); throw restore; },
  ]), error => error instanceof AggregateError && error.errors.length === 3 && error.errors[0] === primary && error.errors[1] === dispose && error.errors[2] === restore);
  assert.deepEqual(calls, ["dispose", "rm", "restore"]);
  let caught = false; try { await preserveFailures(() => { throw undefined; }, [() => {}]); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true);
});

test("Qianfan original observer restoration failure cannot hide the primary or skip removal", async () => {
  const lifetime = createLifetimeObserver(), target = { operation() {} }, primary = new Error("synthetic primary"); let removed = false;
  lifetime.patch(target, "operation", function () {});
  Object.defineProperty(target, "operation", { configurable: false, writable: false });
  await assert.rejects(preserveFailures(() => { throw primary; }, [() => lifetime.restore(), () => { removed = true; }]), error =>
    error instanceof AggregateError && error.errors[0] === primary && error.errors[1] instanceof AggregateError && error.errors[1].errors[0] instanceof TypeError);
  assert.equal(removed, true);
});

// Real native stream errors, not hand-authored observation records. The caller
// and guard reasons deliberately differ; only the guard-input error is matched.
async function boundSdkAbort(options = {}) {
  const bindings = createRequestBindings(), caller = new AbortController(), guard = new AbortController();
  const bodySucceeded = options.bodySucceeded !== false;
  const lifetime = createLifetimeObserver(options.worker ? undefined : { bindings: bindings.bindings, bodySucceeded: () => bodySucceeded });
  const owner = bindings.expect("cancel", "chat", "https://fixture.example/chat", "POST", "fixture-cancel", caller.signal);
  owner.callerObservation = {}; lifetime.signal(owner.callerObservation, caller.signal);
  const init = { method: "POST", headers: { authorization: "Bearer fixture-cancel" } };
  assert.equal(bindings.claim("https://fixture.example/chat", init, "chat"), owner);
  lifetime.signal(owner, guard.signal);
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } }, { highWaterMark: 0 });
  const response = new Response(body), releasing = options.release ?? Promise.resolve();
  const result = { response, release() { assert.equal(this, result); return releasing; } };
  const acquired = Promise.resolve(result), operands = [{ url: "https://fixture.example/chat", init, signal: guard.signal }];
  assert.equal(lifetime.guard(function (value) { assert.equal(value, operands[0]); return acquired; }, {}, operands, owner), acquired);
  assert.equal(await acquired, result);
  const reader = body.getReader(), originalClosed = reader.closed;
  if (options.syncCancel) reader.cancel = (() => {
    const original = reader.cancel;
    return function (...args) { return lifetime.invoke("reader.cancel", function () { throw undefined; }, this, args, owner, undefined, { reader: lifetime.readers[0], acquisition: lifetime.guards[0], original }); };
  })();
  const reading = reader.read();
  const reason = Object.hasOwn(options, "reason") ? options.reason : new Error("synthetic guard abort");
  if (options.prior) { controller.error(reason); await Promise.allSettled([reading, originalClosed]); }
  if (options.partial !== false) lifetime.partial(owner);
  caller.abort(new Error("distinct original caller abort"));
  guard.abort(Object.hasOwn(options, "guardReason") ? options.guardReason : reason);
  if (!options.prior) controller.error(reason);
  if (options.unlockBeforeCancel) reader.releaseLock();
  let cancellation, syncThrown = false;
  try { cancellation = reader.cancel(); } catch (error) { syncThrown = true; assert.equal(error, undefined); }
  if (!options.unlockBeforeCancel) reader.releaseLock();
  assert.equal(result.release(), releasing);
  await Promise.allSettled([reading, originalClosed, cancellation]);
  return { bindings, owner, caller, guard, lifetime, reader, response, reason, result, reading, originalClosed, cancellation, releasing, syncThrown };
}

test("Qianfan SDK bound abort accepts original read/closed and stored cancel after unlock", async () => {
  const f = await boundSdkAbort();
  await f.lifetime.join(); f.bindings.verify();
  const row = f.lifetime.readers[0], cancelled = f.lifetime.operations.find(op => op.kind === "reader.cancel");
  assert.equal(row.closed, f.originalClosed); assert.equal(cancelled.pending, f.cancellation);
  assert.equal(cancelled.receiver, f.reader); assert.deepEqual(cancelled.operands, []);
  assert.equal(cancelled.unlocksAtInvoke, 0); assert.ok(cancelled.invoked < row.unlockInvocations[0]);
  assert.ok(cancelled.settled > row.unlockReturns[0]);
  assert.equal(cancelled.signalAtInvoke.reason, f.reason); assert.equal(cancelled.signalAtReject.reason, f.reason);
  assert.notEqual(f.caller.signal.reason, f.guard.signal.reason);
  assert.equal(f.response.body.locked, false); assert.equal(f.lifetime.summary().rejected, 3, "disposition retains original errors");
  await f.lifetime.restore();
});

test("Qianfan Worker join rejects the identical native abort observations", async () => {
  const f = await boundSdkAbort({ worker: true });
  await assert.rejects(f.lifetime.join(), error => error.errors.length === 3 && error.errors.every(reason => reason === f.reason));
  await f.lifetime.restore();
});

for (const [label, options] of [
  ["prior rejection", { prior: true }], ["false partial delivery", { partial: false }],
  ["unsuccessful case body", { bodySucceeded: false }], ["undefined stream error", { reason: undefined }],
  ["foreign guard error", { guardReason: new Error("different guard error") }],
  ["cancel invoked after unlock", { unlockBeforeCancel: true }], ["synchronous cancel throw", { syncCancel: true }],
]) test("Qianfan SDK abort rejects " + label, async () => {
  const f = await boundSdkAbort(options); await assert.rejects(f.lifetime.join(), AggregateError); await f.lifetime.restore();
});

test("Qianfan SDK abort rejects wrong or duplicate binding and foreign guard identity", async () => {
  for (const alter of [
    f => { f.owner.id = "foreign"; },
    f => { f.bindings.bindings.push({ ...f.owner }); },
    f => { f.owner.signal = new AbortController().signal; },
  ]) {
    const f = await boundSdkAbort(); alter(f); await assert.rejects(f.lifetime.join(), AggregateError); await f.lifetime.restore();
  }
});

test("Qianfan SDK abort rejects a mixed undefined operation despite a qualified reader", async () => {
  const f = await boundSdkAbort();
  f.lifetime.watch("reader.read", Promise.reject(undefined), f.owner);
  await assert.rejects(f.lifetime.join(), error => error.errors.some(reason => reason === undefined)); await f.lifetime.restore();
});

test("Qianfan SDK cancellation failure with fulfilled original closed is not stored-error disposition", async () => {
  const bindings = createRequestBindings(), caller = new AbortController(), guard = new AbortController(), failure = new Error("underlying cancel failure");
  const life = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => true });
  const owner = bindings.expect("cancel", "chat", "https://fixture.example/chat", "POST", "fixture-cancel", caller.signal);
  bindings.claim("https://fixture.example/chat", { method: "POST", headers: { authorization: "Bearer fixture-cancel" } }, "chat");
  owner.callerObservation = {}; life.signal(owner.callerObservation, caller.signal); life.signal(owner, guard.signal);
  const response = new Response(new ReadableStream({ cancel() { return Promise.reject(failure); } }, { highWaterMark: 0 }));
  const result = { response, release() { return Promise.resolve(); } }, acquired = Promise.resolve(result);
  life.guard(() => acquired, null, [], owner); await acquired; const reader = response.body.getReader(), reading = reader.read(), closed = reader.closed;
  life.partial(owner); caller.abort(); guard.abort(failure);
  const cancellation = reader.cancel(); reader.releaseLock(); result.release();
  await Promise.allSettled([reading, cancellation, closed]); assert.equal((await reading).done, true); await closed;
  await assert.rejects(life.join(), error => error.errors.includes(failure)); await life.restore();
});

test("Qianfan SDK abort cannot pass a pending or failed original request release", async () => {
  const releasing = deferred(), f = await boundSdkAbort({ release: releasing.promise });
  let complete = false; const joined = f.lifetime.join().then(() => { complete = true; }, error => { complete = true; throw error; });
  await nextTurn(); assert.equal(complete, false); const failure = new Error("original release failure"); releasing.reject(failure);
  await assert.rejects(joined, error => error.errors.includes(failure)); await f.lifetime.restore();
});

test("Qianfan SDK abort cannot pass failed unlock or a newly locked original body", async () => {
  const f = await boundSdkAbort();
  const held = f.response.body.getReader();
  await assert.rejects(f.lifetime.join(), AggregateError); held.releaseLock(); await f.lifetime.restore();
  const failed = await boundSdkAbort();
  assert.throws(() => failed.reader.releaseLock.call({}), TypeError);
  await assert.rejects(failed.lifetime.join(), error => error.errors.some(reason => reason instanceof TypeError)); await failed.lifetime.restore();
});

test("Qianfan cancellation receipt is exact once and requires original consumer fulfillment", async () => {
  const calls = [], context = { diagnostic(value) { assert.equal(this, context); calls.push(value); } };
  const good = createCancelReceiptReceiver(context); const original = deferred();
  good.context.diagnostic("native test wall time 1ms\n" + cancelReceiptLine + "\n");
  let done = false; const waiting = good.finish(original.promise).then(() => { done = true; }); await nextTurn(); assert.equal(done, false);
  original.resolve(); await waiting; assert.equal(calls.length, 1);
  for (const lines of [[], [cancelReceiptLine, cancelReceiptLine], [cancelReceiptLine.replace('"restored":true', '"restored":false')]]) {
    const receiver = createCancelReceiptReceiver(context); for (const line of lines) receiver.context.diagnostic(line);
    await assert.rejects(receiver.finish(Promise.resolve()), AggregateError);
  }
  const failed = createCancelReceiptReceiver(context); failed.context.diagnostic(cancelReceiptLine);
  const failure = new Error("original helper cleanup failed"); await assert.rejects(failed.finish(Promise.reject(failure)), error => error === failure);
  const undefinedFailure = createCancelReceiptReceiver(context); undefinedFailure.context.diagnostic(cancelReceiptLine);
  let caught = false; try { await undefinedFailure.finish(Promise.reject(undefined)); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true);
});

async function retireWorker(mf) {
  if (!mf) return;
  await preserveFailures(async () => {
    const router = await mf.getWorker("router"), response = await router.fetch("https://fixture.example/fixture/retirement");
    const proof = await response.json();
    assert.equal(proof.accepted, true); assert.equal(proof.settled, true); assert.equal(proof.rejected, 0);
    assert.equal(proof.readers, proof.unlocked);
  }, [async () => {
    const upstream = await mf.getWorker("upstream"), response = await upstream.fetch("https://fixture.example/retirement");
    const proof = await response.json(); assert.equal(proof.accepted, true); assert.equal(proof.settled, true); assert.equal(proof.rejected, 0);
  }]);
}

test("actual OpenClaw Qianfan configured native client through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  assert.ok(endpoint);
  assert.deepEqual(provider.models.map(model => [model.id, model.upstream]), ["ernie-4.5-0.3b", ...models].map(id => ["qianfan/" + id, id]));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-qianfan-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
  let mf;
  await preserveFailures(async () => {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture());
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [id === "qianfan_foreign" ? "openai" : "qianfan"], models: id === "qianfan_empty" ? ["qianfan/unlisted-fixture"] : models.map(id => `qianfan/${id}`), tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "qianfan_unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/qianfan", JSON.stringify({ providerId: "qianfan", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const catalogResponse = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-qianfan_catalog-fixture-secret" } });
    assert.equal(catalogResponse.status, 200); const catalog = await catalogResponse.json();
    assert.equal(catalog.scope.credentialId, "qianfan_catalog");
    const visible = catalog.providers.find(row => row.id === "qianfan"); assert.ok(visible);
    assert.deepEqual(visible.models.map(row => row.id).sort(), models.map(id => "qianfan/" + id).sort());
    assert.ok(models.every(id => visible.offers.some(offer => offer.modelId === "qianfan/" + id && offer.routeKind === "native" && offer.eligible)));

    const cancelReceipt = createCancelReceiptReceiver(t);
    const originalConsumer = runOpenClawConsumer(cancelReceipt.context, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url),
      testPath: "extensions/qianfan/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, QIANFAN_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" },
    });
    await cancelReceipt.finish(originalConsumer);
    const upstream = await mf.getWorker("upstream");
    let calls;
    for (let attempt = 0; attempt < 150; attempt++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const cancelled = calls.find(call => call.body && JSON.stringify(call.body.messages).includes("qianfan_cancel"));
      if (cancelled?.cancelled || cancelled?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancelled = calls.find(call => call.body && JSON.stringify(call.body.messages).includes("qianfan_cancel"));
    assert.ok(cancelled?.cancelled || cancelled?.aborted, "actual client abort must cancel the upstream transport");
    assert.notEqual(cancelled.fixtureExpired, true, "fixture timeout is not caller cancellation");
    const catalogCalls = calls.filter(call => call.method === "GET");
    assert.equal(catalogCalls.length, 2, "actual strict discovery filters the original credential and retains an empty catalog");
    for (const call of catalogCalls) {
      assert.equal(call.url, provider.base_urls.default + "/models");
      assert.ok(["qianfan_catalog", "qianfan_empty"].some(id => call.headers.authorization === "Bearer " + grantSecret(id)));
    }
    calls = calls.filter(call => call.method === "POST");
    assert.equal(calls.length, charged.length, "invalid keys, foreign grants and unknown-price hard budgets must not dispatch; errors must not replay");
    for (const call of calls) {
      assert.equal(call.url, provider.base_urls.default.replace(/\/$/, "") + endpoint.path);
      const id = charged.find(id => JSON.stringify(call.body.messages).includes(id)); assert.ok(id);
      assert.equal(call.headers.authorization, "Bearer " + grantSecret(id));
      const expected = modelFor(id);
      assert.equal(call.body.model, expected);
      assert.equal(call.body.stream, true);
      assert.equal(call.body.max_completion_tokens, 128);
      assert.equal(call.body.max_tokens, undefined);
      const efforts = { qianfan_high: "high", qianfan_max: "high" };
      if (id in efforts) assert.equal(call.body.reasoning_effort, efforts[id]);
      if ([models[1], models[3]].includes(expected)) assert.ok(call.body.messages.every(message => message.reasoning_content === undefined), "nonreasoning frozen rows strip thinking history");
      else assert.ok(call.body.messages.some(message => message.reasoning_content === "synthetic-prior-thinking"), "reasoning rows preserve actual host replay on wire");
      if (id.startsWith("qianfan_image")) assert.ok(call.body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url" && part.image_url.url === "data:image/png;base64," + image)));
      assert.equal(call.body.tools[0].function.name, "lookup");
      assert.ok(call.body.messages.some(message => ["system", "developer"].includes(message.role) && message.content === "Synthetic instructions"), "the actual native serializer retains system instructions");
      assert.ok(call.body.messages.some(message => message.role === "tool" && message.tool_call_id === "callfixture" && message.content === "synthetic-tool-result"));
      assert.ok(call.body.messages.some(message => message.tool_calls?.[0]?.function?.name === "lookup"));
      assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback/);
    }
    for (const id of charged) {
      let usage;
      for (let attempt = 0; attempt < 150; attempt++) {
        usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
        if (usage.usage.events.length === (id === "qianfan_catalog" ? 2 : 1)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const events = usage.usage.events.filter(event => event.capability === "llm.chat");
      assert.equal(events.length, 1);
      assert.equal(usage.usage.events.length, id === "qianfan_catalog" ? 2 : 1);
      if (id === "qianfan_catalog") {
        const discovery = usage.usage.events.find(event => event.capability === "models.list");
        assert.equal(discovery.actual_cost_micros, 0); assert.equal(discovery.reserved_cost_micros, 0);
      }
      const [event] = events;
      assert.equal(usage.budget.spentMicros, 7);
      assert.equal(event.provider, "qianfan"); assert.equal(event.model, `qianfan/${modelFor(id)}`);
      assert.equal(event.credential_id, id); assert.equal(event.policy_id, id);
      assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.actual_cost_micros, 7);
      assert.equal(event.status, id === "qianfan_error" ? "provider_error" : id === "qianfan_cancel" ? "client_error" : "success");
      assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens], id === "qianfan_observed" ? [4, 3, 7] : [null, null, null]);
      assert.doesNotMatch(JSON.stringify(event), /synthetic-tool-result|fixture-upstream|must-not-fallback/);
    }
    for (const id of ["qianfan_empty", "qianfan_unpriced", "qianfan_foreign"]) {
      const usage = await (await fetch(`${origin}/v1/usage`, { headers: { authorization: `Bearer clawrouter-live-${id}-fixture-secret` } })).json();
      assert.equal(usage.budget.spentMicros, 0);
      assert.ok(usage.usage.events.every(event => event.actual_cost_micros === 0));
    }
  }, [() => retireWorker(mf), () => mf?.dispose(), () => rm(temporary, { recursive: true, force: true })]);
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
${observerCode}
const lifetime = createLifetimeObserver(), ingress = createRequestBindings(), outbound = createRequestBindings();
const originals = globalThis.fetch;
const ids = ${JSON.stringify(ids)}, charged = ${JSON.stringify(charged)};
for (const id of [...ids, "qianfan_invalid"]) {
  if (id !== "qianfan_empty") ingress.expect(id, "chat", "/v1/native/qianfan/chat/completions", "POST", id === "qianfan_invalid" ? "clawrouter-live-qianfan_high-invalid" : "clawrouter-live-" + id + "-fixture-secret");
  if (["qianfan_catalog", "qianfan_empty", "qianfan_foreign"].includes(id)) ingress.expect(id, "catalog", "/v1/native/qianfan/models", "GET", "clawrouter-live-" + id + "-fixture-secret");
  if (charged.includes(id)) outbound.expect(id, "chat", ${JSON.stringify(provider.base_urls.default.replace(/\/$/, "") + endpoint.path)}, "POST", "fixture-upstream-" + id);
  if (["qianfan_catalog", "qianfan_empty"].includes(id)) outbound.expect(id, "catalog", ${JSON.stringify(provider.base_urls.default + "/models")}, "GET", "fixture-upstream-" + id);
}
// Keep the actual ingress origin, method, effective credential and signal before
// calling the original handler. No ordinal or mutable current-case association.
function bindIngress(request) {
  const url = new URL(request.url), kind = request.method === "GET" ? "catalog" : "chat";
  for (const row of ingress.bindings) if (row.url.startsWith("/")) row.url = url.origin + row.url;
  return ingress.claim(request, undefined, kind);
}
lifetime.patch(globalThis, "fetch", function (...args) {
  const input = args[0], init = args[1], method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const owner = outbound.claim(input, init, method === "GET" ? "catalog" : "chat");
  const incoming = ingress.bindings.find(row => row.id === owner.id && row.kind === owner.kind && row.claimed);
  if (!incoming) throw new Error("outbound without original Qianfan ingress");
  owner.ingress = incoming;
  lifetime.signal(owner, init?.signal ?? (input instanceof Request ? input.signal : undefined));
  return lifetime.invoke("fetch", originals, this, args, owner, response => lifetime.response(response, owner));
});
let accepted = false;
async function retirement() {
  try { await preserveFailures(async () => { await lifetime.join(); ingress.verify(); outbound.verify(); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); }
  const proof = lifetime.summary();
  return Response.json({ ...proof, settled: proof.operations === proof.settled, accepted });
}
export default { ...handler, fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/grants") return (async () => {
    for (const id of ids) await putGrantCredentials(env, "oauth/" + id + "/qianfan", { provider: "qianfan", kind: "api_key", enabled: true, credential: "fixture-upstream-" + id });
    return new Response(null, { status: 204 });
  })();
  if (path === "/fixture/retirement") return retirement();
  if (!path.startsWith("/v1/native/qianfan/")) return handler.fetch(request, { ...env, QIANFAN_API_KEY: "must-not-fallback" }, context);
  const owner = bindIngress(request); lifetime.signal(owner, request.signal);
  const waitUntil = context.waitUntil;
  lifetime.patch(context, "waitUntil", function (...args) {
    lifetime.watch("waitUntil", args[0], owner);
    return Reflect.apply(waitUntil, context, args);
  });
  return lifetime.invoke("handler", handler.fetch, handler, [request, { ...env, QIANFAN_API_KEY: "must-not-fallback" }, context], owner);
} };`;
}

function upstreamFixture() {
  return `${observerCode}
const lifetime = createLifetimeObserver(), calls = [];
const bindings = createRequestBindings();
for (const id of ${JSON.stringify(charged)}) bindings.expect(id, "chat", ${JSON.stringify(provider.base_urls.default.replace(/\/$/, "") + endpoint.path)}, "POST", "fixture-upstream-" + id);
for (const id of ["qianfan_catalog", "qianfan_empty"]) bindings.expect(id, "catalog", ${JSON.stringify(provider.base_urls.default + "/models")}, "GET", "fixture-upstream-" + id);
export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    if (request.url === "https://fixture.example/retirement") {
      let accepted = false;
      try { await preserveFailures(async () => { await lifetime.join(); bindings.verify(); }, [() => lifetime.restore()]); accepted = true; } catch (error) { lifetime.errors.push(error); }
      const proof = lifetime.summary(); return Response.json({ ...proof, settled: proof.operations === proof.settled, accepted });
    }
    const owner = bindings.claim(request, undefined, request.method === "GET" ? "catalog" : "chat"); lifetime.signal(owner, request.signal);
    const body = request.method === "POST" ? await request.json() : null;
    const call = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body }; calls.push(call);
    if (request.method === "GET") return Response.json({ object: "list", data: ["deepseek-v4-pro", "foreign-fixture"].map(id => ({ id, object: "model", owned_by: "qianfan" })) });
    const input = JSON.stringify(body.messages), frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const failed = input.includes("qianfan_error"), cancel = input.includes("qianfan_cancel");
    const first = frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "synthetic-answer" }, finish_reason: null }] });
    const wire = first + (failed ? frame({ error: { message: "synthetic-upstream-error", code: "server_error" } })
      : cancel ? "" : frame({ id: "chat_fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(input.includes("qianfan_observed") ? { usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } } : {}) }) + "data: [DONE]\\n\\n");
    const bytes = new TextEncoder().encode(wire); let offset = 0, beats = 0, timer, wake;
    request.signal.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); wake?.(); }, { once: true });
    const originalSource = { pull(controller) {
      if (offset === bytes.length) {
        if (!cancel) { controller.close(); return; }
        // Heartbeats keep the synthetic request live and make downstream
        // disconnection observable. The bound never substitutes for an abort.
        const pending = new Promise(resolve => { wake = resolve; timer = setTimeout(() => {
          if (++beats > 200) { call.fixtureExpired = true; controller.close(); }
          else controller.enqueue(new TextEncoder().encode(": fixture heartbeat\\n\\n"));
          resolve();
        }, 50); });
        lifetime.watch("timer-wake", pending, owner); return pending;
      }
      const end = Math.min(offset + 7, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
    }, cancel() { call.cancelled = true; clearTimeout(timer); wake?.(); } };
    for (const kind of ["pull", "cancel"]) {
      const original = originalSource[kind];
      lifetime.patch(originalSource, kind, function (...args) { return lifetime.invoke("source." + kind, original, this, args, owner); });
    }
    return new Response(new ReadableStream(originalSource, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
