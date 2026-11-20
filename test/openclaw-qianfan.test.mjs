import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { types as nodeTypes } from "node:util";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";
import { registerQianfanMemoryTests } from "./helpers/qianfan-memory.mjs";

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
registerQianfanMemoryTests({ source, sourceHead, observerCode, bundleOutcome: bundleQianfanOutcome });
const { preserveFailures, createRequestBindings, createLifetimeObserver, createWorkerOutcomeWitness, createCancelReceiptReceiver, cancelReceiptLine, observeRetirementSteps } = new Function(observerCode + "; return { preserveFailures, createRequestBindings, createLifetimeObserver, createWorkerOutcomeWitness, createCancelReceiptReceiver, cancelReceiptLine, observeRetirementSteps };")();
// Reuse the SDK-owned closed protocol; never forward child stdout/stderr.
const diagnosticStart = sdkText.indexOf("// BEGIN QIANFAN FAILURE DIAGNOSTICS"), diagnosticEnd = sdkText.indexOf("// END QIANFAN FAILURE DIAGNOSTICS");
assert.ok(diagnosticStart >= 0 && diagnosticEnd > diagnosticStart);
const diagnosticCode = stripTypeScriptTypes(sdkText.slice(diagnosticStart, diagnosticEnd));
const makeDiagnostic = new Function(diagnosticCode + "; return qianfanDiagnostics;")();
const diagnostic = makeDiagnostic(nodeTypes.isProxy);
const controlStart = sdkText.indexOf("// BEGIN PINNED CONTROL BOOKKEEPING"), controlEnd = sdkText.indexOf("// END PINNED CONTROL BOOKKEEPING");
const controlCode = stripTypeScriptTypes(sdkText.slice(controlStart, controlEnd));
const { pinnedControlIds, createPinnedControlSummary, requirePinnedControlAdmission } = new Function(controlCode + ";return { pinnedControlIds, createPinnedControlSummary, requirePinnedControlAdmission };")();
const negativeStart = sdkText.indexOf("// BEGIN PINNED OBSERVER NEGATIVE CONTROLS"), negativeEnd = sdkText.indexOf("// END PINNED OBSERVER NEGATIVE CONTROLS");
const negativeCode = stripTypeScriptTypes(sdkText.slice(negativeStart, negativeEnd));
const runQianfanObserverControl = new Function("createRequestBindings", "createLifetimeObserver", "preserveFailures", negativeCode + ";return runQianfanObserverControl;")(createRequestBindings, createLifetimeObserver, preserveFailures);
const stepAnnotations = diagnostic.emitter(text => process.stdout.write(text));
function outerDiagnostics(context, annotations = stepAnnotations) {
  const records = [], retirements = new Map(); let failed = false, phase = "worker";
  const base = (phase, role) => ({ layer: "outer", route: "none", caseId: "none", phase, role });
  const collect = text => { for (const record of diagnostic.parse(text)) if (records.length < 512) records.push(record); };
  const safe = fn => { try { fn(); } catch { /* reporting never replaces original errors */ } };
  function controlFacts() {
    const record = records.findLast(row => row.phase === "controls" && row.controlCounts);
    const last = records.at(-1), failed = records.findLast(row => row.outcome === "rejected");
    return { ...(record ? { controlCounts: record.controlCounts, controlSequence: record.controlSequence, controlFlags: record.controlFlags, controlAt: record.controlAt } : {}),
      sdkAt: diagnostic.boundary(last), ...(failed?.fault ? { sdkFault: failed.fault } : {}) };
  }
  function failure(error, at = phase, role = "primary", facts = {}) {
    failed = true; safe(() => annotations.emit(diagnostic.record(base(at, role), "rejected", error,
      { ...(role === "primary" && at !== "receipt" ? controlFacts() : {}), ...facts }))); reportWorkers();
  }
  const adapter = new Proxy(context, { get(target, property, receiver) {
    if (property !== "diagnostic") return Reflect.get(target, property, receiver);
    return function (...args) { safe(() => collect(args[0])); };
  } });
  function helper(original) {
    return diagnostic.observe(original, (outcome, error) => {
      if (outcome !== "rejected") return;
      const child = diagnostic.child(error);
      for (const record of child.records) if (records.length < 512) records.push(record);
      failure(error, "helper", "primary", { ...child.metadata, sdkRecords: records.length });
      reportSdk();
    });
  }
  function reportSdk() {
    safe(() => {
      if (!failed) return;
      const latest = new Map();
      for (const record of records) latest.set([record.layer, record.route, record.caseId, record.phase, record.role].join("/"), record);
      const values = [...latest.values()];
      // Prioritize real failure outcomes; a pending boundary remains only an
      // observation. No SDK record means unknown, never an inferred loader bug.
      const rejected = values.filter(record => record.outcome === "rejected");
      // Keep the three summaries from the same first failing case together.
      const first = rejected.find(record => record.phase === "join_contract");
      if (first) for (const at of ["join_contract", "join_census", "join_rejections"]) {
        const record = rejected.find(record => record.caseId === first.caseId && record.route === first.route && record.phase === at);
        if (record) annotations.emit(record);
      }
      for (const record of rejected) annotations.emit(record);
      const last = records.at(-1); if (last && last.outcome !== "rejected" && !values.some(record => record.phase === "join_contract")) annotations.emit(last);
    });
  }
  function reportWorkers() {
    if (failed) safe(() => { for (const records of retirements.values()) for (const record of records) annotations.emit(record); });
  }
  return { context: adapter, helper, failure,
    retirement(side, predicate, proof, error, fulfilled = false) {
      if (!fulfilled) failed = true;
      safe(() => {
        const bounded = value => Number.isInteger(value) && value >= 0 && value <= 9999 ? value : null;
        const bit = value => typeof value === "boolean" ? Number(value) : null;
        const outcome = fulfilled ? "fulfilled" : "rejected";
        retirements.set(side, [
          diagnostic.record(base("retirement_" + side, "cleanup"), outcome, error, { ...proof?.join?.contract, predicate,
            ...(proof?.retirementChecks ? { retirementChecks: proof.retirementChecks } : {}),
            retirement: [bit(proof?.accepted), bit(proof?.settled), bounded(proof?.rejected), bounded(proof?.readers), bounded(proof?.unlocked)] }),
          diagnostic.record(base("retirement_" + side + "_ops", "cleanup"), outcome, error, { ...proof?.join?.worker, predicate }),
        ]);
      });
      reportWorkers();
    },
    stage(next) { phase = next; },
    cleanup(at, original) { return () => diagnostic.observe(original, (outcome, error) => {
      if (outcome === "rejected") failure(error, at, "cleanup");
      else if (failed && outcome === "fulfilled") safe(() => annotations.emit(diagnostic.record(base(at, "cleanup"), outcome)));
    }); },
    get failed() { return failed; },
    finish() { if (failed) { reportSdk(); reportWorkers(); safe(() => annotations.finish()); } },
    count() { return records.length; },
  };
}
const grantSecret = id => "fixture-upstream-" + id;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

const diagnosticContext = { layer: "sdk", route: "nativechat", caseId: "cancel", phase: "body", role: "primary" };
test("Qianfan diagnostic schema rejects accessors, proxies, private strings and extra fields", () => {
  const valid = diagnostic.record(diagnosticContext, "rejected", undefined, { pending: null, partialDelivery: null });
  assert.equal(valid.category, "undefined"); assert.deepEqual(diagnostic.validate(valid), valid);
  let touched = 0;
  const getter = { ...valid }; Object.defineProperty(getter, "phase", { enumerable: true, get() { touched++; throw undefined; } });
  const proxy = new Proxy({}, { ownKeys() { touched++; throw undefined; }, getOwnPropertyDescriptor() { touched++; throw undefined; } });
  for (const value of [getter, proxy, { ...valid, phase: "body\n::error" }, { ...valid, caseId: "foreign" }, { ...valid, message: "private" }, { ...valid, pending: -1 }, { ...valid, pending: 10000 }, { ...valid, partialDelivery: "true" }]) assert.equal(diagnostic.validate(value), null);
  const error = Object.create({ get name() { touched++; throw undefined; } });
  assert.equal(diagnostic.category(error), "unknown"); assert.equal(diagnostic.category(proxy), "unknown");
  assert.equal(diagnostic.category(null), "null"); assert.equal(touched, 0);
});

test("Qianfan diagnostics parse only new closed records and own child DATA fields", () => {
  const record = diagnostic.record(diagnosticContext, "rejected", undefined);
  const wire = diagnostic.encode(record), output = "private child output\n" + wire;
  assert.deepEqual(diagnostic.parse(output), [record]);
  assert.deepEqual(diagnostic.parse('QIANFAN_DIAGNOSTIC {"message":"private"}\n'), []);
  assert.deepEqual(diagnostic.parse("QIANFAN_DIAGNOSTIC " + "x".repeat(769)), []);
  assert.deepEqual(diagnostic.parse("x".repeat(2 * 1024 * 1024 + 1)), []);
  let touched = 0;
  const child = Object.defineProperties({}, { stdout: { value: output }, stderr: { get() { touched++; throw undefined; } }, code: { value: 1 }, killed: { value: false }, signal: { value: null } });
  const parsed = diagnostic.child(child); assert.deepEqual(parsed.records, [record]); assert.equal(parsed.metadata.exit, 1); assert.equal(touched, 0);
  const missing = diagnostic.child({ stderr: "Error [ERR_MODULE_NOT_FOUND]: private/path" });
  assert.equal(missing.metadata.observedCode, "ERR_MODULE_NOT_FOUND"); assert.equal(missing.metadata.sdkRecords, 0);
  assert.equal(diagnostic.child(undefined).metadata.exit, null);
});

test("Qianfan one-step annotation budget deduplicates, caps and flushes only once", () => {
  const lines = [], emitter = diagnostic.emitter(line => lines.push(line));
  const first = diagnostic.record(diagnosticContext, "rejected", undefined);
  for (const phase of ["helper", "receipt"]) emitter.emit({ ...first, layer: "outer", route: "none", caseId: "none", phase });
  for (const phase of ["join_contract", "join_census", "join_rejections"]) {
    emitter.emit({ ...first, phase, role: "summary" }); emitter.emit({ ...first, phase, role: "summary" });
  }
  for (const caseId of diagnostic.cases.filter(id => id !== "none")) emitter.emit({ ...first, caseId });
  for (const phase of ["retirement_router", "retirement_router_ops", "retirement_upstream", "retirement_upstream_ops"]) {
    emitter.emit({ ...first, layer: "outer", route: "none", caseId: "none", role: "cleanup", phase, predicate: "accepted" });
  }
  for (const phase of ["dispose", "rm"]) for (const outcome of ["fulfilled", "rejected"]) {
    emitter.emit({ ...first, layer: "outer", phase, role: outcome === "fulfilled" ? "summary" : "cleanup", outcome });
  }
  emitter.finish(); emitter.finish();
  assert.equal(lines.length, 10); assert.equal(emitter.summary().emitted, 9);
  assert.ok(lines.every(line => line.startsWith("::error title=Qianfan contract diagnostic::") && Buffer.byteLength(line) <= 768));
  assert.ok(Buffer.byteLength(lines.join("")) <= 8192);
  const records = lines.map(line => JSON.parse(line.slice(line.indexOf("::{") + 2)));
  assert.equal(records.at(-1).phase, "overflow"); assert.ok(records.at(-1).suppressed > 0);
  assert.deepEqual(records.at(-1).folded.slice(0, 4), [1, 1, 1, 1]);
  assert.equal(records.filter(row => row.caseId === "cancel").length, 3);
  emitter.emit({ ...first, message: "private\r\n::error" }); assert.equal(lines.length, 10);
});

