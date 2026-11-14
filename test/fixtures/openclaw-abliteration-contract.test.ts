import { types as nodeTypes } from "node:util";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["abliterated-model-large-flash", "abliterated-model-large-v2", "abliterated-model", "abliterated-model-large"];
const efforts = [["off", "low", "high", "max"], ["off", "low", "high", "max"], ["off", "minimal", "low", "medium", "high", "xhigh", "max"], ["off", "high", "max"]] as const;
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const key = (id: string) => `clawrouter-live-abliteration_${id}-fixture-secret`;


// BEGIN typed diagnostic protocol. The outer fixture executes and embeds this
// exact source; the Worker supplies no exception inspector.
type DiagnosticValue = number | boolean | null;
type DiagnosticContext = { source: string; test: string; scenario: string; operation: string; ordinal: number };
type DiagnosticReason = { kind: string; depth: number; actual: DiagnosticValue; expected: DiagnosticValue };
type DiagnosticObservation = Record<string, DiagnosticValue | string>;
type DiagnosticRecord = DiagnosticContext & { v: number; reasons: DiagnosticReason[]; observation?: DiagnosticObservation };
function diagnosticProtocol(isProxy?: (value: unknown) => boolean) {
  const scenarios = ["m0_off", "m0_low", "m0_high", "m0_max", "m1_off", "m1_low", "m1_high", "m1_max", "m2_off", "m2_minimal", "m2_low", "m2_medium", "m2_high", "m2_xhigh", "m2_max", "m3_off", "m3_high", "m3_max", "simple", "notools", "image0", "image2", "observed", "cached", "invalid", "foreign", "revoked", "unpriced", "error", "cancel"];
  const operations = ["setup", "register", "catalog", "select", "augment", "history", "wrapper", "stream", "result", "assert", "abort", "guard", "acquire", "reader", "read", "cancel", "release", "unlock", "acquisition_join", "release_join", "reader_join", "retirement_assert", "restore", "report", "fixture_start", "provision", "catalog_assert", "sdk_process", "worker_retire", "upstream_assert", "cancel_assert", "usage_wait", "usage_assert", "denial_assert", "dispose", "scratch_cleanup", "capacity"];
  const kinds = ["unknown", "undefined", "null", "primitive", "proxy", "error", "assertion", "abort", "aggregate", "suppressed"];
  const own = (value: object, key: PropertyKey): unknown => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d && Object.hasOwn(d, "value") ? d.value : undefined;
  };
  const object = (value: unknown): value is object => value !== null && typeof value === "object" && !isProxy?.(value);
  const scalar = (value: unknown): value is DiagnosticValue => value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000);
  function identity(test: string, scenario: string) {
    if (test === "T00") return scenario === "none";
    const index = scenarios.indexOf(scenario);
    return index >= 0 && test === `T${String(index < 24 ? index + 1 : index < 28 ? 25 : index - 2).padStart(2, "0")}`;
  }
  function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
    if (!object(value)) return false;
    const actual = Reflect.ownKeys(value);
    return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
  }
  function validate(value: unknown): DiagnosticRecord | null {
    try {
      const hasObservation = object(value) && Object.hasOwn(value, "observation");
      if (!fields(value, ["v", "source", "test", "scenario", "operation", "ordinal", "reasons", ...(hasObservation ? ["observation"] : [])])) return null;
      const v = own(value, "v"), source = own(value, "source"), test = own(value, "test"), scenario = own(value, "scenario"), operation = own(value, "operation"), ordinal = own(value, "ordinal"), raw = own(value, "reasons");
      if (v !== 1 || typeof source !== "string" || !["sdk", "worker", "outer"].includes(source) || typeof test !== "string" || typeof scenario !== "string" || !identity(test, scenario) || typeof operation !== "string" || !operations.includes(operation) || typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 1_000_000 || !object(raw) || !Array.isArray(raw)) return null;
      const length = own(raw, "length");
      if (typeof length !== "number" || length < 1 || length > 4 || Reflect.ownKeys(raw).length !== length + 1) return null;
      const reasons: DiagnosticReason[] = [];
      for (let i = 0; i < length; i++) {
        const r = own(raw, String(i));
        if (!fields(r, ["kind", "depth", "actual", "expected"])) return null;
        const kind = own(r, "kind"), depth = own(r, "depth"), actual = own(r, "actual"), expected = own(r, "expected");
        if (typeof kind !== "string" || !kinds.includes(kind) || typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > 2 || !scalar(actual) || !scalar(expected)) return null;
        reasons.push({ kind, depth, actual, expected });
      }
      const observation = hasObservation ? validateObservation(own(value, "observation")) : undefined;
      if (hasObservation && !observation) return null;
      const result = { v: 1, source, test, scenario, operation, ordinal, reasons, ...(observation ? { observation } : {}) };
      return new TextEncoder().encode(JSON.stringify(result)).byteLength <= 2048 ? result : null;
    } catch { return null; }
  }
  function validateObservation(value: unknown): DiagnosticObservation | null {
    const enums: Record<string, string[]> = {
      site: ["sdk_operation", "sdk_join", "wait_until", "fetch", "observer", "missing_reader", "read_join", "cancel_join"],
      kind: ["read", "cancel", "none"], state: ["invoke", "sync_throw", "fulfilled", "rejected", "pending"],
      closedState: ["pending", "fulfilled", "rejected", "unknown"], closedFinal: ["pending", "fulfilled", "rejected", "unknown"],
      signalScope: ["guard_input", "fetch_input"],
    };
    const numbers = ["input", "reader", "op", "invokeSeq", "settleSeq", "closedSeq", "closedFinalSeq", "readRejectSeq", "unlockCallsBefore", "unlockCalls", "unlockReturns", "unlockInvokeSeq", "unlockReturnSeq", "operations", "settled", "releaseCalls", "releaseSettled", "releaseFulfilled", "acquisitions", "acquisitionSettled"];
    const booleans = ["reasonDefined", "closedReasonDefined", "closedAfterUnlock", "closedFinalReasonDefined", "closedFinalAfterUnlock", "sameClosedFinal", "sameReadFinal", "operandSameRead", "operandSameClosed", "operandSameSignalAtInvoke", "operandSameSignalAtSettle", "readRejectSeen", "readReasonDefined", "operandPresent", "operandDefined", "sameClosed", "sameRead", "sameOperand", "sameSignal", "sameCaller", "signalPresent", "signalAborted", "signalReasonPresent", "signalReasonDefined", "rejectSignalPresent", "rejectSignalAborted", "rejectSignalReasonPresent", "rejectSignalReasonDefined", "callerPresent", "callerAborted", "callerReasonDefined", "rejectCallerPresent", "rejectCallerAborted", "rejectCallerReasonDefined", "effectiveSignalKnown", "eof", "allSettled", "allReleasesFulfilled", "allUnlocked", "bodyLocked", "joinAccepted"];
    if (!object(value)) return null;
    const keys = Reflect.ownKeys(value); if (!keys.length || keys.length > 64) return null;
    const result: DiagnosticObservation = {};
    for (const key of keys) {
      if (typeof key !== "string" || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) return null;
      const v = own(value, key);
      if (Object.hasOwn(enums, key)) { if (typeof v !== "string" || !enums[key].includes(v)) return null; }
      else if (numbers.includes(key)) { if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000)) return null; }
      else if (booleans.includes(key)) { if (v !== null && typeof v !== "boolean") return null; }
      else return null;
      result[key] = v as DiagnosticValue | string;
    }
    return result;
  }
  // Identity-only observation of original products; never waits on reader.closed.
  function readerTrace(reader: ReadableStreamDefaultReader<Uint8Array>, input: number, readerIndex: number, signal: AbortSignal | null | undefined, caller: AbortSignal | undefined, signalScope: "guard_input" | "fetch_input") {
    let sequence = 0, count = 0, settled = 0, unlockCalls = 0, unlockReturns = 0, eof = false, unlockInvokeSeq = 0, unlockReturnSeq = 0;
    let closedState = "pending", closedSeq = 0, closedReason: unknown, closedAfterUnlock = false;
    let originalClosed: Promise<void> | undefined;
    let readSeen = false, readSeq = 0, readReason: unknown;
    const tick = () => sequence = Math.min(sequence + 1, 1_000_000);
    const safe = (fn: () => void) => { try { fn(); } catch { /* observation cannot alter an original outcome */ } };
    const signalState = (value: AbortSignal | null | undefined) => {
      try { return value ? { present: true, aborted: value.aborted, reasonPresent: true, reason: value.reason } : { present: false, aborted: null, reasonPresent: false, reason: undefined }; }
      catch { return { present: null, aborted: null, reasonPresent: null, reason: undefined }; }
    };
    const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && a === b;
    // Capture the actual promise before any consumer can release the lock.
    safe(() => { const closed = reader.closed; originalClosed = closed; void closed.then(() => safe(() => { closedState = "fulfilled"; closedSeq = tick(); closedAfterUnlock = unlockCalls > 0; }), reason => safe(() => { closedState = "rejected"; closedReason = reason; closedSeq = tick(); closedAfterUnlock = unlockCalls > 0; })); });
    type Op = { kind: "read" | "cancel"; index: number; invokeSeq: number; settleSeq: number; state: string; operandPresent: boolean; operand: unknown; unlockBefore: number; signal: ReturnType<typeof signalState>; caller: ReturnType<typeof signalState>; detail?: DiagnosticObservation; reason?: unknown; pending?: Promise<unknown>; rejectSignal?: ReturnType<typeof signalState>; rejectCaller?: ReturnType<typeof signalState> };
    const originalOperations = new Set<Op>();
    const finish = (op: Op, state: string, reason: unknown, value?: unknown) => safe(() => {
      op.state = state; op.reason = reason; op.settleSeq = tick(); settled++;
      if (op.kind === "read" && state === "fulfilled" && object(value) && own(value, "done") === true) eof = true;
      if (op.kind === "read" && state !== "fulfilled") { readSeen = true; readSeq = op.settleSeq; readReason = reason; }
      const atReject = signalState(signal), callerReject = signalState(caller);
      op.rejectSignal = atReject; op.rejectCaller = callerReject;
      op.detail = { closedState, closedSeq, closedReasonDefined: closedState === "rejected" && closedReason !== undefined, closedAfterUnlock,
        readRejectSeen: readSeen, readRejectSeq: readSeq, readReasonDefined: readSeen && readReason !== undefined,
        reasonDefined: state !== "fulfilled" && reason !== undefined,
        sameClosed: state !== "fulfilled" && closedState === "rejected" && same(reason, closedReason),
        sameRead: state !== "fulfilled" && readSeen && same(reason, readReason),
        sameOperand: state !== "fulfilled" && op.operandPresent && same(reason, op.operand),
        sameSignal: state !== "fulfilled" && atReject.aborted === true && same(reason, atReject.reason),
        sameCaller: state !== "fulfilled" && callerReject.aborted === true && same(reason, callerReject.reason),
        rejectSignalPresent: atReject.present, rejectSignalAborted: atReject.aborted, rejectSignalReasonPresent: atReject.reasonPresent, rejectSignalReasonDefined: atReject.reasonPresent === true && atReject.reason !== undefined,
        rejectCallerPresent: callerReject.present, rejectCallerAborted: callerReject.aborted, rejectCallerReasonDefined: callerReject.reasonPresent === true && callerReject.reason !== undefined };
    });
    return {
      begin(kind: "read" | "cancel", operands: unknown[]): Op {
        const operation = { kind, index: ++count, invokeSeq: tick(), settleSeq: 0, state: "invoke", operandPresent: operands.length > 0, operand: operands[0], unlockBefore: unlockCalls, signal: signalState(signal), caller: signalState(caller) };
        originalOperations.add(operation); return operation;
      },
      invoke<F extends (...args: any[]) => Promise<unknown>>(op: Op, original: F, receiver: unknown, operands: unknown[]): ReturnType<F> {
        let pending: ReturnType<F>;
        try { pending = Reflect.apply(original, receiver, operands); } catch (reason) { finish(op, "sync_throw", reason); throw reason; }
        op.pending = pending;
        safe(() => { void pending.then(value => finish(op, "fulfilled", undefined, value), reason => finish(op, "rejected", reason)); });
        return pending;
      },
      unlocking() { safe(() => { unlockCalls++; unlockInvokeSeq = tick(); }); },
      unlocked() { safe(() => { unlockReturns++; unlockReturnSeq = tick(); }); },
      retired() {
        return count > 0 && count === settled && unlockCalls > 0 && unlockReturns === unlockCalls &&
          [...originalOperations].every(op => op.pending !== undefined && (op.state === "fulfilled" || op.state === "rejected"));
      },
      storedErrorCancel(op: Op, pending: Promise<unknown>, reason: unknown, requireCaller: boolean) {
        // Authority is retained original objects/outcomes, never serialized diagnostics.
        return signalScope === "guard_input" && originalOperations.has(op) && op.kind === "cancel" && op.pending === pending &&
          op.state === "rejected" && op.unlockBefore === 0 && reason !== undefined && op.reason === reason &&
          originalClosed !== undefined && closedState === "rejected" && closedReason === reason &&
          [...originalOperations].some(read => read.kind === "read" && read.pending !== undefined && read.state === "rejected" && read.reason === reason) &&
          op.signal.present === true && op.signal.aborted === true && op.signal.reason === reason &&
          op.rejectSignal?.present === true && op.rejectSignal.aborted === true && op.rejectSignal.reason === reason &&
          (!requireCaller || (op.caller.present === true && op.caller.aborted === true && op.caller.reason === reason &&
            op.rejectCaller?.present === true && op.rejectCaller.aborted === true && op.rejectCaller.reason === reason));
      },
      snapshot(op?: Op): DiagnosticObservation {
        return { input, reader: readerIndex, op: op?.index ?? 0, kind: op?.kind ?? "none", state: op?.state ?? "pending", invokeSeq: op?.invokeSeq ?? 0, settleSeq: op?.settleSeq ?? 0,
          signalScope, effectiveSignalKnown: signalScope === "fetch_input", operandPresent: op?.operandPresent ?? false, operandDefined: !!op?.operandPresent && op.operand !== undefined,
          signalPresent: op?.signal.present ?? null, signalAborted: op?.signal.aborted ?? null, signalReasonPresent: op?.signal.reasonPresent ?? null, signalReasonDefined: op ? op.signal.reasonPresent === true && op.signal.reason !== undefined : null,
          callerPresent: op?.caller.present ?? null, callerAborted: op?.caller.aborted ?? null, callerReasonDefined: op ? op.caller.reasonPresent === true && op.caller.reason !== undefined : null,
          ...(signalScope === "fetch_input" ? { unlockInvokeSeq, unlockReturnSeq, operandSameRead: !!op?.operandPresent && readSeen && same(op.operand, readReason), operandSameClosed: !!op?.operandPresent && closedState === "rejected" && same(op.operand, closedReason),
            operandSameSignalAtInvoke: !!op?.operandPresent && op.signal.aborted === true && same(op.operand, op.signal.reason), operandSameSignalAtSettle: !!op?.operandPresent && op.rejectSignal?.aborted === true && same(op.operand, op.rejectSignal.reason) } : {}),
          unlockCallsBefore: op?.unlockBefore ?? 0, ...(op?.detail ?? { closedState, closedSeq }), closedFinal: closedState, closedFinalSeq: closedSeq, closedFinalReasonDefined: closedState === "rejected" && closedReason !== undefined, closedFinalAfterUnlock: closedAfterUnlock,
          sameClosedFinal: !!op && op.state !== "fulfilled" && closedState === "rejected" && same(op.reason, closedReason), sameReadFinal: !!op && op.state !== "fulfilled" && readSeen && same(op.reason, readReason),
          unlockCalls, unlockReturns, operations: count, settled, allSettled: count === settled, eof };
      },
    };
  }
  function classify(reason: unknown): DiagnosticReason[] {
    const result: DiagnosticReason[] = [], seen = new Set<object>();
    function visit(value: unknown, depth: number) {
      if (result.length === 4) return;
      const row: DiagnosticReason = { kind: "unknown", depth, actual: null, expected: null }; result.push(row);
      // No Worker reflection on thrown values. Node rejects Proxy before even
      // requesting descriptors, including proxies in a prototype/aggregate chain.
      if (!isProxy) return;
      if (value === undefined) { row.kind = "undefined"; return; }
      if (value === null) { row.kind = "null"; return; }
      if (typeof value !== "object" && typeof value !== "function") { row.kind = "primitive"; return; }
      if (isProxy(value)) { row.kind = "proxy"; return; }
      if (seen.has(value)) return;
      seen.add(value);
      try {
        let current: object | null = value, name: unknown;
        for (let i = 0; current && i < 3; i++) {
          if (isProxy(current)) break;
          name = own(current, "name");
          if (typeof name === "string") break;
          current = Object.getPrototypeOf(current);
        }
        row.kind = name === "AssertionError" ? "assertion" : name === "AbortError" ? "abort" : name === "AggregateError" ? "aggregate" : name === "Error" || name === "TypeError" ? "error" : "unknown";
        if (row.kind === "assertion") {
          const actual = own(value, "actual"), expected = own(value, "expected");
          row.actual = scalar(actual) ? actual : null; row.expected = scalar(expected) ? expected : null;
        }
        if (row.kind === "aggregate" && depth < 2) {
          const errors = own(value, "errors");
          if (object(errors) && Array.isArray(errors)) {
            const length = own(errors, "length");
            if (typeof length === "number") for (let i = 0; i < Math.min(length, 4) && result.length < 4; i++) {
              const d = Object.getOwnPropertyDescriptor(errors, String(i));
              if (d && Object.hasOwn(d, "value")) visit(d.value, depth + 1);
            }
          }
        }
      } catch { /* Diagnostic classification cannot replace the original throw. */ }
    }
    visit(reason, 0); return result;
  }
  function record(context: DiagnosticContext, reason: unknown, observation?: DiagnosticObservation): DiagnosticRecord {
    return { v: 1, ...context, reasons: classify(reason), ...(observation ? { observation } : {}) };
  }
  function store() {
    const records: DiagnosticRecord[] = []; let suppressed = 0;
    return {
      add(value: unknown) {
        const valid = validate(value); if (!valid) return false;
        if (records.length < 63) records.push(valid); else suppressed = Math.min(suppressed + 1, 1_000_000);
        return true;
      },
      values() {
        return suppressed ? [...records, { v: 1, source: "outer", test: "T00", scenario: "none", operation: "capacity", ordinal: suppressed, reasons: [{ kind: "suppressed", depth: 0, actual: null, expected: null }] }] : [...records];
      },
    };
  }
  async function read(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<string> {
    if (!body) return "";
    const reader = body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const value = await reader.read(); if (value.done) break;
        length += value.value.byteLength;
        if (length > maximum) { await reader.cancel(); throw new Error("diagnostic capacity"); }
        chunks.push(value.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  function relay() {
    const records = store();
    const route = async (request: Request): Promise<Response | null> => {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/diagnostic" && request.method === "POST") {
        try {
          return new Response(null, { status: records.add(JSON.parse(await read(request.body, 2048))) ? 204 : 400 });
        } catch { return new Response(null, { status: 400 }); }
      }
      if (path === "/fixture/diagnostics" && request.method === "GET") return Response.json(records.values());
      return null;
    };
    return Object.assign(route, { add: records.add });
  }
  async function flush(records: DiagnosticRecord[], target: string, send: typeof fetch) {
    if (!records.length) return;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
    try {
      for (const value of records) {
        const valid = validate(value); if (!valid) throw new Error("invalid diagnostic");
        const response = await send(target + "/fixture/diagnostic", { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(valid) });
        await read(response.body, 2048);
        if (response.status !== 204) throw new Error("diagnostic rejected");
      }
    } finally { clearTimeout(timer); }
  }
  return { scenarios, operations, own, identity, validate, record, classify, store, read, relay, flush, readerTrace };
}
// END typed diagnostic protocol.

const diagnostic = diagnosticProtocol(nodeTypes.isProxy);
const diagnosticFetch = globalThis.fetch;
let current: DiagnosticContext = { source: "sdk", test: "T00", scenario: "none", operation: "setup", ordinal: 0 };
let failureRecords = diagnostic.store();
let bodyPassed = false;
const testNames = new Map<string, string>();
function mark(operation: string) { current = { ...current, operation }; }
function remember(context: DiagnosticContext, error: unknown, observation?: DiagnosticObservation) {
  // This observer never throws into an original operation or promise continuation.
  try { failureRecords.add(diagnostic.record(context, error, observation)); } catch { /* original outcome remains authoritative */ }
}
function caseBody<T extends unknown[]>(testId: string, body: (...args: T) => Promise<void>) {
  return async (...args: T) => {
    try { await body(...args); bodyPassed = true; }
    catch (error) {
      try { const bodyFailure = diagnostic.record({ ...current, test: testId }, error); remember(bodyFailure, error); } catch { /* preserve even throw undefined */ }
      throw error;
    }
  };
}
function caseTest(testId: string, title: string, body: () => Promise<void>) {
  testNames.set(title, testId); it(title, caseBody(testId, body));
}
function resultOf<T>(stream: { result(): Promise<T> }): Promise<T> {
  mark("result"); const context = { ...current };
  const pending = stream.result();
  void pending.then(() => { if (current.scenario === context.scenario) mark("assert"); }, error => remember(context, error));
  return pending;
}

// Observe the shipped guard and its original products. Do not stub global fetch:
// that changes the pinned client's SSRF/runtime-dispatcher selection.
const originalGuard = guardedTransport.fetchWithProviderHttpGuard;
const acquisitions: Array<{
  context: DiagnosticContext;
  returned: ReturnType<typeof originalGuard>;
  released: Promise<void>;
  releaseCalls: number;
  releasePending: Promise<void>[];
  releaseSettled: number; releaseFulfilled: number;
  body?: ReadableStream<Uint8Array> | null;
  readers: Array<{ reader: ReadableStreamDefaultReader<Uint8Array>; pending: ReaderOperation[]; unlocked: boolean; trace: ReturnType<typeof diagnostic.readerTrace> }>;
}> = [];
const observationErrors: unknown[] = [];
let started = 0;
let callerSignal: AbortSignal | undefined;

// Pure observation/join functions are also exercised by the outer fixture tests.
type ReaderOperation = { kind: "read" | "cancel"; pending: Promise<unknown>; expectedAbort: boolean; detail?: () => DiagnosticObservation; storedError?: (reason: unknown, requireCaller: boolean) => boolean };
function observeReaderOperation<T extends Promise<unknown>>(operations: ReaderOperation[], kind: ReaderOperation["kind"], pending: T, signals: Array<AbortSignal | null | undefined>): T {
  const operation = { kind, pending, expectedAbort: false }; operations.push(operation);
  void pending.then(() => {}, reason => {
    // Match the original request's exact reason at rejection, never an error name
    // or a signal that only becomes aborted later. SDK cancellation classification
    // is deferred until every original acquisition, release and reader has joined.
    operation.expectedAbort = kind === "read" && reason !== undefined && signals.some(signal => signal?.aborted && signal.reason === reason);
  });
  return pending;
}
async function joinReaderOperations(operations: ReaderOperation[], accepted?: (operation: ReaderOperation, reason: unknown) => boolean, joined?: PromiseSettledResult<unknown>[]) {
  const results = joined ?? await Promise.allSettled(operations.map(operation => operation.pending));
  const failures = results.flatMap((result, index) => result.status === "rejected" && !operations[index].expectedAbort &&
    !(operations[index].kind === "cancel" && accepted?.(operations[index], result.reason)) ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "original reader operations failed");
}
function acceptStoredSdkCancel(context: DiagnosticContext, operation: ReaderOperation, reason: unknown, originalsRetired: boolean) {
  const knownCase = (context.test === "T26" && context.scenario === "error") || (context.test === "T27" && context.scenario === "cancel");
  return originalsRetired && knownCase && operation.kind === "cancel" && reason !== undefined &&
    operation.storedError?.(reason, context.test === "T27") === true;
}


beforeEach(({ task }) => {
  const test = testNames.get(task.name);
  const scenario = test ? diagnostic.scenarios.find(value => diagnostic.identity(test, value))! : "none";
  current = { source: "sdk", test: test ?? "T00", scenario, operation: "setup", ordinal: 0 };
  failureRecords = diagnostic.store(); bodyPassed = false;
  acquisitions.length = 0; observationErrors.length = 0; started = 0; callerSignal = undefined;
  try {
  if (!test) throw new Error("unmapped diagnostic test");
  vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function (options) {
    const context = { ...current, operation: "guard", ordinal: acquisitions.length + 1 };
    let returned: ReturnType<typeof originalGuard>;
    try { returned = Reflect.apply(originalGuard, this, [options]); } catch (error) { remember(context, error); throw error; }
    const signals = [options.signal, options.init?.signal], caller = callerSignal;
    let released!: () => void;
    const row: (typeof acquisitions)[number] = { context, returned, released: new Promise(resolve => { released = resolve; }), releaseCalls: 0, releasePending: [], releaseSettled: 0, releaseFulfilled: 0, readers: [] };
    acquisitions.push(row);
    // Register before returning the same promise, so instrumentation precedes the
    // consumer's continuation without replacing its response or transport.
    void returned.then(result => {
      try {
        row.body = result.response.body;
        const release = result.release;
        vi.spyOn(result, "release").mockImplementation(function () {
          row.releaseCalls++;
          let pending: Promise<void>;
          try { pending = Reflect.apply(release, this, []); } catch (error) { remember({ ...context, operation: "release" }, error); throw error; }
          row.releasePending.push(pending);
          void pending.then(() => { row.releaseSettled++; row.releaseFulfilled++; released(); }, error => { row.releaseSettled++; remember({ ...context, operation: "release" }, error); released(); });
          return pending;
        });
        if (row.body) {
          const getReader = row.body.getReader;
          vi.spyOn(row.body, "getReader").mockImplementation(function (...args) {
            let reader: ReadableStreamDefaultReader<Uint8Array>;
            try { reader = Reflect.apply(getReader, this, args); } catch (error) { remember({ ...context, operation: "reader" }, error); throw error; }
            const trace = diagnostic.readerTrace(reader, context.ordinal, row.readers.length + 1, options.signal ?? options.init?.signal, caller, "guard_input");
            const observed = { reader, pending: [] as ReaderOperation[], unlocked: false, trace };
            row.readers.push(observed);
            for (const name of ["read", "cancel"] as const) {
              const original = reader[name];
              vi.spyOn(reader, name).mockImplementation(function (...operands: unknown[]) {
                const operation = { ...context, operation: name };
                const detail = trace.begin(name, operands);
                let pending: ReturnType<typeof original>;
                try { pending = trace.invoke(detail, original, this, operands); } catch (error) { remember(operation, error, { site: "sdk_operation", ...trace.snapshot(detail) }); throw error; }
                const result = observeReaderOperation(observed.pending, name, pending, signals);
                const observedOperation = observed.pending.at(-1)!;
                observedOperation.detail = () => trace.snapshot(detail);
                observedOperation.storedError = (reason, requireCaller) => trace.storedErrorCancel(detail, observedOperation.pending, reason, requireCaller);
                void pending.then(() => {}, error => { if (name !== "cancel" && !observedOperation.expectedAbort) remember(operation, error, { site: "sdk_operation", ...trace.snapshot(detail) }); });
                return result;
              });
            }
            const unlock = reader.releaseLock;
            vi.spyOn(reader, "releaseLock").mockImplementation(function () {
              trace.unlocking();
              let result: void;
              try { result = Reflect.apply(unlock, this, []); } catch (error) { remember({ ...context, operation: "unlock" }, error); throw error; }
              trace.unlocked(); observed.unlocked = true;
              return result;
            });
            return reader;
          });
        }
      } catch (error) { remember({ ...context, operation: "acquire" }, error); observationErrors.push(error); released(); }
    }, error => { remember({ ...context, operation: "acquire" }, error); released(); });
    return returned;
  });
  } catch (error) { remember({ ...current }, error); throw error; }
});

