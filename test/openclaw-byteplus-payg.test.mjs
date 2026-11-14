import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify, types as nodeTypes } from "node:util";
import snapshot from "../worker/generated/provider-snapshot.json" with { type: "json" };
import { runOpenClawConsumer } from "./helpers/openclaw-consumer.mjs";

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const models = ["dola-seed-2-1-turbo-260628", "seed-2-0-code-preview-260328", "glm-5-2-260617", "deepseek-v4-pro-260425", "deepseek-v4-flash-260425"];
const closed = ["glm-4-7-251222"];
const cards = Object.fromEntries(models.flatMap((model, i) => [[`m${i}_stream`, model], [`m${i}_simple`, model]]));
Object.assign(cards, { roundtrip: "deepseek-v4-pro-260425", no_usage: models[0], http_error: models[0], embedded_error: models[0], cancel: models[0] });
const dispatched = Object.keys(cards), ids = [...dispatched, "foreign", "missing", "unpriced", "revoked", "aborted", ...closed.map((_, i) => `closed${i}`)];
const key = id => `clawrouter-live-byte_${id}-fixture-secret`;
test("registered ClawRouter catalog routes BytePlus PAYG turns with original grants and SQLite accounting", { skip: !source, timeout: 300_000 }, async t => {
  const provider = snapshot.providers.find(p => p.id === "byteplus");
  assert.deepEqual(provider.models.filter(m => m.capabilities.includes("llm.chat")).map(m => m.upstream), models);
  assert.ok(provider.models.every(m => m.pricing === null));
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-byteplus-client-"));
  const { startWorkerdFixture } = await import("./helpers/workerd.mjs"); let mf, origin;
  const failures = [];
  try {
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(), { directRouter: true });
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    for (const id of ids) {
      const model = id.startsWith("closed") ? closed[Number(id.slice(6))] : cards[id] ?? models[0];
      await kv.put(`policies/byte_${id}`, JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture", providers: [id === "foreign" ? "volcengine" : "byteplus"], models: [`byteplus/${model}`],
        grantRouting: { eligibleGrants: { byteplus: ["byteplus"] }, environmentFallback: false }, monthlyBudgetMicros: 100, requestCostMicros: id === "unpriced" ? null : 7, budgetMode: "reserve", retainRequestContent: false }));
      await kv.put(`credentials/byte_${id}`, JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: `byte_${id}`, policyGeneration: "fixture" }));
    }
    await kv.put("connections/byteplus", JSON.stringify({ providerId: "byteplus", enabled: true }));
    origin = (await mf.unsafeGetDirectURL("router")).origin;
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    await runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-byteplus-payg-contract.test.ts", import.meta.url),
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, BYTEPLUS_API_KEY: "must-not-fallback", VOLCANO_ENGINE_API_KEY: "must-not-fallback", VOLCENGINE_PLAN_API_KEY: "must-not-fallback", BYTEPLUS_PLAN_API_KEY: "must-not-fallback", ARK_API_KEY: "must-not-fallback" } });
    // The actual client omits closed rows. Separately prove its raw Worker
    // denial rather than inventing an executable client catalog entry.
    for (const [i, model] of closed.entries()) {
      const response = await fetch(origin + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key(`closed${i}`)}`, "content-type": "application/json" }, body: JSON.stringify({ model: `byteplus/${model}`, messages: [] }) });
      assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "model_capability_unsupported");
    }
    const retirement = await fetch(origin + "/fixture/retire", { method: "POST" });
    assert.equal(retirement.status, 200);
    const joined = await retirement.json();
    const observation = await (await fetch(origin + "/fixture/state")).json();
    assert.equal(joined.requests, observation.catalog.length + observation.incoming.length);
    assert.equal(joined.inputs.length, dispatched.length + 1);
    for (const input of joined.inputs) {
      assert.equal(input.joined, true); assert.equal(input.locked, false);
      assert.ok(input.readers.length > 0);
      assert.ok(input.readers.every(reader => reader.unlocked && reader.pendingSettled));
    }
    assert.ok(observation.catalog.length >= dispatched.length, "catalog HTTP is counted separately from inference");
    assert.ok(observation.catalog.every(c => c.proxyKey && c.path === "/v1/catalog"));
    assert.ok(observation.incoming.every(c => c.proxyKey && c.path === "/v1/chat/completions"));
    for (const [id, status, code] of [["foreign", 403, "provider_not_allowed"], ["missing", 503, "upstream_grant_pool_unavailable"], ["unpriced", 400, "pricing_required"], ["revoked", 503, "upstream_grant_pool_unavailable"]]) {
      assert.deepEqual(observation.denials.filter(row => row.id === id).map(({ status, code }) => ({ status, code })), [{ status, code }], id);
    }
    const upstream = await mf.getWorker("upstream"); let calls;
    for (let n = 0; n < 150; n++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      const call = calls.find(c => c.id === "cancel"); if (call?.cancelled || call?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const cancelled = calls.find(c => c.id === "cancel");
    assert.ok(cancelled?.cancelled || cancelled?.aborted, "actual post-header cancellation must reach upstream transport");
    assert.notEqual(cancelled.fixtureExpired, true, "fixture expiry is not caller cancellation");
    assert.equal(calls.length, dispatched.length + 1, "one POST per turn; two explicit tool turns; no denied egress or retry");
    for (const id of dispatched) {
      const expected = id === "roundtrip" ? 2 : 1, matching = calls.filter(c => c.id === id); assert.equal(matching.length, expected, id);
      const incoming = observation.incoming.filter(c => c.id === id); assert.equal(incoming.length, expected, id);
      for (const c of incoming) assert.equal(c.model, `byteplus/${cards[id]}`);
      for (const call of matching) {
        assert.equal(call.url, "https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions"); assert.equal(call.authorization, `Bearer fixture-upstream-${id}`);
        assert.equal(call.apiKey, null); assert.equal(call.xApiKey, null); assert.equal(call.body.model, cards[id]); assert.equal(call.body.stream, true);
        assert.equal(call.body.max_tokens ?? call.body.max_completion_tokens, 128);
        assert.doesNotMatch(JSON.stringify(call), /clawrouter-live-|must-not-fallback|fixture-foreign/);
      }
      if (id === "roundtrip") {
        const [first, second] = matching;
        assert.ok(!first.body.messages.some(m => m.role === "tool"));
        assert.equal(first.body.tools[0].function.name, "lookup");
        // The registered generic replay policy normalizes both paired IDs.
        assert.ok(second.body.messages.some(m => m.role === "tool" && m.tool_call_id === "callfixture" && m.content === "synthetic-tool-result"));
        assert.ok(second.body.messages.some(m => m.reasoning_content === "synthetic-reasoning"));
        const replayCall = second.body.messages.flatMap(m => m.tool_calls ?? []);
        assert.deepEqual(replayCall, [{ id: "callfixture", type: "function", function: { name: "lookup", arguments: '{"value":"fixture"}' } }]);
      }
      let usage;
      for (let n = 0; n < 150; n++) {
        usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer ${key(id)}` } })).json();
        if (usage.usage.events.length === expected) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(usage.usage.events.length, expected, id); const rejected = ["http_error", "embedded_error"].includes(id);
      assert.equal(usage.budget.spentMicros, rejected ? 0 : 7 * expected, id);
      for (const event of usage.usage.events) {
        assert.equal(event.provider, "byteplus"); assert.equal(event.model, `byteplus/${cards[id]}`); assert.equal(event.credential_id, `byte_${id}`);
        assert.equal(event.status, id === "http_error" || id === "cancel" ? "client_error" : id === "embedded_error" ? "provider_error" : "success", id);
        assert.equal(event.actual_cost_micros, rejected ? 0 : 7); assert.equal(event.cost_basis, rejected ? "none" : "policy_fixed");
        assert.deepEqual([event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens], rejected || ["cancel", "no_usage"].includes(id) ? [null, null, null, null] : [100, 20, 120, 40], id);
      }
      assert.doesNotMatch(JSON.stringify(usage), /fixture-upstream|synthetic-reasoning|synthetic-tool-result|synthetic-answer/);
    }
  } catch (error) { failures.push(error); }
  finally {
    if (mf && origin) {
      try {
        const response = await fetch(origin + "/fixture/retire", { method: "POST" });
        assert.equal(response.status, 200); await response.json();
      } catch (error) { failures.push(error); }
    }
    if (mf && origin) {
      try { const records = await retrieveWorkerEvidence(origin); if (failures.length) emitWorkerEvidence(records); }
      catch (error) { failures.push(error); }
    }
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "BytePlus contract or retirement failed");
});
function observeReaderOperation(operations, kind, pending, signals) {
  const operation = { kind, pending, expectedAbort: false }; operations.push(operation);
  void pending.then(() => {}, reason => {
    operation.expectedAbort = kind === "read" && reason !== undefined && signals.some(signal => signal?.aborted && signal.reason === reason);
  });
  return pending;
}
async function joinReaderOperations(operations) {
  const results = await Promise.allSettled(operations.map(operation => operation.pending));
  const failures = results.flatMap((result, index) => result.status === "rejected" && !operations[index].expectedAbort ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "original reader operations failed");
}