test("Qianfan success output adapter preserves the independent receipt without raw forwarding", async () => {
  const lines = [], diagnostics = outerDiagnostics({ diagnostic() { throw new Error("raw output forwarded"); } }, diagnostic.emitter(line => lines.push(line)));
  const receiver = createCancelReceiptReceiver(diagnostics.context);
  receiver.context.diagnostic("private text\n" + diagnostic.encode(diagnostic.record(diagnosticContext, "fulfilled")) + cancelReceiptLine + "\n");
  const original = Promise.resolve(7); assert.equal(diagnostics.helper(() => original), original);
  assert.equal(await receiver.finish(original), 7); diagnostics.finish();
  assert.equal(diagnostics.count(), 1); assert.deepEqual(lines, []);
});

test("Qianfan rejected child emits early safe attribution and retains primary plus cleanup errors", async () => {
  const lines = [], diagnostics = outerDiagnostics({}, diagnostic.emitter(line => lines.push(line)));
  const record = diagnostic.record(diagnosticContext, "rejected", undefined);
  const primary = Object.assign(new Error("private child error"), { stdout: diagnostic.encode(record), stderr: "private stderr", code: 1, killed: false });
  const original = Promise.reject(primary);
  assert.equal(diagnostics.helper(() => original), original);
  await assert.rejects(preserveFailures(() => original, [diagnostics.cleanup("dispose", () => { throw undefined; }), diagnostics.cleanup("rm", () => {})]), error => error.errors.length === 2 && error.errors[0] === primary && error.errors[1] === undefined);
  diagnostics.finish(); assert.ok(lines[0].includes('"phase":"helper"')); assert.ok(lines.some(line => line.includes('"caseId":"cancel"')));
  const overflow = lines.map(line => JSON.parse(line.slice(line.indexOf("::{") + 2))).find(record => record.phase === "overflow");
  assert.deepEqual(overflow.folded.slice(0, 4), [0, 1, 1, 0]);
  assert.doesNotMatch(lines.join(""), /private/);
});

test("Qianfan zero SDK records and failing diagnostic writer never alter the original verdict", async () => {
  const lines = [], diagnostics = outerDiagnostics({}, diagnostic.emitter(line => lines.push(line)));
  const original = Promise.reject(undefined); diagnostics.helper(() => original);
  await assert.rejects(preserveFailures(() => original, [diagnostics.cleanup("rm", () => { throw null; })]), error => error.errors[0] === undefined && error.errors[1] === null);
  diagnostics.finish(); assert.ok(lines[0].includes('"sdkRecords":0')); assert.doesNotMatch(lines.join(""), /loader/);
  const broken = outerDiagnostics({}, diagnostic.emitter(() => { throw new Error("writer failed"); }));
  await assert.rejects(preserveFailures(() => broken.helper(() => { throw undefined; }), [broken.cleanup("dispose", () => { throw null; })]), error => error.errors.length === 2 && error.errors[0] === undefined && error.errors[1] === null);
  broken.finish();
});

test("Qianfan diagnostic observations retain original promises and real pending counts", async () => {
  const pending = deferred(), lifetime = createLifetimeObserver(), bindings = createRequestBindings(), outcomes = [];
  const original = lifetime.watch("release", pending.promise, {});
  assert.equal(diagnostic.observe(() => original, outcome => outcomes.push(outcome)), original);
  const before = diagnostic.snapshot(lifetime, bindings); assert.equal(before.pending, 1); assert.equal(before.releasePending, 1); assert.equal(before.partialDelivery, null);
  assert.deepEqual(outcomes, ["entered"]); pending.resolve(); await original; await nextTurn();
  const after = diagnostic.snapshot(lifetime, bindings); assert.equal(after.pending, 0); assert.equal(after.releasePending, 0);
  assert.deepEqual(outcomes, ["entered", "fulfilled"]);
});