afterEach(async () => {
  const cleanupFailures: unknown[] = [];
  try {
    mark("acquisition_join");
    const returned = await Promise.allSettled(acquisitions.map(row => row.returned));
    const joined = await Promise.all(acquisitions.map(async row => {
      mark("release_join");
      await row.released;
      const releases = await Promise.allSettled(row.releasePending);
      mark("reader_join");
      const readers = await Promise.all(row.readers.map(observed => Promise.allSettled(observed.pending.map(operation => operation.pending))));
      return { releases, readers };
    }));
    const originalsRetired = bodyPassed && observationErrors.length === 0 && acquisitions.length === started &&
      returned.every(result => result.status === "fulfilled") && acquisitions.every((row, index) =>
        row.releaseCalls > 0 && row.releaseCalls === row.releasePending.length && joined[index].releases.every(result => result.status === "fulfilled") &&
        row.readers.length > 0 && row.body?.locked === false && row.readers.every((observed, readerIndex) => observed.unlocked && observed.trace?.retired() === true &&
          joined[index].readers[readerIndex].every((result, opIndex) => result.status === "fulfilled" || observed.pending[opIndex].kind === "cancel" || observed.pending[opIndex].expectedAbort)));
    const releases = await Promise.all(acquisitions.map(async (row, index) => {
      const readers = await Promise.allSettled(row.readers.map((observed, readerIndex) => joinReaderOperations(observed.pending, (operation, reason) => {
        const accepted = acceptStoredSdkCancel(row.context, operation, reason, originalsRetired);
        if (!accepted) try { remember({ ...row.context, operation: "cancel" }, reason, { site: "sdk_operation", ...operation.detail?.() }); } catch { /* retain original rejection */ }
        return accepted;
      }, joined[index].readers[readerIndex])));
      return [...joined[index].releases, ...readers];
    }));
    // Assertions follow every original join, so one failed observation cannot
    // skip retirement of a later acquisition in the four-denial case.
    const failures = [...returned, ...releases.flat()].flatMap(result => result.status === "rejected" ? [result.reason] : []);
    failures.push(...observationErrors);
    // Vitest retains the test-body failure separately from this afterEach failure.
    if (failures.length) {
      // Snapshot only after the existing joins. Settled is not accepted/retired.
      for (const row of acquisitions) for (const observed of row.readers) for (const operation of observed.pending) {
        if (operation.kind !== "cancel") continue;
        try { remember({ ...row.context, operation: "reader_join" }, undefined, { site: "sdk_join", ...operation.detail?.(),
          acquisitions: acquisitions.length, acquisitionSettled: returned.length, releaseCalls: row.releaseCalls, releaseSettled: row.releaseSettled, releaseFulfilled: row.releaseFulfilled,
          allReleasesFulfilled: row.releasePending.length === row.releaseFulfilled, allUnlocked: row.readers.every(value => value.unlocked), bodyLocked: row.body?.locked ?? null, joinAccepted: false }); } catch { /* preserve original failures */ }
      }
      throw new AggregateError(failures, "Abliteration client retirement failed");
    }
    mark("retirement_assert");
    for (const row of acquisitions) {
      expect(row.releaseCalls).toBeGreaterThan(0);
      expect(row.readers.length).toBeGreaterThan(0);
      expect(row.readers.every(observed => observed.unlocked)).toBe(true);
      expect(row.body?.locked).toBe(false);
    }
    expect(observationErrors).toEqual([]);
    expect(acquisitions).toHaveLength(started);
  } catch (error) { remember({ ...current }, error); cleanupFailures.push(error); }
  finally {
    try { vi.restoreAllMocks(); } catch (error) { remember({ ...current, operation: "restore" }, error); cleanupFailures.push(error); }
    // Physical joins and mock restoration precede any reporting I/O. Vitest
    // retains the original body failure independently, including throw undefined.
    try { await diagnostic.flush(failureRecords.values(), origin, diagnosticFetch); }
    catch (error) { cleanupFailures.push(error); }
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "retirement or diagnostic reporting failed");
});