// Exercise the same functions embedded in the Worker and the actual TS fixture.
// This is observer coverage, not execution of the native OpenClaw SDK.
async function readerObservers() {
  const text = await readFile(new URL("./fixtures/openclaw-byteplus-payg-contract.test.ts", import.meta.url), "utf8");
  const start = text.indexOf("type ReaderOperation = "), end = text.indexOf("\nfunction observe(kind:", start);
  assert.ok(start >= 0 && end > start);
  const code = stripTypeScriptTypes(text.slice(start, end));
  const sdk = new Function(code + "; return { observeReaderOperation, joinReaderOperations, readerWitness, acceptStoredSdkCancel };")();
  return [["Worker", { observeReaderOperation, joinReaderOperations }], ["SDK fixture", sdk]];
}

test("retirement observers retain rejecting cancellation and body failures until every original operation joins", async t => {
  for (const [name, observer] of await readerObservers()) await t.test(name, async () => {
    const operations = [], bodyFailure = new Error("body read failed"), cancellationFailure = new Error("cancel failed");
    let body, rejectCancel;
    const broken = new ReadableStream({ start(controller) { body = controller; } }).getReader();
    const reading = broken.read();
    assert.equal(observer.observeReaderOperation(operations, "read", reading, []), reading);
    body.error(bodyFailure);
    const canceled = new ReadableStream({ cancel() { return new Promise((_, reject) => { rejectCancel = reject; }); } }).getReader();
    const cancellation = canceled.cancel();
    assert.equal(observer.observeReaderOperation(operations, "cancel", cancellation, []), cancellation);
    const joined = observer.joinReaderOperations(operations);
    let settled = false; void joined.then(() => { settled = true; }, () => { settled = true; });
    try {
      await reading.catch(() => {}); await Promise.resolve();
      assert.equal(settled, false, "body failure must not bypass a still-owned cancellation");
      rejectCancel(cancellationFailure);
      await assert.rejects(joined, error => error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === bodyFailure && error.errors[1] === cancellationFailure);
    } finally {
      rejectCancel(cancellationFailure);
      await Promise.allSettled([reading, cancellation, joined]);
      broken.releaseLock(); canceled.releaseLock();
    }
  });
});
test("retirement observers accept only exact owned read aborts and never cancellation rejection", async t => {
  for (const [name, observer] of await readerObservers()) await t.test(name, async () => {
    const controller = new AbortController(), reason = new Error("owned abort"), foreign = new Error("owned abort");
    const operations = []; controller.abort(reason);
    for (const [kind, value] of [["read", reason], ["read", foreign], ["cancel", reason], ["cancel", undefined]]) {
      const pending = Promise.reject(value);
      assert.equal(observer.observeReaderOperation(operations, kind, pending, [controller.signal]), pending);
    }
    await assert.rejects(observer.joinReaderOperations(operations), error => error instanceof AggregateError && error.errors.length === 3 && error.errors[0] === foreign && error.errors[1] === reason && error.errors[2] === undefined);
    const late = new AbortController(), lateOperations = [];
    observer.observeReaderOperation(lateOperations, "read", Promise.reject(reason), [late.signal]);
    await Promise.resolve(); late.abort(reason);
    await assert.rejects(observer.joinReaderOperations(lateOperations), error => error.errors[0] === reason);
  });
});