test("Qianfan default Node reporter forwards only column-zero diagnostic commands", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "qianfan-diagnostic-reporter-"));
  try {
    const path = join(directory, "reporter.test.mjs");
    await writeFile(path, 'import test from "node:test"; import { types } from "node:util";\n' + diagnosticCode + '\nconst d=qianfanDiagnostics(types.isProxy);test("reporter",()=>{const e=d.emitter(text=>process.stdout.write(text));e.emit(' + JSON.stringify(diagnostic.record(diagnosticContext, "rejected", undefined)) + ');e.finish();});\n');
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", path], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0);
    const commands = result.stdout.split("\n").filter(line => line.includes("::error title=Qianfan contract diagnostic::"));
    assert.equal(commands.length, 1); assert.ok(commands[0].startsWith("::error title=Qianfan contract diagnostic::"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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

function verifyRetirement(proof, side, diagnostics) {
  let predicate = "accepted";
  try {
    assert.equal(proof.accepted, true);
    predicate = "settled"; assert.equal(proof.settled, true);
    predicate = "rejected";
    if (side === "router" && proof.qualifiedReadRejections === 1) {
      assert.equal(proof.rejected, 1); assert.deepEqual(proof.join.contract.failureFlags, [0, 0, 0, 0, 0, 0]);
      assert.equal(proof.join.contract.releasesFulfilled, true);
    } else assert.equal(proof.rejected, 0);
    if (side === "router") { predicate = "unlocked"; assert.equal(proof.readers, proof.unlocked); }
  } catch (error) {
    try { diagnostics?.retirement(side, predicate, proof, error); } catch { /* original assertion wins */ }
    throw error;
  }
  try { diagnostics?.retirement(side, "none", proof, undefined, true); } catch { /* diagnostic only */ }
}
test("Qianfan join diagnostic schema bounds fixed columns without invoking nested accessors", () => {
  const context = { ...diagnosticContext, caseId: "error", phase: "join_contract", role: "summary" };
  const facts = { bodySucceeded: true, failureFlags: [0, 0, 0, 0, 1, 0], releasesFulfilled: true, ownership: [0, 1, 1, 1, 1, 0, 0, 1, 1] };
  const record = diagnostic.record(context, "rejected", new AggregateError([undefined]), facts);
  assert.ok(record); assert.deepEqual(diagnostic.validate(record), record);
  let touched = 0;
  const getter = Array(9).fill(0); Object.defineProperty(getter, "0", { get() { touched++; throw undefined; } });
  const proxy = new Proxy([], { get() { touched++; throw undefined; } });
  for (const extra of [
    { failureFlags: [0, 0, 0, 0, 2, 0] }, { failureFlags: [0] }, { ownership: getter }, { ownership: proxy },
    { ownership: Array(9) }, { ownership: Array(9).fill(10000) }, { census: Array(56).fill(-1) },
    { census: Array(55).fill(0) }, { rejections: Array(5).fill(Array(12).fill(0)) },
    { rejections: [[14, 2, 0, 1, 2, 0, null, null, null, 14, 1, null]] }, { rejections: [[2, 1, 0, 1, 2, 0, null, null, null, 14, 1, null]] },
    { rejections: [[2, 2, 8388608, 1, 2, 0, null, null, null, 14, 1, null]] }, { rejections: [[2, 2, 0, 10000, 2, 0, null, null, null, 14, 1, null]] },
    { rejections: [[2, 2, null, 1, 2, 0, null, null, null, 14, 1, null]] }, { rejections: [getter] }, { omitted: -1 }, { predicate: "private" }, { bodySucceeded: "true" },
  ]) assert.equal(diagnostic.validate({ ...record, ...extra }), null);
  assert.equal(touched, 0);
  assert.ok(diagnostic.validate({ ...record, ownership: Array(9).fill(null) }));
});

async function errorCaseObserver(body, release = () => Promise.resolve()) {
  const bindings = createRequestBindings(), owner = bindings.expect("error", "chat", "https://fixture.example/chat", "POST", "fixture-error");
  bindings.claim(owner.url, { method: "POST", headers: { authorization: "Bearer fixture-error" } }, "chat");
  const life = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => true });
  const response = new Response(body), result = { response, release }, acquired = Promise.resolve(result);
  assert.equal(life.guard(() => acquired, null, [], owner), acquired); await acquired;
  return { life, result, response, owner, acquired };
}
function joinRecordParts(life) {
  const parts = life.joinDiagnostic(); assert.ok(parts);
  return [["join_contract", parts.contract], ["join_census", parts.census], ["join_rejections", parts.rejection]].map(([phase, facts]) => {
    const value = diagnostic.record({ ...diagnosticContext, caseId: "error", phase, role: "summary" }, "rejected", new AggregateError([]), facts);
    assert.ok(value, phase); return value;
  });
}

test("Qianfan join projection retains normal EOF and clean early cancellation acceptance", async () => {
  for (const early of [false, true]) {
    const f = await errorCaseObserver(new ReadableStream({ start(controller) { if (!early) controller.close(); } }, { highWaterMark: 0 }));
    const reader = f.response.body.getReader(), closed = reader.closed, reading = reader.read();
    let cancel;
    if (early) { cancel = reader.cancel(); assert.equal(f.life.operations.at(-1).pending, cancel); await cancel; }
    await reading; await closed; reader.releaseLock(); const releasing = f.result.release(); await releasing;
    await f.life.join();
    const proof = f.life.joinDiagnostic(); assert.deepEqual(proof.contract.failureFlags, [0, 0, 0, 0, 0, 0]);
    assert.equal(proof.contract.bodySucceeded, true); assert.equal(proof.contract.releasesFulfilled, true);
    assert.deepEqual(proof.contract.ownership, [0, 1, 1, 1, 1, 1, 0, 1, 1]);
    assert.equal(proof.census.census[1], 1); assert.equal(proof.census.census[6 * 4 + 1], 1);
    assert.equal(f.life.operations.find(op => op.kind === "reader.closed").pending, closed);
    assert.equal(f.life.operations.find(op => op.kind === "reader.read").pending, reading);
    assert.equal(f.life.operations.find(op => op.kind === "release").pending, releasing);
    assert.deepEqual(proof.rejection, { rejections: [], omitted: 0 }); joinRecordParts(f.life); await f.life.restore();
  }
});

test("Qianfan nonabort source errors keep original read closed cancel failures including undefined", async () => {
  for (const reason of [undefined, new Error("synthetic source error")]) {
    const f = await errorCaseObserver(new ReadableStream({ start(controller) { controller.error(reason); } }));
    const reader = f.response.body.getReader(), closed = reader.closed, reading = reader.read(), cancelling = reader.cancel();
    await Promise.allSettled([reading, closed, cancelling]); reader.releaseLock(); await f.result.release();
    await assert.rejects(f.life.join(), error => error.errors.length === 3 && error.errors.every(value => value === reason));
    const proof = f.life.joinDiagnostic(); assert.deepEqual(proof.contract.failureFlags, [0, 0, 0, 0, 1, 0]);
    assert.equal(proof.contract.bodySucceeded, true); assert.equal(proof.contract.releasesFulfilled, true);
    assert.equal(proof.rejection.rejections.length, 3);
    for (const row of proof.rejection.rejections) {
      assert.equal(row[1], 2); const bits = row[2];
      for (const bit of [1, 2, 3, 14, 19]) assert.ok(bits & 2 ** bit);
      for (const bit of [7, 8, 9, 10, 16, 20]) assert.equal(bits & 2 ** bit, 0);
      for (const bit of [0, 4, 5, 6]) assert.equal(Boolean(bits & 2 ** bit), reason !== undefined);
      assert.equal(Boolean(bits & 2 ** 17), reason === undefined);
    }
    assert.equal(f.life.operations.find(op => op.kind === "reader.read").pending, reading);
    assert.equal(f.life.operations.find(op => op.kind === "reader.cancel").pending, cancelling);
    joinRecordParts(f.life); await f.life.restore();
  }
});

test("Qianfan pending reader unlock rejection is not converted into expected provider error", async () => {
  const f = await errorCaseObserver(new ReadableStream({}, { highWaterMark: 0 }));
  const reader = f.response.body.getReader(), closed = reader.closed, reading = reader.read();
  reader.releaseLock(); await Promise.allSettled([reading, closed]); await f.result.release();
  await assert.rejects(f.life.join(), error => error.errors.length === 2 && error.errors.every(value => value instanceof TypeError));
  const proof = f.life.joinDiagnostic(); assert.deepEqual(proof.contract.failureFlags, [0, 0, 0, 0, 1, 0]);
  assert.equal(proof.contract.ownership[5], 0); assert.equal(proof.contract.ownership[6], 0);
  assert.ok(proof.rejection.rejections.every(row => (row[2] & 2 ** 12) !== 0));
  assert.equal(f.life.operations.find(op => op.kind === "reader.closed").pending, closed);
  joinRecordParts(f.life); await f.response.body.cancel(); await f.life.restore();
});

test("Qianfan missing and failed original releases stay hard with exact diagnostic categories", async () => {
  const missing = createLifetimeObserver({ bindings: [], bodySucceeded: () => true });
  const frozen = Object.freeze({ response: new Response(null), release() { return Promise.resolve(); } });
  const acquired = Promise.resolve(frozen); missing.guard(() => acquired, null, [], {}); await acquired;
  await assert.rejects(missing.join(), error => error.errors.length === 3);
  assert.deepEqual(missing.joinDiagnostic().contract.failureFlags, [1, 1, 0, 0, 0, 1]);
  assert.equal(missing.joinDiagnostic().contract.ownership[3], 0); joinRecordParts(missing); await missing.restore();
  for (const sync of [false, true]) {
    const f = await errorCaseObserver(new ReadableStream({ start(controller) { controller.close(); } }), () => { if (sync) throw undefined; return Promise.reject(undefined); });
    const reader = f.response.body.getReader(); await reader.read(); await reader.closed; reader.releaseLock();
    let caught = false; try { await f.result.release(); } catch (reason) { caught = true; assert.equal(reason, undefined); }
    assert.equal(caught, true);
    await assert.rejects(f.life.join(), error => error.errors.length === 2 && error.errors[0] === undefined);
    const proof = f.life.joinDiagnostic(); assert.deepEqual(proof.contract.failureFlags, [0, 0, 0, 0, 1, 1]);
    assert.equal(proof.contract.releasesFulfilled, false); assert.equal(proof.rejection.rejections[0][0], 6);
    assert.equal(proof.rejection.rejections[0][1], sync ? 3 : 2); joinRecordParts(f.life); await f.life.restore();
  }
});

test("Qianfan join projection distinguishes missing consumption and still-owned native readers", async () => {
  const missing = createLifetimeObserver(), body = new ReadableStream({ start(controller) { controller.close(); } });
  missing.response(new Response(body), {});
  await assert.rejects(missing.join(), error => error.errors.length === 1);
  assert.deepEqual(missing.joinDiagnostic().contract.failureFlags, [0, 0, 1, 0, 0, 0]);
  joinRecordParts(missing); await body.cancel(); await missing.restore();
  const owned = createLifetimeObserver(), response = new Response(new ReadableStream({ start(controller) { controller.close(); } }));
  owned.response(response, {}); const reader = response.body.getReader(); await reader.read(); await reader.closed;
  await assert.rejects(owned.join(), error => error.errors.length === 1);
  assert.deepEqual(owned.joinDiagnostic().contract.failureFlags, [0, 0, 0, 1, 0, 0]);
  assert.deepEqual(owned.joinDiagnostic().contract.ownership.slice(4), [1, 1, 1, 0, 0]);
  joinRecordParts(owned); reader.releaseLock(); await owned.restore();
});

test("Qianfan diagnostic census counts dynamic originals and bounds overflow without false zero", async () => {
  const life = createLifetimeObserver();
  for (let i = 0; i < 10000; i++) life.watch("handler", i, {});
  await life.join(); assert.equal(life.operations.length, 10000);
  assert.equal(life.joinDiagnostic().census.census[8 * 4 + 1], null); joinRecordParts(life);
  const rejected = createLifetimeObserver();
  for (let i = 0; i < 6; i++) rejected.watch("waitUntil", Promise.reject(undefined), {});
  await assert.rejects(rejected.join(), error => error.errors.length === 6 && error.errors.every(value => value === undefined));
  assert.equal(rejected.joinDiagnostic().rejection.rejections.length, 4); assert.equal(rejected.joinDiagnostic().rejection.omitted, 2);
  joinRecordParts(rejected);
});

test("Qianfan join records fit the existing step budget and preserve strict Worker failed predicates", async () => {
  const f = await errorCaseObserver(new ReadableStream({ start(controller) { controller.error(undefined); } }));
  const reader = f.response.body.getReader(); await Promise.allSettled([reader.read(), reader.cancel()]); reader.releaseLock(); await f.result.release();
  await assert.rejects(f.life.join(), AggregateError);
  const records = joinRecordParts(f.life), lines = [], diagnostics = outerDiagnostics({}, diagnostic.emitter(text => lines.push(text)));
  const primary = Object.assign(new Error("not emitted"), { stdout: records.map(record => diagnostic.encode(record)).join(""), code: 1 });
  await assert.rejects(diagnostics.helper(() => Promise.reject(primary)), error => error === primary);
  for (const side of ["router", "upstream"]) for (const [predicate, proof] of [
    ["accepted", { accepted: false }], ["settled", { accepted: true, settled: false }],
    ["rejected", { accepted: true, settled: true, rejected: 1 }],
    ...(side === "router" ? [["unlocked", { accepted: true, settled: true, rejected: 0, readers: 1, unlocked: 0 }]] : []),
  ]) {
    const events = []; assert.throws(() => verifyRetirement({ ...proof, join: f.life.joinDiagnostic() }, side, { retirement(...args) { events.push(args); } }), assert.AssertionError);
    assert.equal(events[0][0], side); assert.equal(events[0][1], predicate);
  }
  for (const side of ["router", "upstream"]) assert.throws(() => verifyRetirement({ accepted: false, join: f.life.joinDiagnostic() }, side, diagnostics), assert.AssertionError);
  diagnostics.finish(); diagnostics.finish();
  assert.equal(lines.length, 8); assert.ok(lines.every(line => line.startsWith("::error") && Buffer.byteLength(line) <= 768));
  assert.ok(Buffer.byteLength(lines.join("")) <= 8192);
  assert.ok(lines.some(line => line.includes('"phase":"retirement_router"') && line.includes('"predicate":"accepted"')));
  assert.ok(lines.some(line => line.includes('"phase":"retirement_upstream"')));
  await f.life.restore();
});

test("Qianfan multiple SDK join failures reserve both strict Worker predicates within nine annotations", async () => {
  const lines = [], diagnostics = outerDiagnostics({}, diagnostic.emitter(line => lines.push(line)));
  const records = [];
  for (const caseId of ["error", "card0", "card1"]) for (const phase of ["original_join", "join_contract", "join_census", "join_rejections"]) {
    records.push(diagnostic.record({ ...diagnosticContext, caseId, phase, role: phase === "original_join" ? "cleanup" : "summary" }, "rejected", new AggregateError([undefined])));
  }
  const primary = Object.assign(new Error("never forwarded"), { stdout: records.map(record => diagnostic.encode(record)).join(""), code: 1 });
  await assert.rejects(diagnostics.helper(() => Promise.reject(primary)), error => error === primary);
  diagnostics.failure(undefined, "receipt");
  for (const side of ["router", "upstream"]) assert.throws(() => verifyRetirement({ accepted: false }, side, diagnostics), assert.AssertionError);
  diagnostics.failure(undefined, "retirement", "cleanup"); diagnostics.finish(); diagnostics.finish();
  const emitted = lines.map(line => JSON.parse(line.slice(line.indexOf("::{") + 2)));
  assert.equal(emitted.length, 10); assert.equal(emitted.at(-1).phase, "overflow"); assert.ok(emitted.at(-1).suppressed > 0);
  assert.deepEqual(emitted.filter(record => record.caseId === "error").map(record => record.phase), ["join_contract", "join_census", "join_rejections"]);
  for (const side of ["router", "upstream"]) for (const suffix of ["", "_ops"]) assert.equal(emitted.filter(record => record.phase === "retirement_" + side + suffix && record.predicate === "accepted").length, 1);
  assert.ok(lines.every(line => line.startsWith("::error") && Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(lines.join("")) <= 8192);
});

async function retireWorker(mf, diagnostics, nativeAccepted = false) {
  if (!mf) return;
  let sourceCancellation;
  async function retire(side, url) {
    let proof;
    try {
      const worker = await mf.getWorker(side), response = await worker.fetch(url, side === "router" ? {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceCancellation, nativeAccepted }),
      } : undefined);
      proof = await response.json();
    } catch (error) {
      try { diagnostics?.retirement(side, "response", undefined, error); } catch { /* original rejection wins */ }
      throw error;
    }
    verifyRetirement(proof, side, diagnostics);
    if (side === "upstream") sourceCancellation = proof.sourceCancellation;
  }
  // A failed source proof never qualifies router reads; both original joins run.
  await preserveFailures(() => retire("upstream", "https://fixture.example/retirement"),
    [() => retire("router", "https://fixture.example/fixture/retirement")]);
}

