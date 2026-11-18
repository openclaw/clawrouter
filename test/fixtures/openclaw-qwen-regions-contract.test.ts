import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { createEmptyPluginRegistry, registerProviderPlugin, requireRegisteredProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import { ssrfPolicyFromHttpBaseUrlAllowedOrigin } from "openclaw/plugin-sdk/ssrf-runtime";
import * as transport from "../../src/agents/provider-transport-dispatcher-pool.js";
import * as guard from "../../src/infra/net/fetch-guard.js";
import * as aiHost from "../../packages/ai/src/host.js";
import * as openAITransport from "../../packages/ai/src/transports/openai-transport-shared.js";
import { types as utilTypes } from "node:util";
import { expect, it, vi } from "vitest";
// Resolved only by the hash-bound, invocation-owned Qwen native config.
import { sink as valueSink, contract as valueContract } from "virtual:clawrouter-qwen-values";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../src/plugins/runtime/generation-state.js";
import { buildQwenProvider } from "./api.js";
import plugin from "./index.js";

const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const entryWitness = createQwenEntryWitness(value => console.log("QWEN_ENTRY_V1 " + JSON.stringify(value)));
entryWitness.moduleEvaluated();
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
type Row = { id: string; provider: string; model: string; simple: boolean; mode: string };
type Operation = { kind: string; pending: Promise<unknown>; state: string; reason?: unknown; generation: object; binding?: object };
type Invocation = Readonly<{ generation: object; caller: object; fn: Function; receiver: unknown; args: readonly unknown[] }>;
type Acquisition = { invocation: Invocation; context: object; input: unknown; fn: Function; receiver: unknown; args: readonly unknown[]; transport?: FetchReceipt; result?: unknown };
type FetchReceipt = { acquisition: Acquisition; context: object; generation: object; fn: Function; receiver: unknown; args: readonly unknown[]; pending?: Promise<Response>; response?: Response };

// BEGIN shared fixture functions. The outer executes these exact functions after
// native TypeScript stripping, including their original-operation tests.
function qwenRegionCases(): Row[] {
  const cn = ["qwen3.5-plus", "qwen3.6-flash", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max", "qwen3.8-flash", "MiniMax-M2.5", "glm-5", "kimi-k2.5"];
  const coding = ["qwen3.7-plus", "qwen3.6-plus", "kimi-k2.5", "glm-5", "MiniMax-M2.5", "qwen3.5-plus"];
  return ["qwen-cn", "qwen-coding-global", "qwen-coding-cn"].flatMap((provider, region) => {
    const rows = (region === 0 ? cn : coding).flatMap((model, index) => [false, true].map(simple => ({
      id: `qr${region}_m${index}_${simple ? "simple" : "stream"}`, provider, model, simple, mode: "eof",
    })));
    for (const mode of ["preabort", "partial", "provider_error"]) for (const simple of [false, true]) {
      rows.push({ id: `qr${region}_${mode}_${simple ? "simple" : "stream"}`, provider, model: "qwen3.7-plus", simple, mode });
    }
    for (const mode of ["no_usage", "missing", "empty", "missing_grant", "foreign", "revoked", "rotation", "unpriced", "invalid_caller", "bad_model", ...(region ? ["invalid", "raw_c0", "raw_del", "whitespace"] : [])]) {
      rows.push({ id: `qr${region}_${mode}`, provider, model: mode === "bad_model" ? "qwen3-coder-plus" : "qwen3.7-plus", simple: true, mode });
    }
    if (region === 0) for (const mode of ["effort_off", "effort_low", "effort_medium"]) {
      rows.push({ id: `qr${region}_${mode}`, provider, model: "qwen3.8-max", simple: true, mode });
    }
    return rows;
  });
}

function createQwenLedger() {
  const generation = Object.freeze({});
  const operations: Operation[] = [], observers: Array<{ pending: Promise<unknown>; terminal?: Promise<unknown>; state: string; reason?: unknown }> = [];
  const synchronous: unknown[] = [], registration: unknown[] = [], observerFailures: unknown[] = [], ownershipFailures: unknown[] = [], restorationFailures: unknown[] = [], lateFailures: unknown[] = [];
  const recordingFailures: unknown[] = [];
  let firstObserverFailure: any;
  const restorers: Array<() => void> = [];
  const readers: Array<{ body: ReadableStream<Uint8Array>; reader: ReadableStreamDefaultReader<Uint8Array>; response?: Response; owner?: object; generation: object; closed: Promise<unknown>; unlocks: number; returns: number }> = [];
  const bodies = new WeakSet<object>(), responses = new WeakMap<object, object | undefined>(), originals = new WeakSet<object>();
  let originalCursor = 0, observerCursor = 0, inFlight: Promise<void> | undefined, restored = false, sealed: object | undefined;
  function open() {
    if (sealed) { const error = new Error("sealed Qwen owner cannot acquire work"); lateFailures.push(error); throw error; }
  }
  function observe<T>(kind: string, pending: Promise<T>, binding?: object): Promise<T> {
    open();
    if (pending && (typeof pending === "object" || typeof pending === "function")) {
      if (originals.has(pending)) { const error = new Error("duplicate Qwen original promise"); ownershipFailures.push(error); throw error; }
      originals.add(pending);
    }
    const operation: Operation = { kind, pending, state: "pending", generation, binding }; operations.push(operation);
    let derived: Promise<unknown>;
    // Preserve the existing first two-arm subscription and retain its Q.
    try { derived = pending.then(() => { operation.state = "fulfilled"; }, reason => { operation.state = "rejected"; operation.reason = reason; }); }
    catch (error) { registration.push(error); throw error; }
    const row = { pending: derived, terminal: undefined as Promise<unknown> | undefined, state: "pending", reason: undefined as unknown }; observers.push(row);
    // Nonthrowing terminal guards subscribe only to Q, never again to original P.
    try { row.terminal = derived.then(() => { row.state = "fulfilled"; }, reason => { row.state = "rejected"; row.reason = reason; observerFailures.push(reason); }); }
    catch (error) { registration.push(error); throw error; }
    return pending;
  }
  function invoke<T>(kind: string, original: (...args: any[]) => Promise<T>, receiver: unknown, args: unknown[], resource?: object): Promise<T> {
    open(); let pending: Promise<T>;
    try { pending = Reflect.apply(original, receiver, args); }
    catch (error) { synchronous.push(error); throw error; }
    return observe(kind, pending, Object.freeze({ original, receiver, args, resource }));
  }
  function follow<T>(kind: string, pending: Promise<unknown>, callbacks: Array<((value: any) => any) | undefined>): Promise<T> {
    open(); let derived: Promise<T>;
    try { derived = Reflect.apply(pending.then, pending, callbacks); }
    catch (error) { registration.push(error); throw error; }
    return observe(kind, derived, Object.freeze({ parent: pending, callbacks }));
  }
  function replace(target: any, name: string, next: any) {
    open(); if (restored) throw new Error("Qwen observer installation after restoration");
    const descriptor = Object.getOwnPropertyDescriptor(target, name), original = target[name];
    const installed = { configurable: true, enumerable: descriptor?.enumerable ?? true, writable: true, value: next };
    Object.defineProperty(target, name, installed);
    restorers.push(() => {
      const current = Object.getOwnPropertyDescriptor(target, name);
      if (!current || current.value !== next || current.get || current.set || current.configurable !== installed.configurable || current.enumerable !== installed.enumerable || current.writable !== installed.writable) throw new Error("Qwen observer descriptor custody changed");
      if (descriptor) Object.defineProperty(target, name, descriptor); else if (!Reflect.deleteProperty(target, name)) throw new Error("Qwen observer removal failed");
    }); return original;
  }
  function body(source: ReadableStream<Uint8Array> | null, owner?: object, response?: Response) {
    open(); if (!source) return;
    if (bodies.has(source)) { ownershipFailures.push(new Error("ambiguous original body")); return; }
    bodies.add(source);
    const originalCancel = source.cancel;
    replace(source, "cancel", function (this: ReadableStream<Uint8Array>, ...args: unknown[]) {
      if (this !== source) ownershipFailures.push(new Error("foreign original body cancel receiver"));
      return invoke("body_cancel", originalCancel, this, args);
    });
    const getReader = source.getReader;
    replace(source, "getReader", function (this: ReadableStream<Uint8Array>, ...args: unknown[]) {
      open(); let reader: ReadableStreamDefaultReader<Uint8Array>;
      try { reader = Reflect.apply(getReader, this, args); } catch (error) { synchronous.push(error); throw error; }
      if (this !== source) ownershipFailures.push(new Error("foreign original body receiver"));
      if (readers.some(row => row.reader === reader)) { ownershipFailures.push(new Error("duplicate original reader")); return reader; }
      const closed = reader.closed;
      const row = { body: source, reader, response, owner, generation, closed, unlocks: 0, returns: 0 }; readers.push(row);
      observe("closed", closed, row);
      for (const kind of ["read", "cancel"] as const) {
        const original = reader[kind];
        replace(reader, kind, function (this: ReadableStreamDefaultReader<Uint8Array>, ...operands: unknown[]) {
          if (this !== reader) ownershipFailures.push(new Error("foreign original reader receiver"));
          return invoke(kind, original, this, operands, row);
        });
      }
      const release = reader.releaseLock;
      replace(reader, "releaseLock", function (this: ReadableStreamDefaultReader<Uint8Array>, ...operands: unknown[]) {
        open(); if (this !== reader) ownershipFailures.push(new Error("foreign original unlock receiver"));
        row.unlocks++;
        try { const result = Reflect.apply(release, this, operands); row.returns++; return result; }
        catch (error) { synchronous.push(error); throw error; }
      });
      return reader;
    });
  }
  function response(value: Response, owner?: object) {
    open();
    if (responses.has(value)) { ownershipFailures.push(new Error("duplicate original response")); return; }
    responses.set(value, owner); body(value.body, owner, value);
  }
  async function join() {
    // Cursors survive every drain. Original and attached observer batches are
    // always joined together: observer rejection cannot skip a held original.
    do {
      const originalsAt = operations.length, observersAt = observers.length;
      const batch = operations.slice(originalCursor, originalsAt), tails = observers.slice(observerCursor, observersAt);
      originalCursor = originalsAt; observerCursor = observersAt;
      await Promise.allSettled([...batch.map(row => row.pending), ...tails.map(row => row.terminal ?? row.pending)]);
    } while (originalCursor < operations.length || observerCursor < observers.length);
    const failures = [...synchronous, ...registration, ...observerFailures, ...ownershipFailures, ...restorationFailures, ...lateFailures, ...recordingFailures,
      ...operations.filter(operation => operation.state !== "fulfilled").map(operation => operation.reason)];
    for (const row of observers) if (row.state === "pending") failures.push(new Error("original observer remains pending"));
    for (const row of readers) if (row.unlocks !== 1 || row.returns !== 1 || row.body.locked) failures.push(new Error("original reader remains owned"));
    if (failures.length) throw new AggregateError(failures, "original Qwen operations failed");
  }
  function drain() {
    open(); if (inFlight) return inFlight;
    let resolve!: () => void, reject!: (reason: unknown) => void;
    // Publish before original promise assimilation can reenter drain(). This
    // preserves the original subscription order without starting another join.
    const current = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    inFlight = current;
    void join().then(() => { inFlight = undefined; resolve(); }, reason => { inFlight = undefined; reject(reason); });
    return current;
  }
  function restore() {
    open(); if (restored) throw new Error("Qwen observers already restored");
    restored = true; const failures: unknown[] = [];
    for (const restore of restorers.reverse()) try { restore(); } catch (error) { failures.push(error); restorationFailures.push(error); }
    restorers.length = 0;
    if (failures.length) throw new AggregateError(failures, "Qwen observer restoration failed");
  }
  function seal() {
    open();
    if (!restored || inFlight || originalCursor !== operations.length || observerCursor !== observers.length || operations.some(row => row.state === "pending") || observers.some(row => row.state === "pending")) throw new Error("Qwen retirement is not joined and restored");
    sealed = Object.freeze({ generation, operations: Object.freeze(operations.map(row => Object.freeze({ ...row }))), observers: Object.freeze(observers.map(row => Object.freeze({ ...row }))), readers: Object.freeze(readers.map(row => Object.freeze({ ...row }))) });
    return sealed;
  }
  function captureObserverFailure(parent: Promise<unknown>, facts: Record<string, any>, reason: unknown) {
    if (firstObserverFailure) return;
    const operation = operations.find(row => row.pending === parent && row.kind === "fetch");
    if (!operation) throw new Error("observer failure lacks original parent");
    firstObserverFailure = Object.freeze({ generation, parent, operation, reason,
      facts: Object.freeze({ ...facts, parentState: operation.state }) });
  }
  function observerRecord(id: string) {
    if (!firstObserverFailure || recordingFailures.length) return null;
    const first = firstObserverFailure;
    const observer = operations.find(row => row.kind === "fetch_observer" && (row.binding as any)?.parent === first.parent);
    if (first.generation !== generation || !observer || observer.state !== "rejected" || !Object.is(observer.reason, first.reason)) {
      throw new Error("observer failure lacks settled original association");
    }
    const { route, callable, valueSnapshot, ...facts } = first.facts;
    const prior = { v: 2, kind: "observer_failure", case: id,
      parent: operations.indexOf(first.operation) + 1, observer: operations.indexOf(observer) + 1,
      ...facts, failurePresent: true, reasonDefined: first.reason !== undefined, route: route ?? null };
    const checked = qwenObserverRecord(callable === undefined ? prior : { ...prior, v: 3, callable });
    return valueSnapshot === undefined ? checked
      : qwenObserverRecord({ ...checked, v: 9, ...valueSnapshot() });
  }
  return { generation, observe, invoke, follow, replace, body, response, drain, restore, seal, operations, observers, readers,
    captureObserverFailure, observerRecord, recordingFailure: (reason: unknown) => { recordingFailures.push(reason); },
    deferRestore(restore: () => void) { open(); if (restored) throw new Error("Qwen observer installation after restoration"); restorers.push(restore); },
    failures: () => ({ synchronous: [...synchronous], registration: [...registration], observer: [...observerFailures], ownership: [...ownershipFailures], restoration: [...restorationFailures], late: [...lateFailures], recording: [...recordingFailures] }),
    fail: (reason: unknown) => { open(); ownershipFailures.push(reason); } };
}

// Observe defining exports without eagerly evaluating an export getter. The
// returned host alone supplies the build descriptor; no earlier host lookup or
// global fetch read is performed. Descriptor custody is sampled, not authority.
function createQwenCallableWitness(ledger: ReturnType<typeof createQwenLedger>, current: () => Invocation | undefined, isProxy: (value: any) => boolean) {
  const rows = new Map<Invocation, any>(), hosts = new Map<object, any>();
  const descriptors: Array<() => boolean> = [];
  let lookupHeld: (() => boolean) | null = null, hookHeld: (() => boolean) | null = null;
  const note = (fn: () => void) => { try { fn(); } catch (error) { ledger.recordingFailure(error); } };
  const same = (a: PropertyDescriptor | undefined, b: PropertyDescriptor) => !!a
    && ["value", "get", "set", "writable", "enumerable", "configurable"].every(key => (a as any)[key] === (b as any)[key]);
  function install(target: any, name: string, wrap: (fn: Function) => Function, dataOnly: boolean) {
    if (!target || !["object", "function"].includes(typeof target) || isProxy(target)) return null;
    if (utilTypes.isModuleNamespaceObject(target)) return null;
    const prior = Object.getOwnPropertyDescriptor(target, name);
    if (!prior) return null;
    let installed: PropertyDescriptor;
    if (Object.hasOwn(prior, "value")) {
      if (typeof prior.value !== "function" || !prior.configurable && !prior.writable) return null;
      installed = { ...prior, value: wrap(prior.value) };
    } else {
      if (dataOnly || !prior.configurable || !prior.get || prior.set) return null;
      const wrappers = new Map<Function, Function>();
      installed = { ...prior, get: function (this: unknown, ...args: unknown[]) {
        const original = Reflect.apply(prior.get!, this, args);
        if (typeof original !== "function") return original;
        let result: Function = original;
        note(() => {
          if (!wrappers.has(original)) wrappers.set(original, wrap(original));
          result = wrappers.get(original)!;
        });
        return result;
      } };
    }
    let applied = false;
    const held = () => applied && same(Object.getOwnPropertyDescriptor(target, name), installed);
    ledger.deferRestore(() => {
      if (!applied) return;
      if (!held()) throw new Error("Qwen callable descriptor custody changed");
      Object.defineProperty(target, name, prior);
    });
    Object.defineProperty(target, name, installed); applied = true;
    descriptors.push(held);
    return held;
  }
  function row() { const invocation = current(); return invocation && rows.get(invocation); }
  function begin(kind: string) {
    let observed: any;
    note(() => { observed = row(); if (observed) {
      if (observed.busy || observed[kind] !== 0) observed.ambiguous = true;
      observed.busy++;
    } });
    return observed;
  }
  function call(original: Function, receiver: unknown, args: unknown[], observed: any, kind: string, returned: (value: any) => void) {
    let result;
    try { result = Reflect.apply(original, receiver, args); }
    catch (error) { note(() => { if (observed) { observed[kind] = error === undefined ? 2 : 3; observed.busy--; } }); throw error; }
    note(() => { if (observed) { observed[kind] = 1; observed.busy--; returned(result); } });
    return result;
  }
  function build(host: object) {
    if (hosts.has(host)) return hosts.get(host);
    const owned: any = { held: null, ambiguous: false }; hosts.set(host, owned);
    owned.held = install(host, "buildModelFetch", original => function (this: unknown, ...args: unknown[]) {
      const observed = begin("build");
      note(() => {
        if (!observed || observed.host !== host || this !== host || args[0] !== observed.model || observed.lookup !== 1) {
          owned.ambiguous = true; if (observed) observed.ambiguous = true;
        }
      });
      return call(original, this, args, observed, "build", value => {
        observed.buildValue = value;
        observed.kind = typeof value === "function" ? 1 : value === null ? 2 : value === undefined ? 3 : 4;
      });
    }, true);
    return owned;
  }
  return {
    bind(invocation: Invocation) {
      if (rows.has(invocation)) { rows.get(invocation).ambiguous = true; return; }
      rows.set(invocation, { model: invocation.args[0], lookup: 0, build: 0, kind: 0, hook: 0, relation: 0, busy: 0, ambiguous: false });
    },
    install(hostModule: object, hookModule: object) {
      note(() => { lookupHeld = install(hostModule, "getAiTransportHost", original => function (this: unknown, ...args: unknown[]) {
        const observed = begin("lookup");
        return call(original, this, args, observed, "lookup", host => {
          observed.host = host; observed.owned = build(host);
        });
      }, false); });
      note(() => { hookHeld = install(hookModule, "withOpenAIErrorResponseHook", original => function (this: unknown, ...args: unknown[]) {
        const observed = begin("hook");
        note(() => { if (observed) {
          if (args.length !== 3 || args[2] !== observed.model || observed.lookup !== 1) observed.ambiguous = true;
          else if (observed.build >= 2 || observed.build === 0 && observed.owned?.held) observed.ambiguous = true;
          else if (observed.build === 1) {
            observed.relation = observed.kind === 1 && args[0] === observed.buildValue ? 1
              : [2, 3].includes(observed.kind) && typeof args[0] === "function" ? 2 : 0;
            if (!observed.relation) observed.ambiguous = true;
          }
        } });
        return call(original, this, args, observed, "hook", () => {});
      }, false); });
    },
    snapshot(invocation: Invocation | undefined) {
      const observed = invocation && rows.get(invocation);
      if (!observed || observed.ambiguous || observed.busy || observed.owned?.ambiguous || descriptors.some(held => !held())) return null;
      const custody = (lookupHeld?.() && hookHeld?.() ? 1 : 0) | (observed.owned?.held?.() ? 2 : 0);
      // 1 = associated invocation; outcomes 0/1/2/3 = unobserved/return/
      // throw undefined/throw defined. Relation 2 identifies only the source
      // nullish branch, never equality with an unobserved global fetch. Custody
      // bits attest the two export descriptors and this host data descriptor.
      return Object.freeze([1, observed.lookup, observed.build, observed.kind, observed.hook, observed.relation, custody]);
    },
  };
}

// Tokens follow actual asynchronous invocation ancestry, never a current case or
// equality between caller, guard and fetch signals (which have different owners).
function createQwenOwnership(storage: AsyncLocalStorage<any>, ledger: ReturnType<typeof createQwenLedger>, expected: { url: string; credential: string }) {
  const invocations = new Set<Invocation>(), acquisitions = new Set<Acquisition>(), fetches = new Set<FetchReceipt>();
  const responses = new WeakMap<object, FetchReceipt>();
  // These private maps observe only this installed spy path. They never grant
  // ownership or infer native interception from a zero entry count.
  const contexts = new Map<object, Invocation>(), routes = new Map<Invocation, any>();
  let callable: ReturnType<typeof createQwenCallableWitness> | undefined;
  let values: { bind: (invocation: Invocation) => void; snapshot: (invocation: Invocation | undefined, diagnostic?: boolean) => unknown; close: () => unknown[] } | undefined;
  let unknownEntry = false;
  function passive(record: () => void) {
    try { record(); } catch (error) { ledger.recordingFailure(error); }
  }
  function entry(kind: "provider" | "guard", context: object) {
    const invocation = contexts.get(context), route = invocation && routes.get(invocation);
    if (!route) { unknownEntry = true; return; }
    route[kind].push(context);
    return { invocation, route };
  }
  function routeAtFetch(context: object) {
    const invocation = contexts.get(context), route = invocation && routes.get(invocation);
    if (unknownEntry || !route) return null;
    const relation = (values: object[]) => values.length === 0 ? 0
      : values.every(value => value === context) ? 1 : values.some(value => value === context) ? 3 : 2;
    return Object.freeze([1, route.provider.length, route.guard.length, route.created.length,
      route.failed, route.undefinedFailed, relation(route.provider), relation(route.guard), relation(route.created)]);
  }
  let active = true, publicOpen = true;
  function incomplete(): never { throw new Error("incomplete Qwen invocation ownership"); }
  const current = () => {
    const value = storage.getStore();
    if (!active || !value || !invocations.has(value.invocation) || value.invocation.generation !== ledger.generation) return incomplete();
    return value;
  };
  function invoke<F extends (...args: any[]) => any>(fn: F, receiver: unknown, args: Parameters<F>, caller: object): ReturnType<F> {
    if (!active || !publicOpen) return incomplete();
    const invocation = Object.freeze({ generation: ledger.generation, caller, fn, receiver, args: Object.freeze([...args]) });
    invocations.add(invocation);
    const context = Object.freeze({ invocation });
    passive(() => { contexts.set(context, invocation); routes.set(invocation, { provider: [], guard: [], created: [], failed: 0, undefinedFailed: 0 }); callable?.bind(invocation); values?.bind(invocation); });
    return storage.run(context, () => Reflect.apply(fn, receiver, args)) as ReturnType<F>;
  }
  function guard(fn: Function, receiver: unknown, args: unknown[]) {
    let acquisition: Acquisition | undefined, observed: ReturnType<typeof entry>;
    try {
      const outer = current();
      passive(() => { observed = entry("guard", outer); });
      if (outer.acquisition) incomplete();
      acquisition = { invocation: outer.invocation, input: args[0], fn, receiver, args: Object.freeze([...args]), context: undefined! };
      const context = acquisition.context = Object.freeze({ invocation: outer.invocation, acquisition });
      acquisitions.add(acquisition);
      passive(() => {
        if (observed) { contexts.set(context, observed.invocation); observed.route.created.push(context); }
        else unknownEntry = true;
      });
    } catch (error) {
      passive(() => { if (observed) { observed.route.failed++; if (error === undefined) observed.route.undefinedFailed++; } else unknownEntry = true; });
      ledger.fail(error);
    }
    const call = () => ledger.invoke("acquisition", fn as (...args: any[]) => Promise<any>, receiver, args);
    const pending = acquisition ? storage.run(acquisition.context, call) : call();
    ledger.follow("acquisition_observer", pending, [result => {
      // Release is owned even when identity validation fails afterward.
      const release = result.release;
      ledger.replace(result, "release", function (this: unknown, ...operands: unknown[]) {
        if (this !== result) ledger.fail(new Error("foreign original release receiver"));
        return ledger.invoke("release", release, this, operands);
      });
      const transport = acquisition?.transport;
      if (!acquisition || !transport || acquisition.result || responses.get(result.response) !== transport || transport.response !== result.response) incomplete();
      acquisition.result = result;
    }, () => {}]);
    return pending;
  }
  function wrapFetch(original: Function) {
    return function (this: unknown, ...args: any[]) {
      let receipt: FetchReceipt | undefined, acquisition: Acquisition | undefined, acquisitionObserved = false, route: readonly number[] | null = null;
      let callableInvocation: Invocation | undefined, valueInvocation: Invocation | undefined;
      try {
        const context = current(); acquisition = context.acquisition as Acquisition; acquisitionObserved = true;
        passive(() => { route = routeAtFetch(context); if (callable) callableInvocation = contexts.get(context); if (values) valueInvocation = contexts.get(context); });
        const [input, init] = args;
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (!acquisition || !acquisitions.has(acquisition) || acquisition.context !== context || acquisition.transport || method !== "POST" || url.href !== expected.url || headers.get("authorization") !== "Bearer " + expected.credential) incomplete();
        receipt = { acquisition, context, generation: ledger.generation, fn: original, receiver: this, args: Object.freeze([...args]) }; acquisition.transport = receipt; fetches.add(receipt);
      } catch (error) { ledger.fail(error); }
      const pending = ledger.invoke("fetch", original as (...args: any[]) => Promise<Response>, this, args);
      if (receipt) receipt.pending = pending;
      ledger.follow("fetch_observer", pending, [response => {
        // Passive scratch taps return each original operand unchanged. No error
        // properties, new original subscriptions or repeated getters are used.
        let site = 1, seen = 0, truthy = 0;
        const tap = <T>(bit: number, value: T): T => { seen |= bit; if (value) truthy |= bit; return value; };
        try {
          ledger.response(response, receipt);
          if (tap(1, !receipt) || (site = 2, tap(2, receipt!.response)) || (site = 3, tap(4, responses.has(response)))) {
            site = 4; incomplete();
          }
          site = 5; receipt!.response = response;
          site = 6; responses.set(response, receipt!);
        } catch (error) {
          try { ledger.captureObserverFailure(pending, { site, seen, truthy, receipt: !!receipt,
            acquisition: acquisitionObserved ? !!acquisition : null, route,
            ...(callable ? { callable: callable.snapshot(callableInvocation) } : {}),
            ...(values ? { valueSnapshot: () => values!.snapshot(valueInvocation, true) } : {}) }, error); }
          catch (reportError) { ledger.recordingFailure(reportError); }
          throw error;
        }
      }, () => {}]);
      return pending;
    };
  }
  function verify(count: number, calls = 1) {
    if (invocations.size !== calls || acquisitions.size !== count || fetches.size !== count) incomplete();
    for (const acquisition of acquisitions) {
      const receipt = acquisition.transport;
      if (!receipt || !acquisition.result || !receipt.response || responses.get(receipt.response) !== receipt || receipt.context !== acquisition.context || receipt.generation !== ledger.generation || !receipt.pending) incomplete();
    }
    for (const reader of ledger.readers) if (!reader.owner || !fetches.has(reader.owner as FetchReceipt) || reader.generation !== ledger.generation || reader.response !== (reader.owner as FetchReceipt).response) incomplete();
  }
  return { invoke, guard, wrapFetch, verify, acquisitions, fetches,
    installValues(claim: (current: () => Invocation | undefined) => NonNullable<typeof values>) {
      values = claim(() => contexts.get(storage.getStore()));
    },
    takeValueFailures() { return values?.close() ?? []; },
    installCallables(hostModule: object, hookModule: object, isProxy: (value: any) => boolean) {
      callable = createQwenCallableWitness(ledger, () => contexts.get(storage.getStore()), isProxy);
      callable.install(hostModule, hookModule);
    },
    // Provider entry has no existing context read. Read once here; guard/fetch
    // reuse their original current() result without any additional ALS reads.
    providerEntry() { passive(() => { entry("provider", storage.getStore()); }); },
    closePublic() { publicOpen = false; }, restore() { publicOpen = false; active = false; storage.disable(); } };
}

function qwenClosedRecord(id: string, phase: string, op: string, state: string, counts: { operations: number; rejected: number; pending: number }) {
  if (!qwenRegionCases().some(row => row.id === id) && id !== "none") throw new Error("invalid closed Qwen case");
  if (!["setup", "caller", "join", "restore", "worker", "helper", "relay"].includes(phase)
    || !["case", "acquisition", "acquisition_observer", "fetch", "fetch_observer", "read", "cancel", "body_cancel", "closed", "release", "caller", "ownership", "cleanup", "control"].includes(op)
    || !["passed", "failed", "incomplete", "unrun"].includes(state)) throw new Error("invalid closed Qwen boundary");
  for (const value of Object.values(counts)) if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw new Error("Qwen diagnostic count exceeded");
  return { v: 1, case: id, phase, op, state, operations: counts.operations, rejected: counts.rejected, pending: counts.pending };
}

// A case-scoped ordinal names the privately retained original P and its derived
// observer. Parent state is sampled at the throw, not inferred from the aggregate.
function qwenObserverRecord(input: unknown): Record<string, any> {
  const invalid = (): never => { throw new Error("invalid Qwen observer witness"); };
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input), value: Record<string, any> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !Object.hasOwn(descriptors[key], "value")) return invalid();
    Object.defineProperty(value, key, { value: descriptors[key].value, enumerable: true });
  }
  if (value.v === 9) {
    if (Object.keys(value).at(-1) !== "valueSelection") invalid();
    const selection = value.valueSelection;
    if (selection === null) return { ...qwenObserverRecord({ ...value, v: 8 }), v: 9 };
    if (utilTypes.isProxy(selection) || !Array.isArray(selection)) invalid();
    const fields = Object.getOwnPropertyDescriptors(selection);
    if (Reflect.ownKeys(fields).join() !== "0,1,2,3,4,5,6,7,8,9,10,11,length"
      || fields.length.value !== 12 || Object.values(fields).some(d => !Object.hasOwn(d, "value"))) invalid();
    const s = Array.from({ length: 12 }, (_, i) => fields[String(i)].value);
    const checked = qwenObserverRecord({ ...value, v: 8, valueSelection: s.slice(0, 8) });
    if (!s.slice(8).every(Number.isSafeInteger) || !s.slice(8, 11).every(n => n === 0 || n === 1)
      || ![0, 1, 2].includes(s[11]) || s[8] === 0 && s.slice(9).some(Boolean)
      || s[9] === 0 && s.slice(10).some(Boolean) || s[8] === 1 && !(s[1] & 4)
      || s[10] === 1 && s[11] === 0) invalid();
    return { ...checked, v: 9, valueSelection: s };
  }
  if (value.v === 8) {
    if (Object.keys(value).at(-1) !== "valueSelection") invalid();
    const selection = value.valueSelection;
    if (selection === null) return { ...qwenObserverRecord({ ...value, v: 7 }), v: 8 };
    if (utilTypes.isProxy(selection) || !Array.isArray(selection)
      || Reflect.ownKeys(selection).join() !== "0,1,2,3,4,5,6,7,length") invalid();
    const fields = Object.getOwnPropertyDescriptors(selection);
    if (fields.length.value !== 8 || Object.values(fields).some(d => !Object.hasOwn(d, "value"))) invalid();
    const s = Array.from({ length: 8 }, (_, i) => fields[String(i)].value);
    if (!s.slice(1).every(Number.isSafeInteger) || s[1] < 0 || s[1] > 63
      || ![0, 1, 2].includes(s[5]) || ![0, 1].includes(s[6]) || ![0, 1, 2].includes(s[7])
      || s[1] & 8 && !(s[1] & 2) || s[1] & 16 && !(s[1] & 8) || s[1] & 32 && !(s[1] & 16)
      || s[5] !== 0 && (!(s[1] & 8) || s[4] !== 1)
      || s[6] !== 0 && s[5] !== 1 || s[7] !== 0 && !(s[1] & 32)
      || s[1] & 16 && s[6] !== 1) invalid();
    const checked = qwenObserverRecord({ ...value, v: 7, valueSelection: [s[0], s[1] & 7, ...s.slice(2, 5)] });
    return { ...checked, v: 8, valueSelection: s };
  }
  if (value.v === 7) {
    if (Object.keys(value).at(-1) !== "valueSelection") invalid();
    const { valueSelection, ...prior } = value;
    const tuple = (input: unknown, size: number): any[] => {
      if (utilTypes.isProxy(input) || !Array.isArray(input)) return invalid();
      const fields = Object.getOwnPropertyDescriptors(input);
      if (Reflect.ownKeys(fields).join() !== [...Array.from({ length: size }, (_, i) => String(i)), "length"].join()
        || fields.length.value !== size || Object.values(fields).some(d => !Object.hasOwn(d, "value"))) return invalid();
      return Array.from({ length: size }, (_, i) => fields[String(i)].value);
    };
    prior.valueState = tuple(prior.valueState, 3);
    if (prior.valueSites !== null) prior.valueSites = tuple(prior.valueSites, 6);
    // v7 relay rejection also covers selection-only records with no site entry.
    const rejected = [10, 11].includes(prior.valueState[2]);
    let validation = prior;
    if (rejected && prior.values === null && Array.isArray(prior.valueSites)) {
      const s = prior.valueSites;
      const complete = s[0] === 1 && s[2] === 1 && [11, 15].includes(s[1]) || s[3] === 1 && s[4] === 3 && s[5] === 1;
      const open = s[0] === 1 && s[2] === 0 || s[3] === 1 && s[5] === 0;
      if (!complete) validation = { ...prior, valueState: [prior.valueState[0], prior.valueState[1], open ? 7 : 8] };
    }
    const checked = qwenObserverRecord({ ...validation, v: 6 });
    if (rejected) checked.valueState[2] = prior.valueState[2];
    if (valueSelection === null) return { ...checked, v: 7, valueSelection: null };
    if (rejected || ![0, 7, 8].includes(checked.valueState[2]) || utilTypes.isProxy(valueSelection)
      || !Array.isArray(valueSelection) || Reflect.ownKeys(valueSelection).join() !== "0,1,2,3,4,length") invalid();
    const fields = Object.getOwnPropertyDescriptors(valueSelection);
    if (fields.length.value !== 5 || Object.values(fields).some(d => !Object.hasOwn(d, "value"))) invalid();
    const s = Array.from({ length: 5 }, (_, i) => fields[String(i)].value);
    if (checked.values === null ? typeof s[0] !== "string" || !/^[a-f0-9]{64}$/.test(s[0]) : s[0] !== null) invalid();
    if (!s.slice(1).every(Number.isSafeInteger) || ![0, 1, 3, 5, 7].includes(s[1])
      || s.slice(2).some(n => n < 0 || n > 2) || s[1] === 0 && s.slice(2).some(Boolean)
      || s[4] !== 0 && s[1] !== 7) invalid();
    return { ...checked, v: 7, valueSelection: s };
  }
  if (value.v === 6) {
    if (Object.keys(value).at(-1) !== "valueSites") invalid();
    const { valueSites, ...prior } = value, checked = qwenObserverRecord({ ...prior, v: 5 });
    const reason = checked.valueState[2];
    if (valueSites === null) {
      if ([0, 7, 8, 10, 11].includes(reason)) invalid();
      return { ...checked, v: 6, valueSites: null };
    }
    if (![0, 7, 8, 10, 11].includes(reason) || utilTypes.isProxy(valueSites) || !Array.isArray(valueSites)
      || Reflect.ownKeys(valueSites).join() !== "0,1,2,3,4,5,length") invalid();
    const fields = Object.getOwnPropertyDescriptors(valueSites);
    if (fields.length.value !== 6 || Object.values(fields).some(d => !Object.hasOwn(d, "value"))) invalid();
    const s = Array.from({ length: 6 }, (_, i) => fields[String(i)].value);
    if (!s.every(Number.isSafeInteger) || ![0, 1].includes(s[0]) || ![0, 1].includes(s[2])
      || ![0, 1].includes(s[3]) || ![0, 1].includes(s[5])
      || ![0, 1, 3, 7, 11, 15].includes(s[1]) || ![0, 1, 3].includes(s[4])
      || s[0] === 0 && (s[1] !== 0 || s[2] !== 0)
      || s[3] === 0 && (s[4] !== 0 || s[5] !== 0)) invalid();
    const client = s[0] === 1 && s[2] === 1 && [11, 15].includes(s[1]);
    const guard = s[3] === 1 && s[5] === 1 && s[4] === 3;
    if (reason === 8 && (client || guard)
      || [0, 10, 11].includes(reason) && !(client || guard)
      || reason !== 7 && (s[0] === 1 && s[2] === 0 || s[3] === 1 && s[5] === 0)) invalid();
    if (checked.values !== null && ((checked.values[3] !== 0) !== client
      || (checked.values[7] !== 0) !== guard
      || checked.values[4] !== (client ? s[1] : 0)
      || checked.values[8] !== (guard ? s[4] : 0))) invalid();
    return { ...checked, v: 6, valueSites: s };
  }
  if (value.v === 5) {
    if (Object.keys(value).at(-1) !== "valueState") invalid();
    const { valueState, ...prior } = value, checked = qwenObserverRecord({ ...prior, v: 4 });
    if (utilTypes.isProxy(valueState) || !Array.isArray(valueState)
      || Reflect.ownKeys(valueState).join() !== "0,1,2,length") invalid();
    const fields = Object.getOwnPropertyDescriptors(valueState);
    if (fields.length.value !== 3 || Object.values(fields).some(d => !Object.hasOwn(d, "value"))) invalid();
    const s = [fields[0].value, fields[1].value, fields[2].value];
    if (!s.every(Number.isSafeInteger) || s[0] < 0 || s[1] < 0 || s[2] < 0 || s[2] > 11
      || (s[2] === 0) !== (checked.values !== null)
      || [0, 7, 8, 10, 11].includes(s[2]) && (s[0] !== 1 || s[1] !== 1)
      || s[2] === 5 && s[0] === 1 || s[2] === 6 && (s[0] !== 1 || s[1] === 1)) invalid();
    return { ...checked, v: 5, valueState: s };
  }
  if (value.v === 4) {
    if (Object.keys(value).at(-1) !== "values") invalid();
    const { values, ...prior } = value, checked = qwenObserverRecord({ ...prior, v: 3 });
    if (values === null) return { ...checked, v: 4, values: null };
    if (utilTypes.isProxy(values) || !Array.isArray(values)
      || Reflect.ownKeys(values).join() !== "0,1,2,3,4,5,6,7,8,9,10,length") invalid();
    const fields = Object.getOwnPropertyDescriptors(values);
    if (fields.length.value !== 11 || Object.values(fields).some(d => !Object.hasOwn(d, "value"))) invalid();
    const v = Array.from({ length: 11 }, (_, i) => fields[String(i)].value);
    if (v[0] !== 1 || typeof v[1] !== "string" || !/^[a-f0-9]{64}$/.test(v[1])
      || !v.slice(2).every(Number.isSafeInteger) || v[2] < 1 || v[2] > 206
      || v[3] < 0 || v[3] > 8 || v[7] < 0 || v[7] > 8 || v[9] !== 3 || v[10] !== 0
      || ![0, 11, 15].includes(v[4]) || ![0, 3].includes(v[8])
      || (v[3] === 0) !== (v[4] === 0) || (v[7] === 0) !== (v[8] === 0)
      || v[3] !== 0 && v[3] === v[7] || v[3] === 0 && v[7] === 0
      || (v[4] === 0 ? v[5] !== 0 || v[6] !== 0
        : v[5] !== (v[4] === 11 ? 1 : 2) || v[6] < 1 || v[6] > 9)
      || v[4] === 11 && v[6] <= 2) invalid();
    return { ...checked, v: 4, values: v };
  }
  if (value.v === 3) {
    if (Object.keys(value).at(-1) !== "callable") invalid();
    const { callable, ...prior } = value, checked = qwenObserverRecord({ ...prior, v: 2 });
    if (callable === null) return { ...checked, v: 3, callable: null };
    if (utilTypes.isProxy(callable) || !Array.isArray(callable) || Reflect.ownKeys(callable).join() !== "0,1,2,3,4,5,6,length") invalid();
    const fields = Object.getOwnPropertyDescriptors(callable);
    if (Object.values(fields).some(d => !Object.hasOwn(d, "value"))) invalid();
    const c = Array.from({ length: 7 }, (_, i) => fields[String(i)].value);
    if (!c.every(Number.isSafeInteger) || c[0] !== 1 || c.slice(1, 3).some(n => n < 0 || n > 3)
      || c[3] < 0 || c[3] > 4 || c[4] < 0 || c[4] > 3 || ![0, 1, 2].includes(c[5]) || c[6] < 0 || c[6] > 3
      || (c[2] === 1) !== (c[3] !== 0) || c[1] !== 1 && (c.slice(2, 6).some(Boolean) || (c[6] & 2) !== 0)
      || c[2] !== 0 && (c[6] & 2) === 0 || c[5] !== 0 && (c[2] !== 1 || c[4] === 0)
      || c[4] !== 0 && c[2] === 0 && (c[6] & 2) !== 0
      || c[5] === 1 && c[3] !== 1 || c[5] === 2 && ![2, 3].includes(c[3])
      || c[2] >= 2 && c[4] !== 0 || c[2] === 1 && c[4] !== 0 && c[5] === 0) invalid();
    return { ...checked, v: 3, callable: c };
  }
  if (value.v === 2) {
    if (Object.keys(value).at(-1) !== "route") invalid();
    const { route, ...prior } = value, checked = qwenObserverRecord({ ...prior, v: 1 });
    if (route !== null) {
      if (!Array.isArray(route) || Object.getOwnPropertyNames(route).join() !== "0,1,2,3,4,5,6,7,8,length") invalid();
      const fields = Object.getOwnPropertyDescriptors(route);
      if (Object.values(fields).some(d => !Object.hasOwn(d, "value"))) invalid();
      const r = Array.from({ length: 9 }, (_, i) => fields[String(i)].value);
      if (r[0] !== 1 || !r.every(Number.isSafeInteger) || r.slice(1,6).some(n => n < 0 || n > 65535)
        || r[3] + r[4] > r[2] || r[5] > r[4] || checked.acquisition === null) invalid();
      for (const [count, relation] of [[r[1],r[6]], [r[2],r[7]], [r[3],r[8]]]) {
        if (count === 0 ? relation !== 0 : ![1,2,3].includes(relation) || relation === 3 && count < 2) invalid();
      }
      if (checked.acquisition === false && r[3] > 0 && r[8] !== 2
        || checked.acquisition === true && (r[3] === 0 || ![1,3].includes(r[8]))) invalid();
      return { ...checked, v: 2, route: r };
    }
    return { ...checked, v: 2, route: null };
  }
  if (Object.keys(value).join(",") !== ["v", "kind", "case", "parent", "observer", "site", "seen", "truthy", "receipt", "acquisition", "parentState", "failurePresent", "reasonDefined"].join(",")
    || value.v !== 1 || value.kind !== "observer_failure" || !qwenRegionCases().some(row => row.id === value.case)
    || value.failurePresent !== true || typeof value.reasonDefined !== "boolean"
    || typeof value.receipt !== "boolean" || ![null, false, true].includes(value.acquisition)
    || (value.receipt && value.acquisition !== true)
    || !["pending", "fulfilled", "rejected"].includes(value.parentState)) invalid();
  for (const key of ["parent", "observer"]) if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 65535) invalid();
  if (value.observer <= value.parent || !Number.isInteger(value.site) || value.site < 1 || value.site > 6
    || (value.site === 4 && !value.reasonDefined)) invalid();
  // Short-circuit prefixes: a thrown operand has no result bit. Only the
  // original explicit assertion can carry a truthy association operand.
  const pairs = value.site === 1 ? [[0, 0]] : value.site === 2 ? [[1, 0]] : value.site === 3 ? [[3, 0]]
    : value.site === 4 ? [[1, 1], [3, 2], [7, 4]] : [[7, 0]];
  if (!pairs.some(([seen, truthy]) => value.seen === seen && value.truthy === truthy)
    || (value.seen !== 0 && value.receipt !== !(value.truthy & 1))) invalid();
  return value;
}

