import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { types as nodeTypes } from "node:util";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it as nativeIt, vi } from "vitest";
import { stream, streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import * as catalogGuard from "openclaw/plugin-sdk/ssrf-runtime";
import * as chatGuard from "../../src/agents/provider-transport-dispatcher-pool.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
type Row = { id: string; mode: string; action?: string; unrestricted?: boolean; versioned?: boolean };
const rows = JSON.parse(process.env.CLAWROUTER_CONTRACT_CASES!) as Row[];
const selected = "tenant/private-alias";
const key = (id: string) => `clawrouter-live-${id}-fixture-secret`;
const originalFetch = globalThis.fetch;
const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
const originalCatalogGuard = catalogGuard.fetchWithSsrFGuard;
const originalChatGuard = chatGuard.fetchWithProviderHttpGuard;
type Operation = { kind: string; promise: Promise<unknown>; state?: "pending" | "fulfilled" | "rejected"; reasonDefined?: boolean };
type Acquisition = { kind: "catalog" | "chat"; promise: Promise<unknown>; releases: number; released: Promise<void>; markReleased: () => void };
const operations: Operation[] = [], acquisitions: Acquisition[] = [], failures: unknown[] = [];
const bodies = new Set<ReadableStream<Uint8Array>>();
const readers: Array<{ body: ReadableStream<Uint8Array>; unlocks: number }> = [];
const closes: Array<{ depth: number; original?: Promise<unknown>; threw: boolean; error?: unknown }> = [];
const dispatchers = new Set<object>();
const requests: Array<{ method: string; path: string; credential: string }> = [];
// BEGIN shared proof functions. These observe originals; they grant no disposition.
function litellmOwnership(storage: any) {
  const tokens = new WeakSet<object>(), guards = new WeakSet<object>(), responses = new WeakMap<object, any>(), bodies = new WeakMap<object, any>(), readers = new WeakMap<object, any>();
  const faults: unknown[] = [], transports: any[] = [], reactions: Promise<unknown>[] = [], signals: any[] = [];
  let active = true, sequence = 0;
  let firstFault = "none", relation: Array<boolean | null> = [null, null, null, null];
  const invalid = (code: string, observed: Array<boolean | null> = [null, null, null, null]) => {
    if (firstFault === "none") { firstFault = code; relation = observed; }
    faults.push(new Error("incomplete LiteLLM invocation ownership"));
  };
  function signal(value: AbortSignal | null | undefined) {
    const row: any = { signal: value, observed: false, initial: null, event: null, reasonPresent: false, reason: undefined }; let attached = false;
    const abort = () => { try { row.event = ++sequence; row.reasonPresent = true; row.reason = value?.reason; } catch (error) { faults.push(error); } };
    try {
      row.initial = value?.aborted ?? null; row.reasonPresent = value?.aborted === true; row.reason = value?.aborted ? value.reason : undefined;
      value?.addEventListener("abort", abort, { once: true }); attached = !!value; row.observed = !!value;
    } catch (error) { faults.push(error); }
    row.restore = () => { if (attached) value?.removeEventListener("abort", abort); }; signals.push(row); return row;
  }
  const current = () => { const c = storage.getStore(); return active && c && tokens.has(c.token) ? c : undefined; };
  const bound = (a: any) => {
    const t = a?.transport;
    return !!(active && guards.has(a) && t?.context === a.context && t.acquisition === a && t.unique && t.state === "fulfilled"
      && a.result?.response === t.response && a.result.response.body === t.body && responses.get(t.response) === t && (!t.body || bodies.get(t.body) === t));
  };
  return {
    faults, transports, signals,
    invoke(owner: any, fn: Function, receiver: unknown, args: any[]) {
      if (!active || !["catalog", "chat"].includes(owner.role) || args[owner.role === "catalog" ? 0 : 2]?.signal !== owner.signal) invalid("invoke");
      const token = Object.freeze({ owner: Object.freeze({ ...owner }), fn, receiver, args: Object.freeze([...args]), caller: signal(owner.signal) });
      tokens.add(token);
      return storage.run(Object.freeze({ token }), () => Reflect.apply(fn, receiver, args));
    },
    guard(kind: string, fn: Function, receiver: unknown, args: any[], a: any) {
      const c = current();
      if (!c || c.acquisition || guards.has(a) || c.token.owner.role !== kind) { invalid("guard", [!!c, !!c?.acquisition, c ? c.token.owner.role === kind : null, guards.has(a)]); return Reflect.apply(fn, receiver, args); }
      guards.add(a); a.context = Object.freeze({ token: c.token, acquisition: a });
      a.guardInput = signal(args[0]?.signal ?? args[0]?.init?.signal);
      a.fn = fn; a.receiver = receiver; a.args = args;
      return storage.run(a.context, () => Reflect.apply(fn, receiver, args));
    },
    fetch(fn: Function, receiver: unknown, args: any[], facts: any) {
      const c = current(), a = c?.acquisition;
      const t: any = { context: c, acquisition: a, fn, receiver, args, state: "invoke", unique: false, input: signal(facts.signal) }; transports.push(t);
      if (!a || !guards.has(a) || a.context !== c || a.transport || c.token.owner.url !== facts.url || c.token.owner.credential !== facts.credential
        || (c.token.owner.role === "catalog" ? "GET" : "POST") !== facts.method) invalid("fetch", [!!c, !!a, a ? guards.has(a) : null, a ? a.context === c : null]);
      else a.transport = t;
      let pending;
      try { pending = Reflect.apply(fn, receiver, args); t.pending = pending; }
      catch (reason) { t.state = "sync_throw"; t.reasonPresent = true; t.reason = reason; throw reason; }
      const reaction = pending.then((response: Response) => {
        t.state = "fulfilled"; t.response = response; t.body = response.body;
        const prior = responses.get(response), priorBody = t.body && bodies.get(t.body);
        if (prior || priorBody) { if (prior) prior.unique = false; if (priorBody) priorBody.unique = false; invalid("response_unique"); return; }
        responses.set(response, t); if (t.body) bodies.set(t.body, t); t.unique = true;
      }, (reason: unknown) => { t.state = "rejected"; t.reasonPresent = true; t.reason = reason; });
      reactions.push(reaction.catch((error: unknown) => { faults.push(error); })); return pending;
    },
    attach(a: any, result: any) { if (a.result) invalid("attach_duplicate"); a.result = result; if (!bound(a)) invalid("attach_bound", [guards.has(a), !!a.transport, a.transport ? a.transport.acquisition === a : null, a.transport ? a.result?.response === a.transport.response : null]); return bound(a); },
    reader(body: object, reader: object, receiver: unknown) {
      const t = bodies.get(body), c = current();
      if (!t || receiver !== body || readers.has(reader) || !c || c.token !== t.context?.token) invalid("reader", [!!c, !!t, c && t?.context ? c.token === t.context.token : null, receiver === body]); else readers.set(reader, t);
    },
    operation(reader: object, receiver: unknown) {
      const t = readers.get(reader), c = current();
      if (!t || receiver !== reader || !c || c.token !== t.context?.token) invalid("reader_operation", [!!c, !!t, c && t?.context ? c.token === t.context.token : null, receiver === reader]);
    },
    bodyCancel(body: object, receiver: unknown) {
      const t = bodies.get(body), c = current();
      if (!t || receiver !== body || !c || c.token !== t.context?.token) invalid("body_cancel", [!!c, !!t, c && t?.context ? c.token === t.context.token : null, receiver === body]);
    },
    bound,
    diagnostic() {
      const rejected = transports.find(t => t.state === "rejected" || t.state === "sync_throw");
      return { first: firstFault === "none" && faults.length ? "observer" : firstFault, relation: [...relation], faults: Math.min(faults.length, 1_000_000),
        transports: [transports.length, ...["invoke", "fulfilled", "rejected", "sync_throw"].map(state => transports.filter(t => t.state === state).length)].map(n => Math.min(n, 1_000_000)),
        defined: rejected ? rejected.reason !== undefined : null };
    },
    async join() {
      let at = 0;
      while (at < transports.length) { const batch = transports.slice(at); at += batch.length; await Promise.allSettled(batch.flatMap(t => t.pending ? [t.pending] : [])); }
      await Promise.all(reactions);
      return [...faults, ...transports.filter(t => ["rejected", "sync_throw"].includes(t.state)).map(t => t.reason)];
    },
    restore() {
      if (!active) throw new Error("duplicate LiteLLM ownership restoration"); active = false;
      const errors: unknown[] = [];
      for (const row of signals) try { row.restore(); } catch (error) { errors.push(error); }
      try { storage.disable(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "LiteLLM ownership restoration failed");
    },
  };
}
function litellmJoinFacts(at: string, body: string, operations: Operation[], acquisitions: Array<{ releases: number }>, readers: Array<{ unlocks: number }>, bodies: Set<ReadableStream>, failures: unknown[], owner: { diagnostic: () => { first: string; relation: Array<boolean | null>; faults: number; transports: number[]; defined: boolean | null } }) {
  const cap = (n: number) => Math.min(n, 1_000_000), first = operations.find(row => row.state === "rejected");
  return {
    at, body,
    ops: [cap(operations.length), cap(operations.filter(row => row.state === "pending").length), cap(operations.filter(row => row.state === "fulfilled").length), cap(operations.filter(row => row.state === "rejected").length)],
    first: first ? [first.kind, first.reasonDefined === true] : null,
    resources: [cap(acquisitions.length), cap(acquisitions.filter(row => row.releases !== 1).length), cap(readers.length), cap(readers.filter(row => row.unlocks !== 1).length), cap([...bodies].filter(body => body.locked).length), cap(failures.length)],
    ownership: owner.diagnostic(),
  };
}
function litellmDiagnostics(ids: string[], isProxy: (v: unknown) => boolean) {
  const prefix = "LITELLM_PROOF_V1 ", phases = new Set(["setup", "body", "catalog", "chat", "control", "join", "restore", "child_launch", "child_result", "retirement", "cleanup", "overflow"]);
  const names = new Set(["none", ...ids]), seen = new Set<string>(); let emitted = 0, suppressed = 0, bytes = 0, overflow = false;
  const own = (v: unknown, k: string) => { try { return v && typeof v === "object" && !isProxy(v) ? Object.getOwnPropertyDescriptor(v, k)?.value : undefined; } catch { return undefined; } };
  const fields = (v: unknown, keys: string[]) => {
    if (!v || typeof v !== "object" || isProxy(v) || Reflect.ownKeys(v).length !== keys.length || keys.some(k => !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k) ?? {}, "value"))) return null;
    return Object.fromEntries(keys.map(k => [k, own(v, k)]));
  };
  const array = (v: unknown, length: number, valid: (v: unknown) => boolean) => {
    if (!Array.isArray(v) || isProxy(v) || own(v, "length") !== length || Reflect.ownKeys(v).length !== length + 1) return null;
    const out: any[] = [];
    for (let i = 0; i < length; i++) { const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d || !Object.hasOwn(d, "value") || !valid(d.value)) return null; out.push(d.value); }
    return out;
  };
  function joinFacts(value: unknown) {
    const j = fields(value, ["at", "body", "ops", "first", "resources", "ownership"]);
    if (!j || !["release_wait", "original_drain", "release_count", "acquisition_count", "reader_unlock", "body_unlocked", "dispatcher_count", "dispatcher_throw", "dispatcher_original", "dispatcher_result", "dispatcher_destroyed", "ownership", "original_observer"].includes(j.at)
      || !["unknown", "fulfilled", "rejected"].includes(j.body)) return null;
    const number = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000;
    const ops = array(j.ops, 4, number), resources = array(j.resources, 6, number), owner = fields(j.ownership, ["first", "relation", "faults", "transports", "defined"]);
    const relation = owner && array(owner.relation, 4, v => v === null || typeof v === "boolean");
    const transports = owner && array(owner.transports, 5, number);
    if (!ops || !resources || !owner || !relation || !transports || !(owner.defined === null || typeof owner.defined === "boolean") || !number(owner.faults) || !["none", "observer", "invoke", "guard", "fetch", "response_unique", "attach_duplicate", "attach_bound", "reader", "reader_operation", "body_cancel"].includes(owner.first)) return null;
    const first = j.first === null ? null : array(j.first, 2, v => typeof v === "string" || typeof v === "boolean");
    if (j.first !== null && (!first || !["body_cancel", "closed", "read", "cancel", "dispatcher", "native_acquisition", "response_observer", "guard_acquisition", "lease_observer", "release"].includes(first[0]) || typeof first[1] !== "boolean")) return null;
    return { at: j.at, body: j.body, ops, first, resources, ownership: { first: owner.first, relation, faults: owner.faults, transports, defined: owner.defined } };
  }
  function validate(v: unknown) {
    try {
      if (!v || typeof v !== "object" || isProxy(v)) return null;
      const keys = ["v", "layer", "id", "role", "phase", "kind", "count", "code"];
      if (Object.hasOwn(v, "join")) keys.push("join");
      if (Reflect.ownKeys(v).length !== keys.length || keys.some(k => !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k) ?? {}, "value"))) return null;
      const r: any = Object.fromEntries(keys.map(k => [k, own(v, k)]));
      if (r.v !== 1 || !["sdk", "outer"].includes(r.layer) || !names.has(r.id) || !["unknown", "catalog", "chat"].includes(r.role) || !phases.has(r.phase)
        || !["undefined", "unknown", "child", "overflow"].includes(r.kind) || !(r.count === null || Number.isSafeInteger(r.count) && r.count >= 0 && r.count <= 1000000)
        || !["UNKNOWN", "EXIT_1", "TIMEOUT", "SIGTERM", "SIGKILL"].includes(r.code)) return null;
      if (keys.includes("join")) { if (r.phase !== "join" || !(r.join = joinFacts(r.join))) return null; }
      return r;
    } catch { return null; }
  }
  const record = (layer: string, id: string, phase: string, error: unknown, role = "unknown", count: number | null = null) => {
    const value = validate({ v: 1, layer, id, role, phase, kind: error === undefined ? "undefined" : "unknown", count, code: "UNKNOWN" });
    if (!value) throw new Error("invalid LiteLLM diagnostic"); return value;
  };
  const joined = (value: unknown, facts: unknown) => { const r = validate({ ...validate(value), join: facts }); if (!r) throw new Error("invalid LiteLLM join diagnostic"); return r; };
  function parse(text: unknown) {
    if (typeof text !== "string" || text.length > 2 * 1024 * 1024) return [];
    const records = [];
    for (const line of text.split("\n")) {
      const clean = line.trimStart(); if (!clean.startsWith(prefix) || clean.length > 768) continue;
      try { const r = validate(JSON.parse(clean.slice(prefix.length))); if (r) records.push(r); } catch {}
      if (records.length >= 64) break;
    }
    return records;
  }
  function child(error: unknown) {
    const records: any[] = [], queue = [{ value: error, depth: 0 }]; let resultCode = "UNKNOWN";
    for (let index = 0; index < queue.length && index < 4; index++) {
      const { value, depth } = queue[index];
      records.push(...parse(own(value, "stdout")), ...parse(own(value, "stderr")));
      const code = own(value, "code"), signal = own(value, "signal"), killed = own(value, "killed");
      if (resultCode === "UNKNOWN") resultCode = signal === "SIGTERM" || signal === "SIGKILL" ? signal : code === 1 ? "EXIT_1" : killed === true ? "TIMEOUT" : "UNKNOWN";
      const errors = own(value, "errors");
      if (depth < 2 && Array.isArray(errors) && !isProxy(errors)) for (let n = 0; n < Math.min(errors.length, 4) && queue.length < 4; n++) {
        const item = Object.getOwnPropertyDescriptor(errors, String(n));
        if (item && Object.hasOwn(item, "value")) queue.push({ value: item.value, depth: depth + 1 });
      }
    }
    return { records, envelope: { v: 1, layer: "outer", id: "none", role: "unknown", phase: "child_result", kind: "child", count: records.length,
      code: resultCode } };
  }
  function emit(records: unknown[], write: (s: string) => void) {
    for (const value of records) {
      const r = validate(value); if (!r) throw new Error("invalid LiteLLM diagnostic");
      const key = [r.layer, r.role, r.id, r.phase].join("/"); if (seen.has(key)) continue; seen.add(key);
      if (emitted >= 9) { suppressed++; continue; }
      const line = `::error title=LiteLLM typed contract::${JSON.stringify(r).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`;
      const size = new TextEncoder().encode(line).length;
      if (size > 768 || bytes + size > 8192) throw new Error("LiteLLM diagnostic quota");
      write(line); bytes += size; emitted++;
    }
  }
  function flush(write: (s: string) => void) {
    if (!suppressed || overflow) return; overflow = true;
    const r = { v: 1, layer: "outer", id: "none", role: "unknown", phase: "overflow", kind: "overflow", count: Math.min(suppressed, 1000000), code: "UNKNOWN" };
    const line = `::error title=LiteLLM typed contract::${JSON.stringify(r)}\n`; const size = new TextEncoder().encode(line).length;
    if (size > 768 || bytes + size > 8192) throw new Error("LiteLLM diagnostic quota"); write(line); bytes += size;
  }
  return { prefix, own, validate, record, joined, parse, child, emit, flush };
}
// END shared proof functions.
let ownership = litellmOwnership(new AsyncLocalStorage());
const diagnostic = litellmDiagnostics(rows.map(row => row.id), nodeTypes.isProxy);
let diagnosticId = "none", diagnosticRole = "unknown", diagnosticRecords: any[] = [], diagnosticSuppressed = 0, bodyOutcome = "unknown";
function reportSdk(phase: string, error: unknown, join?: ReturnType<typeof litellmJoinFacts>) {
  if (diagnosticRecords.length < 63) {
    const record = diagnostic.record("sdk", diagnosticId, phase, error, diagnosticRole);
    diagnosticRecords.push(join ? diagnostic.joined(record, join) : record);
  } else diagnosticSuppressed++;
}
function flushSdk() {
  if (diagnosticSuppressed) { diagnosticRecords.push(diagnostic.record("sdk", "none", "overflow", undefined, "unknown", Math.min(diagnosticSuppressed, 1000000))); diagnosticSuppressed = 0; }
  for (const record of diagnosticRecords.splice(0, 64)) process.stdout.write(diagnostic.prefix + JSON.stringify(record) + "\n");
}
function remember<T extends Promise<unknown>>(kind: string, promise: T): T {
  const record: Operation = { kind, promise, state: "pending" }; operations.push(record);
  void promise.then(() => { record.state = "fulfilled"; }, error => { record.state = "rejected"; record.reasonDefined = error !== undefined; }); return promise;
}
function raise(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "LiteLLM body or original retirement failed");
}
// This exact function is extracted by the outer Node tests. No rejection class
// is accepted here: control executions must qualify native outcomes first.
async function drainOriginals(records: Operation[]): Promise<void> {
  const errors: unknown[] = []; let cursor = 0;
  while (cursor < records.length) {
    const batch = records.slice(cursor); cursor += batch.length;
    const outcomes = await Promise.allSettled(batch.map(record => record.promise));
    for (const result of outcomes) if (result.status === "rejected") errors.push(result.reason);
  }
  raise(errors);
}
function observeBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body || bodies.has(body)) return;
  bodies.add(body);
  const get = body.getReader, cancel = body.cancel;
  vi.spyOn(body, "cancel").mockImplementation(function (this: typeof body, ...args) {
    ownership.bodyCancel(body, this);
    try { return remember("body_cancel", Reflect.apply(cancel, this, args)); } catch (error) { failures.push(error); throw error; }
  });
  vi.spyOn(body, "getReader").mockImplementation(function (this: typeof body, ...args) {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try { reader = Reflect.apply(get, this, args); } catch (error) { failures.push(error); throw error; }
    ownership.reader(body, reader, this);
    const record = { body, unlocks: 0 }; readers.push(record); remember("closed", reader.closed);
    for (const kind of ["read", "cancel"] as const) {
      const original = reader[kind];
      vi.spyOn(reader, kind).mockImplementation(function (this: typeof reader, ...values: unknown[]) {
        ownership.operation(reader, this);
        try { return remember(kind, Reflect.apply(original, this, values)); } catch (error) { failures.push(error); throw error; }
      });
    }
    const unlock = reader.releaseLock;
    vi.spyOn(reader, "releaseLock").mockImplementation(function (this: typeof reader, ...args: unknown[]) {
      ownership.operation(reader, this);
      try { const value = Reflect.apply(unlock, this, args); record.unlocks++; return value; } catch (error) { failures.push(error); throw error; }
    });
    return reader;
  });
}
function observeTransport(this: unknown, ...args: Parameters<typeof undici.fetch>): Promise<Response> {
  const [input, init] = args;
  const request = { url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    method: init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET"),
    headers: new Headers(init?.headers !== undefined ? init.headers : typeof input === "object" && "headers" in input ? input.headers : undefined) };
  const url = new URL(request.url), credential = request.headers.get("authorization") ?? "";
  expect(url.origin).toBe(origin); expect(url.search).toBe("");
  expect(["/v1/native/litellm/models", "/v1/native/litellm/v1/models", "/v1/native/litellm/chat/completions", "/v1/native/litellm/v1/chat/completions"]).toContain(url.pathname);
  expect(rows.some(row => credential === "Bearer " + key(row.id))).toBe(true);
  expect(request.headers.has("x-api-key")).toBe(false);
  requests.push({ method: request.method, path: url.pathname, credential });
  const dispatcher = (init as { dispatcher?: import("undici").Dispatcher } | undefined)?.dispatcher;
  if (!dispatcher) throw new Error("missing original runtime dispatcher");
  if (request.method === "GET" && !dispatchers.has(dispatcher)) {
    dispatchers.add(dispatcher); const original = dispatcher.close; let depth = 0;
    vi.spyOn(dispatcher, "close").mockImplementation(function (this: typeof dispatcher, ...args: unknown[]) {
      const call = { depth, threw: false } as (typeof closes)[number]; closes.push(call); depth++;
      try {
        const result = Reflect.apply(original, this, args);
        if (result && typeof result.then === "function") call.original = remember("dispatcher", result);
        return result;
      } catch (error) { call.threw = true; call.error = error; failures.push(error); throw error; }
      finally { depth--; }
    } as typeof dispatcher.close);
  }
  const signal = init?.signal !== undefined ? init.signal : typeof input === "object" && "signal" in input ? input.signal : undefined;
  const pending = ownership.fetch(undici.fetch, this, args, { url: request.url, method: request.method.toUpperCase(), credential, signal }) as Promise<Response>;
  remember("native_acquisition", pending);
  remember("response_observer", pending.then(response => { observeBody(response.body); }));
  return pending;
}
function observeLease(kind: Acquisition["kind"], fn: Function, receiver: unknown, args: any[]): Promise<any> {
  let markReleased!: () => void;
  const released = new Promise<void>(resolve => { markReleased = resolve; });
  const record: any = { kind, releases: 0, released, markReleased }; acquisitions.push(record);
  let pending;
  try { pending = ownership.guard(kind, fn, receiver, args, record); record.promise = pending; }
  catch (error) { failures.push(error); markReleased(); throw error; }
  remember("guard_acquisition", pending);
  remember("lease_observer", pending.then((result: any) => {
    try {
    ownership.attach(record, result);
    observeBody(result.response.body); const release = result.release;
    vi.spyOn(result, "release").mockImplementation(function (this: any, ...values: unknown[]) {
      record.releases++;
      try { const value = Reflect.apply(release, this, values); remember("release", value); void value.then(markReleased, markReleased); return value; }
      catch (error) { failures.push(error); markReleased(); throw error; }
    });
    } catch (error) { failures.push(error); markReleased(); throw error; }
  }, () => { markReleased(); }));
  return pending;
}
const it = (name: string, body: () => Promise<void>, timeout: number) => nativeIt(name, async () => {
  try { await body(); bodyOutcome = "fulfilled"; }
  catch (error) {
    bodyOutcome = "rejected";
    try { reportSdk("body", error); flushSdk(); } catch (reportError) { throw new AggregateError([error, reportError], "LiteLLM body and reporting failed"); }
    throw error;
  }
}, timeout);
beforeEach(() => {
  diagnosticId = "none"; diagnosticRole = "unknown"; diagnosticRecords = []; diagnosticSuppressed = 0; bodyOutcome = "unknown";
  ownership = litellmOwnership(new AsyncLocalStorage());
  try {
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(sourceHead);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sourceHead);
  clearLiveCatalogCacheForTests(); operations.length = 0; acquisitions.length = 0; failures.length = 0;
  bodies.clear(); readers.length = 0; closes.length = 0; dispatchers.clear(); requests.length = 0;
  for (const name of ["LITELLM_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(name, "poison-environment");
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: observeTransport });
  vi.spyOn(catalogGuard, "fetchWithSsrFGuard").mockImplementation(function (options) {
    return observeLease("catalog", originalCatalogGuard, this, [options]);
  });
  vi.spyOn(chatGuard, "fetchWithProviderHttpGuard").mockImplementation(function (options) {
    return observeLease("chat", originalChatGuard, this, [options]);
  });
  } catch (error) {
    try { reportSdk("setup", error); flushSdk(); } catch (reportError) { throw new AggregateError([error, reportError], "LiteLLM setup and reporting failed"); }
    throw error;
  }
});
afterEach(async () => {
  const errors: unknown[] = [];
  let checkpoint = "release_wait", failedCheckpoint: string | undefined;
  try {
    // A fulfilled response is not release completion. Follow each original
    // guard through its consumed release before draining dynamically added work.
    await Promise.all(acquisitions.map(row => row.released));
    checkpoint = "original_drain";
    await drainOriginals(operations);
    checkpoint = "release_count";
    for (const row of acquisitions) { expect(row.releases).toBe(1); }
    checkpoint = "acquisition_count";
    expect(acquisitions.length).toBe(requests.length);
    checkpoint = "reader_unlock";
    for (const reader of readers) expect(reader.unlocks).toBe(1);
    checkpoint = "body_unlocked";
    for (const body of bodies) expect(body.locked).toBe(false);
    const external = closes.filter(row => row.depth === 0);
    checkpoint = "dispatcher_count";
    expect(external).toHaveLength(dispatchers.size);
    for (const row of external) {
      checkpoint = "dispatcher_throw"; expect(row.threw).toBe(false);
      checkpoint = "dispatcher_original"; expect(row.original).toBeDefined();
      checkpoint = "dispatcher_result"; expect(await row.original).toBeNull();
    }
    checkpoint = "dispatcher_destroyed";
    for (const dispatcher of dispatchers) expect(Reflect.get(dispatcher, "destroyed")).toBe(true);
    // Inference owns a pooled request lease, never the global pool lifetime.
  } catch (error) { failedCheckpoint = checkpoint; errors.push(error); }
  try { const ownedErrors = await ownership.join(); if (ownedErrors.length) failedCheckpoint ??= "ownership"; errors.push(...ownedErrors); } catch (error) { failedCheckpoint ??= "ownership"; errors.push(error); }
  errors.push(...failures);
  let join: ReturnType<typeof litellmJoinFacts> | undefined;
  if (errors.length) try { join = litellmJoinFacts(failedCheckpoint ?? "original_observer", bodyOutcome, operations, acquisitions, readers, bodies, failures, ownership); } catch (error) { errors.push(error); }
  for (const error of errors) try { reportSdk("join", error, join); } catch (reportError) { errors.push(reportError); break; }
  for (const restore of [() => ownership.restore(), () => vi.restoreAllMocks(), () => vi.unstubAllGlobals(), () => vi.unstubAllEnvs(), () => clearLiveCatalogCacheForTests()]) {
    try { restore(); } catch (error) { errors.push(error); try { reportSdk("restore", error); } catch (reportError) { errors.push(reportError); } }
  }
  try { flushSdk(); } catch (error) { errors.push(error); }
  raise(errors);
});
async function control(action: string, id: string): Promise<void> {
  try {
    const response = await originalFetch(`${origin}/__litellm/${action}/${id}`, { method: ["started", "retire"].includes(action) ? "GET" : "POST" });
    await response.arrayBuffer(); expect(response.status).toBe(200);
  } catch (error) { try { reportSdk("control", error); flushSdk(); } catch (reportError) { throw new AggregateError([error, reportError], "LiteLLM control and reporting failed"); } throw error; }
}
async function fixture(body: (discover: (row: Row, signal?: AbortSignal, authId?: string) => Promise<ModelProviderConfig | undefined>) => Promise<void>): Promise<void> {
  const { default: entry } = await loadBundledPluginFacade<{ default: Parameters<typeof registerSingleProviderPlugin>[0] }>({ pluginId: "litellm", artifactBasename: "index.js" });
  const provider = await registerSingleProviderPlugin(entry); expect(provider.catalog?.run).toBeTypeOf("function");
  await withOpenClawTestState({ label: "litellm-worker" }, async state => {
    const discover = async (row: Row, signal?: AbortSignal, authId = row.id) => {
      const baseUrl = origin + "/v1/native/litellm" + (row.versioned ? "/v1" : ""); let resolutions = 0;
      const auth = { apiKey: key(authId), discoveryApiKey: key(row.id), profileId: row.id, mode: "api_key" as const, source: "profile" as const };
      diagnosticId = row.id; diagnosticRole = "catalog";
      const result = await ownership.invoke({ id: row.id, role: "catalog", signal, url: baseUrl + "/models", credential: "Bearer " + key(row.id) }, provider.catalog!.run, provider.catalog, [{ config: { models: { providers: { litellm: { baseUrl, models: [] } } } }, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir, signal,
        resolveProviderAuth: () => { throw new Error("unexpected second auth resolver"); }, resolveProviderApiKey: () => { resolutions++; return auth; } }]);
      expect(resolutions).toBe(1);
      if (!result || !("provider" in result)) return undefined;
      if (result.provider) { expect(result.provider.baseUrl).toBe(baseUrl); expect(result.provider.apiKey).toBe(key(authId)); }
      return result.provider;
    };
    await body(discover);
  });
}
async function infer(catalog: ModelProviderConfig, row: Row, signal?: AbortSignal, simple = true) {
  const model = catalog.models.find(value => value.id === selected); expect(model).toBeDefined();
  diagnosticId = row.id; diagnosticRole = "chat";
  return ownership.invoke({ id: row.id, role: "chat", signal, url: catalog.baseUrl + "/chat/completions", credential: "Bearer " + key(row.id) }, simple ? streamSimple : stream, undefined,
    [{ ...model, provider: "litellm", api: "openai-completions", baseUrl: catalog.baseUrl } as Model<"openai-completions">,
    { messages: [{ role: "user", content: "synthetic fixture", timestamp: 1 }] }, { apiKey: key(row.id), maxTokens: 16, signal }]);
}