test("Qianfan release chronology observes original entry return and settlement without accepting source errors", async () => {
  // Observer instrumentation controls only. These are not OpenAI/parser or guard
  // implementation comparisons and establish no SDK error disposition.
  for (const when of ["before", "inside", "after", "never"]) {
    const input = new AbortController(), released = deferred(), reason = new Error("observer control");
    const bindings = createRequestBindings(), owner = bindings.expect("error", "chat", "https://fixture.example/chat", "POST", "fixture-error");
    bindings.claim(owner.url, { method: "POST", headers: { authorization: "Bearer fixture-error" } }, "chat");
    const life = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => true }); life.signal(owner, input.signal);
    const response = new Response(new ReadableStream({ start(controller) { controller.error(reason); } }));
    const operands = [17]; let receiver, originalOperands;
    const result = { response, release(...args) { receiver = this; originalOperands = args; if (when === "inside") input.abort(reason); return released.promise; } };
    const acquisition = Promise.resolve(result); assert.equal(life.guard(() => acquisition, null, [], owner), acquisition); await acquisition;
    const reader = response.body.getReader(), closed = reader.closed, reading = reader.read(), cancelling = reader.cancel();
    await Promise.allSettled([reading, closed, cancelling]); reader.releaseLock();
    if (when === "before") input.abort(reason);
    const product = result.release(...operands); assert.equal(product, released.promise); assert.equal(receiver, result); assert.deepEqual(originalOperands, operands);
    const releasing = life.operations.find(op => op.kind === "release");
    assert.equal(releasing.pending, product); assert.equal(releasing.state, "pending");
    assert.ok(releasing.returned > releasing.invoked); assert.equal(releasing.settled, undefined);
    if (when === "after") input.abort(reason);
    released.resolve(); await product;
    await assert.rejects(life.join(), error => error.errors.length === 3 && error.errors.every(value => value === reason));
    assert.equal(life.operations.find(op => op.kind === "reader.read").pending, reading);
    assert.equal(life.operations.find(op => op.kind === "reader.closed").pending, closed);
    assert.equal(life.operations.find(op => op.kind === "reader.cancel").pending, cancelling);
    const trace = life.joinDiagnostic().census.releaseTrace[0], mask = trace[6];
    assert.deepEqual(trace.slice(0, 2), [14, 1]); assert.equal(trace[7], 1);
    assert.ok(trace[2] < trace[3] && trace[3] < trace[4]);
    for (const bit of [0, 1, 2, 3, 4, 5, 12, 13, 19]) assert.ok(mask & 2 ** bit);
    for (const bit of [14, 15, 16, 17]) assert.equal(mask & 2 ** bit, 0);
    assert.equal(Boolean(mask & 2 ** 6), when === "before");
    assert.equal(Boolean(mask & 2 ** 7), ["before", "inside"].includes(when));
    assert.equal(Boolean(mask & 2 ** 8), when !== "never");
    assert.equal(Boolean(mask & 2 ** 9), when === "before");
    assert.equal(Boolean(mask & 2 ** 10), ["before", "inside"].includes(when));
    assert.equal(Boolean(mask & 2 ** 11), when !== "never");
    if (when === "before") assert.ok(trace[5] < trace[2]);
    if (when === "inside") assert.ok(trace[2] < trace[5] && trace[5] < trace[3]);
    if (when === "after") assert.ok(trace[3] < trace[5] && trace[5] < trace[4]);
    if (when === "never") assert.equal(trace[5], null);
    joinRecordParts(life); await life.restore();
  }
});

test("Qianfan strict Worker identities use original case role signal and handler waitUntil products", async () => {
  const life = createLifetimeObserver(), bindings = createRequestBindings(), signal = new AbortController(), reason = new Error("owned signal");
  const owner = bindings.expect("qianfan_error", "chat", "https://fixture.example/chat", "POST", "fixture-error");
  bindings.claim(owner.url, { method: "POST", headers: { authorization: "Bearer fixture-error" } }, "chat"); life.signal(owner, signal.signal);
  let controller; const response = new Response(new ReadableStream({ start(value) { controller = value; } }, { highWaterMark: 0 }));
  life.response(response, owner); const reader = response.body.getReader(), closed = reader.closed, reading = reader.read();
  const handler = Promise.resolve(response), waitUntil = Promise.resolve();
  assert.equal(life.watch("handler", handler, owner), handler); assert.equal(life.watch("waitUntil", waitUntil, owner), waitUntil);
  signal.abort(reason); controller.error(reason); const cancelling = reader.cancel();
  await Promise.allSettled([reading, closed, cancelling, handler, waitUntil]); reader.releaseLock();
  await assert.rejects(life.join(), error => error.errors.length === 3 && error.errors.every(value => value === reason));
  const projection = life.joinDiagnostic(); assert.deepEqual(projection.worker.work, [0, 1, 0, 0, 0, 1, 0, 0]);
  for (const row of projection.worker.rejections) {
    assert.deepEqual(row.slice(9, 11), [14, 1]); assert.equal(row[11], owner.abort.sequence);
    for (const bit of [8, 10, 20, 21, 22]) assert.ok(row[2] & 2 ** bit);
    assert.equal(row[2] & 2 ** 19, 0); // No SDK acquisition is invented for Worker reads.
  }
  assert.equal(projection.contract.bodySucceeded, null); assert.deepEqual(projection.contract.failureFlags, [0, 0, 0, 0, 1, 0]);
  await life.restore();
});

test("Qianfan extended diagnostics reject malformed owner release and nested fields without reading them", () => {
  const context = { ...diagnosticContext, phase: "join_rejections", role: "summary" };
  const row = [2, 2, 8388607, 1, 9, 0, 5, 6, 8, 14, 1, 4];
  const valid = diagnostic.record(context, "rejected", undefined, { rejections: [row], omitted: 0 }); assert.ok(valid);
  let touched = 0; const getter = row.slice(); Object.defineProperty(getter, "9", { get() { touched++; throw undefined; } });
  const proxy = new Proxy(row, { get() { touched++; throw undefined; } });
  const release = [14, 1, 1, 3, 7, 2, 1048575, 0];
  for (const fields of [
    { rejections: [getter] }, { rejections: [proxy] }, { rejections: [[...row.slice(0, 9), 20, 1, 4]] },
    { rejections: [[...row.slice(0, 10), 3, 4]] }, { rejections: [[...row.slice(0, 11), 10000]] },
    { releaseTrace: [[...release.slice(0, 6), 1048576, 0]] }, { releaseTrace: [release, release, release] },
    { releaseTrace: [[20, ...release.slice(1)]] }, { work: Array(8).fill(10000) }, { folded: Array(8).fill(0) },
    { retirement: [2, 1, 0, 0, 0] }, { retirement: [1, "true", 0, 0, 0] },
  ]) assert.equal(diagnostic.validate({ ...valid, ...fields }), null);
  assert.equal(touched, 0);
  assert.ok(diagnostic.validate({ ...valid, releaseTrace: [release], releaseOmitted: 0 }));
  assert.equal(diagnostic.validate("x".repeat(159)), null);
  assert.deepEqual(diagnostic.parse("QIANFAN_DIAGNOSTIC " + JSON.stringify("x".repeat(159)) + "\n"), []);
});

test("Qianfan both Worker summaries survive overall failure including previously fulfilled retirement", async () => {
  for (const failure of ["none", "helper", "router", "upstream"]) {
    const lines = [], diagnostics = outerDiagnostics({}, diagnostic.emitter(line => lines.push(line)));
    const proof = { accepted: true, settled: true, rejected: 0, readers: 1, unlocked: 1,
      join: { contract: { bodySucceeded: null, failureFlags: Array(6).fill(0), releasesFulfilled: true, ownership: Array(9).fill(0) },
        worker: { rejections: [], omitted: 0, work: [0, 1, 0, 0, 0, 1, 0, 0] } } };
    if (failure === "helper") diagnostics.failure(undefined, "helper");
    for (const side of ["router", "upstream"]) {
      if (failure === side) assert.throws(() => verifyRetirement({ ...proof, accepted: false }, side, diagnostics), assert.AssertionError);
      else verifyRetirement(proof, side, diagnostics);
      if (failure === "upstream" && side === "router") assert.deepEqual(lines, []);
    }
    diagnostics.finish(); diagnostics.finish();
    const records = lines.map(line => JSON.parse(line.slice(line.indexOf("::{") + 2)));
    if (failure === "none") { assert.deepEqual(records, []); continue; }
    for (const side of ["router", "upstream"]) for (const suffix of ["", "_ops"]) {
      const matching = records.filter(row => row.phase === "retirement_" + side + suffix); assert.equal(matching.length, 1);
      assert.equal(matching[0].outcome, failure === side ? "rejected" : "fulfilled");
      assert.equal(matching[0].predicate, failure === side ? "accepted" : "none");
    }
    assert.ok(lines.every(line => Buffer.byteLength(line) <= 768));
  }
});

test("Qianfan unknown Worker response failure stays distinct and still attempts the original other retirement", async () => {
  const lines = [], diagnostics = outerDiagnostics({}, diagnostic.emitter(line => lines.push(line))), calls = [];
  const proof = { accepted: true, settled: true, rejected: 0, readers: 0, unlocked: 0 };
  const mf = { async getWorker(side) { calls.push(side); return { async fetch() { if (side === "router") throw undefined; return Response.json(proof); } }; } };
  let rejected = false; try { await retireWorker(mf, diagnostics); } catch (error) { rejected = true; assert.equal(error, undefined); }
  assert.equal(rejected, true); assert.deepEqual(calls, ["upstream", "router"]); diagnostics.finish();
  const records = lines.map(line => JSON.parse(line.slice(line.indexOf("::{") + 2)));
  assert.equal(records.length, 4);
  assert.equal(records.find(row => row.phase === "retirement_router").predicate, "response");
  assert.deepEqual(records.find(row => row.phase === "retirement_router").retirement, [null, null, null, null, null]);
  assert.equal(records.find(row => row.phase === "retirement_upstream").outcome, "fulfilled");
});

for (const id of pinnedControlIds.slice(6)) test("Qianfan hosted observer control implementation " + id, { timeout: 5000 }, async () => {
  await runQianfanObserverControl(id, assert);
});