// These witnesses describe observed entry and completion, never native acceptance.
function qwenEntryRecord(input: unknown): Record<string, any> {
  const invalid = (): never => { throw new Error("invalid closed Qwen entry witness"); };
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const value: Record<string, any> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return invalid();
    if (!Object.hasOwn(descriptors[key], "value")) return invalid();
    Object.defineProperty(value, key, { value: descriptors[key].value, enumerable: true });
  }
  const keys = ["v", "kind", "pin"];
  if (value.kind === "registration") keys.push("registered", "complete", "failurePresent", "reasonDefined");
  else if (value.kind === "case_enter" || value.kind === "case_complete") keys.push("case", "index");
  else if (value.kind !== "module_evaluated") invalid();
  if (value.kind === "case_complete") keys.push("stage", "state", "failurePresent", "reasonDefined", "operations", "rejected", "pending");
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",") || value.v !== 1
    || value.pin !== "d8bb939408aa4d2be7df0161748edb52ebf3b1fb") invalid();
  const rows = qwenRegionCases();
  if (value.kind === "registration") {
    if (!Number.isSafeInteger(value.registered) || value.registered < 0 || value.registered > rows.length
      || value.complete !== (value.registered === rows.length && value.failurePresent === false)) invalid();
  }
  if (value.kind === "case_enter" || value.kind === "case_complete") {
    if (!Number.isSafeInteger(value.index) || value.index < 0 || value.index >= rows.length
      || typeof value.case !== "string" || rows[value.index].id !== value.case) invalid();
  }
  if (value.kind === "registration" || value.kind === "case_complete") {
    if (typeof value.failurePresent !== "boolean" || typeof value.reasonDefined !== "boolean"
      || (!value.failurePresent && value.reasonDefined)) invalid();
  }
  if (value.kind === "case_complete") {
    if (!["ledger", "ownership", "loader", "guard_hooks", "source_pin", "register_provider", "provider_lookup", "provider_catalog", "normalize", "select", "history_state", "history_policy", "history_sanitize", "convert", "wrap", "caller", "body_assertions", "owned_drain", "ownership_assertions", "restore_ledger", "restore_ownership", "restore_mocks", "restore_globals", "report", "completed"].includes(value.stage)
      || value.state !== (value.failurePresent ? "failed" : "passed")
      || (value.stage === "completed") !== !value.failurePresent) invalid();
    for (const key of ["operations", "rejected", "pending"]) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 65535) invalid();
    }
    if (value.rejected + value.pending > value.operations) invalid();
    if (value.state === "passed" && (value.rejected !== 0 || value.pending !== 0)) invalid();
  }
  return value;
}