async function start(id: string, modelId = models[0], options: { apiKey?: string; signal?: AbortSignal; simpleCompletion?: boolean; tools?: boolean; reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; image?: boolean } = {}) {
  if (!diagnostic.identity(current.test, id)) throw new Error("unmapped diagnostic scenario");
  current = { ...current, scenario: id };
  callerSignal = options.signal;
  mark("register");
  const provider = await registerSingleProviderPlugin(plugin);
  mark("catalog");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  mark("select");
  const row = catalog.models.find(row => row.id === modelId);
  expect(row).toBeDefined();
  expect(catalog.models.map(row => row.id)).toEqual(models);
  expect(row!.reasoning, modelId).toBe(true);
  const configured = { ...catalog, baseUrl: origin + "/v1/native/abliteration", models: [row!] };
  const config = { models: { providers: { abliteration: configured } } };
  mark("augment");
  const augmented = await provider.augmentModelCatalog?.({ config });
  expect(augmented).toEqual([expect.objectContaining({ id: modelId, provider: "abliteration" })]);
  const model = { ...row, provider: "abliteration", api: catalog.api, baseUrl: configured.baseUrl } as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: "openai-completions", provider: "abliteration", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: options.image ? [{ type: "text", text: `fixture abliteration_${id}` }, { type: "image", data: image, mimeType: "image/png" }] : `fixture abliteration_${id}`, timestamp: 4 },
  ];
  // Execute the registered provider's actual replay policy and host sanitizer.
  // The proxy URL is explicit configuration; no live-discovery route is invented.
  mark("history");
  const messages = await withOpenClawTestState({ label: "abliteration-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "abliteration", modelId, modelApi: model.api, model, runtimeHandle: { provider: "abliteration", plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(false);
    return sanitizeSessionHistory({ provider: "abliteration", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: `abliteration-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "abliteration", modelApi: model.api, modelId })]),
      messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: options.tools === false ? undefined : [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  mark("wrapper");
  expect(provider.wrapStreamFn).toBeUndefined();
  expect(provider.wrapSimpleCompletionStreamFn).toBeUndefined();
  const wrap = options.simpleCompletion ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const selectedStream = wrap?.({ provider: "abliteration", modelId, model, streamFn: streamSimple }) ?? streamSimple;
  expect(selectedStream).toBe(streamSimple);
  mark("stream");
  started++;
  return selectedStream(model, context, { apiKey: options.apiKey ?? key(id), maxTokens: 128, reasoning: options.reasoning ?? "high", sessionId: "synthetic-cache-affinity", cacheRetention: "long", signal: options.signal });
}

describe("actual Abliteration static catalog and replay through Worker and SQLite", () => {
  let effortId = 0;
  for (const [modelIndex, levels] of efforts.entries()) for (const reasoning of levels) caseTest(`T${String(++effortId).padStart(2, "0")}`, `streams frozen card ${modelIndex} with logical effort ${reasoning}`, async () => {
    const result = await resultOf(await start(`m${modelIndex}_${reasoning}`, models[modelIndex], { reasoning }));
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  caseTest("T19", "runs the actual simple-completion tool/reasoning path", async () => {
    const result = await resultOf(await start("simple", models[0], { simpleCompletion: true }));
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  caseTest("T20", "retains prior tool history as text when no tools are declared", async () => {
    const result = await resultOf(await start("notools", models[0], { tools: false }));
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  for (const index of [0, 2]) caseTest(index === 0 ? "T21" : "T22", `preserves actual image input on frozen card ${index}`, async () => {
    const result = await resultOf(await start(`image${index}`, models[index], { image: true }));
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  caseTest("T23", "uses observed counters when supplied", async () => {
    const result = await resultOf(await start("observed"));
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  caseTest("T24", "keeps cached input and reasoning as subsets of native usage", async () => {
    const result = await resultOf(await start("cached"));
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.usage).toMatchObject({ input: 60, output: 20, cacheRead: 40, totalTokens: 120 });
  });
  caseTest("T25", "denies invalid, foreign, revoked and unknown-dollar calls without ambient-key fallback", async () => {
    for (const [id, apiKey] of [["invalid", "clawrouter-live-abliteration_m0_high-invalid"], ["foreign", key("foreign")], ["revoked", key("revoked")], ["unpriced", key("unpriced")]]) {
      const result = await resultOf(await start(id, models[0], { apiKey }));
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
    }
  });
  caseTest("T26", "retains embedded errors without replay", async () => {
    const result = await resultOf(await start("error"));
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("synthetic-upstream-error");
  });
  caseTest("T27", "cancels the actual native SDK stream after partial delivery", async () => {
    const controller = new AbortController(), stream = await start("cancel", models[0], { signal: controller.signal });
    mark("abort");
    for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
    const result = await resultOf(stream); expect(controller.signal.aborted).toBe(true); expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