test("Qianfan controls reject mocked or foreign dependency admission without executing imports", () => {
  const installed = { fetch() {}, Agent: class {}, ProxyAgent: class {} };
  requirePinnedControlAdmission(installed.fetch, false, false, installed, installed, "7.43.0");
  for (const args of [
    [undefined, false, false, installed, installed, "7.43.0"],
    [installed.fetch, true, false, installed, installed, "7.43.0"],
    [installed.fetch, false, true, installed, installed, "7.43.0"],
    [installed.fetch, false, false, installed, installed, "7.45.1"],
    ...["fetch", "Agent", "ProxyAgent"].map(key => [installed.fetch, false, false, { ...installed, [key]() {} }, installed, "7.43.0"]),
  ]) assert.throws(() => requirePinnedControlAdmission(...args));
});

test("Qianfan actual registrations isolate twelve controls from the exact fifteen product hooks", () => {
  const scopes = [], cases = [], hooks = [], options = [];
  function suite(name, config, body) {
    if (typeof config === "function") { body = config; config = undefined; }
    options.push(config); scopes.push(name); body(); scopes.pop();
  }
  function register(name, body) { cases.push({ name, body, scope: scopes.at(-1), hooks: hooks.filter(h => h.scope === scopes.at(-1)).length }); }
  register.each = rows => (name, body) => { for (const row of rows) register(name, () => body(...Array.isArray(row) ? row : [row])); };
  const registrations = stripTypeScriptTypes(sdkText.slice(sdkText.indexOf('describe("exact d8 parser'), sdkText.lastIndexOf('sdkDiagnostic("collection", "progress", "fulfilled");')));
  new Function("describe", "beforeEach", "nativeIt", "it", "models", "createPinnedControlSummary", "pinnedControlIds", "sdkDiagnostic", registrations)(
    suite, body => hooks.push({ scope: scopes.at(-1), body }), register, register, models, createPinnedControlSummary, pinnedControlIds, () => {});
  assert.equal(cases.length, 27); assert.equal(hooks.length, 1);
  assert.deepEqual(options, [{ concurrent: false }, undefined], "Vitest 5 suite options keep controls serial without the removed sequential API");
  assert.ok(cases.slice(0, 12).every(row => row.scope.startsWith("exact d8 parser") && row.hooks === 0));
  assert.ok(cases.slice(12).every(row => row.scope.startsWith("actual Qianfan") && row.hooks === 1));
  assert.equal((sdkText.match(/\bbeforeEach\(/g) ?? []).length, 1);
  assert.equal((sdkText.match(/\b(?:afterEach|beforeAll|afterAll)\(/g) ?? []).length, 0);
});

test("Qianfan twelve-control summary rejects inconsistent masks and preserves unknown in-flight state", () => {
  const controls = createPinnedControlSummary(); controls.start("done");
  assert.equal(controls.facts().controlCounts[4], null); controls.finish("done", true);
  assert.deepEqual(controls.facts().controlCounts, [12, 1, 1, 0, 0, 0, 0]);
  assert.throws(() => controls.start("done")); assert.throws(() => controls.finish("done", false)); assert.throws(() => controls.start("private"));
  const context = { ...diagnosticContext, caseId: "none", route: "none", phase: "controls", role: "summary" };
  const valid = diagnostic.record(context, "fulfilled", undefined, controls.facts()); assert.ok(valid);
  for (const controlCounts of [[13, 1, 1, 0, 0, 0, 0], [12, 4096, 0, 0, 0, 0, 0], [12, 1, 1, 1, 0, 0, 0], [12, 1, 2, 0, 0, 0, 0]]) assert.equal(diagnostic.validate({ ...valid, controlCounts }), null);
  let calls = 0; const values = Array(8).fill(0); Object.defineProperty(values, "3", { get() { calls++; throw undefined; } });
  assert.equal(diagnostic.validate({ ...valid, controlSequence: values }), null); assert.equal(calls, 0);
  assert.equal(diagnostic.validate({ ...valid, controlFlags: [0, 0, 0, 0, 0, 2] }), null);
});

test("Qianfan full twelve plus fifteen failure pipeline keeps all nine essential slots within budget", async () => {
  const controls = createPinnedControlSummary(); for (const id of pinnedControlIds) { controls.start(id); controls.finish(id, false); }
  const records = [diagnostic.record({ ...diagnosticContext, caseId: "none", route: "none", phase: "controls", role: "summary" }, "rejected", undefined, controls.facts())];
  for (const caseId of diagnostic.cases.filter(id => id !== "none")) for (const phase of ["body", "original_join", "join_contract", "join_census", "join_rejections"]) {
    records.push(diagnostic.record({ ...diagnosticContext, caseId, phase, role: phase.startsWith("join_") ? "summary" : "primary" }, "rejected", undefined));
  }
  const lines = [], diagnostics = outerDiagnostics({}, diagnostic.emitter(line => lines.push(line)));
  const primary = Object.assign(new Error("not forwarded"), { stdout: records.map(record => diagnostic.encode(record)).join(""), code: 1, killed: false, signal: null });
  await assert.rejects(preserveFailures(() => diagnostics.helper(() => Promise.reject(primary)), [
    diagnostics.cleanup("dispose", () => { throw undefined; }), diagnostics.cleanup("rm", () => { throw undefined; }),
  ]), error => error.errors[0] === primary && error.errors[1] === undefined && error.errors[2] === undefined);
  diagnostics.failure(undefined, "receipt");
  for (const side of ["router", "upstream"]) assert.throws(() => verifyRetirement({ accepted: false }, side, diagnostics));
  diagnostics.finish(); diagnostics.finish();
  const emitted = lines.map(line => JSON.parse(line.slice(line.indexOf("::{") + 2)));
  assert.equal(emitted.length, 10); assert.deepEqual(emitted[0].controlCounts, [12, 4095, 0, 4095, 0, 0, 0]);
  assert.ok(lines.every(line => line.startsWith("::error") && Buffer.byteLength(line) <= 768)); assert.ok(Buffer.byteLength(lines.join("")) <= 8192);
  for (const phase of ["helper", "receipt", "join_contract", "join_census", "join_rejections", "retirement_router", "retirement_router_ops", "retirement_upstream", "retirement_upstream_ops", "overflow"]) assert.equal(emitted.filter(row => row.phase === phase).length, 1);
  assert.deepEqual(emitted.at(-1).folded.slice(0, 4), [0, 1, 0, 1]);
});

test("Qianfan maximum closed control metadata fits the reserved helper command", () => {
  const facts = { sdkRecords: 512, exit: 255, killed: true, signal: "SIGTERM", observedCode: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    sdkAt: [diagnostic.phases.length - 1, 2, 5], sdkFault: [9, 5, 4, 9999, 4], controlAt: [11, 6],
    controlCounts: [12, 4095, 0, 4095, 9999, 9999, 9999], controlSequence: Array(8).fill(9999), controlFlags: Array(6).fill(1) };
  const record = diagnostic.record({ layer: "outer", route: "none", caseId: "none", phase: "helper", role: "primary" }, "rejected", undefined, facts);
  assert.ok(record); const lines = [], emitter = diagnostic.emitter(line => lines.push(line)); emitter.emit(record);
  assert.equal(lines.length, 1); assert.ok(Buffer.byteLength(lines[0]) <= 768);
  const controls = createPinnedControlSummary(); controls.start("embedded"); controls.pending(1); controls.finish("embedded", false);
  assert.equal(controls.facts().controlCounts[4], 1); assert.equal(controls.facts().controlCounts[5], null);
});

test("Qianfan precase progress and own-data failure shapes survive helper failure without invented control results", async () => {
  const lines = [], diagnostics = outerDiagnostics({}, diagnostic.emitter(line => lines.push(line)));
  let getters = 0;
  const unsafe = Object.defineProperty({}, "name", { get() { getters++; throw undefined; } });
  Object.defineProperty(unsafe, "code", { get() { getters++; throw undefined; } });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { getters++; throw undefined; } });
  assert.deepEqual(diagnostic.fault(unsafe).slice(1), [null, null, null, null]);
  assert.deepEqual(diagnostic.fault(proxy).slice(1), [null, null, null, null]);
  const aggregate = new AggregateError([undefined, null]);
  assert.deepEqual(diagnostic.fault(aggregate).slice(3), [2, 1]); assert.equal(getters, 0);
  const record = diagnostic.record({ ...diagnosticContext, route: "none", caseId: "none", phase: "collection", role: "primary" }, "rejected", undefined, { fault: diagnostic.fault(undefined) });
  const original = Object.assign(new Error("not emitted"), { code: 1, stdout: diagnostic.encode(record) });
  await assert.rejects(diagnostics.helper(() => Promise.reject(original)), error => error === original);
  diagnostics.finish(); const first = JSON.parse(lines[0].slice(lines[0].indexOf("::{") + 2));
  assert.deepEqual(first.sdkAt, diagnostic.boundary(record)); assert.deepEqual(first.sdkFault, diagnostic.fault(undefined));
  assert.equal(first.sdkRecords, 1); assert.equal(Object.hasOwn(first, "controlCounts"), false);
  for (const extra of [{ sdkAt: [40, 1, 1] }, { sdkFault: [1, 6, null, null, null] }, { controlAt: [12, 1] }, { retirementChecks: Array(8).fill(4) }]) assert.equal(diagnostic.validate({ ...record, ...extra }), null);
});

test("Qianfan original retirement steps preserve pending promises, undefined failures and independent restore", async () => {
  const steps = observeRetirementSteps(); let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  assert.equal(steps.observe(0, () => pending), pending); assert.deepEqual(steps.facts(), [1, 0, 0, 0, 0, 0, 0, 0]);
  finish(); await pending; assert.equal(steps.facts()[0], 2);
  let thrown = false; try { steps.observe(1, () => { throw undefined; }); } catch (error) { thrown = true; assert.equal(error, undefined); }
  assert.equal(thrown, true);
  const restore = Promise.reject(undefined); assert.equal(steps.observe(3, () => restore), restore); await Promise.allSettled([restore]);
  assert.deepEqual(steps.facts(), [2, 3, 0, 3, 0, 2, 0, 2]);
  const life = createLifetimeObserver(), bindings = createRequestBindings(), stage = observeRetirementSteps();
  bindings.expect("error", "chat", "https://fixture.example/test", "POST", "fixture-only");
  await assert.rejects(preserveFailures(async () => { await stage.observe(0, () => life.join()); stage.observe(1, () => bindings.verify()); }, [() => stage.observe(3, () => life.restore())]));
  assert.deepEqual(stage.facts(), [2, 3, 0, 2, 0, 1, 0, 0]); assert.equal(life.summary().readers, 0);
  assert.equal(life.joinDiagnostic().worker.rejections.length, 0);
  const lines = [], diagnostics = outerDiagnostics({}, diagnostic.emitter(line => lines.push(line)));
  assert.throws(() => verifyRetirement({ accepted: false, settled: true, rejected: 1, readers: 0, unlocked: 0, join: life.joinDiagnostic(), retirementChecks: stage.facts() }, "router", diagnostics));
  diagnostics.finish(); const record = JSON.parse(lines[0].slice(lines[0].indexOf("::{") + 2));
  assert.equal(record.predicate, "accepted"); assert.deepEqual(record.retirementChecks, stage.facts());
});