describe("registered LiteLLM live inventory and native inference", () => {
  // Genuine controls come first. No stored-error/cancellation exemption is
  // borrowed from another provider; all original operations remain strict.
  for (const id of ["sdk_eof", "sdk_preabort", "sdk_partial_abort", "sdk_provider_error"]) it(id, async () => {
    const row = rows.find(value => value.id === id)!;
    await fixture(async discover => {
      const catalog = await discover(row); expect(catalog).toBeDefined();
      const controller = new AbortController(); if (id === "sdk_preabort") controller.abort();
      const events = await infer(catalog!, row, controller.signal);
      let partial = false;
      for await (const event of events) if (id === "sdk_partial_abort" && event.type === "text_delta") { partial = true; controller.abort(); break; }
      const result = await events.result();
      if (id === "sdk_eof") expect(result.stopReason).toBe("stop");
      else if (id === "sdk_provider_error") { expect(controller.signal.aborted).toBe(false); expect(result.stopReason).toBe("error"); }
      else { expect(controller.signal.aborted).toBe(true); expect(result.stopReason).toBe(id === "sdk_preabort" ? "error" : "aborted"); }
      if (id === "sdk_partial_abort") expect(partial).toBe(true);
    });
  }, 120_000);
  for (const row of rows.filter(value => value.action === "stream" || value.action === "streamSimple")) it(row.id, async () => {
    await fixture(async discover => {
      const catalog = await discover(row); expect(catalog?.models.map(model => model.id)).toContain(selected);
      const result = await (await infer(catalog!, row, undefined, row.action === "streamSimple")).result();
      expect(result.stopReason).toBe("stop"); expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      if (row.mode === "measured") expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
      expect(requests.map(request => request.method)).toEqual(["GET", "POST"]);
    });
  }, 120_000);
  for (const row of rows.filter(value => value.action === "catalog")) it(row.id, async () => {
    await fixture(async discover => {
      const result = await discover(row);
      if (row.mode === "table") { expect(result?.models.map(model => model.id)).toEqual([selected]); expect(result?.models[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); }
      else if (row.mode === "empty") expect(result?.models).toEqual([]);
      else expect(result).toBeUndefined();
      expect(requests).toHaveLength(1); expect(requests[0].method).toBe("GET");
    });
  }, 120_000);
  it("keeps warm catalog keys and configured versioned bases isolated without clearing between them", async () => {
    await fixture(async discover => {
      const a = rows.find(row => row.id === "sdk_warm_a")!, b = rows.find(row => row.id === "sdk_warm_b")!;
      expect((await discover(a))?.models.map(model => model.id)).toEqual([selected]);
      expect((await discover(b))?.models).toEqual([]);
      expect((await discover(a))?.models.map(model => model.id)).toEqual([selected]);
      expect((await discover({ ...a, versioned: true }))?.models.map(model => model.id)).toEqual([selected]);
      expect(requests).toHaveLength(3); expect(requests[0].credential).not.toBe(requests[1].credential);
    });
  }, 120_000);
  it("keeps discovery profile and explicit inference credentials distinct", async () => {
    await fixture(async discover => {
      const metadata = rows.find(row => row.id === "sdk_auth_metadata")!, inference = rows.find(row => row.id === "sdk_auth_inference")!;
      const catalog = await discover(metadata, undefined, inference.id); expect(catalog).toBeDefined();
      expect((await (await infer(catalog!, inference)).result()).stopReason).toBe("stop");
      expect(requests.map(row => row.credential)).toEqual(["Bearer " + key(metadata.id), "Bearer " + key(inference.id)]);
    });
  }, 120_000);
  for (const action of ["narrow", "broaden", "revoke"]) it("withholds or intersects a held original acquisition: " + action, async () => {
    await fixture(async discover => {
      const row = rows.find(value => value.id === "sdk_held_" + action)!;
      const pending = discover(row); const outcome = pending.then(value => ({ value }), error => ({ error }));
      try { await control("started", row.id); await control(action, row.id); } finally { await control("release", row.id); }
      const result = await outcome; if ("error" in result) throw result.error;
      if (action === "revoke") expect(result.value).toBeUndefined();
      else expect(result.value?.models.map(model => model.id)).toEqual(action === "narrow" ? [] : [selected]);
      expect(requests).toHaveLength(1);
    });
  }, 120_000);
  it("consumer abort rejects only its waiter while the same original acquisition completes for its survivor", async () => {
    await fixture(async discover => {
      const row = rows.find(value => value.id === "sdk_waiter_abort")!, controller = new AbortController();
      const first = discover(row, controller.signal), observed = first.then(() => ({ rejected: false }), error => ({ rejected: true, error }));
      const survivor = discover(row); const retained = survivor.then(value => ({ value }), error => ({ error }));
      try { await control("started", row.id); controller.abort(); expect((await observed).rejected).toBe(true); expect(requests).toHaveLength(1); }
      finally { await control("release", row.id); }
      const result = await retained; if ("error" in result) throw result.error;
      expect(result.value?.models.map(model => model.id)).toEqual([selected]); expect(requests).toHaveLength(1);
    });
  }, 120_000);
});
