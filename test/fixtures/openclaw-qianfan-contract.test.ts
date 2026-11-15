import { clampThinkingLevel, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildLiveModelProviderConfig, clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
import { fetchWithSsrFGuard } from "../../src/infra/net/fetch-guard.js";
import { beforeEach, describe, expect, it as nativeIt, vi } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";
import { types as nodeTypes } from "node:util";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["deepseek-v4-pro", "ernie-5.1", "ernie-5.0", "deepseek-v3.2", "ernie-5.0-thinking-preview"];
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const key = (id: string) => `clawrouter-live-qianfan_${id}-fixture-secret`;

// BEGIN QIANFAN FAILURE DIAGNOSTICS
// Extracted unchanged by the outer fixture. This protocol never carries errors,
// request data or the independent successful cancellation receipt.
function qianfanDiagnostics(isProxy: (value: any) => boolean) {
  const prefix = "QIANFAN_DIAGNOSTIC ";
  const cases = ["none", "card0", "card1", "card2", "card3", "card4", "high", "max", "image2", "image4", "catalog", "catalog_denials", "observed", "admission_denials", "error", "cancel"];
  const phases = ["module", "setup", "body", "registration", "catalog", "replay", "dispatch", "original_join", "join_contract", "join_census", "join_rejections", "retirement_router", "retirement_upstream", "release", "binding", "restoration", "mock_cleanup", "cache_cleanup", "worker", "grant", "helper", "receipt", "retirement", "upstream", "sqlite", "dispose", "rm", "overflow"];
  const enums: Record<string, any[]> = { layer: ["sdk", "outer"], route: ["none", "nativechat", "discovery"], caseId: cases, phase: phases,
    role: ["progress", "primary", "cleanup", "summary"], outcome: ["entered", "fulfilled", "rejected", "unknown"],
    category: ["none", "undefined", "null", "assertion", "aggregate", "unknown"],
    signal: [null, "SIGTERM", "SIGKILL", "SIGABRT", "SIGINT", "SIGHUP", "SIGSEGV"],
    observedCode: [null, "ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_REQUIRE_ESM", "ERR_UNKNOWN_FILE_EXTENSION"] };
  const required = ["v", "layer", "route", "caseId", "phase", "role", "outcome", "category"];
  const counts = ["pending", "settled", "operations", "releasePending", "releaseRejected", "sdkRecords", "suppressed"];
  const bools = ["partialDelivery", "callerAborted", "killed"];
  const optional = [...counts, ...bools, "exit", "signal", "observedCode", "bodySucceeded", "releasesFulfilled", "failureFlags", "ownership", "census", "rejections", "omitted", "predicate"];
  // Fixed columns, not arbitrary nested data. See joinDiagnostic() for the
  // operation/state/flag dictionaries. Null means outside the bounded range.
  function vector(value: any, length: number, maximum: number) {
    if (!Array.isArray(value) || isProxy(value) || value.length !== length || Reflect.ownKeys(value).length !== length + 1) return null;
    const result = [];
    for (let i = 0; i < length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      const item = descriptor.value;
      if (item !== null && !(Number.isInteger(item) && item >= 0 && item <= maximum)) return null;
      result.push(item);
    }
    return result;
  }
  function table(value: any, columns: number, maximum: number) {
    if (!Array.isArray(value) || isProxy(value) || value.length > 4 || Reflect.ownKeys(value).length !== value.length + 1) return null;
    const rows = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      const row = descriptor && Object.hasOwn(descriptor, "value") ? vector(descriptor.value, columns, maximum) : null;
      if (!row) return null; rows.push(row);
    }
    return rows;
  }
  function own(value: any, field: string): any {
    try { if (!value || !["object", "function"].includes(typeof value) || isProxy(value)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    } catch { return undefined; }
  }
  function validate(value: any): any {
    try {
      if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) return null;
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key !== "string" || ![...required, ...optional].includes(key)) || required.some(key => !keys.includes(key))) return null;
      const result: any = {};
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
        const item = descriptor.value;
        if (["failureFlags", "ownership", "census", "rejections"].includes(key)) {
          const copy = key === "failureFlags" ? vector(item, 6, 1) : key === "ownership" ? vector(item, 9, 9999)
            : key === "census" ? vector(item, 56, 9999) : table(item, 9, 2097151);
          if (!copy) return null;
          if (key === "rejections" && copy.some((row: any[]) => row[0] === null || row[0] > 13 || ![2, 3].includes(row[1]) || row[2] === null || row.slice(3).some((n: any) => n !== null && n > 9999))) return null;
          result[key] = copy; continue;
        }
        if (key === "bodySucceeded" || key === "releasesFulfilled") { if (item !== null && typeof item !== "boolean") return null; result[key] = item; continue; }
        if (key === "omitted") { if (item !== null && !(Number.isInteger(item) && item >= 0 && item <= 9999)) return null; result[key] = item; continue; }
        if (key === "predicate") { if (!["accepted", "settled", "rejected", "unlocked"].includes(item)) return null; result[key] = item; continue; }
        if (key === "v" ? item !== 1 : enums[key] ? !enums[key].includes(item) : counts.includes(key) ? item !== null && !(Number.isInteger(item) && item >= 0 && item <= 9999)
          : bools.includes(key) ? item !== null && typeof item !== "boolean" : key === "exit" ? item !== null && !(Number.isInteger(item) && Math.abs(item) <= 255) : true) return null;
        result[key] = item;
      }
      return Buffer.byteLength(JSON.stringify(result)) <= 640 ? result : null;
    } catch { return null; }
  }
  function category(error: unknown) {
    if (error === undefined) return "undefined";
    if (error === null) return "null";
    if (own(error, "code") === "ERR_ASSERTION") return "assertion";
    if (Array.isArray(own(error, "errors"))) return "aggregate";
    return "unknown";
  }
  function record(context: any, outcome: string, error?: unknown, facts: any = {}) {
    return validate({ v: 1, ...context, outcome, category: outcome === "rejected" ? category(error) : "none", ...facts });
  }
  function encode(record: any) { const valid = validate(record); return valid ? prefix + JSON.stringify(valid) + "\n" : null; }
  function parse(text: any): any[] {
    if (typeof text !== "string" || text.length > 2 * 1024 * 1024) return [];
    const records: any[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith(prefix) || Buffer.byteLength(line) > 768 || records.length >= 512) continue;
      try { const value = validate(JSON.parse(line.slice(prefix.length))); if (value?.layer === "sdk") records.push(value); } catch { /* not protocol */ }
    }
    return records;
  }
  function child(error: unknown) {
    const stdout = own(error, "stdout"), stderr = own(error, "stderr");
    const records = [...parse(stdout), ...parse(stderr)].slice(0, 512);
    const exit = own(error, "code"), killed = own(error, "killed"), signal = own(error, "signal");
    let observedCode = null;
    for (const text of [stdout, stderr]) if (typeof text === "string" && text.length <= 2 * 1024 * 1024) {
      for (const code of enums.observedCode.filter(Boolean)) if (new RegExp("\\b" + code + "\\b").test(text)) { observedCode = code; break; }
    }
    return { records, metadata: { sdkRecords: records.length, exit: Number.isInteger(exit) && Math.abs(exit) <= 255 ? exit : null,
      killed: typeof killed === "boolean" ? killed : null, signal: enums.signal.includes(signal) ? signal : null, observedCode } };
  }
  function emitter(write: (text: string) => unknown) {
    const seen = new Set<string>(), workerSides = new Set<string>(); let emitted = 0, ordinary = 0, bytes = 0, suppressed = 0, overflow = false;
    function command(value: any) {
      const text = "::error title=Qianfan contract diagnostic::" + JSON.stringify(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A") + "\n";
      const length = Buffer.byteLength(text); if (length > 768 || bytes + length > 8192) return;
      bytes += length; try { write(text); } catch { /* reporting cannot replace the verdict */ }
    }
    function emit(input: any) {
      const value = validate(input); if (!value) return;
      const id = [value.layer, value.route, value.caseId, value.phase, value.role].join("/");
      if (seen.has(id)) return; seen.add(id);
      const worker = value.layer === "outer" && value.route === "none" && value.caseId === "none" && value.role === "cleanup" &&
        ["retirement_router", "retirement_upstream"].includes(value.phase);
      // The first failed SDK join retains its four records plus the helper
      // envelope. Multiple case failures cannot crowd out either Worker side.
      if (emitted >= 9 || (!worker && ordinary >= 7) || (worker && workerSides.has(value.phase))) { suppressed = Math.min(9999, suppressed + 1); return; }
      if (worker) workerSides.add(value.phase); else ordinary++;
      emitted++; command(value);
    }
    function finish() {
      if (!suppressed || overflow) return; overflow = true;
      command(record({ layer: "outer", route: "none", caseId: "none", phase: "overflow", role: "summary" }, "unknown", undefined, { suppressed }));
    }
    return { emit, finish, summary: () => ({ emitted, suppressed, bytes }) };
  }
  // Observe, but return the very same original result/promise. No diagnostic await.
  function observe(original: () => any, notify: (outcome: string, error?: unknown) => void) {
    const safe = (outcome: string, error?: unknown) => { try { notify(outcome, error); } catch { /* original verdict wins */ } };
    safe("entered"); let value;
    try { value = original(); } catch (error) { safe("rejected", error); throw error; }
    if (value instanceof Promise) void value.then(() => safe("fulfilled"), error => safe("rejected", error));
    else safe("fulfilled");
    return value;
  }
  function snapshot(lifetime: any, bindings: any) {
    const summary = lifetime?.summary(), bound = bindings?.bindings.filter((row: any) => row.id === "cancel" && row.kind === "chat");
    return { operations: summary?.operations ?? null, settled: summary?.settled ?? null,
      pending: summary ? summary.operations - summary.settled : null,
      releasePending: lifetime ? lifetime.operations.filter((op: any) => op.kind === "release" && op.state === "pending").length : null,
      releaseRejected: lifetime ? lifetime.operations.filter((op: any) => op.kind === "release" && ["rejected", "sync_throw"].includes(op.state)).length : null,
      partialDelivery: bound?.length === 1 && bound[0].partialDelivery === true ? true : null,
      callerAborted: bound?.length === 1 && bound[0].callerObservation?.abort ? true : null };
  }
  return { cases, phases, own, validate, category, record, encode, parse, child, emitter, observe, snapshot };
}
// END QIANFAN FAILURE DIAGNOSTICS