test("Qianfan control failure retains actual case masks, stage and undefined reason before product execution", async () => {
  const summary = createPinnedControlSummary(); summary.start("done"); summary.stage(2); summary.finish("done", false);
  const context = { ...diagnosticContext, caseId: "none", route: "none", phase: "controls", role: "summary" };
  const record = diagnostic.record(context, "rejected", undefined, { ...summary.facts(), fault: diagnostic.fault(undefined) });
  const lines = [], diagnostics = outerDiagnostics({}, diagnostic.emitter(line => lines.push(line)));
  const error = { code: 1, stdout: diagnostic.encode(record) };
  await assert.rejects(diagnostics.helper(() => Promise.reject(error)), value => value === error); diagnostics.finish();
  const value = JSON.parse(lines[0].slice(lines[0].indexOf("::{") + 2));
  assert.deepEqual(value.controlCounts, [12, 1, 0, 1, 0, 0, 0]); assert.deepEqual(value.controlAt, [0, 2]);
  assert.deepEqual(value.sdkFault, diagnostic.fault(undefined)); assert.deepEqual(value.sdkAt, diagnostic.boundary(record));
});

test("Qianfan actual collection boundaries rethrow undefined and retain the failing registration phase", () => {
  const callbacks = [], events = [];
  function suite(name, config, body) { callbacks.push(typeof config === "function" ? config : body); }
  const registrations = stripTypeScriptTypes(sdkText.slice(sdkText.indexOf('sdkStage("collection");')));
  const register = () => {}; register.each = () => () => { throw undefined; };
  new Function("describe", "beforeEach", "nativeIt", "it", "models", "createPinnedControlSummary", "pinnedControlIds", "sdkStage", "sdkDiagnostic", registrations)(
    suite, () => {}, register, register, models, createPinnedControlSummary, pinnedControlIds, phase => events.push([phase, "entered"]),
    (phase, role, outcome, error) => events.push([phase, outcome, error]));
  assert.equal(callbacks.length, 2);
  assert.ok(events.some(row => row[0] === "collection" && row[1] === "fulfilled"));
  for (const [i, phase] of ["control_registration", "product_registration"].entries()) {
    let failed = false; try { callbacks[i](); } catch (error) { failed = true; assert.equal(error, undefined); }
    assert.equal(failed, true); assert.deepEqual(events.at(-1), [phase, "rejected", undefined]);
  }
});

test("actual OpenClaw Qianfan configured native client through workerd and SQLite", { skip: !source, timeout: 300_000 }, async t => {
  const diagnostics = outerDiagnostics(t);
  try {
  assert.ok(endpoint);
  assert.deepEqual(provider.models.filter(model => model.capabilities.includes("llm.chat")).map(model => [model.id, model.upstream]), ["ernie-4.5-0.3b", ...models].map(id => ["qianfan/" + id, id]));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-qianfan-client-"));
  let mf, nativeAccepted = false;
  await preserveFailures(async () => {
    try {
    mf = await startQianfanWorkerd(temporary);
    diagnostics.stage("grant");
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      await kv.put(`policies/${id}`, JSON.stringify({ enabled: true, generation: "fixture", providers: [id === "qianfan_foreign" ? "openai" : "qianfan"], models: id === "qianfan_empty" ? ["qianfan/unlisted-fixture"] : models.map(id => `qianfan/${id}`), tenantId: "fixture", monthlyBudgetMicros: 100, requestCostMicros: id === "qianfan_unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: id, policyGeneration: "fixture" }));
    }
    await kv.put("connections/qianfan", JSON.stringify({ providerId: "qianfan", enabled: true }));
    const origin = String(await mf.ready).replace(/\/$/, "");
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    diagnostics.stage("catalog");
    const catalogResponse = await fetch(origin + "/v1/catalog", { headers: { authorization: "Bearer clawrouter-live-qianfan_catalog-fixture-secret" } });
    assert.equal(catalogResponse.status, 200); const catalog = await catalogResponse.json();
    assert.equal(catalog.scope.credentialId, "qianfan_catalog");
    const visible = catalog.providers.find(row => row.id === "qianfan"); assert.ok(visible);
    assert.deepEqual(visible.models.map(row => row.id).sort(), models.map(id => "qianfan/" + id).sort());
    assert.ok(models.every(id => visible.offers.some(offer => offer.modelId === "qianfan/" + id && offer.routeKind === "native" && offer.eligible)));

    diagnostics.stage("helper");
    const cancelReceipt = createCancelReceiptReceiver(diagnostics.context);
    const originalConsumer = diagnostics.helper(() => runOpenClawConsumer(cancelReceipt.context, {
      source, sourceHead, fixture: new URL("./fixtures/openclaw-qianfan-contract.test.ts", import.meta.url),
      testPath: "extensions/qianfan/worker-contract.test.ts",
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, QIANFAN_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" },
    }));
    diagnostics.stage("receipt");
    await cancelReceipt.finish(originalConsumer);
    diagnostics.stage("upstream");
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
    diagnostics.stage("sqlite");
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
    nativeAccepted = true;
    } catch (error) { diagnostics.failure(error); throw error; }
  }, [diagnostics.cleanup("retirement", () => retireWorker(mf, diagnostics, nativeAccepted)), diagnostics.cleanup("dispose", () => mf?.dispose()), diagnostics.cleanup("rm", () => rm(temporary, { recursive: true, force: true }))]);
  } catch (error) { if (!diagnostics.failed) diagnostics.failure(error); throw error; }
  finally { diagnostics.finish(); }
});

// The test bundle alone observes the original handler boundary. Exact source
// pins and single anchors prevent an overlay from silently following new code.
const workerOutcomePins = {"proxy.ts": "b1a8d68993b406b5660ebff0cd3b94e6d11cd0dccbafb7a22d50ec5bec2d483f", "proxy-response.ts": "d612c0a2181c145c6cc4761b82053d04454bb009c872dd2996595a202c9b2b0f", "http-operation.ts": "b530ed9b485191e2752d91a6f6384456f1ab551c97fef08d44919f507b221683"};
function workerOutcomeOverlay(text, name = "proxy-response.ts") {
  assert.equal(createHash("sha256").update(text).digest("hex"), workerOutcomePins[name]);
  const edit = (before, after, count = 1) => { assert.equal(text.split(before).length, count + 1, before); text = text.replaceAll(before, after); };
  if (name === "proxy.ts") {
    // Thread the already-held operation to the original source owner; the
    // forwarded/normalized reader is deliberately NOT used as its identity.
    edit('function ownOrdinaryResponse(response: Response, completion: ProxyCompletion): Response {',
      'function ownOrdinaryResponse(response: Response, completion: ProxyCompletion, operation: HttpOperation): Response {');
    edit('ownOrdinaryResponse(response, completion)', 'ownOrdinaryResponse(response, completion, operation)', 2);
    edit('    const reader = response.body!.getReader(), input = inputRetirement(reader);',
      '    const reader = response.body!.getReader(), input = inputRetirement(reader);\n    qianfanOutcome.current.bind(operation, response, reader);');
    edit('              const next = await input.read(() => reader.read());',
      '              qianfanOutcome.current.readStart(operation, reader);\n              const next = await input.read(() => reader.read());\n              qianfanOutcome.current.readDone(operation, reader);');
    edit('            } catch (error) {\n              if (!stopped)',
      '            } catch (error) {\n              qianfanOutcome.current.failure(operation, reader, error);\n              if (!stopped)');
  } else {
    assert.equal(name, "proxy-response.ts");
    // Embeddings bypass the ordinary Chat completion wrapper. Their original
    // fetched reader belongs directly to observeUsage, not to a forwarded body.
    edit('  const reader = response.body.getReader(), sourceRetired = replayRetirements.get(response.body);',
      '  const reader = response.body.getReader(), sourceRetired = replayRetirements.get(response.body);\n  if (responseFormat === "openai.embeddings") qianfanOutcome.current.bind(operation, response, reader);');
    edit('        const next = await input.read(() => reader.read());',
      '        if (responseFormat === "openai.embeddings") qianfanOutcome.current.readStart(operation, reader);\n        const next = await input.read(() => reader.read());\n        if (responseFormat === "openai.embeddings") qianfanOutcome.current.readDone(operation, reader);');
    edit('      } catch (error) { if (!finished) { finish("failed", error); controller.error(error); } }',
      '      } catch (error) { if (responseFormat === "openai.embeddings") qianfanOutcome.current.failure(operation, reader, error); if (!finished) { finish("failed", error); controller.error(error); } }');
    edit('    resolve({ ...inspection, delivery,', '    qianfanOutcome.current.inspection(operation, inspection, delivery);\n    resolve({ ...inspection, delivery,');
    edit('    cancel(reason) { return finish("canceled", reason); },',
      '    cancel(reason) { const prior = qianfanOutcome.current.downstreamStart(operation, reason); try { return finish("canceled", reason); } finally { qianfanOutcome.current.downstreamEnd(operation, prior); } },');
  }
  return 'import { qianfanOutcome } from "qianfan-outcome-witness";\n' + text;
}
async function bundleQianfanOutcome(contents) {
  const require = createRequire(import.meta.resolve("wrangler/package.json")), { build } = require("esbuild");
  const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), sourcefile: "qianfan-fixture.ts", loader: "ts" },
    write: false, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
    plugins: [{ name: "qianfan-first-outcome", setup(build) {
      build.onResolve({ filter: /^qianfan-outcome-witness$/ }, () => ({ path: "witness", namespace: "qianfan" }));
      build.onLoad({ filter: /.*/, namespace: "qianfan" }, () => ({ contents: "export const qianfanOutcome = { current: undefined };", loader: "js" }));
      build.onLoad({ filter: /[/\\]worker[/\\](?:proxy|proxy-response|http-operation)\.ts$/ }, args => {
        const name = args.path.split(/[/\\]/).at(-1), source = readFileSync(args.path, "utf8");
        assert.equal(createHash("sha256").update(source).digest("hex"), workerOutcomePins[name]);
        return { contents: name !== "http-operation.ts" ? workerOutcomeOverlay(source, name) : source, loader: "ts" };
      });
    } }],
  });
  return bundle.outputFiles[0].text;
}
async function startQianfanWorkerd(temporary) {
  const { startBundledWorkerdFixture } = await import("./helpers/workerd.mjs");
  return startBundledWorkerdFixture(temporary, await bundleQianfanOutcome(routerFixture()), upstreamFixture());
}

