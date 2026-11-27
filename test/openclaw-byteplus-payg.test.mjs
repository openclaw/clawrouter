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
  const failures = [], helperRecord = { v: 1, site: "helper", kind: "none", state: "unknown", helperCalled: false, diagnosticCount: null, sdkRecords: null };
  let evidenceRecords = [], helperFulfilled = false, cancelUsage, physical, observedCalls;
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
    await observeConsumerReturn(() => runOpenClawConsumer(t, { source, sourceHead, fixture: new URL("./fixtures/openclaw-byteplus-payg-contract.test.ts", import.meta.url),
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, BYTEPLUS_API_KEY: "must-not-fallback", VOLCANO_ENGINE_API_KEY: "must-not-fallback", VOLCENGINE_PLAN_API_KEY: "must-not-fallback", BYTEPLUS_PLAN_API_KEY: "must-not-fallback", ARK_API_KEY: "must-not-fallback" } }), helperRecord);
    helperFulfilled = true; // Only the fulfilled original await qualifies the suite.
    // The actual client omits closed rows. Separately prove its raw Worker
    // denial rather than inventing an executable client catalog entry.
    for (const [i, model] of closed.entries()) {
      const response = await fetch(origin + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key(`closed${i}`)}`, "content-type": "application/json" }, body: JSON.stringify({ model: `byteplus/${model}`, messages: [] }) });
      assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "model_capability_unsupported");
    }
    const retirement = await fetch(origin + "/fixture/retire", { method: "POST" });
    assert.equal(retirement.status, 200);
    const joined = await retirement.json(); physical = joined;
    helperRecord.sdkRecords = joined.sdkReceipt?.valid === true ? 1 : 0;
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
    observedCalls = calls;
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
      if (id === "cancel") cancelUsage = usage;
    }
    assert.equal(finalCallerCancellation({ physical: joined, helperFulfilled, receipt: joined.sdkReceipt, incoming: observation.incoming, calls, usage: cancelUsage }), true,
      "bound caller cancellation disposition requires every independent oracle");
  } catch (error) { failures.push(error); }
  finally {
    if (mf && origin) {
      try {
        const response = await fetch(origin + "/fixture/retire", { method: "POST" });
        assert.equal(response.status, 200); await response.json();
      } catch (error) { failures.push(error); }
    }
    if (mf && origin) {
      try { evidenceRecords = validateWorkerEvidenceCollection(await retrieveWorkerEvidence(origin)); helperRecord.diagnosticCount = evidenceRecords.length; }
      catch (error) { failures.push(error); }
    }
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    try { emitWorkerEvidence(evidenceRecords, undefined, [helperRecord, ...cancelSummaryEvidence(physical, observedCalls, cancelUsage), primaryEvidence(failures[0])]); }
    catch (error) { failures.push(error); }
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
  new Function("afterEach", "acquisitions", "closeOperations", "dispatchers", "observationErrors", "bodyPassed", "catalogCalls", "chatCalls", "expectedChatCalls", "negativeCase", "joinReaderOperations", "acceptStoredSdkCancel", "vi", "clearLiveCatalogCacheForTests", "expect", "callerScenario", "callerSignal", "nativeFetch", "origin", code)(
    fn => { cleanup = fn; }, rows, options.closeOperations ?? [Promise.resolve()], options.dispatchers ?? new Set([{ closed: true }]), options.observationErrors ?? [], options.bodyPassed !== false,
    1, rows.length - 1, rows.length - 1, Object.hasOwn(options, "scenario") ? options.scenario : "embedded_error", helpers.joinReaderOperations, helpers.acceptStoredSdkCancel,
    { restoreAllMocks: options.restore ?? (() => {}) }, options.clear ?? (() => {}), expect, options.callerScenario ?? "cancel", options.callerSignal ?? AbortSignal.abort(), options.fetchControl ?? (async () => new Response(null, { status: 204 })), "https://fixture.example");
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
  const numeric = ["input", "reader", "op", "invokeSeq", "settleSeq", "closedSeq", "readSeq", "unlockBefore", "unlockCalls", "unlockReturns", "unlockInvokeSeq", "unlockReturnSeq", "operations", "settled", "suppressed", "duplicates", "omitted", "attempts", "matchedPosts"];
  const boolean = ["reasonDefined", "closedReasonDefined", "readReasonDefined", "operandPresent", "operandDefined", "signalAborted", "signalReasonDefined", "settleSignalAborted", "settleSignalReasonDefined", "sameClosed", "sameRead", "sameOperand", "sameSignal", "operandSameRead", "operandSameSignal", "allSettled", "bodyLocked", "joinAccepted", "helperCalled", "ingressObserved", "readPendingAtCancel", "earlierReadFailure", "bound", "responseAdmitted"];
  const enums = { scenario: ["cancel", "none"], disposition: ["provisional", "unclassified"], signalScope: ["fetch_input"], site: ["read_join", "cancel_join", "suppressed", "helper", "primary", "sdk_receipt", "binding", "upstream", "accounting"], kind: ["read", "cancel", "none"], state: ["pending", "fulfilled", "rejected", "sync_throw", "unknown"], failureClass: ["unknown", "undefined", "assertion"], closedState: ["pending", "fulfilled", "rejected"] };
  function validate(value) {
    try {
      if (!value || typeof value !== "object" || isProxy?.(value)) return null;
      const out = {}, keys = Reflect.ownKeys(value); if (keys.length < 4 || keys.length > 64) return null;
      for (const key of keys) {
        const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !Object.hasOwn(d, "value")) return null;
        const v = d.value;
        if (["ingressAborted", "receiptValid", "partialDelivery", "callerAborted", "originalsJoined", "restored", "requestBound", "admitted", "upstreamCanceled", "nonExpired", "noReplay", "accountingMatched"].includes(key)) { if (v !== null && typeof v !== "boolean") return null; }
        else if (["diagnosticCount", "sdkRecords"].includes(key)) { if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 64)) return null; }
        else if (["actual", "expected"].includes(key)) { if (v !== null && typeof v !== "boolean" && !(typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1_000_000_000)) return null; }
        else if (key === "v" ? v !== 1 : numeric.includes(key) ? !(Number.isInteger(v) && v >= 0 && v <= 1_000_000) : boolean.includes(key) ? typeof v !== "boolean" : !enums[key]?.includes(v)) return null;
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
function workerReaderEvidence(reader, input, index, signal, ingressSignal) {
  let seq = 0, unlockCalls = 0, unlockReturns = 0, unlockInvokeSeq = 0, unlockReturnSeq = 0;
  let closedState = "pending", closedReason, closedSeq = 0, readReason, readSeq = 0;
  const operations = [], closed = reader.closed;
  void closed.then(() => { closedState = "fulfilled"; closedSeq = ++seq; }, reason => { closedState = "rejected"; closedReason = reason; closedSeq = ++seq; });
  const snapshot = () => ({ aborted: signal?.aborted === true, reason: signal?.reason });
  return {
    invoke(kind, original, receiver, args) {
      const op = { kind, state: "pending", op: operations.length + 1, invokeSeq: ++seq, settleSeq: 0, unlockBefore: unlockCalls, operandPresent: args.length > 0, operand: args[0], signal: snapshot(), reason: undefined,
        ingressObserved: !!ingressSignal, ingressAborted: ingressSignal ? ingressSignal.aborted : null,
        earlierReadFailure: operations.some(row => row.kind === "read" && ["rejected", "sync_throw"].includes(row.state)),
        pendingReads: operations.filter(row => row.kind === "read" && row.state === "pending") };
      operations.push(op);
      let pending;
      try { pending = Reflect.apply(original, receiver, args); } catch (reason) { op.state = "sync_throw"; op.reason = reason; op.settleSeq = ++seq; op.settleSignal = snapshot(); throw reason; }
      op.pending = pending;
      void pending.then(() => { op.state = "fulfilled"; op.settleSeq = ++seq; op.settleSignal = snapshot(); }, reason => {
        op.state = "rejected"; op.reason = reason; op.settleSeq = ++seq; op.settleSignal = snapshot(); if (kind === "read") { readReason = reason; readSeq = op.settleSeq; }
      });
      return pending;
    },
    unlocking() { unlockCalls++; unlockInvokeSeq = ++seq; }, unlocked() { unlockReturns++; unlockReturnSeq = ++seq; },
    candidate(pending, reason, body) {
      const read = operations.find(op => op.pending === pending && op.kind === "read" && op.state === "rejected" && op.reason === reason);
      const cancels = operations.filter(op => op.kind === "cancel"), cancel = cancels[0];
      return reason !== undefined && !!read && cancels.length === 1 && cancel.state === "fulfilled" && cancel.unlockBefore === 0 &&
        cancel.signal.aborted === true && cancel.ingressObserved && typeof cancel.ingressAborted === "boolean" &&
        !cancel.earlierReadFailure && cancel.pendingReads.includes(read) && closedState === "fulfilled" &&
        cancel.settleSeq > 0 && closedSeq > 0 && cancel.settleSeq < unlockInvokeSeq && closedSeq < unlockInvokeSeq &&
        unlockCalls === 1 && unlockReturns === 1 && body.locked === false && operations.every(op => op.state === "fulfilled" || op === read);
    },
    disposition() {
      const cancel = operations.find(op => op.kind === "cancel");
      return { physical: true, ingressObserved: cancel?.ingressObserved === true, ingressAborted: cancel?.ingressAborted ?? null, fetchAborted: cancel?.signal.aborted === true };
    },
    records(body) {
      const definedSame = (a, b) => a !== undefined && b !== undefined && a === b;
      return operations.filter(op => op.state === "rejected" || op.state === "sync_throw" || op.kind === "cancel").map(op => ({
        v: 1, signalScope: "fetch_input", site: op.kind === "cancel" ? "cancel_join" : "read_join", input, reader: index, op: op.op, kind: op.kind, state: op.state,
        invokeSeq: op.invokeSeq, settleSeq: op.settleSeq, closedState, closedSeq, readSeq, unlockBefore: op.unlockBefore,
        unlockCalls, unlockReturns, unlockInvokeSeq, unlockReturnSeq, operations: operations.length, settled: operations.filter(p => p.state !== "pending").length,
        reasonDefined: op.reason !== undefined, closedReasonDefined: closedReason !== undefined, readReasonDefined: readReason !== undefined,
        operandPresent: op.operandPresent, operandDefined: op.operand !== undefined,
        signalAborted: op.signal.aborted, signalReasonDefined: op.signal.reason !== undefined,
        ingressObserved: op.ingressObserved, ingressAborted: op.ingressAborted, readPendingAtCancel: op.pendingReads.length > 0, earlierReadFailure: op.earlierReadFailure,
        settleSignalAborted: op.settleSignal?.aborted === true, settleSignalReasonDefined: op.settleSignal?.reason !== undefined,
        sameClosed: definedSame(op.reason, closedReason), sameRead: definedSame(op.reason, readReason), sameOperand: definedSame(op.reason, op.operand),
        sameSignal: definedSame(op.reason, op.settleSignal?.reason), operandSameRead: definedSame(op.operand, readReason), operandSameSignal: definedSame(op.operand, op.signal.reason),
        allSettled: operations.every(p => p.state !== "pending"), bodyLocked: body.locked, joinAccepted: false,
      }));
    },
  };
}
const workerEvidence = workerEvidenceProtocol(nodeTypes.isProxy);
function validateWorkerEvidenceCollection(records) {
  if (!Array.isArray(records) || nodeTypes.isProxy(records) || records.length > 64) throw new Error("invalid Worker evidence collection");
  const safe = Array.from({ length: records.length }, (_, i) => {
    const descriptor = Object.getOwnPropertyDescriptor(records, String(i));
    return descriptor && Object.hasOwn(descriptor, "value") ? workerEvidence.validate(descriptor.value) : null;
  });
  if (safe.some(record => !record) || Buffer.byteLength(JSON.stringify(safe)) > 128 * 1024) throw new Error("invalid Worker evidence");
  return safe;
}
function observeConsumerReturn(invoke, record) {
  record.helperCalled = true; record.state = "pending";
  let pending;
  try { pending = invoke(); } catch (error) { record.state = "rejected"; throw error; }
  void pending.then(() => { record.state = "fulfilled"; }, () => { record.state = "rejected"; });
  return pending; // Original helper promise; no child-start or SDK-count inference.
}
function primaryEvidence(error) {
  const row = { v: 1, site: "primary", kind: "none", state: "rejected", failureClass: error === undefined ? "undefined" : "unknown", reasonDefined: error !== undefined, actual: null, expected: null };
  if (!error || typeof error !== "object" || nodeTypes.isProxy(error)) return row;
  const own = key => { const d = Object.getOwnPropertyDescriptor(error, key); return d && Object.hasOwn(d, "value") ? d.value : undefined; };
  if (own("code") === "ERR_ASSERTION") {
    row.failureClass = "assertion";
    for (const key of ["actual", "expected"]) { const value = own(key); if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000)) row[key] = value; }
  }
  return row;
}
function emitWorkerEvidence(records, write = process.stdout.write.bind(process.stdout), outer = []) {
  if (!Array.isArray(outer) || nodeTypes.isProxy(outer) || outer.length > 6) throw new Error("invalid outer evidence collection");
  const safe = [...validateWorkerEvidenceCollection(records), ...validateWorkerEvidenceCollection(outer)];
  const unique = new Map(); let duplicates = 0, suppressed = 0;
  const finality = row => [row.settled ?? 0, row.unlockReturns ?? 0, row.unlockReturnSeq ?? 0, row.settleSeq ?? 0];
  for (const row of safe) {
    if (row.site === "suppressed") { suppressed = Math.min(1_000_000, suppressed + (row.suppressed ?? 0)); continue; }
    const operation = row.input !== undefined && row.reader !== undefined && row.op !== undefined;
    const key = row.site === "helper" ? "helper" : operation ? `${row.input}/${row.reader}/${row.op}/${row.kind}` : JSON.stringify(row);
    const previous = unique.get(key);
    if (previous) {
      duplicates++;
      if (operation) {
        const next = finality(row), prior = finality(previous), differing = next.findIndex((value, i) => value !== prior[i]);
        if (differing >= 0 && next[differing] < prior[differing]) continue;
      } else if (row.site === "helper" && ["fulfilled", "rejected"].includes(previous.state) && !["fulfilled", "rejected"].includes(row.state)) continue;
    }
    unique.set(key, row);
  }
  const values = [...unique.values()], physical = values.filter(row => ["read_join", "cancel_join"].includes(row.site)).sort((a, b) =>
    (a.input ?? 0) - (b.input ?? 0) || (a.reader ?? 0) - (b.reader ?? 0) || (a.op ?? 0) - (b.op ?? 0));
  const first = physical.find(row => row.kind === "read") ?? physical[0];
  const sibling = first && physical.find(row => row !== first && row.input === first.input && row.reader === first.reader && row.kind === "cancel");
  const leading = [first, sibling].filter(Boolean);
  const ordered = [...values.filter(row => row.site === "helper"), ...values.filter(row => row.site === "sdk_receipt"), ...values.filter(row => row.site === "binding"), ...leading,
    ...values.filter(row => !["helper", "sdk_receipt", "binding", "read_join", "cancel_join"].includes(row.site)), ...physical.filter(row => !leading.includes(row))];
  const selected = ordered.slice(0, 9), omitted = ordered.length - selected.length;
  // Actions admits ten error annotations per step, independently of the API's
  // fifty-annotation request size. Retain the internal 64-record evidence bank.
  if (duplicates || omitted || suppressed) selected.push({ v: 1, site: "suppressed", kind: "none", state: "fulfilled", duplicates, omitted, suppressed });
  for (const record of selected) {
    if (!workerEvidence.validate(record)) throw new Error("invalid compacted evidence");
    write(`::error title=BytePlus retirement diagnostic::${JSON.stringify(record).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`);
  }
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
function crowdedEvidence(outcome) {
  const read = { v: 1, site: "read_join", kind: "read", state: "rejected", input: 26, reader: 1, op: 32, invokeSeq: 63, settleSeq: 67, settled: 33, unlockReturns: 1, unlockReturnSeq: 69, allSettled: true, bodyLocked: false, joinAccepted: false };
  const cancel = { ...read, site: "cancel_join", kind: "cancel", state: "fulfilled", op: 33, invokeSeq: 64, settleSeq: 66 };
  return [
    { v: 1, site: "helper", kind: "none", state: "pending", helperCalled: true, diagnosticCount: null, sdkRecords: null },
    ...Array.from({ length: 20 }, () => ({ ...read, unlockReturns: 0, unlockReturnSeq: 0, bodyLocked: true })),
    ...Array.from({ length: 20 }, () => ({ ...cancel, unlockReturns: 0, unlockReturnSeq: 0, bodyLocked: true })),
    read, cancel,
    ...Array.from({ length: 12 }, (_, i) => ({ ...read, input: i + 30 })),
    { v: 1, site: "helper", kind: "none", state: outcome, helperCalled: true, diagnosticCount: 56, sdkRecords: null },
  ];
}
test("first-ten annotation collector retains final helper facts and original physical snapshots before duplicate overflow", () => {
  const prefix = "::error title=BytePlus retirement diagnostic::";
  for (const outcome of ["fulfilled", "rejected"]) {
    const lines = []; emitWorkerEvidence(crowdedEvidence(outcome), line => lines.push(line));
    const collected = lines.slice(0, 10).map(line => JSON.parse(line.slice(prefix.length)));
    assert.equal(lines.length, 10); assert.equal(collected[0].site, "helper"); assert.equal(collected[0].state, outcome);
    assert.equal(collected[0].diagnosticCount, 56); assert.equal(collected[0].sdkRecords, null);
    assert.deepEqual(collected.slice(1, 3).map(row => [row.op, row.kind, row.state, row.unlockReturns, row.bodyLocked, row.joinAccepted]),
      [[32, "read", "rejected", 1, false, false], [33, "cancel", "fulfilled", 1, false, false]]);
    assert.deepEqual(collected.at(-1), { v: 1, site: "suppressed", kind: "none", state: "fulfilled", duplicates: 41, omitted: 6, suppressed: 0 });
    assert.ok(collected.every(row => workerEvidence.validate(row) && Buffer.byteLength(JSON.stringify(row)) <= 2048));
  }
  const rows = []; emitWorkerEvidence([], line => rows.push(JSON.parse(line.slice(prefix.length))),
    [{ v: 1, site: "helper", kind: "none", state: "fulfilled", helperCalled: true, diagnosticCount: 0, sdkRecords: null }]);
  assert.equal(rows[0].sdkRecords, null, "no SDK count is inferred from an empty Worker collection");
  const withPrimary = []; emitWorkerEvidence(crowdedEvidence("rejected"), line => withPrimary.push(JSON.parse(line.slice(prefix.length))), [primaryEvidence(undefined)]);
  assert.deepEqual(withPrimary.slice(0, 4).map(row => row.site), ["helper", "read_join", "cancel_join", "primary"]);
  assert.equal(withPrimary[3].failureClass, "undefined"); assert.equal(withPrimary.length, 10);
});
test("helper outcome observes the original promise and preserves undefined rejection independently of reporting", async () => {
  const record = { v: 1, site: "helper", kind: "none", state: "unknown", helperCalled: false, diagnosticCount: null, sdkRecords: null };
  const original = Promise.resolve(); assert.equal(observeConsumerReturn(() => original, record), original); await original;
  assert.equal(record.state, "fulfilled"); assert.equal(record.sdkRecords, null);
  const rejected = Promise.reject(undefined); assert.equal(observeConsumerReturn(() => rejected, record), rejected);
  const results = await Promise.allSettled([rejected]); assert.equal(results[0].status, "rejected"); assert.equal(results[0].reason, undefined); assert.equal(record.state, "rejected");
  assert.throws(() => observeConsumerReturn(() => { throw undefined; }, record), error => error === undefined);
  let called = 0; const error = { code: "ERR_ASSERTION", actual: 500, expected: 200 };
  Object.defineProperties(error, { message: { get() { called++; throw undefined; } }, stdout: { get() { called++; throw undefined; } }, stderr: { get() { called++; throw undefined; } } });
  assert.deepEqual(primaryEvidence(error), { v: 1, site: "primary", kind: "none", state: "rejected", failureClass: "assertion", reasonDefined: true, actual: 500, expected: 200 });
  assert.equal(primaryEvidence(undefined).failureClass, "undefined"); assert.equal(called, 0);
  const failures = [undefined]; try { emitWorkerEvidence([], () => { throw undefined; }, [record]); } catch (reason) { failures.push(reason); }
  assert.deepEqual(failures, [undefined, undefined]);
});
test("Worker typed evidence reaches an undecorated bounded first-ten collector through the real Node spec reporter", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "byteplus-reporter-"));
  const failures = [];
  try {
    const file = join(temporary, "report.test.mjs");
    for (const outcome of ["fulfilled", "rejected"]) {
      await writeFile(file, `import test from "node:test"; import { types as nodeTypes } from "node:util";
${workerEvidenceProtocol.toString()}
const workerEvidence = workerEvidenceProtocol(nodeTypes.isProxy);
${validateWorkerEvidenceCollection.toString()}
${emitWorkerEvidence.toString()}
test("fixed safe report", () => emitWorkerEvidence(${JSON.stringify(crowdedEvidence(outcome))}));`);
      // Match the standalone Node reporter probe; never read actual SDK child output.
      const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
      const { stdout } = await promisify(execFile)(process.execPath, ["--test", file], { env, timeout: 30_000, maxBuffer: 128 * 1024 });
      assert.match(stdout, /✔ fixed safe report/); assert.match(stdout, /tests 1/);
      const prefix = "::error title=BytePlus retirement diagnostic::", lines = stdout.split("\n").filter(line => line.includes(prefix));
      assert.equal(lines.length, 10); assert.ok(lines.every(line => line.startsWith(prefix)));
      const collected = lines.slice(0, 10).map(line => JSON.parse(line.slice(prefix.length)));
      assert.equal(collected[0].state, outcome); assert.equal(collected[0].diagnosticCount, 56); assert.equal(collected[0].sdkRecords, null);
      assert.equal(collected[1].op, 32); assert.equal(collected[2].op, 33); assert.equal(collected[2].state, "fulfilled");
      assert.ok(collected.slice(1, 3).every(row => row.unlockReturns === 1 && row.bodyLocked === false && row.joinAccepted === false));
      assert.equal(collected[9].site, "suppressed");
    }
  } catch (error) { failures.push(error); }
  finally { try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "reporter regression or cleanup failed");
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

function sdkCancelReceiptStore() {
  let attempts = 0, receipt = null;
  const valid = value => value && typeof value === "object" && Object.keys(value).length === 6 && value.v === 1 && value.scenario === "cancel" &&
    value.partialDelivery === true && value.callerAborted === true && value.originalsJoined === true && value.restored === true;
  return {
    async receive(request) {
      attempts++;
      if (request.method !== "POST" || !request.body) return new Response(null, { status: 409 });
      const reader = request.body.getReader(), chunks = []; let bytes = 0; const failures = [];
      try { for (;;) { const result = await reader.read(); if (result.done) break; bytes += result.value.byteLength; if (bytes > 512) throw new Error("receipt bound"); chunks.push(result.value); } }
      catch (error) { failures.push(error); }
      finally { try { await reader.cancel(); } catch (error) { failures.push(error); } try { reader.releaseLock(); } catch (error) { failures.push(error); } }
      if (failures.length) return new Response(null, { status: 400 });
      if (attempts !== 1) return new Response(null, { status: 409 });
      try {
        const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
        const value = JSON.parse(new TextDecoder().decode(joined)); if (!valid(value)) return new Response(null, { status: 400 });
        receipt = value; return new Response(null, { status: 204 });
      } catch { return new Response(null, { status: 400 }); }
    },
    snapshot() { return { attempts, valid: attempts === 1 && receipt !== null, receipt }; },
  };
}
function bindByteplusInput(input, init, records, knownIds) {
  const request = input instanceof Request ? input : null, url = request ? request.url : String(input);
  const method = init?.method !== undefined ? init.method : request?.method ?? "GET";
  // Fetch replaces Request headers when init.headers is defined; never merge.
  const headers = new Headers(init?.headers !== undefined ? init.headers : request?.headers);
  const id = knownIds.find(id => headers.get("authorization") === `Bearer fixture-upstream-${id}`) ?? null;
  const matches = records.filter(record => record.kind === "inference" && record.id === id && record.method === "POST" && record.path === "/v1/chat/completions");
  return { id, record: matches.length === 1 ? matches[0] : null, matches: matches.length,
    target: url === "https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions" && method === "POST" };
}
function byteplusBindingFacts(proof, records, inputs) {
  const ingress = records.filter(record => record.kind === "inference" && record.id === "cancel"), binding = proof?.binding;
  const bound = binding?.id === "cancel" && binding.target === true && binding.matches === 1 && ingress.length === 1 &&
    binding.record === ingress[0] && binding.record.request?.signal === binding.record.signal &&
    binding.record.method === "POST" && binding.record.path === "/v1/chat/completions" && inputs.filter(input => input.binding.id === "cancel").length === 1;
  const responseAdmitted = bound && proof.response?.status === 200 && proof.body === proof.response.body &&
    proof.response.headers.get("content-type")?.includes("text/event-stream") === true && binding.record.response?.status === 200 &&
    binding.record.response.headers.get("content-type")?.includes("text/event-stream") === true;
  return { bound: !!bound, responseAdmitted: !!responseAdmitted };
}

function cancelSummaryEvidence(physical, calls, usage) {
  const receipt = physical?.sdkReceipt, proof = receipt?.receipt, binding = physical?.cancellationBinding;
  const posts = calls?.filter(row => row.id === "cancel"), event = usage?.usage?.events?.[0];
  const base = { v: 1, kind: "none", state: "fulfilled", scenario: "cancel" };
  return [
    { ...base, site: "sdk_receipt", receiptValid: receipt ? receipt.valid === true : null, partialDelivery: proof ? proof.partialDelivery === true : null,
      callerAborted: proof ? proof.callerAborted === true : null, originalsJoined: proof ? proof.originalsJoined === true : null, restored: proof ? proof.restored === true : null },
    { ...base, site: "binding", requestBound: binding ? binding.bound === true : null, admitted: binding ? binding.responseAdmitted === true : null },
    { ...base, site: "upstream", upstreamCanceled: posts ? posts.length === 1 && (posts[0].cancelled === true || posts[0].aborted === true) : null,
      nonExpired: posts ? posts.length === 1 && posts[0].fixtureExpired !== true : null, noReplay: posts ? posts.length === 1 : null },
    { ...base, site: "accounting", accountingMatched: usage ? usage?.usage?.events?.length === 1 && usage.budget?.spentMicros === 7 && event?.status === "client_error" &&
      event?.credential_id === "byte_cancel" && event?.policy_id === "byte_cancel" && event?.provider === "byteplus" && event?.model === "byteplus/dola-seed-2-1-turbo-260628" &&
      event?.actual_cost_micros === 7 && event?.cost_basis === "policy_fixed" && [event?.input_tokens, event?.output_tokens, event?.total_tokens, event?.cached_input_tokens].every(value => value === null) : null },
  ];
}

function finalCallerCancellation({ physical, helperFulfilled, receipt, incoming, calls, usage }) {
  const candidates = physical?.inputs?.flatMap(input => input.candidates ?? []) ?? [];
  const matches = incoming?.filter(row => row.id === "cancel") ?? [], posts = calls?.filter(row => row.id === "cancel") ?? [];
  const event = usage?.usage?.events?.[0];
  return helperFulfilled === true && receipt?.attempts === 1 && receipt.valid === true && receipt.receipt?.scenario === "cancel" &&
    receipt.receipt.partialDelivery === true && receipt.receipt.callerAborted === true && receipt.receipt.originalsJoined === true && receipt.receipt.restored === true &&
    physical?.tasksFulfilled === true && Array.isArray(physical.inputs) && physical.inputs.every(input => input.joined === true && input.locked === false) &&
    physical.cancellationBinding?.bound === true && physical.cancellationBinding.responseAdmitted === true &&
    candidates.length <= 1 && candidates.every(candidate => candidate.scenario === "cancel" && candidate.bound === true && candidate.responseAdmitted === true &&
      candidate.physical === true && candidate.ingressObserved === true && typeof candidate.ingressAborted === "boolean" && candidate.fetchAborted === true) &&
    matches.length === 1 && matches[0].path === "/v1/chat/completions" && matches[0].method === "POST" && matches[0].model === "byteplus/dola-seed-2-1-turbo-260628" &&
    posts.length === 1 && posts[0].url === "https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions" &&
    posts[0].authorization === "Bearer fixture-upstream-cancel" && posts[0].body?.model === "dola-seed-2-1-turbo-260628" && posts[0].body?.stream === true &&
    (posts[0].cancelled === true || posts[0].aborted === true) && posts[0].fixtureExpired !== true &&
    usage?.usage?.events?.length === 1 && usage.budget?.spentMicros === 7 && event?.credential_id === "byte_cancel" && event.policy_id === "byte_cancel" &&
    event.provider === "byteplus" && event.model === "byteplus/dola-seed-2-1-turbo-260628" && event.status === "client_error" &&
    event.actual_cost_micros === 7 && event.cost_basis === "policy_fixed" &&
    [event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens].every(value => value === null);
}

const cancelReceipt = { v: 1, scenario: "cancel", partialDelivery: true, callerAborted: true, originalsJoined: true, restored: true };
test("SDK cancellation receipt follows original joins and restoration and refuses failed or duplicate delivery", async t => {
  for (const fault of [null, "body", "restore", "observer", "delivery", "duplicate"]) await t.test(fault ?? "joined", async () => {
    const state = await nativeStoredReader(), store = sdkCancelReceiptStore(), order = [];
    const options = { scenario: "cancel", restore() { order.push("restore"); if (fault === "restore") throw undefined; },
      clear() { order.push("clear"); }, fetchControl: async (url, init) => {
        order.push("receipt"); assert.deepEqual(order.slice(0, 2), ["restore", "clear"]);
        assert.equal(state.row.body.locked, false);
        if (fault === "delivery") throw undefined;
        const response = await store.receive(new Request(url, init));
        if (fault === "duplicate") return store.receive(new Request(url, init));
        return response;
      }, ...(fault === "body" ? { bodyPassed: false } : {}), ...(fault === "observer" ? { observationErrors: [undefined] } : {}) };
    try {
      const cleanup = await sdkRetirementHarness([state.catalog, state.row], options);
      if (fault) await assert.rejects(cleanup()); else await cleanup();
      assert.equal(store.snapshot().valid, fault === null);
      if (["body", "restore", "observer"].includes(fault)) assert.equal(order.includes("receipt"), false);
    } finally { state.finish(); }
  });
  for (const payload of [{ ...cancelReceipt, partialDelivery: false }, { ...cancelReceipt, unexpected: true }, { v: 1 }]) {
    const store = sdkCancelReceiptStore();
    const result = await store.receive(new Request("https://fixture.example/fixture/sdk-cancel", { method: "POST", body: JSON.stringify(payload) }));
    assert.equal(result.status, 400); assert.equal(store.snapshot().valid, false);
  }
});

test("actual Request binding honors header replacement and rejects ambiguous or unadmitted inference", () => {
  const ingress = new Request("https://fixture.example/v1/chat/completions", { method: "POST" });
  const record = { request: ingress, signal: ingress.signal, kind: "inference", id: "cancel", method: "POST", path: "/v1/chat/completions",
    response: new Response(null, { headers: { "content-type": "text/event-stream" } }) };
  const outgoing = new Request("https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions", { method: "POST", headers: { authorization: "Bearer fixture-upstream-cancel" } });
  const catalog = { ...record, kind: "catalog" }, records = [catalog, record];
  assert.equal(bindByteplusInput(outgoing, undefined, records, ids).record, record);
  assert.equal(bindByteplusInput(outgoing, { headers: {} }, records, ids).id, null);
  assert.equal(bindByteplusInput(outgoing, { method: "GET" }, records, ids).target, false);
  assert.equal(bindByteplusInput(outgoing, undefined, [...records, { ...record }], ids).record, null);
  const response = new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
  const proof = { binding: bindByteplusInput(outgoing, undefined, records, ids), response, body: response.body };
  assert.deepEqual(byteplusBindingFacts(proof, records, [proof]), { bound: true, responseAdmitted: true });
  assert.equal(byteplusBindingFacts(proof, records, [proof, proof]).bound, false);
  record.response = new Response(null, { status: 400 });
  assert.equal(byteplusBindingFacts(proof, records, [proof]).responseAdmitted, false);
});

function completeCancelProof() {
  return { helperFulfilled: true, receipt: { attempts: 1, valid: true, receipt: { ...cancelReceipt } },
    physical: { tasksFulfilled: true, cancellationBinding: { bound: true, responseAdmitted: true }, inputs: [{ joined: true, locked: false,
      candidates: [{ scenario: "cancel", bound: true, responseAdmitted: true, physical: true, ingressObserved: true, ingressAborted: false, fetchAborted: true }] }] },
    incoming: [{ id: "cancel", path: "/v1/chat/completions", method: "POST", model: `byteplus/${models[0]}` }],
    calls: [{ id: "cancel", url: "https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions", authorization: "Bearer fixture-upstream-cancel", body: { model: models[0], stream: true }, cancelled: true }],
    usage: { budget: { spentMicros: 7 }, usage: { events: [{ credential_id: "byte_cancel", policy_id: "byte_cancel", provider: "byteplus", model: `byteplus/${models[0]}`, status: "client_error",
      actual_cost_micros: 7, cost_basis: "policy_fixed", input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null }] } } };
}
test("final cancellation gate accepts observed false ingress but rejects every missing or contrary independent witness", () => {
  assert.equal(finalCallerCancellation(completeCancelProof()), true);
  const mutations = [
    p => { p.helperFulfilled = false; }, p => { delete p.helperFulfilled; }, p => { p.receipt = undefined; }, p => { p.receipt.attempts = 2; },
    p => { p.receipt.receipt.partialDelivery = false; }, p => { p.physical.tasksFulfilled = false; }, p => { p.physical.inputs[0].locked = true; },
    p => { p.physical.inputs[0].joined = false; }, p => { p.physical.cancellationBinding.bound = false; },
    p => { p.physical.cancellationBinding.responseAdmitted = false; }, p => { p.physical.inputs[0].candidates[0].ingressAborted = null; },
    p => { p.physical.inputs[0].candidates[0].ingressObserved = false; }, p => { p.physical.inputs[0].candidates[0].fetchAborted = false; },
    p => { p.incoming.push({ ...p.incoming[0] }); }, p => { p.calls.push({ ...p.calls[0] }); }, p => { p.calls[0].fixtureExpired = true; },
    p => { p.calls[0].cancelled = false; }, p => { p.calls[0].authorization = "Bearer fixture-foreign"; }, p => { p.usage = undefined; },
    p => { p.usage.usage.events[0].status = "provider_error"; }, p => { p.usage.usage.events[0].status = "deadline_exceeded"; },
    p => { p.usage.usage.events[0].policy_id = "foreign"; }, p => { p.usage.usage.events[0].actual_cost_micros = 0; },
  ];
  for (const mutate of mutations) { const proof = completeCancelProof(); mutate(proof); assert.equal(finalCallerCancellation(proof), false); }
  // Client-error without a successful partial stream cannot qualify a rejection.
  const rejected = completeCancelProof(); rejected.physical.cancellationBinding.responseAdmitted = false;
  assert.equal(finalCallerCancellation(rejected), false);
});

test("Worker original native operations deny foreign early failures, late abort, rejected cancel, locked or pending work", async t => {
  for (const fault of ["early", "late", "cancel", "undefined", "sync", "locked", "pending", "unknown_ingress"]) await t.test(fault, async () => {
    let controller, finishCancel; const signal = new AbortController(), ingress = new Request("https://fixture.example/").signal;
    const reason = new Error("fixture failure");
    const body = new ReadableStream({ start(c) { controller = c; }, cancel() {
      if (fault === "cancel") throw reason;
      if (fault === "undefined") throw undefined;
      if (fault === "pending") return new Promise(resolve => { finishCancel = resolve; });
    } });
    const reader = body.getReader(), trace = workerReaderEvidence(reader, 1, 1, signal.signal, fault === "unknown_ingress" ? undefined : ingress);
    const reading = trace.invoke("read", reader.read, reader, []); void reading.catch(() => {});
    if (fault === "early") { controller.error(reason); await reading.catch(() => {}); }
    if (fault !== "late") signal.abort(reason);
    let canceled;
    try { canceled = trace.invoke("cancel", fault === "sync" ? function () { throw undefined; } : reader.cancel, reader, [reason]); }
    catch (error) { assert.equal(error, undefined); }
    if (fault === "sync") controller.error(reason); // Retire this unit-test source after the synchronous counterexample.
    if (fault === "late") signal.abort(reason);
    if (fault === "pending") { assert.equal(trace.candidate(reading, reason, body), false); finishCancel(); }
    await Promise.allSettled([reading, canceled].filter(Boolean));
    if (fault !== "locked") { trace.unlocking(); reader.releaseLock(); trace.unlocked(); }
    assert.equal(trace.candidate(reading, reason, body), false);
    if (body.locked) reader.releaseLock();
  });
});

test("real Worker cancellation binds admitted partial streaming, physical joins and exact SQLite before disposition", { timeout: 45_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "byteplus-bound-cancel-")); let mf, reader; const failures = [];
  try {
    const { startWorkerdFixture } = await import("./helpers/workerd.mjs");
    mf = await startWorkerdFixture(temporary, routerFixture(), upstreamFixture(), { directRouter: true });
    const kv = await mf.getKVNamespace("POLICY_KV", "router"), id = "cancel";
    await kv.put("policies/byte_cancel", JSON.stringify({ enabled: true, generation: "fixture", tenantId: "fixture", providers: ["byteplus"], models: [`byteplus/${models[0]}`],
      grantRouting: { eligibleGrants: { byteplus: ["byteplus"] }, environmentFallback: false }, monthlyBudgetMicros: 100, requestCostMicros: 7, budgetMode: "reserve", retainRequestContent: false }));
    await kv.put("credentials/byte_cancel", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update("fixture-secret").digest("hex"), policyId: "byte_cancel", policyGeneration: "fixture" }));
    await kv.put("connections/byteplus", JSON.stringify({ providerId: "byteplus", enabled: true }));
    const origin = (await mf.unsafeGetDirectURL("router")).origin;
    assert.equal((await fetch(origin + "/fixture/grants", { method: "POST" })).status, 204);
    const controller = new AbortController();
    const response = await fetch(origin + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key(id)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: `byteplus/${models[0]}`, stream: true, max_tokens: 128, messages: [{ role: "user", content: "fixture" }] }), signal: controller.signal });
    assert.equal(response.status, 200); reader = response.body.getReader();
    let text = ""; const decoder = new TextDecoder();
    while (!text.includes("synthetic-answer")) { const next = await reader.read(); assert.equal(next.done, false); text += decoder.decode(next.value); }
    const closed = reader.closed; void closed.catch(() => {}); controller.abort();
    await Promise.allSettled([reader.cancel(), closed]); reader.releaseLock(); reader = undefined;
    // Control-protocol regression only: this is not an actual SDK/helper receipt.
    const receiptResponse = await fetch(origin + "/fixture/sdk-cancel", { method: "POST", body: JSON.stringify(cancelReceipt) });
    assert.equal(receiptResponse.status, 204);
    const retired = await fetch(origin + "/fixture/retire", { method: "POST" }); assert.equal(retired.status, 200);
    const physical = await retired.json(), observation = await (await fetch(origin + "/fixture/state")).json();
    const upstream = await mf.getWorker("upstream"); let calls, usage;
    for (let n = 0; n < 150; n++) {
      calls = await (await upstream.fetch("https://fixture.example/state")).json();
      usage = await (await fetch(origin + "/v1/usage", { headers: { authorization: `Bearer ${key(id)}` } })).json();
      if ((calls[0]?.cancelled || calls[0]?.aborted) && usage.usage.events.length === 1) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const proof = { physical, receipt: physical.sdkReceipt, helperFulfilled: true, incoming: observation.incoming, calls, usage };
    assert.equal(finalCallerCancellation(proof), true);
    assert.equal(finalCallerCancellation({ ...proof, helperFulfilled: false }), false, "a valid receipt cannot override helper rejection");
    assert.equal(physical.cancellationBinding.responseAdmitted, true);
    assert.equal(physical.inputs.length, 1); assert.ok(physical.inputs.every(input => input.joined && !input.locked));
    const records = await retrieveWorkerEvidence(origin), annotations = [];
    const verdictFailures = finalCallerCancellation(proof) ? [] : [new Error("disposition failed")];
    if (verdictFailures.length) emitWorkerEvidence(records, line => annotations.push(line));
    assert.equal(annotations.length, 0, "successful disposition produces no error annotations");
    assert.ok(cancelSummaryEvidence(physical, calls, usage).every(record => workerEvidence.validate(record)));
  } catch (error) { failures.push(error); }
  finally {
    if (reader) { try { await reader.cancel(); } catch (error) { failures.push(error); } try { reader.releaseLock(); } catch (error) { failures.push(error); } }
    try { await mf?.dispose(); } catch (error) { failures.push(error); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "bound cancellation fixture or cleanup failed");
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
${bindByteplusInput.toString()}
${byteplusBindingFacts.toString()}
${sdkCancelReceiptStore.toString()}
const sdkReceipt = sdkCancelReceiptStore();
const evidence = workerEvidenceProtocol();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
globalThis.fetch = function(input, init) {
  const url = input instanceof Request ? input.url : String(input);
  const binding = url === "https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions" ? bindByteplusInput(input, init, records, ${JSON.stringify(ids)}) : null;
  const pending = Reflect.apply(rawFetch, this, [input, init]);
  if (!binding) return pending;
  const signals = [init?.signal, input instanceof Request ? input.signal : undefined];
  const effectiveSignal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
  const proof = { returned: pending, binding, body: undefined, response: undefined, readers: [], errors: [], candidates: [] }; inputs.push(proof);
  const inputIndex = inputs.length;
  void pending.then(response => {
    try {
      proof.response = response; proof.body = response.body;
      if (!proof.body) { proof.errors.push(new Error("upstream body missing")); return; }
      const getReader = proof.body.getReader;
      proof.body.getReader = function(...args) {
        const reader = Reflect.apply(getReader, this, args);
        const row = { pending: [], unlocked: false, terminal: deferred(), pendingSettled: false, reported: false, evidence: workerReaderEvidence(reader, inputIndex, proof.readers.length + 1, effectiveSignal, binding.record?.signal) }; proof.readers.push(row);
        for (const name of ["read", "cancel"]) {
          const original = reader[name];
          reader[name] = function(...operands) {
            try { const pending = row.evidence.invoke(name, original, this, operands);
              return observeReaderOperation(row.pending, name, pending, signals);
            } catch (error) { proof.errors.push(error); throw error; }
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
    await record.returned.promise; failures.push(...record.errors);
    for (let cursor = 0; cursor < record.pending.length;) {
      const batch = record.pending.slice(cursor); cursor += batch.length;
      for (const result of await Promise.allSettled(batch)) if (result.status === "rejected") failures.push(result.reason);
    }
  }
  const joined = await Promise.allSettled(inputs.map(async proof => {
    await proof.returned;
    const readers = await Promise.allSettled(proof.readers.map(async row => {
      await row.terminal.promise;
      const results = await Promise.allSettled(row.pending.map(operation => operation.pending)); row.pendingSettled = true;
      const failures = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i], operation = row.pending[i];
        if (result.status !== "rejected" || operation.expectedAbort) continue;
        const { bound, responseAdmitted } = byteplusBindingFacts(proof, records, inputs);
        if (bound && responseAdmitted && operation.kind === "read" && row.evidence.candidate(operation.pending, result.reason, proof.body)) {
          // Preserve the original defined rejection. This is only a provisional
          // joined post-termination disposition, never an exception-cause claim.
          if (!proof.candidates.some(candidate => candidate.operation === operation)) proof.candidates.push({ operation, reason: result.reason,
            safe: { scenario: "cancel", bound: true, responseAdmitted: true, ...row.evidence.disposition() } });
        } else failures.push(result.reason);
      }
      if (results.some(result => result.status === "rejected") && !row.reported) {
        row.reported = true; try { for (const snapshot of row.evidence.records(proof.body)) evidence.add({ ...snapshot,
          scenario: proof.binding.id === "cancel" ? "cancel" : "none", ...byteplusBindingFacts(proof, records, inputs),
          disposition: proof.candidates.length ? "provisional" : "unclassified" }); } catch { /* original errors remain */ }
      }
      if (failures.length) throw new AggregateError(failures, "original reader operations failed");
    }));
    const failures = [...proof.errors, ...readers.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
    if (!proof.readers.length) failures.push(new Error("upstream reader observation missing"));
    if (failures.length) throw new AggregateError(failures, "upstream reader retirement failed");
    proof.joined = true;
  }));
  for (const result of joined) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, "original Worker work failed");
  return { requests: records.length, tasksFulfilled: true, sdkReceipt: sdkReceipt.snapshot(),
    cancellationBinding: byteplusBindingFacts(inputs.find(input => input.binding.id === "cancel"), records, inputs), inputs: inputs.map(proof => ({ joined: proof.joined, locked: proof.body.locked,
    candidates: proof.candidates.map(candidate => candidate.safe), readers: proof.readers.map(row => ({ unlocked: row.unlocked, pendingSettled: row.pendingSettled })) })) };
}

export default { ...handler, async fetch(request, env, context) {
  const path = new URL(request.url).pathname;
  if (path === "/fixture/sdk-cancel") return sdkReceipt.receive(request);
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
  if (path === "/v1/chat/completions") incoming.push({ id, path, method: request.method, proxyKey: (request.headers.get("authorization") ?? "").startsWith("Bearer clawrouter-live-byte_"), model: (await request.clone().json()).model });
  const record = { request, signal: request.signal, id, path, method: request.method, kind: path === "/v1/chat/completions" ? "inference" : "catalog", returned: deferred(), pending: [], errors: [], response: undefined };
  if (path === "/v1/catalog" || path === "/v1/chat/completions") records.push(record);
  let response;
  try { response = await handler.fetch(request, { ...env, BYTEPLUS_API_KEY: "must-not-fallback", VOLCANO_ENGINE_API_KEY: "must-not-fallback", ARK_API_KEY: "must-not-fallback", VOLCENGINE_PLAN_API_KEY: "must-not-fallback", BYTEPLUS_PLAN_API_KEY: "must-not-fallback" }, {
    waitUntil(pending) { record.pending.push(pending); context.waitUntil(pending); }
  }); record.response = response; } catch (error) { record.errors.push(error); throw error; } finally { record.returned.resolve(); }
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