function createQwenEntryWitness(emit: (value: Record<string, any>) => void) {
  const rows = qwenRegionCases(), errors: unknown[] = [];
  let registered = 0;
  const send = (fields: Record<string, any>) => {
    try { emit(qwenEntryRecord({ v: 1, pin: "d8bb939408aa4d2be7df0161748edb52ebf3b1fb", ...fields })); }
    catch (error) { errors.push(error); }
  };
  const takeErrors = () => errors.splice(0);
  return {
    moduleEvaluated() { send({ kind: "module_evaluated" }); },
    registered(id: string) {
      if (rows[registered]?.id !== id) throw new Error("Qwen registration order changed");
      registered++;
    },
    registrationComplete(failure?: { reason: unknown }) {
      send({ kind: "registration", registered, complete: registered === rows.length && !failure,
        failurePresent: !!failure, reasonDefined: !!failure && failure.reason !== undefined });
      const reporting = takeErrors();
      if (failure && !reporting.length) throw failure.reason;
      if (failure || reporting.length) throw new AggregateError([...(failure ? [failure.reason] : []), ...reporting], "Qwen registration or witness failed");
    },
    enter(id: string) {
      const index = rows.findIndex(row => row.id === id);
      send({ kind: "case_enter", case: id, index });
      let stage = "ledger", first: { stage: string; reason: unknown } | undefined;
      return {
        at(next: string) { stage = next; },
        failed(reason: unknown) { first ??= { stage, reason }; },
        observe<T>(operationStage: string, original: Promise<T>): Promise<T> {
          void original.then(() => {}, reason => { first ??= { stage: operationStage, reason }; });
          return original;
        },
        complete(counts: { operations: number; rejected: number; pending: number }) {
          send({ kind: "case_complete", case: id, index, stage: first?.stage ?? "completed",
            state: first ? "failed" : "passed", failurePresent: !!first, reasonDefined: !!first && first.reason !== undefined, ...counts });
        },
      };
    },
    takeErrors,
  };
}
// END shared fixture functions.