async function sdkRetirementHarness(rows, options = {}) {
  const text = await readFile(new URL("./fixtures/openclaw-byteplus-payg-contract.test.ts", import.meta.url), "utf8");
  const helpers = (await readerObservers())[1][1];
  const begin = text.indexOf("afterEach(async () => {"), end = text.indexOf("\nasync function selected(", begin);
  let cleanup;
  const expect = value => ({ toBe(v) { assert.equal(value, v); }, toEqual(v) { assert.deepEqual(value, v); },
    toHaveLength(n) { assert.equal(value.length, n); }, toBeGreaterThan(n) { assert.ok(value > n); } });
  const code = stripTypeScriptTypes(text.slice(begin, end));
  new Function("afterEach", "acquisitions", "closeOperations", "dispatchers", "observationErrors", "bodyPassed", "catalogCalls", "chatCalls", "expectedChatCalls", "negativeCase", "joinReaderOperations", "acceptStoredSdkCancel", "vi", "clearLiveCatalogCacheForTests", "expect", code)(
    fn => { cleanup = fn; }, rows, options.closeOperations ?? [Promise.resolve()], options.dispatchers ?? new Set([{ closed: true }]), options.observationErrors ?? [], options.bodyPassed !== false,
    1, rows.length - 1, rows.length - 1, Object.hasOwn(options, "scenario") ? options.scenario : "embedded_error", helpers.joinReaderOperations, helpers.acceptStoredSdkCancel,
    { restoreAllMocks() {} }, () => {}, expect);
  return cleanup;
}
async function nativeStoredReader(options = {}) {
  const helpers = (await readerObservers())[1][1], guard = new AbortController(), caller = new AbortController();
  const reason = options.undefinedReason ? undefined : new Error("fixed stored error"), foreign = new Error("fixed stored error");
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; }, cancel() { if (options.underlyingFailure) throw reason; } });
  const reader = body.getReader(), witness = helpers.readerWitness(reader, guard.signal, caller.signal), operations = [];
  if (!options.lateAbort) { guard.abort(options.foreign ? foreign : reason); if (!options.noCaller) caller.abort(reason); }
  const reading = witness.invoke("read", reader.read, reader, []);
  helpers.observeReaderOperation(operations, "read", reading.pending, [guard.signal]);
  if (options.unlockBefore) { witness.unlocking(); reader.releaseLock(); witness.unlocked(); }
  if (!options.underlyingFailure) controller.error(reason);
  const canceled = witness.invoke("cancel", reader.cancel, reader, []);
  helpers.observeReaderOperation(operations, "cancel", canceled.pending, [guard.signal]);
  if (!options.missingWitness) operations.at(-1).storedError = canceled.storedError;
  if (!options.unlockBefore && !options.locked) { witness.unlocking(); reader.releaseLock(); witness.unlocked(); }
  await Promise.allSettled([reading.pending, canceled.pending]);
  if (options.lateAbort) { guard.abort(reason); caller.abort(reason); }
  const release = options.releaseFailure ? Promise.reject(options.releaseFailure) : Promise.resolve();
  void release.catch(() => {});
  const row = { kind: "chat", returned: Promise.resolve(), released: Promise.resolve(), releaseCalls: 1, releases: [release], body,
    readers: [{ pending: operations, unlocked: !options.locked, witness }] };
  // A real catalog body and release join remain separate from the Chat request.
  const catalogBody = new ReadableStream({ start(c) { c.close(); } }), catalogReader = catalogBody.getReader();
  const catalogWitness = helpers.readerWitness(catalogReader), catalogRead = catalogWitness.invoke("read", catalogReader.read, catalogReader, []), catalogOps = [];
  helpers.observeReaderOperation(catalogOps, "read", catalogRead.pending, []); await catalogRead.pending;
  catalogWitness.unlocking(); catalogReader.releaseLock(); catalogWitness.unlocked();
  const catalog = { kind: "catalog", returned: Promise.resolve(), released: Promise.resolve(), releaseCalls: 1, releases: [Promise.resolve()], body: catalogBody,
    readers: [{ pending: catalogOps, unlocked: true, witness: catalogWitness }] };
  return { row, catalog, reason, reader, witness, operations, helpers, finish() { if (body.locked) reader.releaseLock(); } };
}