// BEGIN ORIGINAL LIFETIME OBSERVERS
// The outer fixture executes these exact functions with native streams and
// embeds them in the Worker. Observations never substitute an original product.
type OriginalOperation = {
  kind: string; owner: any; reader?: any; acquisition?: any; pending?: Promise<any>; state: string;
  invoked: number; settled?: number; receiver?: any; operands?: any[]; unlocksAtInvoke?: number;
  guardSignal?: AbortSignal; signalAtInvoke: { aborted: boolean; reason: unknown };
  signalAtReject?: { aborted: boolean; reason: unknown }; value?: unknown; reason?: unknown;
};
function preserveFailures(body: () => unknown, cleanups: Array<() => unknown>) {
  return (async () => {
    const errors: unknown[] = []; let value: unknown;
    try { value = await body(); } catch (error) { errors.push(error); }
    for (const cleanup of cleanups) try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Qianfan body and cleanup failures");
    return value;
  })();
}
function createRequestBindings() {
  const bindings: any[] = [];
  function effective(input: Request | URL | string, init?: RequestInit) {
    const request = input instanceof Request ? input : undefined;
    return { url: new URL(request?.url ?? String(input)), method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers !== undefined ? init.headers : request?.headers) };
  }
  return {
    bindings,
    expect(id: string, kind: string, url: string, method: string, credential: string, caller?: AbortSignal) {
      if (bindings.some(row => row.id === id && row.kind === kind)) throw new Error("duplicate Qianfan binding");
      const row: any = { id, kind, url, method, credential, caller, claimed: false };
      bindings.push(row); return row;
    },
    claim(input: Request | URL | string, init: RequestInit | undefined, kind: string) {
      const actual = effective(input, init), authorization = actual.headers.get("authorization");
      const matches = bindings.filter(row => row.kind === kind && row.url === actual.url.href && row.method === actual.method && authorization === "Bearer " + row.credential);
      if (matches.length !== 1 || matches[0].claimed) throw new Error("unknown, duplicate or ambiguous Qianfan request");
      const row = matches[0]; row.claimed = true; return row;
    },
    verify() { if (bindings.some(row => !row.claimed)) throw new Error("unobserved Qianfan request binding"); },
  };
}
function createLifetimeObserver(sdk?: { bindings: any[]; bodySucceeded: () => boolean }) {
  const operations: OriginalOperation[] = [], errors: unknown[] = [], readers: any[] = [], bodies: any[] = [], guards: any[] = [];
  const restores: Array<() => void> = [], bodyOwners = new WeakMap<object, any>();
  let sequence = 0;
  let lastJoin: any = null;
  const event = () => ++sequence;
  const snapshot = (signal?: AbortSignal) => ({ aborted: signal?.aborted === true, reason: signal?.reason });
  function safe(callback: () => void) { try { callback(); } catch (error) { errors.push(error); } }
  function invocation(owner: any, identity: any = {}) {
    const guardSignal = identity.acquisition?.guardSignal ?? owner?.signal;
    return { ...identity, invoked: event(), guardSignal, signalAtInvoke: snapshot(guardSignal), unlocksAtInvoke: identity.reader?.unlocks };
  }
  function watch(kind: string, pending: any, owner: any, settled?: (value: any) => void, observed = invocation(owner)) {
    const op: OriginalOperation = { kind, owner, ...observed, pending, state: "pending" }; operations.push(op);
    if (!pending || typeof pending.then !== "function") {
      op.state = "fulfilled"; op.value = pending; op.settled = event(); if (settled) safe(() => settled(pending)); return pending;
    }
    // Attach before the caller consumes the same original promise. The signal
    // here is the guard INPUT, never its private internally combined signal.
    void pending.then((value: unknown) => { op.state = "fulfilled"; op.value = value; op.settled = event(); if (settled) safe(() => settled(value)); }, (reason: unknown) => {
      op.state = "rejected"; op.reason = reason; op.settled = event(); op.signalAtReject = snapshot(op.guardSignal);
    });
    return pending;
  }
  function invoke(kind: string, original: (...args: any[]) => any, receiver: any, args: any[], owner: any, settled?: (value: any) => void, identity: any = {}) {
    const observed = invocation(owner, { ...identity, original, receiver, operands: args });
    let value;
    try { value = Reflect.apply(original, receiver, args); }
    catch (reason) { operations.push({ kind, owner, ...observed, state: "sync_throw", reason, settled: event() }); throw reason; }
    return watch(kind, value, owner, settled, observed);
  }
  function patch(target: any, key: string, replacement: (...args: any[]) => any) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
    restores.push(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else if (!Reflect.deleteProperty(target, key)) throw new Error("observer restoration failed"); });
  }
  function signal(owner: any, original?: AbortSignal | null) {
    if (!original) return;
    owner.signal = original; owner.signalAtEntry = snapshot(original); owner.entered = event();
    const aborted = () => safe(() => { owner.abort = { sequence: event(), reason: original.reason }; });
    original.addEventListener("abort", aborted, { once: true }); restores.push(() => original.removeEventListener("abort", aborted));
  }
  function partial(owner: any) { owner.partialDelivery = true; owner.partialSequence = event(); }
  function response(value: Response, owner: any, acquisition?: any) {
    const body = value.body;
    if (!body) return value;
    if (bodyOwners.has(body)) throw new Error("duplicate original response ownership");
    bodyOwners.set(body, owner); bodies.push({ body, owner, acquisition });
    const getReader = body.getReader, cancel = body.cancel;
    patch(body, "cancel", function (...args: any[]) { return invoke("body.cancel", cancel, this, args, owner, undefined, { acquisition }); });
    patch(body, "getReader", function (...args: any[]) {
      let reader: any;
      try { reader = Reflect.apply(getReader, this, args); } catch (reason) { errors.push(reason); throw reason; }
      safe(() => {
        const row = { reader, body, receivedBody: this, owner, acquisition, closed: reader.closed, unlocks: 0, unlocked: 0, eof: false, unlockInvocations: [] as number[], unlockReturns: [] as number[] }; readers.push(row);
        watch("reader.closed", row.closed, owner, undefined, invocation(owner, { reader: row, acquisition }));
        for (const kind of ["read", "cancel"] as const) {
          const original = reader[kind];
          patch(reader, kind, function (...operands: any[]) {
            return invoke("reader." + kind, original, this, operands, owner, kind === "read" ? value => { if (value?.done === true) row.eof = true; } : undefined, { reader: row, acquisition });
          });
        }
        const unlock = reader.releaseLock;
        patch(reader, "releaseLock", function (...operands: any[]) {
          row.unlocks++; row.unlockInvocations.push(event());
          const result = invoke("reader.unlock", unlock, this, operands, owner, undefined, { reader: row, acquisition });
          row.unlocked++; row.unlockReturns.push(event()); return result;
        });
      });
      return reader;
    });
    return value;
  }
  function guard(original: (...args: any[]) => any, receiver: any, args: any[], owner: any) {
    let released!: () => void;
    const row: any = { owner, guardSignal: owner.signal, releaseCalls: 0, acquired: false, hooked: false, released: new Promise<void>(resolve => { released = resolve; }) }; guards.push(row);
    row.returned = invoke("acquire", original, receiver, args, owner, result => {
      row.acquired = true; row.result = result;
      const release = result.release;
      patch(result, "release", function (...operands: any[]) {
        row.releaseCalls++; released(); return invoke("release", release, this, operands, owner, undefined, { acquisition: row });
      });
      row.hooked = true; response(result.response, owner, row);
    }, { acquisition: row });
    return row.returned;
  }
  function sdkAbortDisposition(op: OriginalOperation) {
    // No context is supplied to Worker instances, and join() takes no policy
    // argument. This branch is reachable only in the explicitly bound SDK case.
    if (!sdk || !sdk.bodySucceeded() || op.state !== "rejected" || op.reason === undefined || !["reader.read", "reader.closed", "reader.cancel"].includes(op.kind)) return false;
    const owner = op.owner, row = op.reader, acquisition = op.acquisition;
    if (!row || !readers.includes(row) || row.owner !== owner || row.acquisition !== acquisition || !guards.includes(acquisition)) return false;
    if (owner.id !== "cancel" || owner.kind !== "chat" || owner.method !== "POST" || owner.claimed !== true || !sdk.bindings.includes(owner) ||
      sdk.bindings.filter(binding => binding.id === "cancel" && binding.kind === "chat").length !== 1 || guards.filter(guard => guard.owner === owner).length !== 1) return false;
    const caller = owner.callerObservation;
    if (!owner.caller || caller?.signal !== owner.caller || !caller.abort || !owner.caller.aborted || !owner.partialDelivery ||
      !(caller.entered < owner.partialSequence && owner.partialSequence < caller.abort.sequence)) return false;
    if (acquisition.guardSignal !== owner.signal || op.guardSignal !== acquisition.guardSignal || !acquisition.result || acquisition.result.response.body !== row.body) return false;
    const reason = op.reason;
    const qualifiedRejection = (item: OriginalOperation) => item.reader === row && item.owner === owner && item.acquisition === acquisition && item.state === "rejected" &&
      item.reason === reason && item.guardSignal === acquisition.guardSignal && item.signalAtReject?.aborted === true && item.signalAtReject.reason === reason &&
      typeof item.settled === "number" && caller.abort.sequence < item.settled;
    const closed = operations.find(item => item.kind === "reader.closed" && item.pending === row.closed && item.reader === row);
    const reads = operations.filter(item => item.kind === "reader.read" && item.receiver === row.reader && qualifiedRejection(item));
    if (!closed || !qualifiedRejection(closed) || !reads.some(read => closed.invoked < read.invoked) || !qualifiedRejection(op)) return false;
    if (op.kind === "reader.closed") return op === closed;
    if (op.kind === "reader.read") return reads.includes(op);
    // Stored-error cancellation is a different disposition. Actual no-argument
    // cancel() is retained; its operand is not a cross-layer error witness.
    return op.receiver === row.reader && op.unlocksAtInvoke === 0 && row.unlockInvocations.every(unlock => op.invoked < unlock) &&
      op.signalAtInvoke.aborted === true && op.signalAtInvoke.reason === reason;
  }
  async function join() {
    for (;;) {
      const count = operations.length;
      await Promise.allSettled(operations.flatMap(op => op.pending && typeof op.pending.then === "function" ? [op.pending] : []));
      await Promise.all(guards.filter(row => row.acquired && row.hooked && !row.releaseCalls).map(row => row.released));
      if (count === operations.length && !operations.some(op => op.state === "pending")) break;
    }
    const structural: unknown[] = [...errors];
    const missingRelease = guards.some(row => row.acquired && (!row.hooked || row.releaseCalls < 1));
    const missingConsumer = bodies.some(row => !readers.some(reader => reader.body === row.body) && !operations.some(op => op.kind === "body.cancel" && op.owner === row.owner && op.receiver === row.body));
    const stillOwned = bodies.some(row => row.body.locked) || readers.some(row => row.receivedBody !== row.body || row.unlocks === 0 || row.unlocks !== row.unlocked);
    if (missingRelease) structural.push(new Error("original release not observed"));
    if (missingConsumer) structural.push(new Error("original body consumer not observed"));
    if (stillOwned) structural.push(new Error("original reader still owned"));
    const releases = operations.filter(op => op.kind === "release");
    const releasesFulfilled = guards.every(row => row.acquired && row.returned && typeof row.returned.then === "function" && operations.some(op => op.kind === "acquire" && op.acquisition === row && op.pending === row.returned && op.state === "fulfilled") &&
      releases.filter(op => op.acquisition === row).length === row.releaseCalls && row.releaseCalls > 0) &&
      releases.every(op => op.state === "fulfilled" && op.pending && typeof op.pending.then === "function");
    const rejected = operations.filter(op => (op.state === "rejected" || op.state === "sync_throw") &&
      !(structural.length === 0 && releasesFulfilled && sdkAbortDisposition(op)));
    const failures = [...structural, ...rejected.map(op => op.reason)];
    if (sdk && !releasesFulfilled) failures.push(new Error("original SDK request release not fulfilled"));
    // Diagnostic projection only, after the original verdict has been formed.
    // Never add an observer/reporting failure to, or remove an original from, it.
    try { lastJoin = joinDiagnostic([errors.length > 0, missingRelease, missingConsumer, stillOwned, rejected.length > 0, Boolean(sdk && !releasesFulfilled)], releasesFulfilled); } catch { /* original verdict wins */ }
    if (failures.length) throw new AggregateError(failures, "original Qianfan work failed");
  }
  function joinDiagnostic(flags: boolean[], releasesFulfilled: boolean) {
    const bounded = (n: any) => Number.isInteger(n) && n >= 0 && n <= 9999 ? n : null;
    // census: kind-major x [pending, fulfilled, rejected, sync_throw]. Unknown
    // kinds use the final column group; they are counted, never silently lost.
    const kinds = ["acquire", "reader.closed", "reader.read", "reader.cancel", "reader.unlock", "body.cancel", "release", "fetch", "handler", "waitUntil", "source.pull", "source.cancel", "timer-wake", "other"];
    const states = ["pending", "fulfilled", "rejected", "sync_throw"];
    const census = Array(56).fill(0);
    for (const op of operations) census[(kinds.includes(op.kind) ? kinds.indexOf(op.kind) : 13) * 4 + states.indexOf(op.state)]++;
    const rejected = operations.filter(op => op.state === "rejected" || op.state === "sync_throw");
    const rows = rejected.slice(0, 4).map(op => {
      const row = op.reader, acquisition = op.acquisition, reason = op.reason;
      const related = (kind: string) => row ? operations.filter(item => item.kind === kind && item.reader === row && item.owner === op.owner && item.acquisition === acquisition) : [];
      const closed = related("reader.closed").find(item => item.pending === row.closed);
      // Bit positions 0..20: defined reason, owner bound, reader bound,
      // acquisition bound, same original read/closed/cancel rejection reason,
      // input aborted at invoke/reject, same reason at invoke/reject,
      // invoke before every unlock, settle after first unlock return, original
      // receiver, original closed, EOF, body locked, undefined reason, null
      // reason, same acquisition guard-input signal, guard-input signal present.
      // No private signal access.
      const bits = [reason !== undefined, sdk ? sdk.bindings.includes(op.owner) && op.owner.claimed === true : null,
        Boolean(row && readers.includes(row) && row.owner === op.owner && row.acquisition === acquisition),
        Boolean(acquisition && guards.includes(acquisition) && acquisition.owner === op.owner),
        ...["reader.read", "reader.closed", "reader.cancel"].map(kind => reason !== undefined && related(kind).some(item => item.state === "rejected" && item.reason === reason)),
        op.signalAtInvoke.aborted, op.signalAtReject?.aborted === true,
        reason !== undefined && op.signalAtInvoke.reason === reason, reason !== undefined && op.signalAtReject?.reason === reason,
        Boolean(row && row.unlockInvocations.length && row.unlockInvocations.every((n: number) => op.invoked < n)),
        Boolean(row && row.unlockReturns.length && typeof op.settled === "number" && op.settled > row.unlockReturns[0]),
        Boolean(row && op.receiver === row.reader), Boolean(closed && closed.pending === row.closed), row?.eof === true, row?.body.locked === true,
        reason === undefined, reason === null, Boolean(acquisition && op.guardSignal === acquisition.guardSignal), op.guardSignal !== undefined];
      const mask = bits.reduce((mask: number, value, bit) => value === true ? mask + 2 ** bit : mask, 0);
      return [kinds.includes(op.kind) ? kinds.indexOf(op.kind) : 13, states.indexOf(op.state), mask,
        bounded(op.invoked), bounded(op.settled), bounded(op.unlocksAtInvoke), bounded(row?.unlockInvocations[0]), bounded(row?.unlockReturns[0]), bounded(closed?.settled)];
    });
    return {
      contract: { bodySucceeded: sdk ? sdk.bodySucceeded() : null, failureFlags: flags.map(Number), releasesFulfilled,
        // observer errors, guards, acquired guards, release calls, readers,
        // EOF readers, locked bodies, unlock invocations, successful returns.
        ownership: [errors.length, guards.length, guards.filter(row => row.acquired).length, guards.reduce((n, row) => n + row.releaseCalls, 0), readers.length,
          readers.filter(row => row.eof).length, bodies.filter(row => row.body.locked).length, readers.reduce((n, row) => n + row.unlocks, 0), readers.reduce((n, row) => n + row.unlocked, 0)].map(bounded) },
      census: { census: census.map(bounded) }, rejection: { rejections: rows, omitted: bounded(Math.max(0, rejected.length - rows.length)) },
    };
  }
  async function restore() { const failures: unknown[] = []; for (const undo of restores.splice(0).reverse()) try { undo(); } catch (error) { failures.push(error); } if (failures.length) throw new AggregateError(failures, "Qianfan observer restoration failed"); }
  function summary() { return { operations: operations.length, settled: operations.filter(op => op.state !== "pending").length,
    rejected: operations.filter(op => op.state === "rejected" || op.state === "sync_throw").length + errors.length,
    readers: readers.length, unlocked: readers.filter(row => row.unlocks > 0 && row.unlocks === row.unlocked).length, releases: guards.reduce((n, row) => n + row.releaseCalls, 0) }; }
  return { operations, errors, readers, bodies, guards, watch, invoke, patch, signal, partial, response, guard, join, restore, summary, joinDiagnostic: () => lastJoin };
}
const cancelReceiptLine = 'QIANFAN_CANCEL_RECEIPT {"v":1,"scenario":"cancel","partialDelivery":true,"callerAborted":true,"originalsJoined":true,"restored":true}';
function createCancelReceiptReceiver(context: { diagnostic: (...args: any[]) => any }) {
  let count = 0; const errors: unknown[] = [];
  const diagnostic = context.diagnostic;
  const observed = new Proxy(context, { get(target, property, receiver) {
    if (property !== "diagnostic") return Reflect.get(target, property, receiver);
    return function (...args: any[]) {
      try {
        if (typeof args[0] !== "string") throw new Error("invalid consumer diagnostic");
        for (const line of args[0].split("\n")) {
          const offset = line.indexOf("QIANFAN_CANCEL_RECEIPT ");
          if (offset < 0) continue;
          count++;
          if (count > 1 || line.slice(offset).trim() !== cancelReceiptLine) throw new Error("invalid or duplicate Qianfan cancellation receipt");
        }
      } catch (error) { errors.push(error); }
      return Reflect.apply(diagnostic, context, args);
    };
  } });
  return { context: observed, async finish(original: Promise<unknown>) {
    return preserveFailures(() => original, [() => {
      if (count !== 1) errors.push(new Error("missing or duplicate Qianfan cancellation receipt"));
      if (errors.length) throw new AggregateError(errors, "Qianfan cancellation receipt failed");
    }]);
  } };
}
// END ORIGINAL LIFETIME OBSERVERS