test("Qianfan Worker first outcome binds the actual handler and retains secondary read rejection", async () => {
  const proxy = workerOutcomeOverlay(readFileSync(new URL("../worker/proxy.ts", import.meta.url), "utf8"), "proxy.ts");
  const inner = proxy.slice(proxy.indexOf("function ownOrdinaryResponse("), proxy.indexOf("\nasync function proxySelected("));
  const code = await bundleQianfanOutcome('import { HttpOperation, InternalHttpAbort } from "./worker/http-operation.ts"; import { inputRetirement } from "./worker/input-retirement.ts"; import { ProxyCompletion } from "./worker/proxy-completion.ts"; import { qianfanOutcome } from "qianfan-outcome-witness"; export { observeUsage } from "./worker/proxy-response.ts"; ' + inner + '; export { HttpOperation, InternalHttpAbort, ProxyCompletion, ownOrdinaryResponse, qianfanOutcome };');
  const { HttpOperation, InternalHttpAbort, ProxyCompletion, ownOrdinaryResponse, observeUsage, qianfanOutcome } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  const modes = ["caller", "downstream", "undefined_read", "foreign_reason", "prior_400", "revoked_400", "prior_500", "deadline", "upstream",
    "protocol", "early_read", "foreign_ingress", "foreign_outbound", "no_handler", "missing_source", "expired_source", "held_source", "failed_source",
    "duplicate_cancel", "cancel_failure", "closed_failure", "unlock_failure", "handler_failure", "waitUntil_failure", "observer_undefined", "native_unqualified"];
  for (const kind of ["chat", "memory"]) for (const mode of modes) {
    const incoming = createRequestBindings(), outgoing = createRequestBindings(), caller = new AbortController();
    const ingress = incoming.expect("qianfan_cancel", kind, "https://fixture.example/ingress", "POST", "fixture-in");
    incoming.claim(ingress.url, { method: "POST", headers: { authorization: "Bearer fixture-in" } }, kind);
    const owner = outgoing.expect("qianfan_cancel", kind, "https://fixture.example/outbound", "POST", "fixture-out");
    outgoing.claim(owner.url, { method: "POST", headers: { authorization: "Bearer fixture-out" } }, kind); owner.ingress = ingress;
    let sourceProof = { ownerId: "qianfan_cancel", claimed: true, cancelled: true, expired: false, cancelCalls: 1, cancelReturned: 1, pending: 0, failed: 0 };
    if (["missing_source", "native_unqualified"].includes(mode)) sourceProof = undefined;
    if (mode === "expired_source") sourceProof.expired = true;
    if (mode === "held_source") sourceProof.pending = 1;
    if (mode === "failed_source") sourceProof.failed = 1;
    const life = createLifetimeObserver(undefined, { source: () => sourceProof, outcome: op => witness.matches(op) });
    life.signal(ingress, caller.signal);
    const operation = new HttpOperation(caller.signal); life.signal(owner, operation.signal);
    const witness = createWorkerOutcomeWitness(life, incoming.bindings, outgoing.bindings, HttpOperation, kind); qianfanOutcome.current = witness;
    if (mode === "no_handler") witness.failure = () => {};
    if (mode === "foreign_ingress") owner.ingress = { ...ingress };
    if (mode === "foreign_outbound") life.signal(owner, new AbortController().signal);
    const read = deferred(), closed = deferred(), reason = mode === "undefined_read" ? undefined : new Error("secondary native read"), abort = new Error("caller intent");
    let reads = 0, cancelCalls = 0, unlocks = 0;
    const reader = {
      closed: closed.promise,
      read() {
        if (++reads === 1) return Promise.resolve({ done: false, value: new TextEncoder().encode(mode === "protocol"
          ? 'data: {"error":{"message":"synthetic"}}\n\n'
          : 'data: {"choices":[{"delta":{"content":"synthetic"},"finish_reason":null}]}\n\n') });
        return read.promise;
      },
      cancel() {
        cancelCalls++; read.reject(reason);
        if (mode === "closed_failure") closed.reject(undefined); else closed.resolve();
        return mode === "cancel_failure" ? Promise.reject(undefined) : Promise.resolve();
      },
      releaseLock() { unlocks++; if (mode === "unlock_failure") throw undefined; },
    };
    const response = new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    Object.defineProperty(response.body, "getReader", { configurable: true, value: () => reader });
    const fetched = Promise.resolve(response);
    assert.equal(life.invoke("fetch", () => fetched, null, [], owner, value => life.response(value, owner)), fetched); await fetched;
    const completion = new ProxyCompletion(), forwarded = kind === "memory" ? response : ownOrdinaryResponse(response, completion, operation);
    completion.seal(); if (kind === "chat") assert.notEqual(forwarded.body, response.body); else assert.equal(forwarded.body, response.body);
    const observed = observeUsage(forwarded, operation, undefined, kind === "memory" ? "openai.embeddings" : undefined), downstream = observed.response.body.getReader();
    await downstream.read(); const pending = downstream.read();
    const settled = Promise.allSettled([pending, observed.retired, observed.result, read.promise, closed.promise, completion.completion]);
    // Wait for the original shipping inputRetirement to start its second read.
    for (let i = 0; i < 10 && reads !== 2; i++) await Promise.resolve();
    assert.equal(reads, 2, mode);
    if (["prior_400", "revoked_400", "prior_500"].includes(mode)) operation.acceptRejection(mode === "prior_500" ? 500 : 400);
    if (mode === "revoked_400") operation.revokeRejection();
    if (mode === "early_read") { read.reject(reason); await Promise.allSettled([pending]); }
    if (mode === "deadline") operation.cancel(new InternalHttpAbort("deadline", "synthetic"));
    if (mode === "upstream") operation.stop("upstream", reason);
    if (mode === "observer_undefined") { const stamp = life.stamp; let once = true; life.stamp = () => { if (once) { once = false; throw undefined; } return stamp(); }; }
    if (mode === "caller") caller.abort(abort);
    else await Promise.allSettled([downstream.cancel(abort)]);
    if (mode === "duplicate_cancel") await reader.cancel();
    await settled;
    const result = await observed.result;
    const handler = mode === "handler_failure" ? Promise.reject(undefined) : Promise.resolve();
    const work = mode === "waitUntil_failure" ? Promise.reject(undefined) : Promise.resolve();
    life.watch("handler", handler, ingress); life.watch("waitUntil", work, ingress);
    const positive = ["caller", "downstream", "undefined_read", "foreign_reason"].includes(mode);
    try {
      if (positive) {
        await life.join(); assert.equal(operation.status, "client_error", mode); assert.equal(result.delivery, "canceled", mode);
        assert.equal(result.outcome, null, mode); assert.equal(cancelCalls, 1, mode); assert.equal(unlocks, 1, mode);
        assert.equal(life.summary().qualifiedReadRejections, 1, mode); assert.equal(life.summary().rejected, 1, mode);
        const rejected = life.operations.find(op => op.kind === "reader.read" && op.state === "rejected");
        assert.equal(rejected.pending, read.promise); assert.equal(rejected.reason, reason); assert.equal(witness.matches(rejected), true, mode);
        verifyRetirement({ ...life.summary(), accepted: true, settled: true, join: life.joinDiagnostic() }, "router");
      } else await assert.rejects(life.join(), AggregateError, mode);
    } finally { await life.restore(); downstream.releaseLock(); }
  }
});

test("Qianfan first-outcome hooks preserve original falsey throws and reject source drift", async () => {
  const original = readFileSync(new URL("../worker/proxy-response.ts", import.meta.url), "utf8");
  assert.throws(() => workerOutcomeOverlay(original + "\n"), assert.AssertionError);
  for (const value of [undefined, false, null]) {
    class Operation {
      get status() { return undefined; } get delivery() { return undefined; } get receivedRejection() { return false; }
      cancel() { throw value; } stop() { throw value; } acceptRejection() { throw value; }
    }
    const life = createLifetimeObserver(); createWorkerOutcomeWitness(life, [], [], Operation);
    const object = new Operation();
    for (const method of ["cancel", "stop", "acceptRejection"]) {
      let caught = false; try { object[method]("caller", value); } catch (error) { caught = true; assert.equal(error, value); }
      assert.equal(caught, true);
    }
    await life.restore();
  }
  assert.ok((await bundleQianfanOutcome(routerFixture())).length > 0);
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials } from "./worker/grant-credentials.ts";
import { HttpOperation } from "./worker/http-operation.ts";
import { qianfanOutcome } from "qianfan-outcome-witness";
${observerCode}
const ingress = createRequestBindings(), outbound = createRequestBindings();
let sourceCancellation, nativeAccepted = false;
const lifetime = createLifetimeObserver(undefined, { source: () => nativeAccepted ? sourceCancellation : undefined, outcome: op => qianfanOutcome.current.matches(op) });
qianfanOutcome.current = createWorkerOutcomeWitness(lifetime, ingress.bindings, outbound.bindings, HttpOperation);
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
const retirementSteps = observeRetirementSteps();
async function retirement() {
  try { await preserveFailures(async () => { await retirementSteps.observe(0, () => lifetime.join()); retirementSteps.observe(1, () => ingress.verify()); retirementSteps.observe(2, () => outbound.verify()); }, [() => retirementSteps.observe(3, () => lifetime.restore())]); accepted = true; } catch (error) { lifetime.errors.push(error); }
  const proof = lifetime.summary();
  return Response.json({ ...proof, settled: proof.operations === proof.settled, accepted, retirementChecks: retirementSteps.facts(), join: lifetime.joinDiagnostic() });
}
export default { ...handler, fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/grants") return (async () => {
    for (const id of ids) await putGrantCredentials(env, "oauth/" + id + "/qianfan", { provider: "qianfan", kind: "api_key", enabled: true, credential: "fixture-upstream-" + id });
    return new Response(null, { status: 204 });
  })();
  if (path === "/fixture/retirement") return (async () => {
    if (request.method === "POST") { const proof = await request.json(); sourceCancellation = proof.sourceCancellation; nativeAccepted = proof.nativeAccepted === true; }
    return retirement();
  })();
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
const lifetime = createLifetimeObserver(), calls = [], callOwners = new Map(), retirementSteps = observeRetirementSteps();
const bindings = createRequestBindings();
for (const id of ${JSON.stringify(charged)}) bindings.expect(id, "chat", ${JSON.stringify(provider.base_urls.default.replace(/\/$/, "") + endpoint.path)}, "POST", "fixture-upstream-" + id);
for (const id of ["qianfan_catalog", "qianfan_empty"]) bindings.expect(id, "catalog", ${JSON.stringify(provider.base_urls.default + "/models")}, "GET", "fixture-upstream-" + id);
export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    if (request.url === "https://fixture.example/retirement") {
      let accepted = false;
      try { await preserveFailures(async () => { await retirementSteps.observe(0, () => lifetime.join()); retirementSteps.observe(1, () => bindings.verify()); }, [() => retirementSteps.observe(3, () => lifetime.restore())]); accepted = true; } catch (error) { lifetime.errors.push(error); }
      const owner = bindings.bindings.find(row => row.id === "qianfan_cancel" && row.kind === "chat"), call = callOwners.get(owner);
      const owned = lifetime.operations.filter(op => op.owner === owner), cancels = owned.filter(op => op.kind === "source.cancel");
      const sourceCancellation = { ownerId: owner?.id, claimed: owner?.claimed === true, cancelled: call?.cancelled === true, expired: call?.fixtureExpired === true,
        cancelCalls: cancels.length, cancelReturned: cancels.filter(op => op.state === "fulfilled").length,
        pending: owned.filter(op => op.state === "pending").length, failed: owned.filter(op => !["pending", "fulfilled"].includes(op.state)).length };
      const proof = lifetime.summary(); return Response.json({ ...proof, settled: proof.operations === proof.settled, accepted, sourceCancellation, retirementChecks: retirementSteps.facts(), join: lifetime.joinDiagnostic() });
    }
    const owner = bindings.claim(request, undefined, request.method === "GET" ? "catalog" : "chat"); lifetime.signal(owner, request.signal);
    const body = request.method === "POST" ? await request.json() : null;
    const call = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body }; calls.push(call); callOwners.set(owner, call);
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

