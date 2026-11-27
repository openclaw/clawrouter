import { clampThinkingLevel, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { createEmptyPluginRegistry, registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
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
import { withPluginRuntimeGenerationRegistryScope } from "../../src/plugins/runtime/generation-state.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";
import { types as nodeTypes } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { APIError } from "openai";
import * as transportStream from "../../packages/ai/src/transports/transport-stream-shared.js";

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
  const phases = ["module", "setup", "body", "registration", "catalog", "replay", "dispatch", "original_join", "join_contract", "join_census", "join_rejections", "retirement_router", "retirement_router_ops", "retirement_upstream", "retirement_upstream_ops", "release", "binding", "restoration", "mock_cleanup", "cache_cleanup", "worker", "grant", "helper", "receipt", "retirement", "upstream", "sqlite", "dispose", "rm", "controls", "overflow", "collection", "control_registration", "product_registration"];
  const enums: Record<string, any[]> = { layer: ["sdk", "outer"], route: ["none", "nativechat", "discovery"], caseId: cases, phase: phases,
    role: ["progress", "primary", "cleanup", "summary"], outcome: ["entered", "fulfilled", "rejected", "unknown"],
    category: ["none", "undefined", "null", "assertion", "aggregate", "unknown"],
    signal: [null, "SIGTERM", "SIGKILL", "SIGABRT", "SIGINT", "SIGHUP", "SIGSEGV"],
    observedCode: [null, "ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_REQUIRE_ESM", "ERR_UNKNOWN_FILE_EXTENSION"] };
  const required = ["v", "layer", "route", "caseId", "phase", "role", "outcome", "category"];
  const counts = ["pending", "settled", "operations", "releasePending", "releaseRejected", "sdkRecords", "suppressed"];
  const bools = ["partialDelivery", "callerAborted", "killed"];
  const optional = [...counts, ...bools, "exit", "signal", "observedCode", "bodySucceeded", "releasesFulfilled", "failureFlags", "ownership", "census", "rejections", "omitted", "predicate", "releaseTrace", "releaseOmitted", "work", "retirement", "folded", "controlCounts", "controlSequence", "controlFlags", "sdkAt", "sdkFault", "fault", "controlAt", "retirementChecks"];
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
        if (["failureFlags", "ownership", "census", "rejections", "releaseTrace", "work", "retirement", "folded", "controlCounts", "controlSequence", "controlFlags", "sdkAt", "sdkFault", "fault", "controlAt", "retirementChecks"].includes(key)) {
          const copy = key === "sdkAt" ? vector(item, 3, 40) : ["sdkFault", "fault"].includes(key) ? vector(item, 5, 9999) : key === "controlAt" ? vector(item, 2, 12) : key === "retirementChecks" ? vector(item, 8, 3) : key === "controlCounts" ? vector(item, 7, 9999) : key === "controlSequence" ? vector(item, 8, 9999) : key === "controlFlags" ? vector(item, 6, 1) : key === "failureFlags" ? vector(item, 6, 1) : key === "ownership" ? vector(item, 9, 9999)
            : key === "census" ? vector(item, 56, 9999) : key === "work" ? vector(item, 8, 9999) : key === "retirement" ? vector(item, 5, 9999)
            : key === "folded" ? vector(item, 7, 9999) : key === "releaseTrace" ? table(item, 8, 1048575) : table(item, 12, 8388607);
          if (!copy) return null;
          if (key === "sdkAt" && copy.some((n: any, i: number) => n !== null && n >= [phases.length, enums.outcome.length, enums.category.length][i])) return null;
          if (["fault", "sdkFault"].includes(key) && copy.some((n: any, i: number) => n !== null && n > [9, 5, 4, 9999, 4][i])) return null;
          if (key === "controlAt" && (copy[0] !== null && copy[0] > 11 || copy[1] === null || copy[1] > 6)) return null;
          if (key === "controlCounts" && (copy[0] !== 12 || copy.slice(1, 4).some((n: any) => n === null || n > 4095) || (copy[2] & copy[3]) !== 0 || ((copy[2] | copy[3]) & ~copy[1]) !== 0)) return null;
          if (key === "retirement" && copy.slice(0, 2).some((n: any) => n !== null && n > 1)) return null;
          if (key === "rejections" && copy.some((row: any[]) => row[0] === null || row[0] > 13 || ![2, 3].includes(row[1]) || row[2] === null || row.slice(3).some((n: any) => n !== null && n > 9999) || row[9] === null || row[9] > 19 || row[10] === null || row[10] > 2)) return null;
          if (key === "releaseTrace" && (copy.length > 2 || copy.some((row: any[]) => row[0] === null || row[0] > 19 || row[1] === null || row[1] > 2 || row[6] === null || row.some((n: any, i: number) => i !== 6 && n !== null && n > 9999)))) return null;
          result[key] = copy; continue;
        }
        if (key === "bodySucceeded" || key === "releasesFulfilled") { if (item !== null && typeof item !== "boolean") return null; result[key] = item; continue; }
        if (key === "omitted" || key === "releaseOmitted") { if (item !== null && !(Number.isInteger(item) && item >= 0 && item <= 9999)) return null; result[key] = item; continue; }
        if (key === "predicate") { if (!["none", "response", "accepted", "settled", "rejected", "unlocked"].includes(item)) return null; result[key] = item; continue; }
        if (key === "v" ? item !== 1 : enums[key] ? !enums[key].includes(item) : counts.includes(key) ? item !== null && !(Number.isInteger(item) && item >= 0 && item <= 9999)
          : bools.includes(key) ? item !== null && typeof item !== "boolean" : key === "exit" ? item !== null && !(Number.isInteger(item) && Math.abs(item) <= 255) : true) return null;
        result[key] = item;
      }
      return Buffer.byteLength(JSON.stringify(result)) <= 640 ? result : null;
    } catch { return null; }
  }
  // Only own DATA properties; names/codes are mapped to closed ordinals.
  function fault(error: unknown) {
    const type = error === null ? 1 : ["undefined", "boolean", "number", "string", "bigint", "symbol", "function", "object"].indexOf(typeof error) + 2;
    const name = ["Error", "TypeError", "SyntaxError", "ReferenceError", "AssertionError", "AggregateError"].indexOf(own(error, "name"));
    const code = enums.observedCode.indexOf(own(error, "code"));
    const reasons = own(error, "errors"); let count = null, undefinedCount = null;
    if (!isProxy(reasons) && Array.isArray(reasons)) {
      const length = own(reasons, "length");
      if (Number.isInteger(length) && length >= 0 && length <= 9999) {
        count = length; undefinedCount = 0;
        for (let i = 0; i < Math.min(length, 4); i++) {
          const descriptor = Object.getOwnPropertyDescriptor(reasons, String(i));
          if (!descriptor || !Object.hasOwn(descriptor, "value")) { undefinedCount = null; break; }
          if (descriptor.value === undefined) undefinedCount++;
        }
      }
    }
    return [type, name < 0 ? null : name, code < 0 ? null : code, count, undefinedCount];
  }
  function boundary(value: any) {
    const valid = validate(value); return valid ? [phases.indexOf(valid.phase), enums.outcome.indexOf(valid.outcome), enums.category.indexOf(valid.category)] : [null, null, null];
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
    const seen = new Set<string>(), slots = new Set<string>();
    const folded = Array(7).fill(0); // dispose ok/fail, rm ok/fail, generic ok/fail, other
    let emitted = 0, bytes = 0, suppressed = 0, overflow = false;
    function command(value: any) {
      const text = "::error title=Qianfan contract diagnostic::" + JSON.stringify(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A") + "\n";
      const length = Buffer.byteLength(text); if (length > 768 || bytes + length > 8192) return;
      bytes += length; try { write(text); } catch { /* reporting cannot replace the verdict */ }
    }
    function emit(input: any) {
      const value = validate(input); if (!value) return;
      const id = [value.layer, value.route, value.caseId, value.phase, value.role].join("/");
      if (seen.has(id)) return; seen.add(id);
      const workerPhase = value.layer === "outer" && value.route === "none" && value.caseId === "none" && value.role === "cleanup" &&
        ["retirement_router", "retirement_router_ops", "retirement_upstream", "retirement_upstream_ops"].includes(value.phase);
      const slot = workerPhase ? value.phase : value.layer === "outer" && value.phase === "receipt" ? "receipt"
        : value.layer === "outer" && value.role === "primary" ? "helper"
        : value.layer === "sdk" && ["join_contract", "join_census", "join_rejections"].includes(value.phase) ? value.phase
        : value.layer === "sdk" && value.role === "primary" && value.outcome === "rejected" ? "join_contract" : null;
      // Nine fixed essential slots; optional cleanup summaries are counted,
      // never treated as accepted retirement or allowed to crowd out identity.
      if (!slot || slots.has(slot) || emitted >= 9) {
        suppressed = Math.min(9999, suppressed + 1);
        const offset = value.phase === "dispose" ? 0 : value.phase === "rm" ? 2 : 4;
        const index = value.outcome === "fulfilled" ? offset : value.outcome === "rejected" ? offset + 1 : 6;
        folded[index] = Math.min(9999, folded[index] + 1); return;
      }
      slots.add(slot);
      emitted++; command(value);
    }
    function finish() {
      if (!suppressed || overflow) return; overflow = true;
      command(record({ layer: "outer", route: "none", caseId: "none", phase: "overflow", role: "summary" }, "unknown", undefined, { suppressed, folded }));
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
  return { cases, phases, own, validate, category, fault, boundary, record, encode, parse, child, emitter, observe, snapshot };
}
// END QIANFAN FAILURE DIAGNOSTICS

// BEGIN PINNED CONTROL BOOKKEEPING
const pinnedControlIds = ["done", "embedded", "release", "caller", "timeout", "preabort", "binding", "prior_foreign", "undefined", "pending_release", "failed_release", "unlock"] as const;
function createPinnedControlSummary() {
  let entered = 0, passed = 0, failed = 0, pending = 0, cleanup = 0, deadline = 0;
  let current: number | null = null, stage = 0;
  let sequence: Array<number | null> = Array(8).fill(null), flags: Array<number | null> = Array(6).fill(null);
  const bit = (id: string) => { const index = pinnedControlIds.indexOf(id as any); if (index < 0) throw new Error("unknown pinned control"); return 2 ** index; };
  const bounded = (n: any) => Number.isInteger(n) && n >= 0 && n <= 9999 ? n : null;
  return {
    start(id: string) { const value = bit(id); if (entered & value) throw new Error("duplicate pinned control"); entered |= value; current = pinnedControlIds.indexOf(id as any); stage = 1; },
    stage(value: number) { stage = value; },
    finish(id: string, ok: boolean) { const value = bit(id); if (!(entered & value) || ((passed | failed) & value)) throw new Error("invalid pinned control completion"); if (ok) passed |= value; else failed |= value; },
    pending(n: number) { pending += n; }, cleanup() { cleanup++; }, deadline() { deadline++; },
    embedded(life: ReturnType<typeof createLifetimeObserver>, owner: any) {
      const op = (kind: string) => life.operations.find(row => row.kind === kind);
      sequence = [owner.abort?.sequence, op("release")?.invoked, op("release")?.returned, op("release")?.settled,
        life.operations.find(row => row.kind === "reader.read" && row.state === "rejected")?.settled, op("reader.closed")?.settled, op("reader.cancel")?.settled, life.readers[0]?.unlockReturns[0]].map(bounded);
      const proof = life.joinDiagnostic(); if (proof) flags = proof.contract.failureFlags;
    },
    facts() { return { controlAt: [current, stage], controlCounts: [12, entered, passed, failed, (passed | failed) === entered ? bounded(pending) : null, pending === 0 && (passed | failed) === entered ? bounded(cleanup) : null, bounded(deadline)], controlSequence: sequence.slice(), controlFlags: flags.slice() }; },
  };
}
function requirePinnedControlAdmission(fetchValue: any, mocked: boolean, managed: boolean, runtime: any, installed: any, version: unknown) {
  if (typeof fetchValue !== "function" || mocked || managed || version !== "7.43.0" ||
      runtime.fetch !== installed.fetch || runtime.Agent !== installed.Agent || runtime.ProxyAgent !== installed.ProxyAgent) throw new Error("pinned control admission failed");
}
// END PINNED CONTROL BOOKKEEPING

// BEGIN ORIGINAL LIFETIME OBSERVERS
// The outer fixture executes these exact functions with native streams and
// embeds them in the Worker. Observations never substitute an original product.
type OriginalOperation = {
  kind: string; owner: any; reader?: any; acquisition?: any; pending?: Promise<any>; state: string;
  invoked: number; settled?: number; receiver?: any; operands?: any[]; unlocksAtInvoke?: number;
  guardSignal?: AbortSignal; signalAtInvoke: { aborted: boolean; reason: unknown };
  signalAtReject?: { aborted: boolean; reason: unknown }; returned?: number; signalAtReturn?: { aborted: boolean; reason: unknown }; signalAtSettle?: { aborted: boolean; reason: unknown }; value?: unknown; reason?: unknown;
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
// Test-only hooks bind the real operation and its actual read-failure handler.
// This proves the committed logical outcome, never the native error's cause.
function createWorkerOutcomeWitness(lifetime: any, ingress: any[], outbound: any[], Operation: any, kind = "chat") {
  const rows = new Map<any, any>(), stops = new Map<any, any>(), rejected = new Set<any>();
  const activeCancels = new Map<any, any>(), downstream = new Map<any, any>();
  const status = Object.getOwnPropertyDescriptor(Operation.prototype, "status")!.get!;
  const delivery = Object.getOwnPropertyDescriptor(Operation.prototype, "delivery")!.get!;
  const received = Object.getOwnPropertyDescriptor(Operation.prototype, "receivedRejection")!.get!;
  const own = (value: any, key: string) => { const d = Object.getOwnPropertyDescriptor(value, key); return d && Object.hasOwn(d, "value") ? d.value : undefined; };
  const note = (fn: () => void) => { try { fn(); } catch (error) { lifetime.errors.push(error); } };
  const originalCancel = Operation.prototype.cancel, originalStop = Operation.prototype.stop, originalRejection = Operation.prototype.acceptRejection;
  lifetime.patch(Operation.prototype, "acceptRejection", function (this: any, ...args: any[]) {
    // History is sticky even when revokeRejection later clears billing evidence.
    note(() => { rejected.add(this); });
    return Reflect.apply(originalRejection, this, args);
  });
  lifetime.patch(Operation.prototype, "cancel", function (this: any, ...args: any[]) {
    let record: any, parent: any;
    note(() => { parent = activeCancels.get(this); record = { operation: this, args, entered: lifetime.stamp(), returned: 0, threw: false }; activeCancels.set(this, record); });
    try {
      const value = Reflect.apply(originalCancel, this, args);
      note(() => { if (record) record.returned = lifetime.stamp(); }); return value;
    } catch (error) { note(() => { if (record) record.threw = true; }); throw error; }
    finally { note(() => { if (parent) activeCancels.set(this, parent); else activeCancels.delete(this); }); }
  });
  lifetime.patch(Operation.prototype, "stop", function (this: any, ...args: any[]) {
    let record: any;
    note(() => {
      if (stops.has(this)) return;
      const binding = rows.get(this), incoming = binding?.owner?.ingress, cancel = activeCancels.get(this);
      const pending = binding?.reading && lifetime.operations.filter((op: any) => op.reader?.reader === binding.reader && op.kind === "reader.read" && op.invoked > binding.readStart);
      record = { operation: this, entered: lifetime.stamp(), args, cancel, returned: 0, threw: false, binding,
        beforeStatus: Reflect.apply(status, this, []), beforeDelivery: Reflect.apply(delivery, this, []),
        received: Reflect.apply(received, this, []), priorRejection: rejected.has(this),
        pending: pending?.length === 1 && pending[0].state === "pending" ? pending[0] : undefined,
        origin: !!cancel && (incoming?.abort?.sequence < cancel.entered && incoming.signal === own(this, "caller")
          || downstream.get(this)?.reason === cancel.args[0] && downstream.has(this)) };
      stops.set(this, record);
    });
    let value;
    try { value = Reflect.apply(originalStop, this, args); }
    catch (error) { note(() => { if (record) record.threw = true; }); throw error; }
    note(() => { if (record) { record.returned = lifetime.stamp(); record.status = Reflect.apply(status, this, []); record.delivery = Reflect.apply(delivery, this, []); } });
    return value;
  });
  return {
    bind(operation: any, response: any, reader: any) { note(() => {
      if (rows.has(operation)) throw new Error("duplicate Worker operation binding");
      const signal = own(operation, "signal"), caller = own(operation, "caller");
      const owners = outbound.filter(owner => owner.signal === signal && owner.claimed);
      const row = lifetime.readers.find((row: any) => row.reader === reader && row.body === response.body);
      if (owners.length !== 1 || !row || row.owner !== owners[0] || row.receivedBody !== row.body) return;
      const owner = owners[0], incoming = owner.ingress;
      const fetched = lifetime.operations.filter((op: any) => op.kind === "fetch" && op.owner === owner);
      if (fetched.length !== 1 || fetched[0].state !== "fulfilled" || fetched[0].value !== response || !fetched[0].pending) return;
      if (!ingress.includes(incoming) || !incoming.claimed || incoming.signal !== caller || stops.has(operation)
        || rejected.has(operation) || Reflect.apply(received, operation, []) || Reflect.apply(status, operation, []) !== undefined
        || Reflect.apply(delivery, operation, []) !== undefined) return;
      rows.set(operation, { operation, owner, signal, caller, reader, body: response.body, bound: lifetime.stamp(), reading: false, failures: [] });
    }); },
    readStart(operation: any, reader: any) { note(() => { const row = rows.get(operation); if (row?.reader === reader) { if (row.reading) throw new Error("overlapping Worker read"); row.reading = true; row.readStart = lifetime.stamp(); } }); },
    readDone(operation: any, reader: any) { note(() => { const row = rows.get(operation); if (row?.reader === reader) row.reading = false; }); },
    failure(operation: any, reader: any, error: unknown) { note(() => {
      const row = rows.get(operation); if (row?.reader === reader) {
        row.failures.push({ at: lifetime.stamp(), error, reading: row.reading, readStart: row.readStart }); row.reading = false;
      }
    }); },
    inspection(operation: any, inspection: any, delivered: any) { note(() => {
      const row = rows.get(operation); if (row) { if (row.inspection) throw new Error("duplicate Worker inspection"); row.inspection = { outcome: own(inspection, "outcome"), delivered, at: lifetime.stamp() }; }
    }); },
    downstreamStart(operation: any, reason: unknown) { let previous: any; note(() => { previous = downstream.get(operation); downstream.set(operation, { reason }); }); return previous; },
    downstreamEnd(operation: any, previous: any) { note(() => { if (previous) downstream.set(operation, previous); else downstream.delete(operation); }); },
    matches(op: any) {
      const matches = [...rows.values()].filter(row => row.owner === op.owner && row.reader === op.reader?.reader);
      if (matches.length !== 1) return false;
      const row = matches[0], record = stops.get(row.operation), owner = row.owner, incoming = owner.ingress, cancel = record?.cancel;
      const failure = row.failures.length === 1 ? row.failures[0] : undefined;
      return outbound.includes(owner) && ingress.includes(incoming) && owner.claimed === true && incoming.claimed === true
        && owner.id === incoming.id && owner.kind === kind && incoming.kind === kind && owner.method === "POST" && incoming.method === "POST"
        && row.caller === incoming.signal && row.signal === owner.signal && op.guardSignal === row.signal
        && Object.getPrototypeOf(row.operation) === Operation.prototype && op.reader.body === row.body
        && record?.binding === row && record.pending === op && record.origin === true
        && record.beforeStatus === undefined && record.beforeDelivery === undefined && record.received === false
        && !record.priorRejection && !rejected.has(row.operation) && record.args[0] === "caller"
        && record.status === "client_error" && record.delivery === "canceled" && !record.threw
        && cancel?.operation === row.operation && !cancel.threw && cancel.entered < record.entered
        && record.entered < record.returned && record.returned < cancel.returned
        && row.bound < failure?.readStart && failure.readStart < op.invoked && op.invoked < record.entered
        && failure.reading === true && Object.is(failure.error, op.reason) && cancel.returned < failure.at
        && row.inspection?.outcome === null && row.inspection.delivered === "canceled" && row.inspection.at < failure.at;
    },
  };
}
function createLifetimeObserver(sdk?: { bindings: any[]; bodySucceeded: () => boolean; current?: () => any; apiPrototype?: object; isProxy?: (value: any) => boolean }, worker?: { source: () => any; outcome: (op: any) => boolean; ownerId?: string }) {
  const operations: OriginalOperation[] = [], errors: unknown[] = [], readers: any[] = [], bodies: any[] = [], guards: any[] = [];
  const restores: Array<() => void> = [], bodyOwners = new WeakMap<object, any>();
  let sequence = 0;
  let lastJoin: any = null;
  const providerErrors = new Map<any, any>();
  let qualifiedReadRejections = 0;
  const event = () => ++sequence;
  const snapshot = (signal?: AbortSignal) => ({ aborted: signal?.aborted === true, reason: signal?.reason });
  function safe(callback: () => void) { try { callback(); } catch (error) { errors.push(error); } }
  function invocation(owner: any, identity: any = {}) {
    const guardSignal = identity.acquisition?.guardSignal ?? owner?.signal;
    return { ...identity, invoked: event(), guardSignal, signalAtInvoke: snapshot(guardSignal), unlocksAtInvoke: identity.reader?.unlocks };
  }
  function watch(kind: string, pending: any, owner: any, settled?: (value: any) => void, observed = invocation(owner)) {
    const op: OriginalOperation = { kind, owner, ...observed, pending, state: "pending" }; operations.push(op);
    const releaseSettled = () => { try { if (kind === "release") op.signalAtSettle = snapshot(op.guardSignal); } catch { /* diagnostic only */ } };
    if (!pending || typeof pending.then !== "function") {
      op.state = "fulfilled"; op.value = pending; op.settled = event(); releaseSettled(); if (settled) safe(() => settled(pending)); return pending;
    }
    // Attach before the caller consumes the same original promise. The signal
    // here is the guard INPUT, never its private internally combined signal.
    void pending.then((value: unknown) => { op.state = "fulfilled"; op.value = value; op.settled = event(); releaseSettled(); if (settled) safe(() => settled(value)); }, (reason: unknown) => {
      op.state = "rejected"; op.reason = reason; op.settled = event(); op.signalAtReject = snapshot(op.guardSignal); releaseSettled();
    });
    return pending;
  }
  function invoke(kind: string, original: (...args: any[]) => any, receiver: any, args: any[], owner: any, settled?: (value: any) => void, identity: any = {}) {
    const observed = invocation(owner, { ...identity, original, receiver, operands: args });
    let value;
    try { value = Reflect.apply(original, receiver, args); }
    catch (reason) { operations.push({ kind, owner, ...observed, state: "sync_throw", reason, settled: event() }); throw reason; }
    // Record the original synchronous return before attaching the existing
    // settlement observer. Return the identical product, including non-promises.
    if (kind === "release") try { Object.assign(observed, { returned: event(), signalAtReturn: snapshot(observed.guardSignal) }); } catch { /* diagnostic only */ }
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
  function providerError(params: any) {
    safe(() => {
      const owner = sdk?.current?.();
      if (!owner || owner.id !== "error" || owner.kind !== "chat" || !sdk?.bindings.includes(owner) || !owner.claimed) return;
      if (providerErrors.has(owner)) { providerErrors.get(owner).ambiguous = true; return; }
      const own = (value: any, key: string) => {
        if (!value || typeof value !== "object" || !sdk.isProxy || sdk.isProxy(value)) return undefined;
        const field = Object.getOwnPropertyDescriptor(value, key);
        return field && Object.hasOwn(field, "value") ? field : undefined;
      };
      const original = own(params, "error"), output = own(params, "output"), caller = own(params, "signal");
      if (!original || !output || !caller || caller.value !== owner.caller) return;
      const error = original.value, payload = own(error, "error")?.value;
      const controlled = !!error && typeof error === "object" && !sdk.isProxy!(error)
        && Object.getPrototypeOf(error) === sdk.apiPrototype && !!own(error, "status") && own(error, "status")!.value === undefined
        && own(error, "message")?.value === "synthetic-upstream-error" && own(error, "code")?.value === "server_error"
        && !!payload && !sdk.isProxy!(payload) && Object.getPrototypeOf(payload) === Object.prototype
        && Reflect.ownKeys(payload).sort().join() === "code,message"
        && own(payload, "message")?.value === "synthetic-upstream-error" && own(payload, "code")?.value === "server_error";
      const acquired = guards.filter(row => row.owner === owner);
      if (acquired.length !== 1 || acquired[0].guardSignal !== owner.signal || owner.signal === owner.caller) return;
      const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
      const reason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")!.get!;
      const isAborted = Reflect.apply(aborted, owner.signal, []);
      providerErrors.set(owner, { error, output: output.value, controlled, acquisition: acquired[0],
        reason: isAborted ? Reflect.apply(reason, owner.signal, []) : undefined, aborted: isAborted === true, matched: false, ambiguous: false });
    });
  }
  function providerResult(result: any) {
    safe(() => {
      if (!sdk?.isProxy || sdk.isProxy(result)) return;
      for (const observed of providerErrors.values()) if (observed.output === result) {
        if (observed.matched) observed.ambiguous = true;
        const stop = Object.getOwnPropertyDescriptor(result, "stopReason"), message = Object.getOwnPropertyDescriptor(result, "errorMessage");
        observed.matched = !!stop && Object.hasOwn(stop, "value") && stop.value === "error"
          && !!message && Object.hasOwn(message, "value") && message.value === "synthetic-upstream-error";
      }
    });
  }
  function sdkProviderErrorDisposition(op: OriginalOperation) {
    const owner = op.owner, row = op.reader, acquisition = op.acquisition, observed = providerErrors.get(owner);
    if (!sdk?.bodySucceeded() || !observed?.controlled || !observed.matched || observed.ambiguous || !observed.aborted
      || !observed.reason || typeof observed.reason !== "object" || observed.reason === observed.error || owner.caller !== undefined
      || sdk.bindings.filter(binding => binding.id === "error" && binding.kind === "chat").length !== 1
      || !sdk.bindings.includes(owner) || !owner.claimed || owner.method !== "POST" || !owner.abort
      || acquisition !== observed.acquisition || guards.filter(guard => guard.owner === owner).length !== 1
      || !row || !readers.includes(row) || row.owner !== owner || row.acquisition !== acquisition
      || readers.filter(reader => reader.owner === owner).length !== 1 || row.closed === undefined
      || acquisition.result?.response.body !== row.body || row.body.locked || row.unlocks !== 1 || row.unlocked !== 1
      || acquisition.releaseCalls !== 1) return false;
    const group = operations.filter(item => item.reader === row && ["reader.closed", "reader.read", "reader.cancel"].includes(item.kind) && item.state !== "fulfilled");
    if (group.length !== 3 || !["reader.closed", "reader.read", "reader.cancel"].every(kind => group.filter(item => item.kind === kind).length === 1)) return false;
    return group.includes(op) && group.every(item => item.state === "rejected" && item.owner === owner && item.acquisition === acquisition
      && item.reason === observed.reason && item.guardSignal === acquisition.guardSignal && item.signalAtReject?.aborted === true
      && item.signalAtReject.reason === observed.reason && owner.abort.reason === observed.reason && owner.abort.sequence < item.settled!
      && (item.kind === "reader.closed" ? item.pending === row.closed && item.invoked < owner.abort.sequence
        : item.receiver === row.reader && (item.kind === "reader.read" ? item.invoked < owner.abort.sequence && !item.signalAtInvoke.aborted
          : item.signalAtInvoke.aborted && item.signalAtInvoke.reason === observed.reason && item.unlocksAtInvoke === 0 && item.invoked < row.unlockInvocations[0])));
  }
  function workerReadDisposition(op: OriginalOperation) {
    if (sdk || !worker || op.kind !== "reader.read" || op.state !== "rejected" || !worker.outcome(op)) return false;
    const owner = op.owner, row = op.reader, source = worker.source();
    if (!source || source.ownerId !== (worker.ownerId ?? "qianfan_cancel") || source.claimed !== true || source.cancelled !== true
      || source.expired !== false || source.cancelCalls !== 1 || source.cancelReturned !== 1 || source.pending !== 0 || source.failed !== 0
      || owner.id !== source.ownerId || !row || !readers.includes(row) || row.owner !== owner || bodyOwners.get(row.body) !== owner
      || row.receivedBody !== row.body || op.receiver !== row.reader || row.unlocks !== 1 || row.unlocked !== 1 || row.body.locked) return false;
    const related = operations.filter(item => item.reader === row);
    const cancel = related.filter(item => item.kind === "reader.cancel"), closed = related.filter(item => item.kind === "reader.closed");
    return cancel.length === 1 && closed.length === 1 && closed[0].pending === row.closed && closed[0].state === "fulfilled"
      && cancel[0].state === "fulfilled" && cancel[0].owner === owner && cancel[0].receiver === row.reader && cancel[0].unlocksAtInvoke === 0
      && op.invoked < cancel[0].invoked && cancel[0].invoked < op.settled! && op.settled! < row.unlockInvocations[0]
      && cancel[0].settled! < row.unlockInvocations[0] && related.filter(item => item.state !== "fulfilled").length === 1;
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
    const workerReads = structural.length === 0 && releasesFulfilled ? operations.filter(workerReadDisposition) : [];
    qualifiedReadRejections = workerReads.length === 1 ? 1 : 0;
    const rejected = operations.filter(op => (op.state === "rejected" || op.state === "sync_throw") &&
      !(structural.length === 0 && releasesFulfilled && (sdkAbortDisposition(op) || sdkProviderErrorDisposition(op) || qualifiedReadRejections === 1 && workerReads.includes(op))));
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
    // Closed owner codes, from actual binding objects. Unknown stays zero;
    // neither a global current case nor an operation ordinal supplies ownership.
    const cases = ["unknown", "card0", "card1", "card2", "card3", "card4", "high", "max", "image2", "image4", "catalog", "catalog_denials", "observed", "admission_denials", "error", "cancel", "invalid", "foreign", "unpriced", "empty"];
    const ownerCodes = (owner: any) => {
      const id = typeof owner?.id === "string" ? owner.id.replace(/^qianfan_/, "") : "unknown";
      return [Math.max(0, cases.indexOf(id)), Math.max(0, ["unknown", "chat", "catalog"].indexOf(owner?.kind))];
    };
    const census = Array(56).fill(0);
    for (const op of operations) census[(kinds.includes(op.kind) ? kinds.indexOf(op.kind) : 13) * 4 + states.indexOf(op.state)]++;
    const rejected = operations.filter(op => op.state === "rejected" || op.state === "sync_throw");
    const rows = rejected.slice(0, 4).map(op => {
      const row = op.reader, acquisition = op.acquisition, reason = op.reason;
      const related = (kind: string) => row ? operations.filter(item => item.kind === kind && item.reader === row && item.owner === op.owner && item.acquisition === acquisition) : [];
      const closed = related("reader.closed").find(item => item.pending === row.closed);
      // Bit positions 0..22: defined reason, owner bound, reader bound,
      // acquisition bound, same original read/closed/cancel rejection reason,
      // input aborted at invoke/reject, same reason at invoke/reject,
      // invoke before every unlock, settle after first unlock return, original
      // receiver, original closed, EOF, body locked, undefined reason, null
      // reason, same acquisition guard-input signal, guard-input signal present,
      // same owner input signal, actual owner binding claimed.
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
        reason === undefined, reason === null, Boolean(acquisition && op.guardSignal === acquisition.guardSignal), op.guardSignal !== undefined,
        Boolean(op.guardSignal && op.guardSignal === op.owner?.signal), op.owner?.claimed === true];
      const mask = bits.reduce((mask: number, value, bit) => value === true ? mask + 2 ** bit : mask, 0);
      return [kinds.includes(op.kind) ? kinds.indexOf(op.kind) : 13, states.indexOf(op.state), mask,
        bounded(op.invoked), bounded(op.settled), bounded(op.unlocksAtInvoke), bounded(row?.unlockInvocations[0]), bounded(row?.unlockReturns[0]), bounded(closed?.settled), ...ownerCodes(op.owner), bounded(op.owner?.abort?.sequence)];
    });
    const releases = operations.filter(op => op.kind === "release");
    const releaseTrace = releases.slice(0, 2).map(op => {
      const acquisition = op.acquisition, abort = op.owner?.abort;
      const sameReason = (state: any) => Boolean(abort && abort.reason !== undefined && state?.reason === abort.reason);
      // Bits: actual acquisition, same original acquisition product, receiver,
      // guard input, owner, bound reader, aborted entry/return/settle, same abort
      // reason entry/return/settle, returned normally, fulfilled/rejected/threw,
      // authored caller present/aborted, defined input abort, input present.
      const bits = [Boolean(acquisition && guards.includes(acquisition)),
        Boolean(acquisition && operations.some(item => item.kind === "acquire" && item.acquisition === acquisition && item.pending === acquisition.returned)),
        Boolean(acquisition && op.receiver === acquisition.result), Boolean(acquisition && op.guardSignal === acquisition.guardSignal),
        Boolean(acquisition && op.owner === acquisition.owner), readers.some(row => row.owner === op.owner && row.acquisition === acquisition),
        op.signalAtInvoke.aborted, op.signalAtReturn?.aborted === true, op.signalAtSettle?.aborted === true,
        sameReason(op.signalAtInvoke), sameReason(op.signalAtReturn), sameReason(op.signalAtSettle), op.returned !== undefined,
        op.state === "fulfilled", op.state === "rejected", op.state === "sync_throw", Boolean(op.owner?.caller), op.owner?.caller?.aborted === true,
        Boolean(abort && abort.reason !== undefined), op.guardSignal !== undefined];
      const mask = bits.reduce((mask: number, value, bit) => value === true ? mask + 2 ** bit : mask, 0);
      return [...ownerCodes(op.owner), bounded(op.invoked), bounded(op.returned), bounded(op.settled), bounded(abort?.sequence), mask, bounded(op.operands?.length)];
    });
    return {
      contract: { bodySucceeded: sdk ? sdk.bodySucceeded() : null, failureFlags: flags.map(Number), releasesFulfilled,
        // observer errors, guards, acquired guards, release calls, readers,
        // EOF readers, locked bodies, unlock invocations, successful returns.
        ownership: [errors.length, guards.length, guards.filter(row => row.acquired).length, guards.reduce((n, row) => n + row.releaseCalls, 0), readers.length,
          readers.filter(row => row.eof).length, bodies.filter(row => row.body.locked).length, readers.reduce((n, row) => n + row.unlocks, 0), readers.reduce((n, row) => n + row.unlocked, 0)].map(bounded) },
      census: { census: census.map(bounded), releaseTrace, releaseOmitted: bounded(Math.max(0, releases.length - releaseTrace.length)) },
      rejection: { rejections: rows, omitted: bounded(Math.max(0, rejected.length - rows.length)) },
      worker: { rejections: rows, omitted: bounded(Math.max(0, rejected.length - rows.length)), work: census.slice(32, 40).map(bounded) },
    };
  }
  async function restore() { const failures: unknown[] = []; for (const undo of restores.splice(0).reverse()) try { undo(); } catch (error) { failures.push(error); } if (failures.length) throw new AggregateError(failures, "Qianfan observer restoration failed"); }
  function summary() { return { operations: operations.length, settled: operations.filter(op => op.state !== "pending").length,
    rejected: operations.filter(op => op.state === "rejected" || op.state === "sync_throw").length + errors.length, qualifiedReadRejections,
    readers: readers.length, unlocked: readers.filter(row => row.unlocks > 0 && row.unlocks === row.unlocked).length, releases: guards.reduce((n, row) => n + row.releaseCalls, 0) }; }
  return { operations, errors, readers, bodies, guards, stamp: event, watch, invoke, patch, signal, partial, response, guard, providerError, providerResult, join, restore, summary, joinDiagnostic: () => lastJoin };
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
// Passive stage states: 0 uncalled, 1 invoked, 2 fulfilled, 3 rejected.
// The second four columns distinguish no rejection / defined / undefined.
function observeRetirementSteps() {
  const checks = Array(8).fill(0);
  return { facts: () => checks.slice(), observe(index: number, original: () => any) {
    checks[index] = 1;
    const failed = (error: unknown) => { checks[index] = 3; checks[index + 4] = error === undefined ? 2 : 1; };
    let value; try { value = original(); } catch (error) { failed(error); throw error; }
    if (value instanceof Promise) void value.then(() => { checks[index] = 2; }, failed);
    else checks[index] = 2;
    return value;
  } };
}
// END ORIGINAL LIFETIME OBSERVERS

const diagnostic = qianfanDiagnostics(nodeTypes.isProxy);
let diagnosticCase = "none", diagnosticRoute = "none", diagnosticPhase = "module", diagnosticCount = 0;
function sdkDiagnostic(phase: string, role: string, outcome: string, error?: unknown) {
  try {
    if (diagnosticCount >= 512) return;
    const value = diagnostic.record({ layer: "sdk", route: diagnosticRoute, caseId: diagnosticCase, phase, role }, outcome, error, { ...diagnostic.snapshot(lifetime, bindings), ...(outcome === "rejected" ? { fault: diagnostic.fault(error) } : {}) });
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
const originalSdkFailure = transportStream.failTransportStream;
const sdkInvocation = new AsyncLocalStorage<any>();
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createRequestBindings>, caseState: { bodySucceeded: boolean };
let cancelReceiptCount = 0;
sdkDiagnostic("module", "progress", "entered");

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
    const replayRegistry = createEmptyPluginRegistry();
    replayRegistry.providers.push({ pluginId: "qianfan", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(replayRegistry, () => sanitizeSessionHistory({ provider: "qianfan", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: `qianfan-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "qianfan", modelApi: model.api, modelId })]),
      messages: history }));
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const invocation = bindings.expect(id, "chat", configured.baseUrl + "/chat/completions", "POST", options.apiKey ?? key(id), options.signal);
  invocation.callerObservation = {}; lifetime.signal(invocation.callerObservation, options.signal);
  sdkStage("dispatch");
  return sdkInvocation.run(invocation, () => streamSimple(model, context, { apiKey: options.apiKey ?? key(id), maxTokens: 128, reasoning: options.reasoning, signal: options.signal }));
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

// BEGIN PINNED OBSERVER NEGATIVE CONTROLS
// Native-stream observer comparisons only, not replacements for the six real
// parser/guard controls below. Test-owned producers settle their own promises.
async function runQianfanObserverControl(id: string, assert: any) {
  const variants = id === "binding" ? ["owner", "acquisition"] : id === "prior_foreign" ? ["prior", "foreign"] : [id];
  for (const variant of variants) {
    const binding = createRequestBindings(), caller = new AbortController(), input = new AbortController();
    const life = createLifetimeObserver({ bindings: binding.bindings, bodySucceeded: () => true });
    const owner = binding.expect("cancel", "chat", "https://fixture.example/control", "POST", "fixture-control", caller.signal);
    binding.claim(owner.url, { method: "POST", headers: { authorization: "Bearer fixture-control" } }, "chat");
    owner.callerObservation = {}; life.signal(owner.callerObservation, caller.signal); life.signal(owner, input.signal);
    let sourceController!: ReadableStreamDefaultController<Uint8Array>, finishRelease!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(value) { sourceController = value; } }, { highWaterMark: 0 });
    const releasing = new Promise<void>((resolve, reject) => { finishRelease = variant === "failed_release" ? () => reject(undefined) : resolve; });
    const result = { response: new Response(body), release() { assert.equal(this, result); return releasing; } };
    const acquired = Promise.resolve(result); life.guard(() => acquired, undefined, [], owner); await acquired;
    const reader = body.getReader(), closed = reader.closed, reading = reader.read();
    const reason = variant === "undefined" ? undefined : new Error("observer control source");
    if (variant === "prior") { sourceController.error(reason); await Promise.allSettled([reading, closed]); }
    life.partial(owner); caller.abort(new Error("observer control caller"));
    input.abort(variant === "foreign" ? new Error("observer control foreign") : reason);
    if (variant !== "prior") sourceController.error(reason);
    const cancellation = reader.cancel(); await Promise.allSettled([reading, closed, cancellation]);
    if (variant === "unlock") assert.throws(() => Reflect.apply(reader.releaseLock, {}, []), TypeError);
    reader.releaseLock(); const release = result.release(); assert.equal(release, releasing);
    if (variant === "owner") owner.id = "foreign";
    if (variant === "acquisition") life.readers[0].acquisition = {};
    await preserveFailures(async () => {
      if (variant === "pending_release") {
        let complete = false; const originalJoin = life.join(); void originalJoin.then(() => { complete = true; }, () => { complete = true; });
        await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(complete, false);
        assert.equal(life.operations.find(op => op.kind === "release")!.pending, releasing);
        finishRelease(); await releasing; await originalJoin;
      } else {
        finishRelease(); await Promise.allSettled([release]);
        await assert.rejects(life.join(), (error: any) => error instanceof AggregateError &&
          (variant !== "undefined" && variant !== "failed_release" || error.errors.includes(undefined)));
      }
      assert.equal(body.locked, false); assert.equal(life.summary().operations, life.summary().settled);
      assert.equal(life.operations.find(op => op.kind === "reader.read")!.pending, reading);
      assert.equal(life.operations.find(op => op.kind === "reader.closed")!.pending, closed);
      assert.equal(life.operations.find(op => op.kind === "reader.cancel")!.pending, cancellation);
    }, [async () => { finishRelease(); await Promise.allSettled([reading, closed, cancellation, release]); }, () => life.restore()]);
  }
}
// END PINNED OBSERVER NEGATIVE CONTROLS

// BEGIN PINNED HOSTED IMPLEMENTATION CONTROLS
async function runQianfanPinnedControl(id: string, summary: ReturnType<typeof createPinnedControlSummary>, deadlineAt: number) {
  summary.stage(2);
  const [{ strict: assert }, { createServer }, { Stream }, { APIError }, guarded, bodyModule, runtime, undici, { readFile }] = await Promise.all([
    import("node:assert"), import("node:http"), import("openai/core/streaming"), import("openai/core/error"),
    import("../../src/infra/net/fetch-guard.js"), import("../../src/infra/net/guarded-body-stream.js"),
    import("../../src/infra/net/undici-runtime.js"), import("undici"), import("node:fs/promises"),
  ]);
  const { isMockedFetch } = await import("../../src/infra/net/runtime-fetch.js");
  const packageMetadata = JSON.parse(await readFile(new URL("../package.json", import.meta.resolve("openai/core/streaming")), "utf8"));
  summary.stage(3);
  requirePinnedControlAdmission(globalThis.fetch, isMockedFetch(globalThis.fetch), guarded.isManagedProxyActive(), runtime.loadUndiciRuntimeDeps(), undici, packageMetadata.version);
  const remaining = deadlineAt - performance.now(); if (remaining <= 0) { summary.deadline(); throw new Error("pinned control admission deadline"); }
  const life = createLifetimeObserver(), input = new AbortController(), bindings = createRequestBindings();
  const sockets = new Set<any>(), socketJoins: Promise<void>[] = [], responses: Promise<void>[] = [], sourceErrors: unknown[] = [];
  let requests = 0, result: any, iterator: any, owner: any, timer: ReturnType<typeof setTimeout> | undefined, hardTimer: ReturnType<typeof setTimeout> | undefined;
  let expired = false, strictObserved = false, releaseStarted = false, ownedSettled = false, sourcePending = 0;
  const sourceJoin = (original: Promise<void>) => { sourcePending++; void original.then(() => { sourcePending--; }, () => { sourcePending--; }); return original; };
  const frame = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
  const server = createServer((request, response) => {
    requests++;
    responses.push(sourceJoin(new Promise<void>(resolve => { response.once("finish", resolve); response.once("close", resolve); })));
    response.once("error", error => { sourceErrors.push(error); });
    if (request.method !== "GET" || request.url !== "/control" || request.headers.authorization !== "Bearer fixture-control") {
      sourceErrors.push(new Error("unexpected control request")); response.writeHead(400).end(); return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (id === "done") response.end(frame({ control: 1 }) + "data: [DONE]\n\n");
    else { response.write(frame({ control: 1 }) + (id === "embedded" ? frame({ error: { message: "synthetic-control-error", type: "fixture", code: "fixture_error" } }) : "")); response.flushHeaders(); }
  });
  server.on("connection", socket => {
    sockets.add(socket); socketJoins.push(sourceJoin(new Promise<void>(resolve => socket.once("close", () => { sockets.delete(socket); resolve(); }))));
    socket.on("error", error => { sourceErrors.push(error); });
  });
  server.on("error", error => { sourceErrors.push(error); });
  const failDeadline = new Error("pinned control deadline");
  let rejectDeadline!: (reason: unknown) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  summary.stage(4);
  const owned = preserveFailures(async () => {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/control`, init = { method: "GET", headers: { authorization: "Bearer fixture-control" } };
    owner = bindings.expect("error", "chat", url, "GET", "fixture-control"); bindings.claim(url, init, "chat");
    if (id === "preabort") input.abort(new Error("control preabort"));
    life.signal(owner, input.signal);
    const options = { url, init, signal: input.signal, capture: false as const, mode: "strict" as const, maxRedirects: 0,
      requireHttps: false, policy: { allowedHostnames: ["127.0.0.1"], hostnameAllowlist: ["127.0.0.1"] },
      ...(id === "timeout" ? { timeoutMs: 1000 } : {}) };
    const acquisition = life.guard(guarded.fetchWithSsrFGuard, undefined, [options], owner);
    if (id === "preabort") { await assert.rejects(acquisition); assert.equal(requests, 0); }
    else {
      result = await acquisition; assert.equal(requests, 1);
      if (id === "release") {
        assert.equal(input.signal.aborted, false); releaseStarted = true; await result.release(); assert.equal(input.signal.aborted, false);
      } else {
        // Matches buildManagedResponse: no added signal shortcut. The original
        // guard response stays owned by its actual reader and original release.
        const managed = new Response(bodyModule.wrapGuardedBodyStream({ body: result.response.body!, cleanup: () => { releaseStarted = true; return result.release(); }, refreshTimeout: result.refreshTimeout }), result.response);
        iterator = Stream.fromSSEResponse<{ control: number }>(managed, input)[Symbol.asyncIterator]();
        const first = await iterator.next(); assert.equal(first.done, false); assert.equal(first.value.control, 1);
        if (id === "caller") input.abort(new Error("control caller abort"));
        if (id === "embedded") await assert.rejects(iterator.next(), (error: any) => error instanceof APIError && (error.error as { message?: unknown } | undefined)?.message === "synthetic-control-error");
        else if (id === "done") assert.equal((await iterator.next()).done, true);
        else await Promise.allSettled([iterator.next()]);
      }
    }
    summary.stage(5);
    // No disposition change: expected source failures remain strict failures.
    let rejected = false, rejection: any;
    try { await life.join(); } catch (error) { rejected = true; rejection = error; }
    strictObserved = true;
    const originals = life.operations.filter(op => op.state === "rejected" || op.state === "sync_throw");
    if (id === "done") { assert.equal(rejected, false); assert.equal(originals.length, 0); }
    else if (id !== "release") { assert.equal(rejected, true); assert.ok(originals.length > 0); }
    if (rejected) {
      assert.ok(rejection instanceof AggregateError); assert.deepEqual(rejection.errors, originals.map(op => op.reason));
      assert.deepEqual(life.joinDiagnostic().contract.failureFlags.slice(0, 4), [0, 0, 0, 0]);
    }
    if (id === "embedded") {
      const releasing = life.operations.find(op => op.kind === "release")!;
      assert.ok(owner.abort && owner.abort.sequence < releasing.invoked); assert.equal(owner.caller, undefined);
      const reading = life.operations.find(op => op.kind === "reader.read" && op.state === "rejected")!;
      const closed = life.operations.find(op => op.kind === "reader.closed" && op.state === "rejected")!;
      const cancellation = life.operations.find(op => op.kind === "reader.cancel" && op.state === "rejected")!;
      assert.ok(reading && closed && cancellation); assert.notEqual(reading.reason, undefined);
      assert.equal(reading.reader, closed.reader); assert.equal(reading.reader, cancellation.reader);
      assert.equal(reading.reason, closed.reason); assert.equal(reading.reason, cancellation.reason);
    }
    if (id === "timeout") assert.ok(life.operations.some(op => op.kind === "reader.read" && op.state === "rejected" && op.signalAtReject?.aborted === false));
    assert.equal(life.summary().operations, life.summary().settled); assert.equal(life.summary().readers, life.summary().unlocked);
    if (result) assert.ok(life.operations.filter(op => op.kind === "release").every(op => op.state === "fulfilled"));
  }, [
    async () => { if (iterator) await iterator.return?.(); },
    async () => { if (result && !releaseStarted) { releaseStarted = true; await result.release(); } },
    async () => { if (!strictObserved) await life.join(); },
    async () => { await Promise.all([...responses, ...socketJoins]); if (sourceErrors.length) throw new AggregateError(sourceErrors, "control source failed"); },
    async () => { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
    () => { if (id === "embedded" && owner) try { summary.embedded(life, owner); } catch { /* diagnostic only */ } },
    () => life.restore(),
  ].map(cleanup => async () => { summary.stage(6); try { await cleanup(); } catch (error) { summary.cleanup(); throw error; } }));
  // The five-second bound includes imports. Reserve the last half-second for
  // failure-only owned cleanup; hitting either boundary is never a PASS.
  const outcome = owned.then(() => { ownedSettled = true; return { ok: true as const }; }, error => { ownedSettled = true; return { ok: false as const, error }; });
  timer = setTimeout(() => {
    expired = true; summary.deadline(); input.abort(failDeadline);
    for (const socket of sockets) socket.destroy(); server.close();
  }, Math.max(0, remaining - 500));
  hardTimer = setTimeout(() => rejectDeadline(failDeadline), remaining);
  try {
    const completed = await Promise.race([outcome, deadline]);
    if (expired) throw new AggregateError([failDeadline, ...(completed.ok ? [] : [completed.error])], "control deadline and original work");
    if (!completed.ok) throw completed.error;
  } finally {
    clearTimeout(timer); clearTimeout(hardTimer);
    summary.pending(life.operations.filter(op => op.state === "pending").length + sourcePending + Number(!ownedSettled));
    // An unsettled original stays owned by its observed outcome. Its later
    // failure remains in that outcome, never a claimed successful retirement.
  }

}

sdkStage("collection");
try {
describe("exact d8 parser and guard controls, separate from registered product cases", { concurrent: false }, () => {
sdkDiagnostic("control_registration", "progress", "entered");
try {
  const controls = createPinnedControlSummary(); let groupDeadline: number | undefined;
  nativeIt.each(pinnedControlIds)("pinned control %s", async id => {
    groupDeadline ??= performance.now() + 45000; controls.start(id); let ok = false, failed = false, failure: unknown;
    const emit = (outcome: string) => { try { const line = diagnostic.encode(diagnostic.record({ layer: "sdk", route: "none", caseId: "none", phase: "controls", role: "summary" }, outcome, failure, { ...controls.facts(), ...(failed ? { fault: diagnostic.fault(failure) } : {}) })); if (line) process.stdout.write(line); } catch { /* original control verdict wins */ } };
    emit("entered");
    try {
      const remaining = groupDeadline - performance.now(); if (remaining <= 0 || controls.facts().controlCounts[6]) { controls.deadline(); throw new Error("pinned control group deadline"); }
      if (pinnedControlIds.indexOf(id) < 6) await runQianfanPinnedControl(id, controls, Math.min(groupDeadline, performance.now() + 5000));
      else { const { strict: assert } = await import("node:assert"); await runQianfanObserverControl(id, assert); }
      ok = true;
    } catch (error) { failed = true; failure = error; throw error; } finally {
      controls.finish(id, ok);
      emit(ok ? "fulfilled" : "rejected");
    }
  }, 5000);
sdkDiagnostic("control_registration", "progress", "fulfilled");
} catch (error) { sdkDiagnostic("control_registration", "primary", "rejected", error); throw error; }
});
// END PINNED HOSTED IMPLEMENTATION CONTROLS

describe("actual Qianfan configured catalog and replay through Worker and SQLite", () => {
sdkDiagnostic("product_registration", "progress", "entered");
try {
beforeEach(async () => {
  diagnosticCase = "none"; diagnosticRoute = "none";
  bindings = createRequestBindings(); caseState = { bodySucceeded: false };
  lifetime = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => caseState.bodySucceeded,
      current: () => sdkInvocation.getStore(), apiPrototype: APIError.prototype, isProxy: nodeTypes.isProxy });
  sdkStage("setup");
  try {
    clearLiveCatalogCacheForTests();
    vi.spyOn(transportStream, "failTransportStream").mockImplementation(function (...args: Parameters<typeof originalSdkFailure>) {
      lifetime.providerError(args[0]);
      return Reflect.apply(originalSdkFailure, this, args);
    });
    vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function (...args) {
      const options = args[0], owner = bindings.claim(options.url, options.init, "chat");
      lifetime.signal(owner, options.signal ?? options.init?.signal);
      return lifetime.guard(originalInferenceGuard, this, args, owner);
    });
  } catch (error) { sdkDiagnostic("setup", "primary", "rejected", error); await preserveFailures(() => { throw error; }, [sdkCleanup("original_join", () => lifetime.join()), sdkCleanup("restoration", () => lifetime.restore()), sdkCleanup("mock_cleanup", () => vi.restoreAllMocks()), sdkCleanup("cache_cleanup", () => clearLiveCatalogCacheForTests())]); }
});
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
    const result = await (await start("error")).result(); expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe("synthetic-upstream-error"); lifetime.providerResult(result);
  });
  it("cancels the actual native SDK stream after partial delivery", async () => {
    const controller = new AbortController(), stream = await start("cancel", models[0], { signal: controller.signal });
    for await (const event of stream) if (event.type === "text_delta") { lifetime.partial(bindings.bindings.find(row => row.id === "cancel" && row.kind === "chat")!); controller.abort(); break; }
    const result = await stream.result(); expect(controller.signal.aborted).toBe(true); expect(result.stopReason).toBe("aborted");
  });
sdkDiagnostic("product_registration", "progress", "fulfilled");
} catch (error) { sdkDiagnostic("product_registration", "primary", "rejected", error); throw error; }
});

// Registration API return is not evidence that any hook or case ran.
sdkDiagnostic("collection", "progress", "fulfilled");
} catch (error) { sdkDiagnostic("collection", "primary", "rejected", error); throw error; }