const originalProviderGuard = transport.fetchWithProviderHttpGuard;
const originalGuard = guard.fetchWithSsrFGuard;
try {
for (const row of qwenRegionCases()) {
it(`${row.id}: registered Qwen ${row.mode}`, async () => {
  const witness = entryWitness.enter(row.id);
  const ledger = createQwenLedger(), failures: unknown[] = [];
  let partial = false, phase = "setup", failedPhase = "setup";
  const controller = new AbortController();
  const key = `clawrouter-live-${row.id}-${row.mode === "invalid_caller" ? "invalid" : "fixture-secret"}`;
  const baseUrl = `${origin}/v1/native/${row.provider}`;
  witness.at("ownership");
  const ownership = createQwenOwnership(new AsyncLocalStorage(), ledger, { url: `${baseUrl}/chat/completions`, credential: key });
  try {
    witness.at("loader");
    const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
    witness.at("guard_hooks");
    ownership.installCallables(aiHost, openAITransport, utilTypes.isProxy);
    ownership.installValues(current => valueSink.claim(valueContract,
      qwenRegionCases().findIndex(candidate => candidate.id === row.id) + 1, current));
    vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: ownership.wrapFetch(undici.fetch) });
    vi.spyOn(transport, "fetchWithProviderHttpGuard").mockImplementation(function (this: unknown, ...args: Parameters<typeof originalProviderGuard>) {
      ownership.providerEntry();
      const options = args[0];
      expect(String(options.url)).toBe(`${baseUrl}/chat/completions`);
      // Preserve the existing loopback SSRF admission; all remaining operands
      // and the original function, receiver and returned promise are retained.
      return Reflect.apply(originalProviderGuard, this, [{ ...options, policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin) }, ...args.slice(1)]);
    });
    vi.spyOn(guard, "fetchWithSsrFGuard").mockImplementation(function (this: unknown, ...args: Parameters<typeof originalGuard>) {
      return ownership.guard(originalGuard, this, args);
    });
    witness.at("source_pin");
    expect(process.env.CLAWROUTER_SDK_SOURCE_HEAD).toBe(sourceHead);
    witness.at("register_provider");
    const { providers } = await registerProviderPlugin({ plugin, id: "qwen", name: "Qwen Provider" });
    witness.at("provider_lookup");
    const provider = requireRegisteredProvider(providers, "qwen");
    witness.at("provider_catalog");
    const catalog = buildQwenProvider({ baseUrl });
    // Loopback is not a coding hostname: eligibility belongs to the real Worker.
    witness.at("normalize");
    expect(provider.normalizeConfig?.({ providerConfig: catalog } as never)).toBeUndefined();
    witness.at("select");
    const selected = catalog.models.find(model => model.id === row.model); expect(selected).toBeDefined();
    const model = { ...selected!, provider: provider.id, api: catalog.api, baseUrl } as Model<"openai-completions">;
    const history: AgentMessage[] = [
      { role: "user", content: "Synthetic tool request", timestamp: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }], api: model.api, provider: model.provider, model: row.model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
      { role: "user", content: `synthetic ${row.id}`, timestamp: 4 },
    ];
    witness.at("history_state");
    const messages = await witness.observe("history_state", withOpenClawTestState({ label: "qwen-regions" }, async state => {
      try {
      witness.at("history_policy");
      const policy = resolveTranscriptPolicy({ provider: model.provider, modelId: row.model, modelApi: model.api, model, runtimeHandle: { provider: model.provider, plugin: provider } });
      witness.at("history_sanitize");
      const replayRegistry = createEmptyPluginRegistry();
      replayRegistry.providers.push({ pluginId: "qwen", provider, source: "test" });
      return witness.observe("history_sanitize", withPluginRuntimeGenerationRegistryScope(replayRegistry, () => sanitizeSessionHistory({ provider: model.provider, modelId: row.model, modelApi: model.api, model, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: row.id,
        sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: model.provider, modelApi: model.api, modelId: row.model })]), messages: history })));
      } catch (error) { witness.failed(error); throw error; }
    }));
    witness.at("convert");
    const context: Context = { messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
    const reasoning = row.mode === "effort_off" ? "off" : row.mode === "effort_low" ? "low" : row.mode === "effort_medium" ? "medium" : "high";
    witness.at("wrap");
    const wrap = row.simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
    const wrapped = wrap?.({ provider: model.provider, modelId: row.model, model, streamFn: row.simple ? streamSimple : stream, thinkingLevel: reasoning });
    expect(wrapped).toBeDefined();
    if (row.mode === "preabort") controller.abort(new Error("synthetic caller cancellation"));
    witness.at("caller");
    phase = "caller";
    const output = ownership.invoke(wrapped!, undefined, [model, context, { apiKey: key, maxTokens: 128, reasoning, signal: controller.signal }], Object.freeze({ id: row.id }));
    for await (const event of output) if (row.mode === "partial" && event.type === "text_delta" && event.delta.length && !partial) {
      partial = true; controller.abort(new Error("synthetic caller cancellation"));
    }
    const result = await ledger.observe("caller", output.result());
    witness.at("body_assertions");
    const success = ["eof", "rotation", "no_usage", "effort_off", "effort_low", "effort_medium"].includes(row.mode);
    expect(result.stopReason).toBe(success ? "stop" : row.mode === "partial" ? "aborted" : "error");
    if (success) {
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      expect(result.usage.totalTokens).toBe(row.mode === "no_usage" ? 0 : 320);
    }
    if (row.mode === "partial") { expect(partial).toBe(true); expect(controller.signal.aborted).toBe(true); }
    if (row.mode === "preabort") expect(result.content).toEqual([]);
  } catch (error) { witness.failed(error); failedPhase = phase; failures.push(error); }
  ownership.closePublic();
  try {
    witness.at("owned_drain");
    await ledger.drain();
    // This asserts attachment to the actual runtime graph. Zero observations
    // cannot qualify a successful stream, and no SDK abort disposition exists.
  } catch (error) { witness.failed(error); if (!failures.length) failedPhase = "join"; failures.push(error); }
  try {
    witness.at("ownership_assertions");
    ownership.verify(row.mode === "preabort" ? 0 : 1);
    expect(ledger.operations.filter(op => op.kind === "release")).toHaveLength(ownership.acquisitions.size);
    if (ownership.acquisitions.size) expect(ledger.readers.length).toBeGreaterThan(0);
  } catch (error) { witness.failed(error); if (!failures.length) failedPhase = "join"; failures.push(error); }
  const restoreStages = ["restore_ledger", "restore_ownership", "restore_mocks", "restore_globals"];
  let restoreIndex = 0;
  for (const restore of [() => ledger.restore(), () => ownership.restore(), () => vi.restoreAllMocks(), () => vi.unstubAllGlobals()]) {
    witness.at(restoreStages[restoreIndex++]);
    try { restore(); } catch (error) { witness.failed(error); if (!failures.length) failedPhase = "restore"; failures.push(error); }
  }
  try { await ledger.drain(); } catch (error) { witness.failed(error); if (!failures.length) failedPhase = "join"; failures.push(error); }
  try { ledger.seal(); } catch (error) { witness.failed(error); if (!failures.length) failedPhase = "join"; failures.push(error); }
  // Append diagnostic faults only AFTER all original drains/restoration failures.
  // No new original subscriptions, context propagation or ownership receipts.
  for (const error of ownership.takeValueFailures()) { witness.failed(error); failures.push(error); }
  witness.at("report");
  for (const error of entryWitness.takeErrors()) { witness.failed(error); failures.push(error); }
  const rejected = ledger.operations.filter(op => op.state === "rejected"), pending = ledger.operations.filter(op => op.state === "pending");
  try {
    console.log("QWEN_SDK_V1 " + JSON.stringify(qwenClosedRecord(row.id, failures.length ? failedPhase : "join", rejected[0]?.kind ?? "case", failures.length ? "failed" : "passed", { operations: ledger.operations.length, rejected: rejected.length, pending: pending.length })));
  } catch (error) { witness.failed(error); failures.push(error); }
  try {
    const observer = ledger.observerRecord(row.id);
    if (observer) console.log("QWEN_OBSERVER_V1 " + JSON.stringify(observer));
  } catch (error) { witness.failed(error); failures.push(error); }
  witness.complete({ operations: ledger.operations.length, rejected: rejected.length, pending: pending.length });
  failures.push(...entryWitness.takeErrors());
  if (failures.length) throw new AggregateError(failures, "Qwen case and original retirement failed");
}, 60_000);
entryWitness.registered(row.id);
}
} catch (error) { entryWitness.registrationComplete({ reason: error }); throw error; }
entryWitness.registrationComplete();
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