test("SDK stored-error classification uses real original native identities after every retirement join", async t => {
  for (const scenario of ["embedded_error", "cancel"]) await t.test(scenario, async () => {
    const actual = await nativeStoredReader();
    try { await (await sdkRetirementHarness([actual.catalog, actual.row], { scenario }))(); }
    finally { actual.finish(); }
  });
  for (const [name, options] of Object.entries({ foreign: { foreign: true }, undefined: { undefinedReason: true }, missing: { missingWitness: true },
    late: { lateAbort: true }, unlocked: { unlockBefore: true }, locked: { locked: true }, underlying: { underlyingFailure: true },
    primary: { bodyPassed: false }, release: { releaseFailure: new Error("release") }, caller: { noCaller: true, scenario: "cancel" },
    wrongCase: { scenario: null }, observerUndefined: { observationErrors: [undefined] } })) await t.test(name, async () => {
    const actual = await nativeStoredReader(options);
    try { await assert.rejects((await sdkRetirementHarness([actual.catalog, actual.row], options))(), AggregateError); }
    finally { actual.finish(); }
  });
});
test("SDK cancellation never qualifies synchronous failure, foreign ownership, or pending original retirement", async () => {
  const actual = await nativeStoredReader();
  let finishRelease, finishOperation;
  const release = new Promise(resolve => { finishRelease = resolve; }), pending = new Promise(resolve => { finishOperation = resolve; });
  actual.row.released = release; actual.row.releases = [release];
  actual.helpers.observeReaderOperation(actual.operations, "read", pending, []);
  const cleanup = await sdkRetirementHarness([actual.catalog, actual.row]); let ended = false;
  const joined = cleanup(); void joined.then(() => { ended = true; }, () => { ended = true; });
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
    finishRelease(); await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
    finishOperation(); await joined;
    assert.throws(() => actual.witness.invoke("cancel", () => { throw actual.reason; }, actual.reader, []), error => error === actual.reason);
    assert.equal(actual.witness.retired(), false);
    assert.equal(actual.helpers.acceptStoredSdkCancel("catalog", "embedded_error", actual.operations[1], actual.reason, true), false);
    assert.equal(actual.helpers.acceptStoredSdkCancel("chat", "embedded_error", { kind: "cancel", pending: actual.operations[1].pending }, actual.reason, true), false);
  } finally { finishRelease(); finishOperation(); await Promise.allSettled([joined]); actual.finish(); }
});
test("SDK retirement retains unrelated reads and dispatcher failures including undefined", async () => {
  const actual = await nativeStoredReader();
  const unrelated = new Error("unrelated read"), rejected = Promise.reject(undefined); void rejected.catch(() => {});
  actual.helpers.observeReaderOperation(actual.operations, "read", Promise.reject(unrelated), []);
  try {
    await assert.rejects((await sdkRetirementHarness([actual.catalog, actual.row], { closeOperations: [rejected], dispatchers: new Set([{ closed: true }]) }))(), error =>
      error instanceof AggregateError && error.errors.includes(undefined) && error.errors.some(value => value instanceof AggregateError && value.errors.includes(unrelated)));
  } finally { actual.finish(); }
});