test("Qianfan actual replay callback scopes the captured provider and preserves asynchronous outcomes", async () => {
  const code = stripTypeScriptTypes(sdkText);
  const anchor = 'withOpenClawTestState({ label: "qianfan-worker" }, async state => {';
  const begin = code.indexOf(anchor), end = code.indexOf('\n  });\n  const context', begin);
  assert.ok(begin >= 0 && end > begin);
  const factory = new Function("resolveTranscriptPolicy", "expect", "createEmptyPluginRegistry", "withPluginRuntimeGenerationRegistryScope",
    "sanitizeSessionHistory", "makeInMemorySessionManager", "makeModelSnapshotEntry", "models", "modelId", "model", "provider", "config", "id", "history",
    "return async state => {" + code.slice(begin + anchor.length, end) + "};");
  // Inert sanitizer and scope boundary: this verifies the actual fixture callback,
  // not SDK/native behavior. Native ALS exercises concurrent suspension/restoration.
  const storage = new AsyncLocalStorage(), registries = [], foreign = { id: "qianfan" };
  const outer = { providers: [{ pluginId: "qianfan", provider: foreign, source: "test" }] };
  for (const fail of [false, true]) for (const reason of [undefined, false, new Error("synthetic")]) {
    await storage.run(outer, async () => {
      await Promise.all([0, 1].map(async index => {
        const selected = { id: "qianfan" }, modelId = models[index], model = { provider: "qianfan", api: "openai-completions" };
        const config = {}, history = [], policy = { dropReasoningFromHistory: index === 1 }, result = [];
        const state = { workspaceDir: "/fixture/workspace" }; let registry, pending, calls = 0, scopedResult;
        const invoke = factory(params => {
          assert.equal(params.runtimeHandle.plugin, selected); assert.equal(params.model, model); return policy;
        }, value => ({ toBe: expected => assert.equal(value, expected) }), () => {
          registry = { providers: [] }; registries.push(registry); return registry;
        }, (owned, run) => {
          assert.equal(owned, registry); scopedResult = storage.run(owned, run); assert.equal(scopedResult, pending); return scopedResult;
        }, params => {
          calls++; assert.equal(storage.getStore(), registry);
          assert.deepEqual(registry.providers, [{ pluginId: "qianfan", provider: selected, source: "test" }]);
          assert.notEqual(registry.providers[0].provider, foreign);
          assert.equal(params.model, model); assert.equal(params.policy, policy); assert.equal(params.config, config);
          assert.equal(params.messages, history); assert.equal(params.workspaceDir, state.workspaceDir);
          assert.equal(params.sessionId, "qianfan-case" + index);
          pending = Promise.resolve().then(async () => {
            assert.equal(storage.getStore(), registry);
            await storage.run({ providers: [] }, async () => { assert.deepEqual(storage.getStore().providers, []); });
            assert.equal(storage.getStore(), registry);
            if (fail) throw reason;
            return result;
          }); return pending;
        }, entries => ({ entries }), value => value, models, modelId, model, selected, config, "case" + index, history);
        let failed = false, value;
        try { value = await invoke(state); } catch (error) { failed = true; value = error; }
        assert.equal(failed, fail); assert.equal(value, fail ? reason : result); assert.equal(calls, 1);
        assert.equal(storage.getStore(), outer);
      }));
      assert.equal(storage.getStore(), outer);
    });
  }
  assert.equal(new Set(registries).size, registries.length); assert.equal(storage.getStore(), undefined);
});

test("Qianfan controlled SDK error disposition binds callback output, owned signal and original reader", async () => {
  for (const mode of ["owned", "foreign_context", "foreign_reader", "wrong_prototype", "wrong_payload", "wrong_result", "missing_callback", "duplicate_callback", "same_parser_reason", "undefined_reason", "wrong_signal_reason", "late_abort", "release_failure", "body_failure", "observer_undefined"]) {
    const binding = createRequestBindings(), owner = binding.expect("error", "chat", "https://fixture.example/chat", "POST", "fixture-error");
    binding.claim(owner.url, { method: "POST", headers: { authorization: "Bearer fixture-error" } }, "chat");
    const prototype = {}, payload = { message: "synthetic-upstream-error", code: "server_error" };
    const parserError = Object.assign(Object.create(mode === "wrong_prototype" ? {} : prototype), {
      status: undefined, message: payload.message, code: payload.code, error: mode === "wrong_payload" ? { ...payload, extra: true } : payload,
    });
    const controller = new AbortController(), abortReason = mode === "same_parser_reason" ? parserError : new Error("private SDK abort");
    const rejectedReason = mode === "undefined_reason" ? undefined : mode === "wrong_signal_reason" ? new Error("independent source error") : abortReason;
    const life = createLifetimeObserver({ bindings: binding.bindings, bodySucceeded: () => mode !== "body_failure",
      current: () => { if (mode === "observer_undefined") throw undefined; return mode === "foreign_context" ? {} : owner; },
      apiPrototype: prototype, isProxy: nodeTypes.isProxy });
    life.signal(owner, controller.signal);
    let source; const response = new Response(new ReadableStream({ start(value) { source = value; } }, { highWaterMark: 0 }));
    const release = () => mode === "release_failure" ? Promise.reject(undefined) : Promise.resolve();
    const result = { response, release }, acquired = Promise.resolve(result);
    assert.equal(life.guard(() => acquired, undefined, [], owner), acquired); await acquired;
    const reader = response.body.getReader(), closed = reader.closed, reading = reader.read();
    if (mode !== "late_abort") controller.abort(abortReason);
    source.error(rejectedReason); const cancelling = reader.cancel(); reader.releaseLock();
    await Promise.allSettled([closed, reading, cancelling]);
    if (mode === "late_abort") controller.abort(abortReason);
    const output = { stopReason: "error", errorMessage: payload.message }, params = { error: parserError, output, signal: undefined };
    if (mode !== "missing_callback") life.providerError(params);
    if (mode === "duplicate_callback") life.providerError(params);
    life.providerResult(mode === "wrong_result" ? { ...output } : output);
    if (mode === "foreign_reader") life.operations.find(op => op.kind === "reader.read").owner = {};
    await Promise.allSettled([result.release()]);
    if (mode === "owned") await life.join();
    else await assert.rejects(life.join(), error => {
      assert.ok(error.errors.length > 0);
      if (["undefined_reason", "release_failure", "observer_undefined"].includes(mode)) assert.ok(error.errors.includes(undefined));
      return true;
    });
    const originals = life.operations.filter(op => ["reader.closed", "reader.read", "reader.cancel"].includes(op.kind));
    assert.equal(originals.length, 3); assert.ok(originals.every(op => op.state === "rejected" && op.reason === rejectedReason));
    assert.equal(originals.find(op => op.kind === "reader.closed").pending, closed);
    assert.equal(originals.find(op => op.kind === "reader.read").pending, reading);
    assert.equal(originals.find(op => op.kind === "reader.cancel").pending, cancelling);
    assert.equal(life.summary().rejected >= 3, true); await life.restore();
  }
});

test("Qianfan actual SDK failure hook preserves receiver operands and falsey original outcomes", () => {
  const code = stripTypeScriptTypes(sdkText);
  const start = code.indexOf('vi.spyOn(transportStream, "failTransportStream")');
  const end = code.indexOf('    vi.spyOn(guardedTransport', start);
  assert.ok(start >= 0 && end > start);
  const install = new Function("vi", "transportStream", "lifetime", "originalSdkFailure", code.slice(start, end));
  for (const throws of [false, true]) for (const reason of [undefined, false, {}]) {
    const bindings = createRequestBindings(), owner = bindings.expect("error", "chat", "https://fixture.example/chat", "POST", "fixture");
    bindings.claim(owner.url, { method: "POST", headers: { authorization: "Bearer fixture" } }, "chat");
    const life = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => true, current: () => { throw undefined; } });
    const target = {}, receiver = {}, args = [{ error: reason, output: {}, signal: undefined }, 17];
    let wrapper, calls = 0;
    install({ spyOn(object, key) { assert.equal(object, target); assert.equal(key, "failTransportStream"); return { mockImplementation(fn) { wrapper = fn; } }; } },
      target, life, function (...received) { calls++; assert.equal(this, receiver); assert.deepEqual(received, args); if (throws) throw reason; return reason; });
    let caught = false, value;
    try { value = Reflect.apply(wrapper, receiver, args); } catch (error) { caught = true; value = error; }
    assert.equal(caught, throws); assert.equal(value, reason); assert.equal(calls, 1);
    assert.deepEqual(life.errors, [undefined], "observer fault remains independent without replacing the original callback");
  }
});

test("Qianfan Worker read errors remain fatal despite later successful sibling cancellation", async () => {
  for (const reason of [undefined, new Error("independent read failure")]) {
    const life = createLifetimeObserver(), owner = {}, reading = deferred(), closed = deferred();
    const body = { locked: false, cancel() { return Promise.resolve(); }, getReader() { this.locked = true; return reader; } };
    const reader = { closed: closed.promise, read() { return reading.promise; }, cancel() { closed.resolve(); return Promise.resolve(); }, releaseLock() { body.locked = false; } };
    life.response({ body }, owner); const captured = body.getReader(), originalRead = captured.read();
    // The rejection is queued first; its reaction is observed after cancel entry.
    reading.reject(reason); const originalCancel = captured.cancel();
    await Promise.allSettled([originalRead, originalCancel, captured.closed]); captured.releaseLock();
    await assert.rejects(life.join(), error => error.errors.length === 1 && error.errors[0] === reason);
    assert.equal(life.operations.find(op => op.kind === "reader.read").pending, originalRead);
    assert.equal(life.summary().rejected, 1); await life.restore();
  }
});