const diagnostic = qianfanDiagnostics(nodeTypes.isProxy);
let diagnosticCase = "none", diagnosticRoute = "none", diagnosticPhase = "module", diagnosticCount = 0;
function sdkDiagnostic(phase: string, role: string, outcome: string, error?: unknown) {
  try {
    if (diagnosticCount >= 512) return;
    const value = diagnostic.record({ layer: "sdk", route: diagnosticRoute, caseId: diagnosticCase, phase, role }, outcome, error, diagnostic.snapshot(lifetime, bindings));
    const line = diagnostic.encode(value); if (line) { diagnosticCount++; process.stdout.write(line); }
  } catch { /* never mask body, original join or cleanup errors */ }
}
function sdkStage(phase: string, route = diagnosticRoute) { diagnosticPhase = phase; diagnosticRoute = route; sdkDiagnostic(phase, "progress", "entered"); }
function sdkCleanup(phase: string, original: () => any) {
  return () => diagnostic.observe(original, (outcome, error) => {
    sdkDiagnostic(phase, "cleanup", outcome, error);
    if (phase === "original_join" && outcome === "rejected") {
      try {
        const details = lifetime.joinDiagnostic();
        for (const [phase, facts] of [["join_contract", details?.contract], ["join_census", details?.census], ["join_rejections", details?.rejection]]) {
          if (!facts || diagnosticCount >= 512) continue;
          const line = diagnostic.encode(diagnostic.record({ layer: "sdk", route: diagnosticRoute, caseId: diagnosticCase, phase, role: "summary" }, "rejected", error, facts));
          if (line) { diagnosticCount++; process.stdout.write(line); }
        }
      } catch { /* original join rejection remains unchanged */ }
    }
    if (phase === "original_join" && outcome !== "entered") sdkDiagnostic("release", "summary", "unknown");
  });
}
function registeredCaseId(name: string, args: any[]) {
  if (name === "streams frozen %s through the registered replay policy") return args[1];
  if (name === "serializes explicit V4 effort %s") return args[0];
  if (name === "preserves actual image input on frozen card %i") return "image" + args[0];
  return ({ "selects the public identity from strict keyed discovery before native dispatch": "catalog",
    "keeps strict empty and denied catalogs closed without static fallback": "catalog_denials",
    "uses observed counters when actually supplied": "observed",
    "denies invalid credentials, foreign policy and unknown-dollar admission without key fallback": "admission_denials",
    "retains embedded errors without replay": "error",
    "cancels the actual native SDK stream after partial delivery": "cancel" } as Record<string, string>)[name] ?? "none";
}
const originalInferenceGuard = guardedTransport.fetchWithProviderHttpGuard;
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createRequestBindings>, caseState: { bodySucceeded: boolean };
let cancelReceiptCount = 0;
sdkDiagnostic("module", "progress", "entered");
beforeEach(async () => {
  diagnosticCase = "none"; diagnosticRoute = "none";
  bindings = createRequestBindings(); caseState = { bodySucceeded: false };
  lifetime = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => caseState.bodySucceeded });
  sdkStage("setup");
  try {
    clearLiveCatalogCacheForTests();
    vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function (...args) {
      const options = args[0], owner = bindings.claim(options.url, options.init, "chat");
      lifetime.signal(owner, options.signal ?? options.init?.signal);
      return lifetime.guard(originalInferenceGuard, this, args, owner);
    });
  } catch (error) { sdkDiagnostic("setup", "primary", "rejected", error); await preserveFailures(() => { throw error; }, [sdkCleanup("original_join", () => lifetime.join()), sdkCleanup("restoration", () => lifetime.restore()), sdkCleanup("mock_cleanup", () => vi.restoreAllMocks()), sdkCleanup("cache_cleanup", () => clearLiveCatalogCacheForTests())]); }
});
async function runCase(body: () => unknown, caseId: string) {
  diagnosticCase = caseId; sdkStage("body", "none");
  await preserveFailures(async () => {
    try { await body(); caseState.bodySucceeded = true; sdkDiagnostic("body", "primary", "fulfilled"); }
    catch (error) { sdkDiagnostic(diagnosticPhase, "primary", "rejected", error); throw error; }
  }, [sdkCleanup("original_join", () => lifetime.join()), sdkCleanup("binding", () => {
    bindings.verify();
    for (const row of bindings.bindings.filter(row => row.caller)) {
      expect(row.callerObservation.signal).toBe(row.caller);
      if (row.id === "cancel") {
        expect(row.partialDelivery).toBe(true); expect(row.callerObservation.abort.reason).toBe(row.caller.reason);
        expect(row.callerObservation.abort.sequence).toBeGreaterThan(row.partialSequence);
      }
    }
  }), sdkCleanup("restoration", () => lifetime.restore()), sdkCleanup("mock_cleanup", () => vi.restoreAllMocks()), sdkCleanup("cache_cleanup", () => clearLiveCatalogCacheForTests())]);
  if (bindings.bindings.some(row => row.id === "cancel" && row.kind === "chat")) {
    if (++cancelReceiptCount !== 1) throw new Error("duplicate Qianfan cancellation receipt emission");
    console.log(cancelReceiptLine);
  }
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body, registeredCaseId(name, []))), {
  each: (values: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(values)(name, (...args) => runCase(() => body(...args), registeredCaseId(name, args))),
});