// Worker-only evidence. No exception strings or diagnostic values authorize a
// verdict; the original joinReaderOperations classifier remains unchanged.
function workerEvidenceProtocol(isProxy) {
  const numeric = ["input", "reader", "op", "invokeSeq", "settleSeq", "closedSeq", "readSeq", "unlockBefore", "unlockCalls", "unlockReturns", "unlockInvokeSeq", "unlockReturnSeq", "operations", "settled", "suppressed"];
  const boolean = ["reasonDefined", "closedReasonDefined", "readReasonDefined", "operandPresent", "operandDefined", "signalAborted", "signalReasonDefined", "settleSignalAborted", "settleSignalReasonDefined", "sameClosed", "sameRead", "sameOperand", "sameSignal", "operandSameRead", "operandSameSignal", "allSettled", "bodyLocked", "joinAccepted"];
  const enums = { signalScope: ["fetch_input"], site: ["read_join", "cancel_join", "suppressed"], kind: ["read", "cancel", "none"], state: ["pending", "fulfilled", "rejected", "sync_throw"], closedState: ["pending", "fulfilled", "rejected"] };
  function validate(value) {
    try {
      if (!value || typeof value !== "object" || isProxy?.(value)) return null;
      const out = {}, keys = Reflect.ownKeys(value); if (keys.length < 4 || keys.length > 48) return null;
      for (const key of keys) {
        const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !Object.hasOwn(d, "value")) return null;
        const v = d.value;
        if (key === "v" ? v !== 1 : numeric.includes(key) ? !(Number.isInteger(v) && v >= 0 && v <= 1_000_000) : boolean.includes(key) ? typeof v !== "boolean" : !enums[key]?.includes(v)) return null;
        out[key] = v;
      }
      if (out.v !== 1 || !out.site || !out.kind || !out.state) return null;
      return new TextEncoder().encode(JSON.stringify(out)).byteLength <= 2048 ? out : null;
    } catch { return null; }
  }
  const records = []; let suppressed = 0;
  return { validate, add(value) { const row = validate(value); if (!row) return false; if (records.length < 63) records.push(row); else suppressed = Math.min(1_000_000, suppressed + 1); return true; },
    values() { return suppressed ? [...records, { v: 1, site: "suppressed", kind: "none", state: "fulfilled", suppressed }] : [...records]; } };
}
function workerReaderEvidence(reader, input, index, signal) {
  let seq = 0, unlockCalls = 0, unlockReturns = 0, unlockInvokeSeq = 0, unlockReturnSeq = 0;
  let closedState = "pending", closedReason, closedSeq = 0, readReason, readSeq = 0;
  const operations = [], closed = reader.closed;
  void closed.then(() => { closedState = "fulfilled"; closedSeq = ++seq; }, reason => { closedState = "rejected"; closedReason = reason; closedSeq = ++seq; });
  const snapshot = () => ({ aborted: signal?.aborted === true, reason: signal?.reason });
  return {
    invoke(kind, original, receiver, args) {
      const op = { kind, state: "pending", op: operations.length + 1, invokeSeq: ++seq, settleSeq: 0, unlockBefore: unlockCalls, operandPresent: args.length > 0, operand: args[0], signal: snapshot(), reason: undefined };
      operations.push(op);
      let pending;
      try { pending = Reflect.apply(original, receiver, args); } catch (reason) { op.state = "sync_throw"; op.reason = reason; op.settleSeq = ++seq; op.settleSignal = snapshot(); throw reason; }
      void pending.then(() => { op.state = "fulfilled"; op.settleSeq = ++seq; op.settleSignal = snapshot(); }, reason => {
        op.state = "rejected"; op.reason = reason; op.settleSeq = ++seq; op.settleSignal = snapshot(); if (kind === "read") { readReason = reason; readSeq = op.settleSeq; }
      });
      return pending;
    },
    unlocking() { unlockCalls++; unlockInvokeSeq = ++seq; }, unlocked() { unlockReturns++; unlockReturnSeq = ++seq; },
    records(body) {
      const definedSame = (a, b) => a !== undefined && b !== undefined && a === b;
      return operations.filter(op => op.state === "rejected" || op.state === "sync_throw" || op.kind === "cancel").map(op => ({
        v: 1, signalScope: "fetch_input", site: op.kind === "cancel" ? "cancel_join" : "read_join", input, reader: index, op: op.op, kind: op.kind, state: op.state,
        invokeSeq: op.invokeSeq, settleSeq: op.settleSeq, closedState, closedSeq, readSeq, unlockBefore: op.unlockBefore,
        unlockCalls, unlockReturns, unlockInvokeSeq, unlockReturnSeq, operations: operations.length, settled: operations.filter(p => p.state !== "pending").length,
        reasonDefined: op.reason !== undefined, closedReasonDefined: closedReason !== undefined, readReasonDefined: readReason !== undefined,
        operandPresent: op.operandPresent, operandDefined: op.operand !== undefined,
        signalAborted: op.signal.aborted, signalReasonDefined: op.signal.reason !== undefined,
        settleSignalAborted: op.settleSignal?.aborted === true, settleSignalReasonDefined: op.settleSignal?.reason !== undefined,
        sameClosed: definedSame(op.reason, closedReason), sameRead: definedSame(op.reason, readReason), sameOperand: definedSame(op.reason, op.operand),
        sameSignal: definedSame(op.reason, op.settleSignal?.reason), operandSameRead: definedSame(op.operand, readReason), operandSameSignal: definedSame(op.operand, op.signal.reason),
        allSettled: operations.every(p => p.state !== "pending"), bodyLocked: body.locked, joinAccepted: false,
      }));
    },
  };
}
const workerEvidence = workerEvidenceProtocol(nodeTypes.isProxy);
function emitWorkerEvidence(records, write = process.stdout.write.bind(process.stdout)) {
  if (!Array.isArray(records) || nodeTypes.isProxy(records) || records.length > 64) throw new Error("invalid Worker evidence collection");
  const safe = Array.from({ length: records.length }, (_, i) => {
    const descriptor = Object.getOwnPropertyDescriptor(records, String(i));
    return descriptor && Object.hasOwn(descriptor, "value") ? workerEvidence.validate(descriptor.value) : null;
  });
  if (safe.some(record => !record) || Buffer.byteLength(JSON.stringify(safe)) > 128 * 1024) throw new Error("invalid Worker evidence");
  for (const record of safe) write(`::error title=BytePlus retirement diagnostic::${JSON.stringify(record).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`);
}
async function retrieveWorkerEvidence(origin) {
  const response = await fetch(origin + "/fixture/diagnostics", { redirect: "error", signal: AbortSignal.timeout(2000) });
  if (response.status !== 200 || !response.body) throw new Error("Worker evidence unavailable");
  const reader = response.body.getReader(), chunks = []; let bytes = 0; const failures = [];
  try { for (;;) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength; if (bytes > 128 * 1024) throw new Error("Worker evidence bound"); chunks.push(result.value); } }
  catch (error) { failures.push(error); }
  finally { try { await reader.cancel(); } catch (error) { failures.push(error); } try { reader.releaseLock(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "Worker evidence read failed");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("Worker evidence preserves native invocation and fulfilled sibling cancellation without accepting a failed read", async () => {
  const reason = new Error("fixed source error"), signal = new AbortController(); let controller;
  const body = new ReadableStream({ start(value) { controller = value; } }), reader = body.getReader();
  const evidence = workerReaderEvidence(reader, 1, 1, signal.signal), operations = [];
  const reading = evidence.invoke("read", reader.read, reader, []); observeReaderOperation(operations, "read", reading, [signal.signal]);
  controller.error(reason);
  const cancel = evidence.invoke("cancel", reader.cancel, reader, []); observeReaderOperation(operations, "cancel", cancel, [signal.signal]);
  await Promise.allSettled([reading, cancel]); evidence.unlocking(); reader.releaseLock(); evidence.unlocked();
  await assert.rejects(joinReaderOperations(operations), AggregateError);
  const rows = evidence.records(body); assert.equal(rows.length, 2);
  assert.ok(rows.every(row => workerEvidence.validate(row) && row.allSettled && row.bodyLocked === false && row.joinAccepted === false));
  assert.equal(rows[1].sameClosed, true); assert.equal(rows[1].sameRead, true);
  assert.equal(rows[1].operandDefined, false); assert.equal(rows[1].sameOperand, false);
  // A separate native readable reader proves fulfilled cancellation and the
  // captured original closed promise; it is never relabelled as the failed reader.
  const live = new ReadableStream().getReader(), trace = workerReaderEvidence(live, 2, 1, signal.signal);
  const pending = trace.invoke("read", live.read, live, []), cancelling = trace.invoke("cancel", live.cancel, live, [reason]);
  await Promise.all([pending, cancelling]); trace.unlocking(); live.releaseLock(); trace.unlocked();
  const sibling = trace.records({ locked: false })[0];
  assert.equal(sibling.state, "fulfilled"); assert.equal(sibling.closedState, "fulfilled"); assert.equal(sibling.operandDefined, true);
  assert.equal(sibling.reasonDefined, false); assert.equal(sibling.sameOperand, false); assert.equal(sibling.joinAccepted, false);
});
test("Worker evidence schema rejects private strings, getters, proxies and undefined identity claims and caps reports", () => {
  const valid = { v: 1, site: "read_join", kind: "read", state: "rejected", reasonDefined: false, sameRead: false };
  let called = 0; const accessor = { ...valid }; Object.defineProperty(accessor, "input", { get() { called++; return 1; }, enumerable: true });
  const proxy = new Proxy(valid, { ownKeys() { called++; throw new Error("must not probe"); } });
  for (const bad of [accessor, proxy, { ...valid, message: "private" }, { ...valid, input: Infinity }]) assert.equal(workerEvidence.validate(bad), null);
  assert.equal(called, 0);
  const store = workerEvidenceProtocol(); for (let i = 0; i < 80; i++) assert.equal(store.add(valid), true);
  assert.equal(store.values().length, 64); assert.equal(store.values().at(-1).suppressed, 17);
  assert.throws(() => emitWorkerEvidence([accessor]), /invalid Worker evidence/);
  const array = []; Object.defineProperty(array, "0", { get() { called++; return valid; } }); assert.throws(() => emitWorkerEvidence(array)); assert.equal(called, 0);
  const primary = undefined, failures = [primary]; try { emitWorkerEvidence([valid], () => { throw new Error("writer"); }); } catch (error) { failures.push(error); }
  assert.equal(failures.length, 2); assert.equal(failures[0], undefined);
});
test("Worker typed evidence reaches an undecorated Actions command through the real Node spec reporter", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "byteplus-reporter-"));
  try {
    const file = join(temporary, "report.test.mjs");
    await writeFile(file, `import test from "node:test"; import { types as nodeTypes } from "node:util";
${workerEvidenceProtocol.toString()}
const workerEvidence = workerEvidenceProtocol(nodeTypes.isProxy);
${emitWorkerEvidence.toString()}
test("fixed safe report", () => emitWorkerEvidence([{ v: 1, site: "read_join", kind: "read", state: "rejected" }]));`);
    // Remove only Node's inherited nested-test marker for this standalone
    // reporter probe, matching the repository's existing reporter regressions.
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const { stdout } = await promisify(execFile)(process.execPath, ["--test", file], { env, timeout: 30_000, maxBuffer: 128 * 1024 });
    assert.match(stdout, /✔ fixed safe report/); assert.match(stdout, /tests 1/);
    assert.ok(stdout.split("\n").some(line => line.startsWith("::error title=BytePlus retirement diagnostic::{")));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
test("real Worker relay preserves a fulfilled sibling snapshot from the strict failed-reader join", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "byteplus-evidence-")); let mf; const failures = [];
  try {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    const script = `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
${workerEvidenceProtocol.toString()}
${workerReaderEvidence.toString()}
${joinReaderOperations.toString()}
const evidence = workerEvidenceProtocol();
export default { ...handler, async fetch(request) {
      if (new URL(request.url).pathname === "/fixture/diagnostics") return Response.json(evidence.values());
      const body = new ReadableStream(), reader = body.getReader(), trace = workerReaderEvidence(reader, 1, 1);
      const reading = trace.invoke("read", reader.read, reader, []), canceled = trace.invoke("cancel", reader.cancel, reader, [undefined]);
      await Promise.all([reading, canceled]); trace.unlocking(); reader.releaseLock(); trace.unlocked();
      // An independently failed join tests relay retention; this does not claim
      // that native Node cancellation rejects its own pending read.
      try { await joinReaderOperations([{ kind: "read", pending: Promise.reject(undefined), expectedAbort: false }]); }
      catch { for (const record of trace.records(body)) evidence.add(record); }
      return new Response(null, { status: 204 });
    } };`;
    mf = await startWorkerdFixture(temporary, script, 'export default { fetch() { return new Response(null, { status: 204 }); } };', { directRouter: true });
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    assert.equal((await fetch(origin + "/fixture/start")).status, 204);
    const records = await retrieveWorkerEvidence(origin); assert.equal(records.length, 1);
    assert.ok(workerEvidence.validate(records[0])); assert.equal(records[0].kind, "cancel"); assert.equal(records[0].state, "fulfilled");
    assert.equal(records[0].closedState, "fulfilled"); assert.equal(records[0].bodyLocked, false); assert.equal(records[0].joinAccepted, false);
  } catch (error) { failures.push(error); }
  finally { try { await mf?.dispose(); } catch (error) { failures.push(error); } try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "Worker evidence or cleanup failed");
});

