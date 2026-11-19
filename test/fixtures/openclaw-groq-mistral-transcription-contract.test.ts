import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { types as nodeTypes } from "node:util";
import { isMainThread } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { upsertAuthProfileAsync, type OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import * as guardedFetch from "../../src/infra/net/fetch-guard.js";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

// BEGIN audio diagnostic protocol. Executed unchanged by the outer validator.
function audioDiagnosticProtocol(isProxy: (value: unknown) => boolean) {
  type Data = Record<string, string | number | boolean | null>;
  const pin = "6de028c4e960db91bdf87882989cb6756a6429c3", prefix = "AUDIO813_SDK_V1 ";
  const scenarios = ["success", "unpriced", "denied", "stale", "malformed", "partial", "error", "redirect", "truncated", "rotation", "missing_key", "unsafe_headers", "preabort", "abort", "invalid_input"];
  const ids = new Set(["groq", "mistral"].flatMap(provider => scenarios.map(scenario => provider + "_" + scenario)));
  const phases = ["module", "setup", "execute", "body", "original_join", "worker_join", "state_scope", "runtime_restore", "case_outcome", "helper", "worker_abort", "worker_retirement", "upstream_sqlite", "worker_dispose", "scratch_cleanup", "report", "capacity", "checkpoint", "state_cleanup", "state_restore"];
  const checkpointIds = ["groq_success", "groq_rotation", "mistral_success"];
  const checkpoints = ["start", "proxy_profile", "native_profile", "native_rejection", "zero_transport", "proxy_select", "rotate", "old_rejection", "zero_upload", "old_status", "rotated_select", "selected_call", "result", "uploads"];
  const profileSteps = ["proxy_profile", "native_profile"].flatMap(step => ["invoke", "promise", "value", "fulfilled", "rejected", "throw"].map(outcome => step + "_" + outcome));
  checkpoints.push(...profileSteps);
  const errorCodes = { ERR_ASSERTION: "assertion", ERR_MODULE_NOT_FOUND: "module_missing", MODULE_NOT_FOUND: "module_missing", ERR_INVALID_ARG_TYPE: "invalid_argument", ERR_INVALID_STATE: "invalid_state", ERR_WORKER_NOT_RUNNING: "worker_stopped", SQLITE_BUSY: "sqlite_busy", SQLITE_LOCKED: "sqlite_locked", SQLITE_ERROR: "sqlite_error", SQLITE_CANTOPEN: "sqlite_cantopen" };
  const errorNames = { Error: "error", TypeError: "type", RangeError: "range", AbortError: "abort", TimeoutError: "timeout", AssertionError: "assertion" };
  const codeKinds = ["unobserved", "other", ...Object.values(errorCodes)], nameKinds = ["unobserved", "other", ...Object.values(errorNames)];
  const sqlSteps = ["state_request", "state_return", "usage_request", "usage_return", "row", "egress_count", "events_select", "denied_cost", "denied_budget", "wire_url", "wire_method", "wire_redirect", "wire_auth", "wire_other_key", "wire_model", "wire_language", "wire_prompt", "wire_filename", "wire_mime", "wire_bytes", "wire_digest", "wire_fields", "event_count", "event_provider", "event_model", "event_capability", "event_policy", "abort_status", "abort_code", "cancel_calls", "cancel_returns", "cancel_rejected", "producer_pulls", "producer_settled", "producer_pending", "producer_joined", "producer_join_failures", "producer_rejected", "producer_expired", "producer_expiry_at", "producer_timer", "producer_failures", "cost", "cost_basis", "retained", "input_tokens", "output_tokens", "total_tokens", "spent", "privacy", "held", "charged", "complete"];
  const checkpointFor = (caseId: string, checkpoint: string) => checkpoints.includes(checkpoint)
    && (caseId === "groq_rotation" ? !["proxy_profile", "native_profile", "native_rejection", "zero_transport", "proxy_select", ...profileSteps].includes(checkpoint)
      : !["rotate", "old_rejection", "zero_upload", "old_status", "rotated_select"].includes(checkpoint));
  const callOutcomes = ["unseen", "pending", "fulfilled", "rejected", "sync_throw"];
  const detailKeys = ["checkpoint", "callOutcome", "callReasonDefined", "bodyReasonSameAsCallReason"];
  const stateKeys = ["bodyFailurePresent", "callbackFailurePresent", "scopeSameAsCallback", "cleanupOutcome", "restoreEnvOutcome"];
  const summaryKeys = ["gs", "gr", "ms"].flatMap(key => [key + "Step", key + "Call", key + "Defined", key + "Same", key + "Code"]);
  const errorKeys = ["errorCode", "errorName"], transportKeys = ["catalogCount", "uploadCount", "catalogStatus", "uploadStatus"];
  const sqlKeys = ["sqlStep", "sqlCase", "sqlCalls", "sqlEvents", "sqlExpected"];
  const keys = [...errorKeys, ...transportKeys, ...sqlKeys, "returnKind", ...detailKeys, ...stateKeys, ...summaryKeys,"v", "pin", "source", "caseId", "phase", "role", "outcome", "failurePresent", "reasonDefined", "reasonType", "partialDelivery", "records", "invalid", "suppressed"];
  function own(value: unknown, key: string): unknown {
    if (!value || typeof value !== "object" || isProxy(value)) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  }
  function errorClass(error: unknown) {
    const code = own(error, "code"), name = own(error, "name");
    return { errorCode: code === undefined ? "unobserved" : typeof code === "string" && Object.hasOwn(errorCodes, code) ? errorCodes[code as keyof typeof errorCodes] : "other",
      errorName: name === undefined ? "unobserved" : typeof name === "string" && Object.hasOwn(errorNames, name) ? errorNames[name as keyof typeof errorNames] : "other" };
  }
  function validate(value: unknown): Data | undefined {
    if (!value || typeof value !== "object" || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const found = Reflect.ownKeys(value), data: Data = {};
    if (found.length > keys.length) return;
    for (const key of found) {
      if (typeof key !== "string" || !keys.includes(key)) return;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return;
      data[key] = descriptor.value;
    }
    if (data.v !== 1 || data.pin !== pin || !["sdk", "outer"].includes(data.source as string)
      || !(ids.has(data.caseId as string) || data.caseId === null && (data.source === "outer" || data.phase === "module"))
      || !phases.includes(data.phase as string) || !["progress", "primary", "cleanup", "summary"].includes(data.role as string)
      || !["entered", "fulfilled", "rejected", "unknown"].includes(data.outcome as string)
      || typeof data.failurePresent !== "boolean" || data.partialDelivery !== null) return;
    if (data.failurePresent) {
      if (!["undefined", "null", "boolean", "number", "bigint", "string", "symbol", "object", "function"].includes(data.reasonType as string)
        || data.reasonDefined !== (data.reasonType !== "undefined") || data.outcome !== "rejected") return;
    } else if (data.reasonDefined !== null || data.reasonType !== "none" || data.outcome === "rejected") return;
    const has = (key: string) => Object.hasOwn(data, key);
    if (errorKeys.some(has) && (!errorKeys.every(has) || !data.failurePresent || !codeKinds.includes(data.errorCode as string) || !nameKinds.includes(data.errorName as string))) return;
    if (has("returnKind") && (data.source !== "sdk" || !["state_cleanup", "state_restore"].includes(data.phase as string)
      || !["none", "promise", "value"].includes(data.returnKind as string)
      || data.outcome === "fulfilled" && data.returnKind === "none" || data.outcome === "rejected" && data.returnKind === "value")) return;
    if (transportKeys.some(has)) {
      if (data.source !== "sdk" || data.phase !== "body" || !checkpointIds.includes(data.caseId as string) || !data.failurePresent || !transportKeys.every(has)) return;
      for (const key of ["catalogCount", "uploadCount"]) if (!(Number.isSafeInteger(data[key]) && Number(data[key]) >= 0 && Number(data[key]) <= 65535)) return;
      for (const key of ["catalogStatus", "uploadStatus"]) if (!(data[key] === null || Number.isSafeInteger(data[key]) && Number(data[key]) >= 100 && Number(data[key]) <= 599)) return;
    }
    if (sqlKeys.some(has)) {
      if (data.source !== "outer" || data.phase !== "upstream_sqlite" || data.caseId !== null || !sqlKeys.every(has) || !sqlSteps.includes(data.sqlStep as string)
        || !(data.sqlCase === null || ids.has(data.sqlCase as string)) || ![null, 0, 1].includes(data.sqlExpected as number | null)) return;
      for (const key of ["sqlCalls", "sqlEvents"]) if (!(data[key] === null || Number.isSafeInteger(data[key]) && Number(data[key]) >= 0 && Number(data[key]) <= 65535)) return;
      const global = ["state_request", "state_return", "usage_request", "usage_return", "held", "charged", "complete"].includes(data.sqlStep as string);
      if (global ? data.sqlCase !== null : !ids.has(data.sqlCase as string)) return;
      if (global || data.sqlStep === "row") {
        if (data.sqlCalls !== null || data.sqlEvents !== null || data.sqlExpected !== null) return;
      } else if (data.sqlCalls === null || data.sqlExpected === null
        || (["egress_count", "events_select"].includes(data.sqlStep as string) ? data.sqlEvents !== null : data.sqlEvents === null)) return;
    }
    if (detailKeys.some(has) || stateKeys.some(has)) {
      if (data.source !== "sdk" || !checkpointIds.includes(data.caseId as string)
        || !["body", "checkpoint"].includes(data.phase as string) || !detailKeys.every(has)
        || !checkpointFor(data.caseId as string, data.checkpoint as string) || !callOutcomes.includes(data.callOutcome as string)
        || ![true, false, null].includes(data.bodyReasonSameAsCallReason as boolean | null)
        || (["rejected", "sync_throw"].includes(data.callOutcome as string) ? typeof data.callReasonDefined !== "boolean" : data.callReasonDefined !== null)
        || (data.bodyReasonSameAsCallReason !== null && !["rejected", "sync_throw"].includes(data.callOutcome as string))) return;
      if (data.phase === "checkpoint") {
        if (data.role !== "summary" || data.outcome !== "fulfilled" || !stateKeys.every(has)
          || typeof data.bodyFailurePresent !== "boolean" || typeof data.callbackFailurePresent !== "boolean"
          || ![true, false, null].includes(data.scopeSameAsCallback as boolean | null)
          || (!data.callbackFailurePresent && data.scopeSameAsCallback !== null)
          || (!data.bodyFailurePresent && data.bodyReasonSameAsCallReason !== null)
          || !callOutcomes.includes(data.cleanupOutcome as string) || !callOutcomes.includes(data.restoreEnvOutcome as string)) return;
      } else if (stateKeys.some(has) || data.role !== "primary" || !data.failurePresent) return;
    } else if (data.phase === "checkpoint") return;
    if (summaryKeys.some(has)) {
      if (data.source !== "outer" || data.caseId !== null || data.phase !== "report" || data.role !== "summary" || !summaryKeys.every(has)) return;
      for (const [index, key] of ["gs", "gr", "ms"].entries()) {
        if (!codeKinds.includes(data[key + "Code"] as string)
          || !(data[key + "Step"] === null || checkpointFor(checkpointIds[index]!, data[key + "Step"] as string))
          || (data[key + "Step"] === null && (data[key + "Call"] !== "unseen" || data[key + "Code"] !== "unobserved"))
          || !callOutcomes.includes(data[key + "Call"] as string)
          || (["rejected", "sync_throw"].includes(data[key + "Call"] as string) ? typeof data[key + "Defined"] !== "boolean" : data[key + "Defined"] !== null)
          || ![true, false, null].includes(data[key + "Same"] as boolean | null)
          || (data[key + "Same"] !== null && !["rejected", "sync_throw"].includes(data[key + "Call"] as string))) return;
      }
    }
    for (const key of ["records", "invalid", "suppressed"]) if (Object.hasOwn(data, key)
      && !(Number.isSafeInteger(data[key]) && Number(data[key]) >= 0 && Number(data[key]) <= 65535)) return;
    if (new TextEncoder().encode(JSON.stringify(data)).length > 640) return;
    return data;
  }
  function record(context: Data, failed = false, error?: unknown): Data {
    const value = validate({ v: 1, pin, ...context, failurePresent: failed, reasonDefined: failed ? error !== undefined : null,
      reasonType: failed ? error === null ? "null" : typeof error : "none", partialDelivery: null });
    if (!value) throw new Error("invalid audio diagnostic");
    return value;
  }
  function parse(text: unknown, accept: (value: Data) => void) {
    let records = 0, invalid = 0;
    if (text === undefined) return { records, invalid };
    if (typeof text !== "string" || text.length > 2 * 1024 * 1024) return { records, invalid: 1 };
    for (const line of text.split("\n")) {
      if (!line.startsWith(prefix)) continue;
      if (records + invalid >= 512 || line.length > prefix.length + 640) { invalid = Math.min(65535, invalid + 1); continue; }
      let value;
      try { value = validate(JSON.parse(line.slice(prefix.length))); } catch { /* invalid closed record */ }
      if (!value || value.source !== "sdk") { invalid++; continue; }
      accept(value); records++;
    }
    return { records, invalid };
  }
  const keyFor = (row: Data) => [row.source, row.caseId, row.phase, row.role, row.reasonType].join("/");
  const priority = (row: Data) => row.source === "sdk" && row.role === "primary" ? 0
    : row.source === "sdk" && row.phase === "original_join" ? 1
    : row.source === "outer" && row.phase === "worker_retirement" && row.caseId === "groq_abort" ? 2
    : row.source === "outer" && row.phase === "worker_retirement" && row.caseId === "mistral_abort" ? 3
    : row.failurePresent && row.reasonDefined === false ? 4 : row.phase === "report" ? 5
    : row.role === "primary" ? 6 : row.failurePresent ? 7 : 8;
  function emitter(write: (line: string) => unknown) {
    const records = new Map<string, Data>(), essential = new Map<string, Data>(), emitted = new Set<string>();
    let suppressed = 0, failed = false, finished = false, bytes = 0;
    const suppress = () => { suppressed = Math.min(65535, suppressed + 1); };
    function command(row: Data) {
      const line = "::error title=Audio contract diagnostic::" + JSON.stringify(row) + "\n";
      const size = new TextEncoder().encode(line).length;
      if (size > 768 || bytes + size > 8192) throw new Error("audio annotation budget");
      bytes += size; emitted.add(keyFor(row)); write(line);
    }
    function put(value: unknown) {
      const row = validate(value); if (!row) throw new Error("invalid audio annotation");
      failed ||= row.failurePresent === true;
      const groups = [row.source === "sdk" && row.role === "primary" ? "sdk_primary" : null,
        row.source === "sdk" && row.phase === "original_join" ? "sdk_join" : null,
        row.source === "outer" && row.phase === "worker_retirement" && ["groq_abort", "mistral_abort"].includes(row.caseId as string) ? row.caseId as string : null,
        row.failurePresent && row.reasonDefined === false ? "undefined" : null, row.phase === "report" ? "report" : null,
        row.source === "outer" && row.role === "primary" ? "outer_primary" : null,
        row.phase === "upstream_sqlite" && row.failurePresent ? "sql" : null, row.role === "cleanup" && row.failurePresent ? "cleanup" : null];
      for (const group of groups) if (group) {
        const previous = essential.get(group);
        if (!previous || !previous.failurePresent) essential.set(group, row);
      }
      const key = keyFor(row), old = records.get(key);
      if (old) { if (JSON.stringify(old) === JSON.stringify(row)) return; if (old.failurePresent) { suppress(); return; } }
      if (!old && records.size >= 256) {
        const disposable = [...records].sort((a, b) => priority(b[1]) - priority(a[1]))[0]!;
        suppress(); if (priority(disposable[1]) <= priority(row)) return; records.delete(disposable[0]);
      }
      records.set(key, row);
    }
    return { put, checkpoint() {
      // One early record survives a later original cleanup stall; no retry.
      if (!failed || emitted.size || finished) return;
      const row = essential.get("sdk_primary") ?? essential.get("outer_primary");
      if (row) command(row);
    }, flush() {
      if (finished) return; finished = true; if (!failed) return;
      const sorted = [...records.values()].sort((a, b) => priority(a) - priority(b)), selected: Data[] = [];
      // Reserve a representative for each essential failure/retirement family.
      const selectedKeys = new Set(emitted);
      for (const row of [...essential.values(), ...sorted]) if (!selectedKeys.has(keyFor(row))) {
        if (selectedKeys.size < 9) { selected.push(row); selectedKeys.add(keyFor(row)); } else suppress();
      }
      if (suppressed) selected.push(record({ source: "outer", caseId: null, phase: "capacity", role: "summary", outcome: "unknown", suppressed }));
      const failures: unknown[] = [];
      for (const row of selected) {
        try { command(row); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "audio annotation delivery failed");
    } };
  }
  return { prefix, pin, ids, checkpointIds, own, errorClass, validate, record, parse, emitter };
}
// END audio diagnostic protocol.
const audioProtocol = audioDiagnosticProtocol(nodeTypes.isProxy);
let audioRecordCount = 0;
function audioCaseDiagnostics(caseId: string) {
  const failures: unknown[] = [], observers: Promise<unknown>[] = [];
  function mark(phase: string, role: string, outcome: string, failed = false, error?: unknown, detail = {}) {
    try {
      if (++audioRecordCount > 512) throw new Error("audio child diagnostic capacity");
      const value = audioProtocol.record({ source: "sdk", caseId, phase, role, outcome, ...(failed ? audioProtocol.errorClass(error) : {}), ...detail }, failed, error);
      process.stdout.write("\n" + audioProtocol.prefix + JSON.stringify(value) + "\n");
    } catch (failure) { failures.push(failure); }
  }
  function track<T>(phase: string, start: () => T): T {
    let original: T;
    try { original = start(); } catch (error) { mark(phase, "cleanup", "rejected", true, error); throw error; }
    if (original instanceof Promise) observers.push(original.then(() => { mark(phase, "cleanup", "fulfilled"); }, error => { mark(phase, "cleanup", "rejected", true, error); }));
    else mark(phase, "cleanup", "fulfilled");
    return original;
  }
  return { mark, track, async join() { await Promise.all(observers); await finishOwned(failures, []); } };
}

// BEGIN passive assertion checkpoints. The outer tests execute this exact helper.
function audioAssertionCheckpoints(caseId: string, diagnostic: ReturnType<typeof audioCaseDiagnostics>) {
  type Outcome = { outcome: string; failure?: { error: unknown } };
  const active = audioProtocol.checkpointIds.includes(caseId);
  const observers: Promise<unknown>[] = [], failures: unknown[] = [], restorers: Array<() => void> = [];
  const then = Promise.prototype.then;
  let checkpoint = "start", call: Outcome = { outcome: "unseen" };
  const methods: Record<string, Outcome> = { cleanup: { outcome: "unseen" }, restoreEnv: { outcome: "unseen" } };
  let body: { error: unknown } | undefined, callback: { error: unknown } | undefined, scope: { error: unknown } | undefined;
  function safely(action: () => void) { try { action(); } catch (error) { failures.push(error); } }
  function observe<T>(start: () => T, target: Outcome, phase?: string, profileStep?: string): T {
    let returnKind = "none";
    const settle = (outcome: string, failed = false, error?: unknown) => {
      target.outcome = outcome;
      if (target === call && outcome === "fulfilled" && checkpoint === "selected_call") checkpoint = "result";
      if (failed) target.failure = { error };
      if (profileStep) checkpoint = profileStep + "_" + (outcome === "sync_throw" ? "throw" : outcome === "fulfilled" && returnKind === "value" ? "value" : outcome);
      if (phase) diagnostic.mark(phase, "cleanup", failed ? "rejected" : "fulfilled", failed, error, { returnKind });
    };
    let original: T;
    target.outcome = "pending";
    if (profileStep) checkpoint = profileStep + "_invoke";
    if (phase) safely(() => diagnostic.mark(phase, "progress", "entered", false, undefined, { returnKind }));
    try { original = start(); }
    catch (error) { safely(() => settle("sync_throw", true, error)); throw error; }
    const promise = nodeTypes.isPromise(original); returnKind = promise ? "promise" : "value";
    if (profileStep) checkpoint = profileStep + "_" + returnKind;
    if (phase) safely(() => diagnostic.mark(phase, "progress", "entered", false, undefined, { returnKind }));
    if (promise) {
      safely(() => { observers.push(Reflect.apply(then, original, [
        () => safely(() => settle("fulfilled")), (error: unknown) => safely(() => settle("rejected", true, error)),
      ])); });
    } else safely(() => settle("fulfilled"));
    return original;
  }
  function details() {
    return { checkpoint, callOutcome: call.outcome, callReasonDefined: call.failure ? call.failure.error !== undefined : null,
      bodyReasonSameAsCallReason: body && call.failure ? body.error === call.failure.error : null };
  }
  return {
    before(value: string) { if (active) checkpoint = value; },
    call<T extends (...args: never[]) => unknown>(original: T): T {
      if (!active) return original;
      return function(this: unknown, ...args: never[]) {
        const current: Outcome = { outcome: "unseen" }; call = current;
        return observe(() => Reflect.apply(original, this, args), current);
      } as T;
    },
    profile<T extends (...args: never[]) => unknown>(original: T): T {
      if (!active) return original;
      return function(this: unknown, ...args: never[]) {
        const step = checkpoint;
        if (!["proxy_profile", "native_profile"].includes(step)) {
          failures.push(new Error("unbound profile observation"));
          return Reflect.apply(original, this, args);
        }
        return observe(() => Reflect.apply(original, this, args), { outcome: "unseen" }, undefined, step);
      } as T;
    },
    attach(state: object) {
      if (!active) return;
      for (const key of ["cleanup", "restoreEnv"]) safely(() => {
        if (nodeTypes.isProxy(state)) throw new Error("unobservable state owner");
        const descriptor = Object.getOwnPropertyDescriptor(state, key);
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || !descriptor.configurable) throw new Error("unobservable state method");
        const original = descriptor.value;
        const replacement = function(this: unknown, ...args: unknown[]) {
          const current: Outcome = { outcome: "unseen" }; methods[key] = current;
          return observe(() => Reflect.apply(original, this, args), current, key === "cleanup" ? "state_cleanup" : "state_restore");
        };
        Object.defineProperty(state, key, { ...descriptor, value: replacement });
        restorers.push(() => {
          const current = Object.getOwnPropertyDescriptor(state, key);
          if (!current || !("value" in current) || current.value !== replacement || current.writable !== descriptor.writable
            || current.enumerable !== descriptor.enumerable || current.configurable !== descriptor.configurable) throw new Error("state observer ownership changed");
          Object.defineProperty(state, key, descriptor);
          const restored = Object.getOwnPropertyDescriptor(state, key)!;
          if (restored.value !== original || restored.writable !== descriptor.writable || restored.enumerable !== descriptor.enumerable
            || restored.configurable !== descriptor.configurable) throw new Error("state observer restoration failed");
        });
      });
    },
    body(error: unknown) { if (active) body = { error }; },
    callback(error: unknown) { if (active) callback = { error }; },
    scope(error: unknown) { if (active) scope = { error }; },
    scopeRole() { return Object.values(methods).some(value => value.failure) ? "cleanup" : "progress"; },
    details(transports?: Array<{ path: string; status?: number }>, route?: string) {
      if (!active) return {};
      const selected = (path: string) => transports?.filter(item => item.path === path) ?? [];
      const catalog = selected("/v1/catalog"), upload = selected(route ?? "");
      return { ...details(), ...(transports ? { catalogCount: catalog.length, uploadCount: upload.length,
        catalogStatus: catalog.at(-1)?.status ?? null, uploadStatus: upload.at(-1)?.status ?? null } : {}) };
    },
    async join() {
      const outcomes = await Promise.allSettled(observers);
      for (const outcome of outcomes) if (outcome.status === "rejected") failures.push(outcome.reason);
      for (const restore of restorers) safely(restore);
      if (active) safely(() => diagnostic.mark("checkpoint", "summary", "fulfilled", false, undefined, { ...details(),
        bodyFailurePresent: !!body, callbackFailurePresent: !!callback, scopeSameAsCallback: callback && scope ? callback.error === scope.error : null,
        cleanupOutcome: methods.cleanup!.outcome, restoreEnvOutcome: methods.restoreEnv!.outcome }));
      await finishOwned(failures, []);
    },
  };
}
// END passive assertion checkpoints.

type Case = { id: string; provider: "groq" | "mistral"; model: string; route: string; scenario: string };
const sourceHead = "6de028c4e960db91bdf87882989cb6756a6429c3";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const cases = JSON.parse(process.env.CLAWROUTER_CONTRACT_CASES!) as Case[];
const originalFetch = globalThis.fetch;
const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
const originalRuntimeFetch = undici.fetch;
const originalGuard = guardedFetch.fetchWithSsrFGuard;
const token = (row: Case, rotated = false) => `clawrouter-live-${row.id}-${rotated ? "rotated-secret" : "fixture-secret"}`;

async function finishOwned(failures: unknown[], operations: Array<() => unknown>): Promise<void> {
  for (const operation of operations) {
    try { await operation(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "transcription body or owned cleanup failed");
}
// END owned cleanup

type Operation = { kind: string; original: Promise<unknown>; allowedReadAbort: boolean };
type Transport = {
  path: string; credential: string; status?: number; operations: Operation[];
  closeStarted: Promise<void>; closeCalls: Array<{ depth: number; value?: unknown; failure?: { error: unknown } }>;
  readers: Array<{ body: ReadableStream<Uint8Array>; unlocked: boolean }>;
};
function observe(list: Operation[], kind: string, original: Promise<unknown>, signal?: AbortSignal | null) {
  const item: Operation = { kind, original, allowedReadAbort: false }; list.push(item);
  void original.then(undefined, error => { item.allowedReadAbort = kind === "read" && signal?.aborted === true && error === signal.reason; });
  return original;
}
async function joinOriginal(transport: Transport): Promise<void> {
  await transport.closeStarted;
  const failures: unknown[] = [];
  const roots = transport.closeCalls.filter(call => call.depth === 0);
  if (roots.length !== 1) failures.push(new Error("original dispatcher close must run once"));
  for (const call of roots) {
    if (call.failure) failures.push(call.failure.error);
    else if (!call.value || typeof (call.value as Promise<unknown>).then !== "function") failures.push(new Error("missing original dispatcher close promise"));
    else { try { expect(await call.value).toBeNull(); } catch (error) { failures.push(error); } }
  }
  const outcomes = await Promise.allSettled(transport.operations.map(item => item.original));
  outcomes.forEach((outcome, index) => { if (outcome.status === "rejected" && !transport.operations[index]!.allowedReadAbort) failures.push(outcome.reason); });
  for (const reader of transport.readers) if (!reader.unlocked || reader.body.locked) failures.push(new Error("original response reader is still owned"));
  await finishOwned(failures, []);
}
async function control(action: string, row: Case): Promise<Record<string, unknown>> {
  const response = await originalFetch(`${origin}/fixture/${action}/${row.id}`, { method: "POST", headers: { "x-fixture-control": "transcription" } });
  const value = await response.json(); expect(response.status).toBe(200); return value;
}
function wav(): Buffer {
  const bytes = Buffer.alloc(2048, 42);
  bytes.write("RIFF"); bytes.writeUInt32LE(2040, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(2004, 40); return bytes;
}

async function runCase(row: Case): Promise<void> {
  const diagnostic = audioCaseDiagnostics(row.id);
  const checkpoint = audioAssertionCheckpoints(row.id, diagnostic); // passive checkpoint
  const writeProfile = checkpoint.profile(upsertAuthProfileAsync); // passive profile wrapper
  diagnostic.mark("setup", "progress", "entered");
  const failures: unknown[] = [], transports: Transport[] = [], unexpected: unknown[] = [];
  let callbackFailure: { error: unknown } | undefined;
  try {
    await withOpenClawTestState({ prefix: "openclaw-native-transcription-", env: { CLAWROUTER_API_KEY: undefined, GROQ_API_KEY: "must-not-fallback", MISTRAL_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" } }, async state => {
      checkpoint.attach(state); // passive checkpoint
      const bodyFailures: unknown[] = [];
      let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;
      const caller = new AbortController(), callerReason = new Error("original transcription caller abort");
      try {
        expect(isMainThread).toBe(true); // Real host broker, never a simulated SQLite owner.
        expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(sourceHead);
        expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sourceHead);
        expect(cases).toHaveLength(30);
        const observeFetch = async (input: RequestInfo | URL, supplied?: RequestInit): Promise<Response> => {
          const init = supplied as RequestInit & { dispatcher?: import("undici").Dispatcher };
          const url = new URL(input instanceof Request ? input.url : String(input));
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          const credential = headers.get("authorization") ?? "";
          if (url.origin !== origin || url.search || !["/v1/catalog", row.route].includes(url.pathname)
            || ![`Bearer ${token(row)}`, `Bearer ${token(row, true)}`].includes(credential) || headers.has("x-api-key") || !init?.dispatcher) {
            const error = new Error("unexpected registered transcription transport"); unexpected.push(error); throw error;
          }
          const method = init.method ?? (input instanceof Request ? input.method : "GET");
          expect(method).toBe(url.pathname === "/v1/catalog" ? "GET" : "POST");
          const dispatcher = init.dispatcher, close = dispatcher.close;
          let started!: () => void, depth = 0;
          const transport: Transport = { path: url.pathname, credential, operations: [], closeStarted: new Promise(resolve => { started = resolve; }), closeCalls: [], readers: [] };
          transports.push(transport);
          vi.spyOn(dispatcher, "close").mockImplementation(function(this: typeof dispatcher, ...args: unknown[]) {
            const call: Transport["closeCalls"][number] = { depth }; transport.closeCalls.push(call); depth++;
            try { const value = Reflect.apply(close, this, args); call.value = value; return value; }
            catch (error) { call.failure = { error }; throw error; }
            finally { depth--; if (call.depth === 0) started(); }
          } as typeof dispatcher.close);
          const response = await Reflect.apply(originalRuntimeFetch, undici, [input, init]) as unknown as Response;
          transport.status = response.status;
          const body = response.body;
          if (body) {
            const getReader = body.getReader, cancelBody = body.cancel;
            vi.spyOn(body, "cancel").mockImplementation(function(this: typeof body, reason?: unknown) {
              return observe(transport.operations, "cancel", Reflect.apply(cancelBody, this, [reason]), init.signal) as Promise<void>;
            });
            vi.spyOn(body, "getReader").mockImplementation(function(this: typeof body, ...args: unknown[]) {
              const reader = Reflect.apply(getReader, this, args) as ReadableStreamDefaultReader<Uint8Array>;
              const state = { body, unlocked: false }; transport.readers.push(state);
              const read = reader.read, cancel = reader.cancel, unlock = reader.releaseLock;
              vi.spyOn(reader, "read").mockImplementation(function(this: typeof reader) { return observe(transport.operations, "read", Reflect.apply(read, this, []), init.signal) as ReturnType<typeof read>; });
              vi.spyOn(reader, "cancel").mockImplementation(function(this: typeof reader, reason?: unknown) { return observe(transport.operations, "cancel", Reflect.apply(cancel, this, [reason]), init.signal) as Promise<void>; });
              vi.spyOn(reader, "releaseLock").mockImplementation(function(this: typeof reader) { Reflect.apply(unlock, this, []); state.unlocked = true; });
              return reader;
            } as typeof body.getReader);
          }
          return response;
        };
        // Plain pass-through keeps the original guard's genuine dispatcher path.
        vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
          if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw new Error("direct vendor fetch is forbidden");
          return originalFetch(input, init);
        });
        vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: observeFetch });
        const observeGuard: typeof originalGuard = async options => {
          const result = await originalGuard(options);
          const transport = transports.findLast(item => item.path === new URL(String(options.url)).pathname && item.credential === new Headers(options.init?.headers).get("authorization"));
          // Supplemental across module graphs; original transport is mandatory.
          if (!transport) return result;
          return { ...result, release: () => observe(transport.operations, "release", result.release()) as Promise<void> };
        };
        vi.spyOn(guardedFetch, "fetchWithSsrFGuard").mockImplementation(observeGuard);
        vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(observeGuard);
        const filePath = state.path(`${row.id}.wav`); await writeFile(filePath, wav());
        const cfg: OpenClawConfig = { plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
          models: { providers: { clawrouter: { baseUrl: origin + "/v1", apiKey: token(row), headers: { "accept-encoding": "identity" }, request: { allowPrivateNetwork: true }, models: [] } } },
          tools: { media: { models: [{ provider: "clawrouter", model: row.model, capabilities: ["audio"] }], audio: { enabled: true } } } };
        const agentDir = state.agentDir();
        const provider = cfg.models!.providers!.clawrouter!, model = cfg.tools!.media!.models![0]!;
        const params = { cfg, filePath, agentDir, mime: "audio/wav", language: "en", ...(row.provider === "groq" ? { prompt: "Synthetic café 東京" } : {}) };
        const call = checkpoint.call(() => transcribeAudioFile(params, { signal: caller.signal, assertCurrent: () => caller.signal.throwIfAborted() })); // passive call wrapper
        diagnostic.mark("execute", "progress", "entered");
        if (row.scenario === "success") {
          checkpoint.before("proxy_profile"); // passive checkpoint
          await writeProfile({ agentDir, profileId: "clawrouter:audio", credential: { type: "api_key", provider: "clawrouter", key: token(row) } });
          checkpoint.before("native_profile"); // passive checkpoint
          await writeProfile({ agentDir, profileId: `${row.provider}:audio`, credential: { type: "api_key", provider: row.provider, key: "must-not-fallback" } });
          model.profile = `${row.provider}:audio`; /* checkpoint:native_rejection */ checkpoint.before("native_rejection"); await expect(call()).rejects.toThrow(/unavailable for ClawRouter/);
          checkpoint.before("zero_transport"); // passive checkpoint
          expect(transports).toHaveLength(0); /* checkpoint:proxy_select */ checkpoint.before("proxy_select"); model.profile = "clawrouter:audio";
        }
        if (row.scenario === "rotation") {
          checkpoint.before("rotate"); // passive checkpoint
          await control("rotate", row); /* checkpoint:old_rejection */ checkpoint.before("old_rejection"); await expect(call()).rejects.toThrow();
          checkpoint.before("zero_upload"); // passive checkpoint
          expect(transports.filter(value => value.path === row.route)).toHaveLength(0);
          checkpoint.before("old_status"); // passive checkpoint
          expect(transports.at(-1)?.status).toBe(401); /* checkpoint:rotated_select */ checkpoint.before("rotated_select"); provider.apiKey = token(row, true);
        }
        if (row.scenario === "missing_key") delete provider.apiKey;
        if (row.scenario === "unsafe_headers") provider.headers = { "x-api-key": "must-not-replace" };
        if (row.scenario === "invalid_input") params.prompt = row.provider === "mistral" ? "unsupported" : "x".repeat(4097);
        if (row.scenario === "preabort") caller.abort(callerReason);
        if (row.scenario === "abort") {
          pending = call().then(value => ({ value }), error => ({ error }));
          const deadline = Date.now() + 10000;
          let held = false;
          while (Date.now() < deadline) {
            const state = await control("state", row);
            if ((state.calls as Array<{ id: string }>).some(value => value.id === row.id) && state.held === 1) { held = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(held).toBe(true); caller.abort(callerReason);
          const outcome = await pending; expect("error" in outcome).toBe(true);
          // Caller failure is separate from this controlled original Worker abort.
          // No claim that the client disconnect propagated across the service binding.
        } else if (["success", "rotation"].includes(row.scenario)) {
          checkpoint.before("selected_call"); // passive checkpoint
          expect(await call()).toMatchObject({ text: "café 東京 🦊", provider: "clawrouter", model: row.model });
        } else await expect(call()).rejects.toThrow();
        const uploads = transports.filter(value => value.path === row.route);
        checkpoint.before("uploads"); // passive checkpoint
        expect(uploads).toHaveLength(["success", "rotation", "stale", "malformed", "partial", "error", "redirect", "truncated", "abort"].includes(row.scenario) ? 1 : 0);
        if (row.scenario === "stale") expect(uploads[0]?.status).toBe(403);
      } catch (error) { checkpoint.body(error); /* passive body */ bodyFailures.push(error); diagnostic.mark("body", "primary", "rejected", true, error, checkpoint.details(transports, row.route)); }
      try {
        await finishOwned(bodyFailures, [
          () => { if (!caller.signal.aborted) caller.abort(callerReason); },
          () => row.scenario === "abort" && control("abort", row),
          async () => { if (pending) { const result = await pending; expect("error" in result).toBe(true); } },
          ...transports.map(transport => () => diagnostic.track("original_join", () => joinOriginal(transport))),
          () => diagnostic.track("worker_join", () => control("join", row)),
          () => { if (unexpected.length) throw new AggregateError(unexpected, "unexpected transport"); },
        ]);
      } catch (error) { checkpoint.callback(error); /* passive callback */ callbackFailure = { error }; throw error; }
    });
  } catch (error) {
    if (callbackFailure && error !== callbackFailure.error) failures.push(callbackFailure.error);
    failures.push(error);
    checkpoint.scope(error); // passive checkpoint
    diagnostic.mark("state_scope", checkpoint.scopeRole(), "rejected", true, error);
  }
  let finalFailure: { error: unknown } | undefined;
  try {
    await finishOwned(failures, [() => diagnostic.track("runtime_restore", () => vi.restoreAllMocks()),
      () => diagnostic.track("runtime_restore", () => vi.unstubAllGlobals()), () => diagnostic.track("runtime_restore", () => vi.unstubAllEnvs())]);
    diagnostic.mark("case_outcome", "summary", "fulfilled");
  } catch (error) { finalFailure = { error }; diagnostic.mark("case_outcome", "summary", "rejected", true, error); }
  await finishOwned(finalFailure ? [finalFailure.error] : [], [() => checkpoint.join(), () => diagnostic.join()]);
}

describe("registered native Groq/Mistral transcription against shipping Worker", () => {
  it.each(cases)("$id", runCase, 30000);
});