async function start(id: string, modelId = models[0], options: { apiKey?: string; signal?: AbortSignal; reasoning?: "high" | "max"; image?: boolean; discovered?: Model<"openai-completions"> } = {}) {
  sdkStage("registration", "nativechat");
  const provider = await registerSingleProviderPlugin(plugin);
  sdkStage("catalog");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const row = catalog.models.find(row => row.id === modelId);
  expect(row).toBeDefined();
  const configured = { ...catalog, baseUrl: origin + "/v1/native/qianfan", models: [row!] };
  const config = { models: { providers: { qianfan: configured } } };
  expect(row!.reasoning).toBe(![models[1], models[3]].includes(modelId));
  const model = options.discovered ?? { ...row, provider: "qianfan", api: catalog.api, baseUrl: configured.baseUrl } as Model<"openai-completions">;
  if (options.reasoning) expect(clampThinkingLevel(model, options.reasoning)).toBe("high");
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: "openai-completions", provider: "qianfan", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: options.image ? [{ type: "text", text: `fixture qianfan_${id}` }, { type: "image", data: image, mimeType: "image/png" }] : `fixture qianfan_${id}`, timestamp: 4 },
  ];
  // Execute the registered provider's actual replay policy and host sanitizer.
  // The proxy URL is explicit configuration; no live-discovery route is invented.
  sdkStage("replay");
  const messages = await withOpenClawTestState({ label: "qianfan-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "qianfan", modelId, modelApi: model.api, model, runtimeHandle: { provider: "qianfan", plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe([models[1], models[3]].includes(modelId));
    return sanitizeSessionHistory({ provider: "qianfan", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: `qianfan-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "qianfan", modelApi: model.api, modelId })]),
      messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const invocation = bindings.expect(id, "chat", configured.baseUrl + "/chat/completions", "POST", options.apiKey ?? key(id), options.signal);
  invocation.callerObservation = {}; lifetime.signal(invocation.callerObservation, options.signal);
  sdkStage("dispatch");
  return streamSimple(model, context, { apiKey: options.apiKey ?? key(id), maxTokens: 128, reasoning: options.reasoning, signal: options.signal });
}

async function discovered(id: string) {
  sdkStage("registration", "discovery");
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  bindings.expect(id, "catalog", origin + "/v1/native/qianfan/models", "GET", key(id));
  sdkStage("catalog", "discovery");
  return buildLiveModelProviderConfig({ providerId: "qianfan", endpoint: origin + "/v1/native/qianfan/models",
    fetchGuard: function (...args) {
      const options = args[0], owner = bindings.claim(options.url, options.init, "catalog");
      lifetime.signal(owner, options.signal ?? options.init?.signal);
      return lifetime.guard(fetchWithSsrFGuard, this, args, owner);
    },
    apiKey: key(id), discoveryMode: "strict", models: catalog.models,
    providerConfig: { ...catalog, baseUrl: origin + "/v1/native/qianfan" },
    policy: { allowPrivateNetwork: true }, requireHttps: false });
}

describe("actual Qianfan configured catalog and replay through Worker and SQLite", () => {
  it.each(models.map((model, i) => [model, `card${i}`]))("streams frozen %s through the registered replay policy", async (model, id) => {
    const result = await (await start(id, model)).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it.each(["high", "max"] as const)("serializes explicit V4 effort %s", async reasoning => {
    const result = await (await start(reasoning, models[0], { reasoning })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it.each([2, 4])("preserves actual image input on frozen card %i", async index => {
    const result = await (await start(`image${index}`, models[index], { image: true })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it("selects the public identity from strict keyed discovery before native dispatch", async () => {
    const catalog = await discovered("catalog");
    expect(catalog.models.map(row => row.id)).toEqual([models[0]]);
    const model = { ...catalog.models[0], provider: "qianfan", api: catalog.api, baseUrl: catalog.baseUrl } as Model<"openai-completions">;
    const result = await (await start("catalog", model.id, { discovered: model })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it("keeps strict empty and denied catalogs closed without static fallback", async () => {
    expect((await discovered("empty")).models).toEqual([]);
    await expect(discovered("foreign")).rejects.toThrow();
  });
  it("uses observed counters when actually supplied", async () => {
    const result = await (await start("observed")).result();
    expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  it("denies invalid credentials, foreign policy and unknown-dollar admission without key fallback", async () => {
    for (const [id, apiKey] of [["invalid", "clawrouter-live-qianfan_high-invalid"], ["foreign", key("foreign")], ["unpriced", key("unpriced")]]) {
      const result = await (await start(id, models[0], { apiKey })).result();
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
    }
  });
  it("retains embedded errors without replay", async () => {
    const result = await (await start("error")).result(); expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("synthetic-upstream-error");
  });
  it("cancels the actual native SDK stream after partial delivery", async () => {
    const controller = new AbortController(), stream = await start("cancel", models[0], { signal: controller.signal });
    for await (const event of stream) if (event.type === "text_delta") { lifetime.partial(bindings.bindings.find(row => row.id === "cancel" && row.kind === "chat")!); controller.abort(); break; }
    const result = await stream.result(); expect(controller.signal.aborted).toBe(true); expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