function routerFixture() {
  return `import handler from "./worker/index.ts"; export * from "./worker/index.ts";
import { putGrantCredentials, revokeGrantCredentials } from "./worker/grant-credentials.ts";
const catalog = [], incoming = [], denials = [];
const records = [], inputs = [], rawFetch = globalThis.fetch;
${observeReaderOperation.toString()}
${joinReaderOperations.toString()}
${workerEvidenceProtocol.toString()}
${workerReaderEvidence.toString()}
const evidence = workerEvidenceProtocol();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
globalThis.fetch = function(input, init) {
  const pending = Reflect.apply(rawFetch, this, [input, init]);
  const url = input instanceof Request ? input.url : String(input);
  if (url !== "https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions") return pending;
  const signals = [init?.signal, input instanceof Request ? input.signal : undefined];
  const proof = { returned: pending, body: undefined, readers: [], errors: [] }; inputs.push(proof);
  const inputIndex = inputs.length;
  void pending.then(response => {
    try {
      proof.body = response.body;
      if (!proof.body) { proof.errors.push(new Error("upstream body missing")); return; }
      const getReader = proof.body.getReader;
      proof.body.getReader = function(...args) {
        const reader = Reflect.apply(getReader, this, args);
        const row = { pending: [], unlocked: false, terminal: deferred(), pendingSettled: false, reported: false, evidence: workerReaderEvidence(reader, inputIndex, proof.readers.length + 1, signals[0] ?? signals[1]) }; proof.readers.push(row);
        for (const name of ["read", "cancel"]) {
          const original = reader[name];
          reader[name] = function(...operands) {
            const pending = row.evidence.invoke(name, original, this, operands);
            return observeReaderOperation(row.pending, name, pending, signals);
          };
        }
        const release = reader.releaseLock;
        reader.releaseLock = function() {
          row.evidence.unlocking();
          const result = Reflect.apply(release, this, []); row.evidence.unlocked(); row.unlocked = true; row.terminal.resolve(); return result;
        };
        return reader;
      };
    } catch (error) { proof.errors.push(error); }
  }, () => {});
  return pending;
};
async function retire() {
  const failures = [];
  for (const record of records) {
    await record.returned.promise;
    for (let cursor = 0; cursor < record.pending.length;) {
      const batch = record.pending.slice(cursor); cursor += batch.length;
      for (const result of await Promise.allSettled(batch)) if (result.status === "rejected") failures.push(result.reason);
    }
  }
  const joined = await Promise.allSettled(inputs.map(async proof => {
    await proof.returned;
    const readers = await Promise.allSettled(proof.readers.map(async row => {
      await row.terminal.promise;
      try { await joinReaderOperations(row.pending); row.pendingSettled = true; }
      catch (error) {
        if (!row.reported) { row.reported = true; try { for (const snapshot of row.evidence.records(proof.body)) evidence.add(snapshot); } catch { /* original failure remains authoritative */ } }
        throw error;
      }
    }));
    const failures = [...proof.errors, ...readers.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
    if (!proof.readers.length) failures.push(new Error("upstream reader observation missing"));
    if (failures.length) throw new AggregateError(failures, "upstream reader retirement failed");
    proof.joined = true;
  }));
  for (const result of joined) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, "original Worker work failed");
  return { requests: records.length, inputs: inputs.map(proof => ({ joined: proof.joined, locked: proof.body.locked,
    readers: proof.readers.map(row => ({ unlocked: row.unlocked, pendingSettled: row.pendingSettled })) })) };
}

export default { ...handler, async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/retire") return Response.json(await retire());
  if (path === "/fixture/diagnostics") return Response.json(evidence.values());
  if (path === "/fixture/state") return Response.json({ catalog, incoming, denials });
  if (path === "/fixture/grants") {
    for (const id of ${JSON.stringify(ids)}) {
      for (const foreign of ["volcengine", "byteplus-plan", "volcengine-plan"]) await putGrantCredentials(env, "oauth/byte_" + id + "/" + foreign, { provider: foreign, enabled: true, kind: "api_key", credential: "fixture-foreign-product" });
      if (id !== "missing") await putGrantCredentials(env, "oauth/byte_" + id + "/byteplus", { provider: "byteplus", enabled: true, kind: "api_key", credential: "fixture-upstream-" + id });
    }
    return new Response(null, { status: 204 });
  }
  if (path === "/fixture/revoke") { await revokeGrantCredentials(env, "oauth/byte_revoked/byteplus"); return new Response(null, { status: 204 }); }
  const id = ${JSON.stringify(ids)}.find(id => request.headers.get("authorization") === "Bearer clawrouter-live-byte_" + id + "-fixture-secret");
  if (path === "/v1/catalog") catalog.push({ id, path, proxyKey: !!id });
  if (path === "/v1/chat/completions") incoming.push({ id, path, proxyKey: (request.headers.get("authorization") ?? "").startsWith("Bearer clawrouter-live-byte_"), model: (await request.clone().json()).model });
  const record = { returned: deferred(), pending: [] };
  if (path === "/v1/catalog" || path === "/v1/chat/completions") records.push(record);
  let response;
  try { response = await handler.fetch(request, { ...env, BYTEPLUS_API_KEY: "must-not-fallback", VOLCANO_ENGINE_API_KEY: "must-not-fallback", ARK_API_KEY: "must-not-fallback", VOLCENGINE_PLAN_API_KEY: "must-not-fallback", BYTEPLUS_PLAN_API_KEY: "must-not-fallback" }, {
    waitUntil(pending) { record.pending.push(pending); context.waitUntil(pending); }
  }); } finally { record.returned.resolve(); }
  if (path === "/v1/chat/completions" && ["foreign", "missing", "unpriced", "revoked"].includes(id)) {
    const body = await response.clone().json(); denials.push({ id, status: response.status, code: body.error?.code });
  }
  return response;
} };`;
}
function upstreamFixture() {
  return `const calls = []; export default { async fetch(request) {
    if (request.url === "https://fixture.example/state") return Response.json(calls);
    const body = await request.json(), id = request.headers.get("authorization").replace("Bearer fixture-upstream-", "");
    const call = { id, url: request.url, authorization: request.headers.get("authorization"), apiKey: request.headers.get("api-key"), xApiKey: request.headers.get("x-api-key"), body }; calls.push(call);
    if (id === "http_error") return Response.json({ error: { message: "synthetic provider rejection" } }, { status: 401 });
    const frame = value => "data: " + JSON.stringify(value) + "\\n\\n";
    const toolTurn = id === "roundtrip" && !body.messages.some(m => m.role === "tool");
    const usage = id === "no_usage" ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } } };
    const first = frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "synthetic-reasoning", ...(toolTurn ? {} : { content: "synthetic-answer" }) }, finish_reason: null }] });
    const tools = toolTurn ? frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{\\\"value\\\":" } }] }, finish_reason: null }] })
      + frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\\\"fixture\\\"}" } }] }, finish_reason: null }] }) : "";
    const wire = id === "embedded_error" ? frame({ error: { code: "synthetic_error", message: "synthetic provider rejection" } }) : first + tools + (id === "cancel" ? "" : frame({ id: "chat_fixture", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: toolTurn ? "tool_calls" : "stop" }], ...usage }) + "data: [DONE]\\n\\n");
    const bytes = new TextEncoder().encode(wire); let offset = 0, beats = 0, timer, wake;
    request.signal.addEventListener("abort", () => { call.aborted = true; clearTimeout(timer); wake?.(); }, { once: true });
    return new Response(new ReadableStream({ pull(c) {
      if (offset === bytes.length) {
        if (id !== "cancel") { c.close(); return; }
        // Existing post-header fixture contract: a bounded real timer keeps the
        // request live; expiry is explicitly rejected as cancellation evidence.
        return new Promise(resolve => { wake = resolve; timer = setTimeout(() => {
          if (++beats > 200) { call.fixtureExpired = true; c.close(); } else c.enqueue(new TextEncoder().encode(": fixture heartbeat\\n\\n")); resolve();
        }, 50); });
      }
      const end = Math.min(offset + 7, bytes.length); c.enqueue(bytes.slice(offset, end)); offset = end;
    }, cancel() { call.cancelled = true; clearTimeout(timer); wake?.(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } };`;
}
