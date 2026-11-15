import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { types as nodeTypes } from "node:util";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeEach, describe, expect, it as nativeIt, vi } from "vitest";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
import type { Model } from "openclaw/plugin-sdk/llm";
const contractMode = litellmControlMode(process.env.CLAWROUTER_LITELLM_MODE);
const nativeStreamProof = litellmNativeIntrinsics(createRequire(import.meta.url)("node:stream/web"), process.versions.node, process.versions.modules);

type Operation = { kind: string; promise: Promise<unknown>; state?: "pending" | "fulfilled" | "rejected"; reasonDefined?: boolean };
// BEGIN shared proof functions. These observe originals; they grant no disposition.
// Observer derivatives have their own generation-bound ledger. Registering one
// never calls remember() or subscribes to the original read again.
function litellmObserverLedger(generation: number) {
  const rows: any[] = [], faults: unknown[] = [], lateFaults: unknown[] = [], known = new WeakSet<object>(); let sealed = false;
  const append = (owner: number, event: unknown, kind: string, promise: Promise<unknown>) => {
    if (sealed || owner !== generation || known.has(promise)) { const error = new Error("invalid observer derivative registration"); faults.push(error); if (sealed) lateFaults.push(error); }
    known.add(promise); const row: any = { generation: owner, event, kind, promise, state: "pending", observer: true }; rows.push(row); return row;
  };
  return {
    rows, faults, lateFaults,
    append(owner: number, event: unknown, kind: string, promise: Promise<unknown>) { append(owner, event, kind, promise); return promise; },
    terminal(owner: number, event: unknown, kind: string, promise: Promise<unknown>) {
      const row = append(owner, event, kind, promise);
      // Observe this terminal derivative immediately, including rejection with
      // undefined. The guard is retained once; its handlers do not throw.
      const guard = promise.then(() => { row.state = "fulfilled"; }, error => { row.state = "rejected"; row.error = error; });
      append(owner, row, "settlement_guard", guard); return promise;
    },
    seal() { if (sealed) faults.push(new Error("duplicate observer seal")); sealed = true; },
  };
}
function litellmFixedPoint(sources: Array<() => Array<{promise: Promise<unknown>}>>, before: () => void) {
  const audit = { members: new Map<Promise<unknown>, Array<{source: number; row: any}>>(), settled: new Map<Promise<unknown>, PromiseSettledResult<unknown>>(), failures: [] as any[], stable: false, sealed: false };
  const cursors = sources.map(() => 0), seen = new WeakSet<object>(), settled = new WeakMap<object, PromiseSettledResult<unknown>>(), joins = new WeakSet<object>();
  const mark = (row: any, result: PromiseSettledResult<unknown>) => {
    if (row.observer === true) { row.state = result.status; if (result.status === "rejected") row.error = result.reason; }
  };
  const run = async () => {
    const errors: unknown[] = []; audit.stable = false;
    const structural = (error: unknown) => { errors.push(error); audit.failures.push({ kind: "structural", reason: error }); };
    if (audit.sealed) { structural(new Error("sealed retirement join")); return errors; }
    while (true) {
      try { before(); } catch (error) { structural(error); }
      const batch: Promise<unknown>[] = [], pendingRows: any[] = [];
      sources.forEach((source, index) => {
        const rows = source();
        for (; cursors[index] < rows.length; cursors[index]++) {
          const row = rows[cursors[index]], p = row.promise;
          const members = audit.members.get(p) ?? []; members.push({ source: index, row }); audit.members.set(p, members);
          if (joins.has(p)) { structural(new Error("observer drain cannot join itself")); continue; }
          const prior = settled.get(p); if (prior) mark(row, prior); else pendingRows.push(row);
          if (!seen.has(p)) { seen.add(p); batch.push(p); }
        }
      });
      if (!batch.length) { audit.stable = true; return errors; }
      const results = await Promise.allSettled(batch);
      results.forEach((result, i) => { settled.set(batch[i], result); audit.settled.set(batch[i], result); if (result.status === "rejected") { errors.push(result.reason); audit.failures.push({ kind: "rejection", promise: batch[i], reason: result.reason }); } });
      for (const row of pendingRows) { const result = settled.get(row.promise); if (result) mark(row, result); }
    }
  };
  const drain = () => { const pending = run(); joins.add(pending); return pending; };
  return Object.assign(drain, { audit, seal() {
    if (audit.sealed || !audit.stable || sources.some((source, i) => source().length !== cursors[i])) throw new Error("unstable retirement seal");
    audit.sealed = true;
  } });
}
function litellmRetirementJoin(owner: any, acquisitions: Array<{released: Promise<unknown>}>, operations: Operation[]) {
  return litellmFixedPoint([
    () => acquisitions.map(row => ({promise: row.released})), () => operations,
    // These originals are captured before observer registration can throw.
    () => owner.transports.filter((row: any) => row.pending).map((row: any) => ({promise: row.pending})),
    () => owner.guardOriginals,
    () => owner.reactions.map((promise: Promise<unknown>) => ({promise})), () => owner.observers.rows,
  ], () => owner.prepareDrain());
}
// Native references are captured before fixture spies. This proves a local
// stream branch only; it does not identify its actor or retire its producer.
function litellmNativeIntrinsics(web: any, node: string, abi: string) {
  const stream = web.ReadableStream.prototype, reader = web.ReadableStreamDefaultReader.prototype;
  const value = (o: object, k: string) => Object.getOwnPropertyDescriptor(o, k)?.value;
  return Object.freeze({ runtime: node === "24.22.1" && abi === "137", stream, reader,
    get: value(stream, "getReader"), read: value(reader, "read"), cancel: value(reader, "cancel"), unlock: value(reader, "releaseLock"),
    closed: Object.getOwnPropertyDescriptor(reader, "closed")?.get });
}
function litellmNativeCapture(i: any, body: any, get: Function, receiver: unknown, args: unknown[], reader: any) {
  const original = (o: any, k: string, fn: unknown) => !Object.hasOwn(o, k) && Object.getOwnPropertyDescriptor(Object.getPrototypeOf(o), k)?.value === fn;
  const qualified = i.runtime && get === i.get && receiver === body && Object.getPrototypeOf(body) === i.stream
    && Object.getPrototypeOf(reader) === i.reader && !Object.hasOwn(reader, "closed")
    && Object.getOwnPropertyDescriptor(i.reader, "closed")?.get === i.closed
    && ["read", "cancel", "releaseLock"].every((k, n) => original(reader, k, [i.read, i.cancel, i.unlock][n]));
  // Capture once, before any ownership bookkeeping or exposure. An unqualified
  // getter is never replaced with a trusted intrinsic to manufacture evidence.
  const closed = qualified ? Reflect.apply(i.closed, reader, []) : reader.closed;
  return Object.freeze({ qualified: !!qualified, body, reader, get, receiver, args, closed, read: i.read, cancel: i.cancel, unlock: i.unlock });
}
function litellmDataDisposition(audit: any, owner: any, body: string, independent: unknown[], originals: Operation[]) {
  const raw = audit.failures.map((f: any) => f.reason), events = owner.witness.operations;
  const result = (accepted: boolean, native = false) => ({ accepted, raw, fatal: accepted ? [] : [...raw, ...independent],
    facts: [native ? 1 : 0, accepted ? 2 : raw.length ? 1 : 0, Math.min(raw.length, 1_000_000), Math.min(accepted ? 0 : raw.length + independent.length, 1_000_000)] });
  if (!audit.sealed || !audit.stable || body !== "fulfilled" || independent.length || audit.failures.length !== 3) return result(false);
  const selected = ["read", "closed", "cancel"].map(kind => events.filter((e: any) => e.kind === kind && e.state === "rejected"));
  if (selected.some((a: any[]) => a.length !== 1)) return result(false);
  const [read, closed, cancel] = selected.map((a: any[]) => a[0]), row = read.row, native = row?.native, b = native?.binding, proof = native?.proof, t = row?.t, a = t?.acquisition;
  if (!proof?.qualified || closed.row !== row || cancel.row !== row || proof.reader !== row.reader || proof.body !== t?.body || proof.closed !== closed.promise
    || !b || b.observer !== owner || b.generation !== owner.generation || b.reader !== row.reader || b.body !== t.body || b.response !== t.response
    || b.transport !== t || b.acquisition !== a || b.context !== t.context || b.token !== t.context?.token || b.result !== a?.result
    || t.unique !== true || t.state !== "fulfilled" || a.context !== t.context || a.transport !== t || a.result?.response !== t.response || t.response.body !== t.body
    || [read, closed, cancel].some(e => e.generation !== owner.generation || e.census !== events)
    || [read, cancel].some(e => e.context?.predicate !== "none" || !e.context.active || !e.context.sameOwner || !e.context.receiver)
    || read.context.context !== "same" || !["same", "absent"].includes(cancel.context.context)
    || read.call?.fn !== proof.read || read.call?.receiver !== row.reader || cancel.call?.fn !== proof.cancel || cancel.call?.receiver !== row.reader
    || !Array.isArray(read.call.args) || !Array.isArray(cancel.call.args) || cancel.resource?.[0] !== true
    || events.filter((e: any) => e.row === row && e.kind === "cancel").length !== 1
    || row.unlockCount !== 1 || row.unlockReturned !== 1 || row.unlockInvoke <= cancel.invoke) return result(false);
  const ps = [read.promise, closed.promise, cancel.promise];
  if (new Set(ps).size !== 3) return result(false, true);
  const outcomes = ps.map(p => audit.settled.get(p));
  if (outcomes.some(r => r?.status !== "rejected" || r.reason === undefined) || !outcomes.every(r => Object.is(r.reason, outcomes[0].reason))) return result(false, true);
  for (const [index, p] of ps.entries()) {
    const members = audit.members.get(p), kind = ["read", "closed", "cancel"][index];
    if (!members || members.length !== 1 || members[0].source !== 1 || members[0].row.kind !== kind || members[0].row.promise !== p
      || !originals.includes(members[0].row) || members[0].row.state !== "rejected"
      || !Object.is(selected[index][0].reason, outcomes[index].reason)) return result(false, true);
  }
  if (audit.failures.some((f: any) => f.kind !== "rejection" || !ps.includes(f.promise)) || new Set(audit.failures.map((f: any) => f.promise)).size !== 3) return result(false, true);
  return result(true, true);
}
function litellmFinalizeDisposition(disposition: {accepted: boolean; raw: unknown[]}, errors: unknown[]) {
  return disposition.accepted && errors.length ? [...disposition.raw, ...errors] : errors;
}
async function litellmAttemptAll(checks: Array<[string, () => unknown]>, failed: (phase: string, error: unknown) => void) {
  for (const [phase, check] of checks) try { await check(); } catch (error) { failed(phase, error); }
}
function litellmOwnership(storage: any, generation = 0) {
  const observers = litellmObserverLedger(generation), witness = litellmWitness(generation, observers);
  const tokens = new WeakSet<object>(), guards = new WeakSet<object>(), responses = new WeakMap<object, any>(), bodies = new WeakMap<object, any>(), readers = new WeakMap<object, any>();
  const faults: unknown[] = [], transports: any[] = [], reactions: Promise<unknown>[] = [], signals: any[] = [], guardOriginals: Array<{promise: Promise<unknown>}> = [];
  let active = true, publicOpen = true;
  let firstFault = "none", relation: Array<boolean | null> = [null, null, null, null];
  const invalid = (code: string, observed: Array<boolean | null> = [null, null, null, null]) => {
    if (firstFault === "none") { firstFault = code; relation = observed; }
    faults.push(new Error("incomplete LiteLLM invocation ownership"));
  };
  const entries = new WeakMap<object, any>(), cleanupReaders = new WeakMap<object, any>(), cleanupLeases = new WeakMap<object, any>(), cleanupAttempts = new WeakMap<object, Set<string>>();
  let reactionObserver: ((q: Promise<unknown>) => void) | undefined;
  const entry = litellmProductReactions(() => invalid("reaction"), error => faults.push(error), q => reactionObserver?.(q), witness.tick);
  let stopHook: (() => void) | undefined;
  function signal(value: AbortSignal | null | undefined) {
    const row: any = { signal: value, observed: false, initial: null, event: null, reasonPresent: false, reason: undefined }; let attached = false;
    const abort = () => { try { row.event = witness.aborted(value!); row.reasonPresent = true; row.reason = value?.reason; } catch (error) { faults.push(error); } };
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
  // A resource claim does not identify its actor or the private producer callback.
  // Consume before forwarding, even when binding/context/original execution fails.
  function cleanup(self: any, key: object, binding: any, kind: string, receiver: unknown, method: Function | undefined, args: unknown[] | undefined, raw: any, captured: any) {
    let attempts = cleanupAttempts.get(key); if (!attempts) cleanupAttempts.set(key, attempts = new Set());
    const first = !attempts.has(kind), readerLive = kind !== "cancel" || !attempts.has("releaseLock"); attempts.add(kind);
    const b = binding, lease = kind === "release" ? b : b?.lease, a = b?.acquisition, t = b?.transport;
    const checks = [
      !!b && active && readerLive && captured === self && b.observer === self && b.generation === generation,
      !!b && tokens.has(b.token) && b.context === a?.context && b.context?.token === b.token,
      !!a && guards.has(a) && a.transport === t && t?.acquisition === a && cleanupLeases.get(a) === lease,
      !!t && t.unique === true && t.state === "fulfilled" && t.context === b?.context,
      !!b && b.result === a?.result && b.result?.response === b.response && t?.response === b.response && responses.get(b.response) === t,
      !!b && b.body === t?.body && b.response?.body === b.body && (b.body === null || bodies.get(b.body) === t),
      kind === "release" ? !!b && key === a && cleanupLeases.get(key) === b : !!b && key === b.reader && cleanupReaders.get(key) === b && readers.get(key) === t,
      !!lease && a?.releaseBinding === lease && lease.result === b?.result && lease.token === b?.token && lease.generation === generation,
      !!b && method === (kind === "release" ? b.fn : b.methods[kind]),
      receiver === (kind === "release" ? undefined : key) && Array.isArray(args) && (kind !== "release" || args.length === 0),
      first,
      raw === undefined || !!raw && tokens.has(raw.token) && raw.token === b?.token && (raw.acquisition === undefined || raw.acquisition === a),
    ];
    const reaction = entry.cleanupEvidence(b, receiver, method, kind, generation, args);
    // Entry facts only; original return/rejection remains in this operation's census.
    // Tuple: resource-bound, first attempt, reaction match, actor/source, checks.
    return { bound: checks.every(Boolean), reaction: reaction.cap,
      facts: Object.freeze([checks.every(Boolean), first, reaction.matches, "unknown", "unknown", Object.freeze(checks)]) };
  }
  return {
    faults, transports, signals, witness, generation, observers, reactions, guardOriginals,
    invoke(owner: any, fn: Function, receiver: unknown, args: any[]) {
      if (!publicOpen) { invalid("invoke"); return Reflect.apply(fn, receiver, args); }
      if (!active || !["catalog", "chat"].includes(owner.role) || args[owner.role === "catalog" ? 0 : 2]?.signal !== owner.signal) invalid("invoke");
      const token = Object.freeze({ owner: Object.freeze({ ...owner }), fn, receiver, args: Object.freeze([...args]), caller: signal(owner.signal) });
      tokens.add(token); witness.token(token);
      return storage.run(Object.freeze({ token }), () => Reflect.apply(fn, receiver, args));
    },
    guard(kind: string, fn: Function, receiver: unknown, args: any[], a: any) {
      const c = current();
      if (!c || c.acquisition || guards.has(a) || c.token.owner.role !== kind) { invalid("guard", [!!c, !!c?.acquisition, c ? c.token.owner.role === kind : null, guards.has(a)]); return Reflect.apply(fn, receiver, args); }
      guards.add(a); witness.acquisition(a); a.context = Object.freeze({ token: c.token, acquisition: a });
      a.guardInput = signal(args[0]?.signal ?? args[0]?.init?.signal);
      a.fn = fn; a.receiver = receiver; a.args = args;
      const event = witness.guard(a);
      try { const original = storage.run(a.context, () => Reflect.apply(fn, receiver, args)); guardOriginals.push({promise: original}); witness.promise(event, original); return original; }
      catch (error) { witness.threw(event, error); throw error; }
    },
    fetch(fn: Function, receiver: unknown, args: any[], facts: any) {
      const c = current(), a = c?.acquisition;
      const t: any = { context: c, acquisition: a, fn, receiver, args, state: "invoke", unique: false, input: signal(facts.signal) }; transports.push(t); witness.transport(t);
      // Context, acquisition, registration, context identity, first fetch, URL,
      // credential, method. Null means the original short circuit did not read it.
      const checks: Array<boolean | null> = [!!c, null, null, null, null, null, null, null];
      let predicate = "fetch_acquisition";
      const rejects = (index: number, id: string, valid: boolean) => { checks[index] = valid; if (!valid) predicate = id; return !valid; };
      if (rejects(1, "fetch_acquisition", !!a) || rejects(2, "fetch_registered", guards.has(a))
        || rejects(3, "fetch_context", a.context === c) || rejects(4, "fetch_duplicate", !a.transport)
        || rejects(5, "fetch_url", c.token.owner.url === facts.url) || rejects(6, "fetch_credential", c.token.owner.credential === facts.credential)
        || rejects(7, "fetch_method", (c.token.owner.role === "catalog" ? "GET" : "POST") === facts.method)) invalid(predicate, checks);
      else a.transport = t;
      let pending;
      try { pending = Reflect.apply(fn, receiver, args); t.pending = pending; witness.promise(t.witness, pending); }
      catch (reason) { t.state = "sync_throw"; t.reasonPresent = true; t.reason = reason; witness.threw(t.witness, reason); throw reason; }
      const reaction = pending.then((response: Response) => {
        t.state = "fulfilled"; t.response = response; t.body = response.body;
        const prior = responses.get(response), priorBody = t.body && bodies.get(t.body);
        if (prior || priorBody) { if (prior) prior.unique = false; if (priorBody) priorBody.unique = false; invalid("response_unique"); return; }
        responses.set(response, t); if (t.body) bodies.set(t.body, t); t.unique = true; witness.response(t);
      }, (reason: unknown) => { t.state = "rejected"; t.reasonPresent = true; t.reason = reason; });
      observers.append(generation, t, "ownership_response", reaction);
      const terminal = reaction.catch((error: unknown) => { faults.push(error); });
      observers.terminal(generation, t, "ownership_response_catch", terminal); reactions.push(terminal); return pending;
    },
    attach(a: any, result: any) { if (a.result) invalid("attach_duplicate"); a.result = result; if (!bound(a)) invalid("attach_bound", [guards.has(a), !!a.transport, a.transport ? a.transport.acquisition === a : null, a.transport ? a.result?.response === a.transport.response : null]); return bound(a); },
    reader(body: object, reader: object, receiver: unknown, captured?: any, methods?: any) {
      const t = bodies.get(body), raw = storage.getStore(), trusted = !!raw && tokens.has(raw.token), c = active && trusted ? raw : undefined;
      let predicate = "none";
      if (!t) predicate = "body_missing";
      else if (receiver !== body) predicate = "receiver";
      else if (readers.has(reader)) predicate = "reader_duplicate";
      else if (!c) predicate = "context";
      else if (c.token !== t.context?.token) predicate = "token";
      if (predicate !== "none") invalid("reader", [!!c, !!t, c && t?.context ? c.token === t.context.token : null, receiver === body]); else readers.set(reader, t);
      const origin = captured ?? this;
      origin.witness.readerBody(body, reader, receiver === body);
      if (predicate !== "none") witness.fault(origin.witness.readerFault(reader, {
        generation, active, trusted, context: raw === undefined ? "absent" : !trusted ? "unrecognized" : t?.context?.token === raw.token ? "same" : "foreign",
        binding: !!t, receiver: receiver === body, sameOwner: origin === this, predicate,
      }));
      if (predicate === "none" && methods && captured === this) {
        const stable = () => active && captured === this && bound(t.acquisition) && readers.get(reader) === t;
        const binding = Object.freeze({ reader, body, response: t.response, transport: t, acquisition: t.acquisition, context: t.context, result: t.acquisition.result,
          token: c.token, observer: this, generation, stable, methods: Object.freeze({ ...methods }), lease: cleanupLeases.get(t.acquisition) });
        cleanupReaders.set(reader, binding);
        if (c.token.owner.role === "chat") entries.set(reader, binding);
      }
    },
    nativeReader(reader: object, proof: any) { witness.nativeReader(reader, proof, cleanupReaders.get(reader)); },
    operation(reader: object, receiver: unknown, kind = "unknown", captured?: any, operand?: unknown, method?: Function, args?: unknown[]) {
      const t = readers.get(reader), raw = storage.getStore();
      const trusted = !!raw && tokens.has(raw.token), c = active && trusted ? raw : undefined;
      const binding = entries.get(reader), origin = captured ?? this;
      const invocation = entry.snapshot({ generation, binding, token: t?.context?.token, acquisition: t?.acquisition, transport: t,
        response: t?.response, body: t?.body, reader, receiver, method, expectedReceiver: reader, expectedMethod: binding?.methods[kind],
        observer: this, captured: origin, args });
      const resource = ["cancel", "releaseLock"].includes(kind)
        ? cleanup(this, reader, cleanupReaders.get(reader), kind, receiver, method, args, raw, captured) : undefined;
      const reaction = resource?.reaction;
      let predicate = "none";
      if (resource) { if (!resource.bound) predicate = "resource"; }
      else if (!t) predicate = "reader_missing";
      else if (receiver !== reader) predicate = "receiver";
      else if (!c) predicate = "context";
      else if (c.token !== t.context?.token) predicate = "token";
      const event = origin.witness.begin(reader, kind, operand, {
        generation, active, trusted, context: raw === undefined ? "absent" : !trusted ? "unrecognized" : t?.context?.token === raw.token ? "same" : "foreign",
        binding: !!t, receiver: receiver === reader, sameOwner: origin === this, predicate,
      }, origin === this ? invocation[1] : undefined);
      event.invocation = invocation; event.reaction = reaction; event.resource = resource?.facts;
      event.call = { fn: method, receiver, args };
      if (predicate !== "none") { witness.fault(event); invalid("reader_operation", [!!c, !!t, c && t?.context ? c.token === t.context.token : null, receiver === reader]); }
      return event;
    },
    releaseBinding(a: any, result: any, fn: Function) {
      if (!bound(a) || a.releaseBinding || a.result !== result) { invalid("release_entry"); return; }
      const t = a.transport;
      const binding = Object.freeze({ acquisition: a, result, fn, generation, context: a.context, token: a.context.token,
        transport: t, response: t.response, body: t.body, observer: this });
      cleanupLeases.set(a, binding); a.releaseBinding = binding;
    },
    releaseEntry(a: any, result: any, fn: Function, receiver: unknown, args: unknown[], captured: any) {
      const raw = storage.getStore(), c = active && raw && tokens.has(raw.token) ? raw : undefined;
      const t = a?.transport;
      const invocation = entry.snapshot({ generation, token: a?.context?.token, acquisition: a, transport: t, response: t?.response, body: t?.body,
        receiver, method: fn, expectedReceiver: undefined, expectedMethod: a?.releaseBinding?.fn, observer: this, captured, args });
      const resource = cleanup(this, a, cleanupLeases.get(a)?.result === result ? cleanupLeases.get(a) : undefined, "release", receiver, fn, args, raw, captured);
      const admitted = resource.bound && a.releaseBinding?.result === result, reaction = resource.reaction;
      const event = witness.release(a, reaction?.binding.acquisition === a ? reaction.binding.reader : undefined, invocation[1]); event.reaction = reaction; event.invocation = invocation; event.resource = resource.facts;
      event.context = { generation, active, trusted: !!c, context: raw === undefined ? "absent" : !c ? "unrecognized" : c.token === a.context?.token ? "same" : "foreign",
        binding: bound(a), receiver: receiver === undefined, sameOwner: captured === this, predicate: admitted ? "none" : "release_entry" };
      if (!admitted) { invalid("release_entry"); witness.fault(event); }
      return event;
    },
    prepareRead(reader: object, original: Promise<unknown>, method: Function, captured: any) {
      const binding = entries.get(reader);
      if (!binding) return;
      const live = () => active && captured === this && binding.observer === this && binding.generation === generation && bound(binding.acquisition)
        && readers.get(reader) === binding.transport && current()?.token === binding.token;
      if (method !== binding.methods.read || !live()) { invalid("reaction"); return; }
      const descriptor = Object.getOwnPropertyDescriptor(original, "then"), then = original.then;
      const restore = () => { if (descriptor) Object.defineProperty(original, "then", descriptor); else if (!Reflect.deleteProperty(original, "then")) throw new Error("read then restoration failed"); };
      const wrapped = entry.arm(binding, original, then, restore, live);
      if (wrapped) try { Object.defineProperty(original, "then", { configurable: true, writable: true, value: wrapped }); }
      catch (error) { faults.push(error); entry.boundary(); }
      return entry.capture(original);
    },
    reactionHooks: entry.hooks,
    setReactionObserver(observe: (q: Promise<unknown>) => void) { if (reactionObserver) invalid("reaction"); else reactionObserver = observe; },
    setReactionHook(stop: () => void) { if (stopHook) invalid("reaction"); else stopHook = stop; },
    closeRegistration() { publicOpen = false; },
    prepareDrain() { entry.drain(); },
    bodyCancel(body: object, receiver: unknown, captured?: any, operand?: unknown, method?: Function, args?: unknown[]) {
      const t = bodies.get(body), raw = storage.getStore();
      const trusted = !!raw && tokens.has(raw.token), c = active && trusted ? raw : undefined;
      const origin = captured ?? this;
      const invocation = entry.snapshot({ generation, token: t?.context?.token, acquisition: t?.acquisition, transport: t, response: t?.response, body,
        receiver, method, expectedReceiver: body, observer: this, captured: origin, args });
      const predicate = !t ? "body_missing" : receiver !== body ? "receiver" : !c ? "context" : c.token !== t.context?.token ? "token" : "none";
      const event = origin.witness.beginBody(t, operand, {
        generation, active, trusted, context: raw === undefined ? "absent" : !trusted ? "unrecognized" : t?.context?.token === raw.token ? "same" : "foreign",
        binding: !!t, receiver: receiver === body, sameOwner: !captured || captured === this, predicate,
      }, origin === this ? invocation[1] : undefined);
      event.invocation = invocation;
      if (predicate !== "none") { witness.fault(event); invalid("body_cancel", [!!c, !!t, c && t?.context ? c.token === t.context.token : null, receiver === body]); }
      return event;
    },
    bound,
    diagnostic() {
      const rejected = transports.find(t => t.state === "rejected" || t.state === "sync_throw");
      return { first: firstFault === "none" && faults.length ? "observer" : firstFault, relation: [...relation], faults: Math.min(faults.length, 1_000_000),
        transports: [transports.length, ...["invoke", "fulfilled", "rejected", "sync_throw"].map(state => transports.filter(t => t.state === state).length)].map(n => Math.min(n, 1_000_000)),
        defined: rejected ? rejected.reason !== undefined : null };
    },
    settledFailures() { return [...faults, ...transports.filter(t => t.state === "sync_throw").map(t => t.reason)]; },
    async join() {
      const drain = litellmRetirementJoin(this, [], []);
      const errors = await drain();
      return [...this.settledFailures(), ...observers.faults, ...errors];
    },
    restore() {
      if (!active) throw new Error("duplicate LiteLLM ownership restoration"); active = false; witness.restored();
      const errors: unknown[] = [], before = faults.length;
      try { entry.finish(); } catch (error) { errors.push(error); }
      try { stopHook?.(); } catch (error) { errors.push(error); }
      errors.push(...faults.slice(before));
      for (const row of signals) try { row.restore(); } catch (error) { errors.push(error); }
      try { storage.disable(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "LiteLLM ownership restoration failed");
    },
  };
}
// No spy may wrap this return: Vitest subscribes to returned promises after a
// mock implementation exits, before the real D8 caller can register its Q.
function litellmReadBoundary(reader: object, original: Function, observe: {
  begin(receiver: unknown, args: unknown[]): any;
  returned(event: any, original: Promise<unknown>): void;
  arm(event: any, original: Promise<unknown>): void;
  threw(event: any, error: unknown): void;
}, errors: unknown[], restores: Array<() => void>) {
  const same = (a: PropertyDescriptor | undefined, b: PropertyDescriptor | undefined) => a === undefined || b === undefined ? a === b
    : ["value", "get", "set", "writable", "enumerable", "configurable"].every(key => Object.hasOwn(a, key) === Object.hasOwn(b, key) && Object.is((a as any)[key], (b as any)[key]));
  const inherited = () => {
    const chain: object[] = []; let at = Object.getPrototypeOf(reader);
    while (at) { chain.push(at); const descriptor = Object.getOwnPropertyDescriptor(at, "read"); if (descriptor) return { chain, descriptor }; at = Object.getPrototypeOf(at); }
    return { chain, descriptor: undefined };
  };
  const own = Object.getOwnPropertyDescriptor(reader, "read"), prototype = Object.getPrototypeOf(reader), source = inherited();
  const descriptor = own ?? source.descriptor;
  if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.value !== original) throw new Error("unsupported original read descriptor");
  const unchangedPrototype = () => {
    if (Object.getPrototypeOf(reader) !== prototype) return false;
    if (own) return true;
    const now = inherited(); return same(now.descriptor, source.descriptor) && now.chain.length === source.chain.length && now.chain.every((value, index) => value === source.chain[index]);
  };
  const wrapped = function (this: unknown, ...args: unknown[]) {
    let event: any, observed = true;
    try { event = observe.begin(this, args); } catch (error) { errors.push(error); observed = false; }
    let pending: Promise<unknown>;
    try { pending = Reflect.apply(original, this, args); }
    catch (error) {
      errors.push(error);
      try { observe.threw(event, error); } catch (failure) { errors.push(failure); }
      throw error;
    }
    try { observe.returned(event, pending); } catch (error) { errors.push(error); observed = false; }
    if (observed) try { observe.arm(event, pending); } catch (error) { errors.push(error); }
    return pending;
  };
  const installed = own ? { ...own, value: wrapped } : { value: wrapped, writable: true, configurable: true, enumerable: descriptor.enumerable };
  let completed = false, defined = false;
  restores.push(() => {
    if (completed) throw new Error("duplicate read descriptor restoration");
    const now = Object.getOwnPropertyDescriptor(reader, "read");
    if (!unchangedPrototype()) throw new Error("foreign read prototype mutation");
    // A failed defineProperty may have made no change. Never overwrite a foreign
    // descriptor, including altered flags on our own function.
    if (!defined && same(now, own)) { completed = true; return; }
    if (!same(now, installed)) throw new Error("foreign read descriptor mutation");
    if (own) Object.defineProperty(reader, "read", own);
    else if (!Reflect.deleteProperty(reader, "read")) throw new Error("read descriptor deletion failed");
    if (!same(Object.getOwnPropertyDescriptor(reader, "read"), own) || !unchangedPrototype()) throw new Error("read descriptor restoration mismatch");
    completed = true;
  });
  try { Object.defineProperty(reader, "read", installed); defined = true; }
  catch (error) { errors.push(error); }
}
// Original read registration only; this grants entry ownership, never disposition.
function litellmProductReactions(fault: () => void, error: (value: unknown) => void, observe: (q: Promise<unknown>) => void = () => {}, clock?: () => number) {
  const reads = new WeakMap<object, any>(), qs = new WeakMap<object, any>(), leases = new WeakSet<object>();
  const pending = new Set<any>(), caps: any[] = [];
  let atomic: any, entered: any, active = true, draining = false, sequence = 0;
  const tick = clock ?? (() => ++sequence), frames: object[] = []; let frameMismatch = false;
  const fail = (cap?: any) => { if (cap) cap.failed = true; fault(); };
  const close = (cap: any) => {
    pending.delete(cap); cap.attempted = true;
    if (!cap.restored) { cap.restored = true; try { cap.restore(); } catch (e) { error(e); fail(cap); } }
  };
  const boundary = () => { for (const cap of pending) { close(cap); fail(cap); } };
  const hooks = {
    init(q: object, p: object | undefined) {
      if (atomic) { if (p === atomic.p && !atomic.q) atomic.q = q; else fail(atomic); }
      else boundary();
    },
    settled() { if (atomic) fail(atomic); boundary(); },
    before(q: object) {
      frames.push(q);
      if (atomic) fail(atomic); boundary();
      if (entered && entered.q !== q) fail(entered);
      const cap = qs.get(q); if (!cap || cap.state === 3) return;
      if (!active || entered || cap.state !== 1 || cap.failed) { fail(cap); return; }
      cap.state = 2; cap.enter = tick(); entered = cap;
    },
    after(q: object) {
      try {
        if (atomic) fail(atomic); boundary();
        if (entered && entered.q !== q) { fail(entered); return; }
        const cap = qs.get(q); if (!cap || cap.state === 3) return;
        if (entered !== cap || cap.state !== 2) { fail(cap); return; }
        cap.exit = tick(); cap.state = 3; entered = undefined;
      } finally {
        if (frames[frames.length - 1] === q) frames.pop();
        else { frames.length = 0; frameMismatch = true; }
      }
    },
  };
  const usable = (binding: any, generation: number) => active && entered && !entered.failed && entered.state === 2
    && entered.binding === binding && binding.generation === generation && binding.stable();
  return {
    hooks, boundary, capture(p: object) { return reads.get(p); },
    // Frozen invocation tuple: clock generation/sequence, argc, current-Q class,
    // P/Q IDs, Q entry state, binding generation, live-entry match, binding bits.
    // This is separate from the final read cap; argc never grants authority.
    snapshot(f: any) {
      const q = frames[frames.length - 1], cap = q && qs.get(q), b = cap?.binding;
      const relation = (key: string) => f[key] === undefined || !b ? null : b[key] === f[key];
      const matches = Object.freeze([f.binding === undefined || !b ? null : b === f.binding, relation("token"), relation("acquisition"), relation("transport"), relation("response"), relation("body"), relation("reader"),
        b ? b.generation === f.generation : null, f.receiver === f.expectedReceiver, f.expectedMethod === undefined ? null : f.method === f.expectedMethod,
        f.captured === f.observer, cap ? reads.get(cap.p) === cap && cap.q === q : null]);
      return Object.freeze([f.generation, tick(), Array.isArray(f.args) ? f.args.length : null,
        frameMismatch ? "unmatched" : !q ? "none" : cap ? "registered" : "unrecognized",
        cap?.id ?? null, cap?.qid ?? null, cap?.state ?? null, b?.generation ?? null, cap ? cap === entered : null, matches]);
    },
    arm(binding: any, p: object, then: Function, restore: () => void, live: () => boolean) {
      boundary();
      if (!active || draining || reads.has(p) || !Object.isFrozen(binding) || !live()) { fail(); return; }
      const cap: any = { binding, p, then, restore, live, id: caps.length + 1, q: undefined, qid: 0, register: 0, enter: 0, exit: 0,
        state: 0, release: 0, admission: 0, calls: new Map(), attempted: false, restored: false, failed: false };
      reads.set(p, cap); caps.push(cap); pending.add(cap);
      return function (this: unknown, ...handlers: unknown[]) {
        // A later subscription forwards transparently and cannot create authority.
        if (cap.attempted) return Reflect.apply(then, this, handlers);
        const valid = active && !draining && !atomic && pending.has(cap) && cap.live() && this === p
          && handlers.length === 2 && handlers.every(handler => typeof handler === "function");
        close(cap); cap.handlers = Object.freeze([...handlers]); cap.receiver = this; cap.register = tick();
        const prior = atomic;
        if (!valid) fail(cap); if (prior) fail(prior); else atomic = cap;
        let q;
        try { q = Reflect.apply(then, this, handlers); }
        catch (e) { fail(cap); error(e); throw e; }
        finally { atomic = prior; }
        if (!valid || cap.failed || !cap.live() || !q || typeof q !== "object" || q === p || cap.q !== q || qs.has(q)) fail(cap);
        else { cap.qid = cap.id; cap.state = 1; qs.set(q, cap); }
        if (q && typeof q === "object") try { observe(q); } catch (e) { error(e); fail(cap); }
        return q;
      };
    },
    cleanupEvidence(binding: any, receiver: unknown, method: Function | undefined, kind: string, generation: number, args?: unknown[]) {
      const cap = entered;
      const matches = kind === "release"
        ? !!cap && !!binding && usable(cap.binding, generation) && cap.binding.lease === binding && binding.fn === method && receiver === undefined && args?.length === 0 && !cap.release && !leases.has(binding)
        : !!binding && usable(binding, generation) && receiver === binding.reader && ["cancel", "releaseLock"].includes(kind) && binding.methods[kind] === method && args?.length === 0 && !cap.calls.has(kind);
      return { matches: !!matches, cap };
    },
    operation(binding: any, receiver: unknown, method: Function | undefined, kind: string, generation: number, args?: unknown[]) {
      const cap = entered;
      const admitted = !!binding && usable(binding, generation) && receiver === binding.reader && ["cancel", "releaseLock"].includes(kind)
        && binding.methods[kind] === method && Array.isArray(args) && args.length === 0 && !cap.calls.has(kind);
      if (admitted) cap.calls.set(kind, Object.freeze({ method, receiver, args: Object.freeze([...args!]) })); else fail(cap);
      return { admitted: !!admitted, cap };
    },
    release(lease: any, receiver: unknown, args: unknown[], generation: number) {
      const cap = entered;
      const admitted = !!cap && !!lease && usable(cap.binding, generation) && cap.binding.lease === lease && receiver === undefined && args.length === 0 && !cap.release && !leases.has(lease);
      if (cap) { cap.admission = admitted ? 1 : 2; cap.release = tick(); }
      if (admitted) { leases.add(lease); cap.releaseCall = Object.freeze({ lease, receiver, args: Object.freeze([...args]) }); }
      if (!admitted) fail(cap);
      return { admitted: !!admitted, cap };
    },
    drain() { draining = true; boundary(); },
    finish() { draining = true; boundary(); if (atomic || entered || caps.some(cap => cap.state !== 3)) fail(); active = false; },
  };
}
function litellmReactionVector(cap: any) {
  // FINAL joined read cap, not an invocation snapshot or Q-settlement oracle.
  // Unique P/Q binding IDs; registration/entry/exit; state; release entry;
  // release admission (0 unknown, 1 admitted, 2 rejected); fault presence.
  return cap ? [cap.id, cap.qid, cap.register, cap.enter, cap.exit, cap.state, cap.release, cap.admission, Number(cap.failed)] : null;
}
// Closed witness only. None of these facts participate in acceptance.
// ids: invocation/acquisition/transport/reader (zero = unavailable), never counts.
// ctx: raw store class/current active/trusted/bound/receiver/same observer/current
// generation/captured active. life: unlock invoke/return, release invoke/return/
// settle, unlock call/return counts. Original rows: id/state/invoke/return/settle/
// rejection present/reason kind + caller/guard-input/native-fetch aborted states.
// Signal equality is Object.is at the original reaction, not cause attribution.
// "unknown" callsite/abort operand and otherRejected must not be filled by inference.
function litellmWitness(generation: number, observers = litellmObserverLedger(generation)) {
  const bodyTransports = new WeakMap<object, any>();
  const tokenIds = new WeakMap<object, number>(), acquisitionIds = new WeakMap<object, number>(), transportIds = new WeakMap<object, number>(), readerIds = new WeakMap<object, any>();
  const observerFailures: unknown[] = [], faultEvents: any[] = [], lifetime = { restore: 0 };
  const tokens: any[] = []; let localDisposition: number[] | null = null;
  const rows: any[] = [], operations: any[] = [], releases = new Map<object, any>(), abortEvents = new WeakMap<object, number>();
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
  const reason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")!.get!;
  let sequence = 0, tokenCount = 0, acquisitionCount = 0, transportCount = 0, restore = 0;
  const tick = () => ++sequence;
  const signal = (value: unknown) => {
    try { const a = Reflect.apply(aborted, value, []); return { known: true, aborted: a, reason: a ? Reflect.apply(reason, value, []) : undefined, event: abortEvents.get(value as object) ?? 0 }; }
    catch { return { known: false, aborted: null, reason: undefined }; }
  };
  const signals = (t: any) => [t?.context?.token?.caller?.signal, t?.acquisition?.guardInput?.signal, t?.input?.signal].map(signal);
  const valueKind = (v: unknown) => v === undefined ? "undefined" : v === null ? "null" : typeof v === "object" || typeof v === "function" ? "object" : "primitive";
  const ids = (t: any, reader = 0) => [tokenIds.get(t?.context?.token) ?? 0, acquisitionIds.get(t?.acquisition) ?? 0, transportIds.get(t) ?? 0, reader];
  function begin(row: any, kind: string, operand: unknown, context: any, invoked?: number) {
    const event: any = { id: operations.length + 1, row, kind, operand, context, invoke: invoked ?? tick(), settle: 0, returned: 0, state: "invoking", reason: undefined,
      input: signals(row?.t), capturedActive: restore === 0, pending: operations.filter(op => op.state === "pending" || op.state === "invoking").length, restore };
    event.generation = generation; event.census = operations; event.ids = ids(row?.t, row?.id ?? 0); event.lifetime = lifetime; event.releases = releases;
    operations.push(event); return event;
  }
  function settle(event: any, state: string, error?: unknown) {
    event.state = state; event.reason = error; event.settle = tick(); event.output = signals(event.row?.t);
  }
  function promise(event: any, original: Promise<unknown>) {
    event.promise = original; event.returned = tick(); event.state = "pending";
    const derived = original.then(() => settle(event, "fulfilled"), error => settle(event, "rejected", error));
    observers.append(generation, event, "witness_settle", derived);
    const terminal = derived.catch(error => { observerFailures.push(error); });
    observers.terminal(generation, event, "witness_settle_catch", terminal);
  }
  function projection(this: any, at: string, body: string, currentGeneration: number, counts: number[], failureCount: number, originals: Operation[] = []) {
    const fault = faultEvents[0] ?? operations.find(op => op.context && op.context.predicate !== "none");
    const rejected = operations.find(op => op.state === "rejected" || op.state === "sync_throw");
    const first = originals.find(op => op.state === "rejected");
    const drained = first && operations.find(op => op.promise === first.promise && op.kind === first.kind);
    const event = fault ?? drained ?? rejected, row = event?.row, t = row?.t?.acquisition?.transport ?? row?.t;
    let locked: boolean | null = null;
    try { locked = Reflect.apply(Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")!.get!, t?.body, []); } catch {}
    const bound = event?.generation !== undefined && event.generation !== generation ? event.ids : ids(t, row?.id ?? 0), owner = t?.context?.token?.owner;
    const census = event?.census ?? operations;
    const selected = ["read", "closed", "cancel"].map(kind => census.find((op: any) => op.row === row && op.kind === kind && (op.state === "rejected" || op.state === "sync_throw"))
      ?? census.find((op: any) => op.row === row && op.kind === kind));
    // The reaction belongs to originals[0]'s exact read P, even when closed was
    // registered first. This projection grants no callback-entry authority.
    const read = selected[0], cap = read?.reaction, binding = cap?.binding;
    const reaction = event?.census === operations && census === operations && event?.generation === generation && currentGeneration === generation
      && read?.generation === generation && read.census === operations && read.row === row && row?.reader && readerIds.get(row.reader) === row
      && cap && cap.p && cap.p === read.promise && binding?.reader === row.reader && binding.observer?.witness === this && binding.generation === generation
      && t === row.t && binding.transport === t && binding.acquisition === t?.acquisition && binding.token === t?.context?.token
      && binding.body === t?.body && binding.response === t?.response && t?.unique === true && t.state === "fulfilled"
      && t.acquisition?.context === t.context && t.acquisition?.transport === t && t.acquisition?.result?.response === t.response && t.response?.body === t.body
      && tokenIds.has(binding.token) && acquisitionIds.has(binding.acquisition) && transportIds.has(t)
      && operations.filter(op => op.kind === "read" && (op.promise === cap.p || op.reaction === cap)).length === 1
      ? litellmReactionVector(cap) : null;
    const hasReason = (op: any) => !!op && (op.state === "rejected" || op.state === "sync_throw");
    const equal = (a: any, b: any) => hasReason(a) && hasReason(b) ? Object.is(a.reason, b.reason) : null;
    const rel = t && (event?.releases ?? releases).get(t.acquisition);
    const shape = (op: any) => op ? [op.id, op.state, op.invoke, op.returned, op.settle, hasReason(op), hasReason(op) ? valueKind(op.reason) : null, ...[0, 1, 2].map(i => op.output?.[i].known ? op.output[i].aborted : null)] : null;
    const eqSignals = (op: any) => [0, 1, 2].map(i => hasReason(op) && op.output?.[i].known && op.output[i].aborted ? Object.is(op.reason, op.output[i].reason) : null);
    const sig = (op: any, key: string) => [0, 1, 2].map(i => { const v = op?.[key]?.[i]; return v?.known ? [v.aborted, v.aborted ? valueKind(v.reason) : null, v.event] : [null, null, null]; });
    // A closed-first drain may still report its exact reader's unique cancel.
    // Keep that operation's own ID/clock/context; never borrow a case's actor.
    const cancels = census.filter((op: any) => op.row === row && op.kind === "cancel" && op.resource);
    const cleanupEvent = event?.resource ? event : cancels.length === 1 ? cancels[0] : undefined;
    const resource = cleanupEvent && cleanupEvent.row === row && cleanupEvent.census === census && cleanupEvent.generation === event?.generation
      ? [cleanupEvent.id, cleanupEvent.kind, cleanupEvent.generation, cleanupEvent.invoke, cleanupEvent.context?.context ?? "unknown", cleanupEvent.resource] : null;
    const ctx = event?.context;
    return [
      { at, body, caseId: owner?.id ?? "none", role: owner?.role ?? "unknown", control: owner?.control ?? "unknown", api: ["catalog", "stream", "streamSimple"].includes(owner?.api) ? owner.api : "unknown", ids: bound,
        g: [event?.generation ?? generation, currentGeneration, event?.lifetime.restore ?? restore], op: event?.kind ?? "none", pred: ctx?.predicate ?? "none",
        ctx: ctx ? [ctx.context, ctx.active, ctx.trusted, ctx.binding, ctx.receiver, ctx.sameOwner, ctx.generation, event.capturedActive] : null,
        time: event ? [event.invoke, event.returned, event.settle, event.pending, event.restore] : null,
        life: [row?.unlockInvoke ?? 0, row?.unlockReturn ?? 0, rel?.invoke ?? 0, rel?.returned ?? 0, rel?.settle ?? 0, row?.unlockCount ?? 0, row?.unlockReturned ?? 0],
        counts: event && event.generation !== currentGeneration ? null : counts, failures: failureCount, source: "unknown", reaction, invocation: event?.invocation ?? null, resource },
      { ids: bound, acquisition: event && ["native_acquisition", "guard_acquisition"].includes(event.kind) ? shape(event) : null, originals: selected.map(shape), same: [equal(selected[0], selected[1]), equal(selected[0], selected[2]), equal(selected[1], selected[2])],
        signals: selected.map(eqSignals), cancel: selected[2] ? [valueKind(selected[2].operand), ...[0, 1, 2].map(i => selected[2].input[i].known && selected[2].input[i].aborted ? Object.is(selected[2].operand, selected[2].input[i].reason) : null)] : null,
        input: sig(event, "input"), output: sig(event, "output"),
        release: rel?.state ?? "unknown", locked, eof: row?.eof ?? false,
        otherRejected: census.filter((op: any) => hasReason(op) && !selected.includes(op)).length,
        abortOperand: "unknown", local: localDisposition },
    ];
  }
  return {
    local(value?: number[]) { if (value) localDisposition = [...value]; return localDisposition && [...localDisposition]; },
    generation, operations, observerFailures, tick, fault(event: any) { faultEvents.push(event); }, aborted(value: object) { if (!abortEvents.has(value)) abortEvents.set(value, tick()); return abortEvents.get(value)!; }, token(t: object) { tokenIds.set(t, ++tokenCount); tokens.push(t); }, acquisition(a: object) { acquisitionIds.set(a, ++acquisitionCount); }, transport(t: any) { transportIds.set(t, ++transportCount); t.witness = begin({ t, id: 0 }, "native_acquisition", undefined, null); },
    guard(a: any) { return begin({ t: { context: a.context, acquisition: a }, id: 0 }, "guard_acquisition", undefined, null); },
    response(t: any) { if (t.body) bodyTransports.set(t.body, t); },
    readerBody(body: object, reader: object, receiver: boolean) { const t = bodyTransports.get(body); const row = { id: rows.length + 1, reader, t, receiver, eof: false, unlockInvoke: 0, unlockReturn: 0, unlockCount: 0, unlockReturned: 0 }; rows.push(row); readerIds.set(reader, row); },
    nativeReader(reader: object, proof: any, binding: any) { const row = readerIds.get(reader); if (row) row.native = Object.freeze({ proof, binding }); },
    readerFault(reader: object, context: any) { const event = begin(readerIds.get(reader), "getReader", undefined, context); event.invoke = 0; event.returned = tick(); settle(event, "fulfilled"); return event; },
    begin(reader: object, kind: string, operand: unknown, context: any, invoked?: number) { const row = readerIds.get(reader); const event = begin(row, kind, operand, context, invoked); if (row && kind === "releaseLock") { row.unlockInvoke = event.invoke; row.unlockCount++; } return event; },
    beginBody(t: any, operand: unknown, context: any, invoked?: number) { return begin({ t, id: 0 }, "body_cancel", operand, context, invoked); },
    closed(reader: object, original: Promise<unknown>) { const event = begin(readerIds.get(reader), "closed", undefined, null); promise(event, original); },
    promise(event: any, original: Promise<unknown>) { promise(event, original); if (event.kind === "read") {
      const derived = original.then((chunk: any) => { if (event.row && chunk && typeof chunk === "object" && !nodeTypes.isProxy(chunk) && Object.getOwnPropertyDescriptor(chunk, "done")?.value === true) event.row.eof = true; }, () => {});
      observers.append(generation, event, "witness_eof", derived);
      const terminal = derived.catch(error => { observerFailures.push(error); });
      observers.terminal(generation, event, "witness_eof_catch", terminal);
    } },
    returned(event: any) { event.returned = tick(); settle(event, "fulfilled"); if (event.row && event.kind === "releaseLock") { event.row.unlockReturn = event.returned; event.row.unlockReturned++; } },
    threw(event: any, error: unknown) { settle(event, "sync_throw", error); },
    release(a: object, reader?: object, invoked?: number) { const event = begin((reader && readerIds.get(reader)) || { t: (a as any).transport, id: 0 }, "release", undefined, null, invoked); releases.set(a, event); return event; },
    roleInvocation(id: string, api: string, control: string) {
      const matches = tokens.filter(t => t.owner?.id === id && t.owner.role === "chat" && t.owner.api === api && t.owner.control === control);
      return matches.length === 1 ? tokenIds.get(matches[0])! : null;
    },
    restored() { restore = tick(); lifetime.restore = restore; }, projection,
  };
}
// Eight fixed role slots; null means no body entry observed, never zero execution.
// Each non-null row is [generation, exact invocation id or null, body outcome
// (0 pending/1 fulfilled/2 rejected), rejection kind (0 undefined/1 null/2 object/
// 3 primitive), cleanup error count/top-level undefined presence, original counts].
// A completed row records afterEach reaching its reporting boundary, not PASS.
function litellmRoleEvidence() {
  const roles = ["eof", "preabort", "partial_abort", "provider_error"];
  const slots: any[] = Array(8).fill(null);
  const index = (id: string) => [...roles.map(r => "sdk_" + r), ...roles.map(r => "sdk_stream_" + r)].indexOf(id);
  const kind = (error: unknown) => error === undefined ? 0 : error === null ? 1 : typeof error === "object" || typeof error === "function" ? 2 : 3;
  return {
    begin(id: string, observer: any) {
      const i = index(id); if (i < 0) return null;
      if (slots[i]) throw new Error("duplicate LiteLLM role evidence");
      const ticket = Object.freeze({ id, i, observer, generation: observer.generation });
      slots[i] = { ticket, outcome: [observer.generation, null, 0, null, null, null, null], finished: false };
      return ticket;
    },
    body(ticket: any, state: "fulfilled" | "rejected", error?: unknown) {
      if (!ticket) return;
      const slot = slots[ticket.i];
      if (!slot || slot.ticket !== ticket || slot.outcome[2] !== 0) throw new Error("foreign LiteLLM role evidence");
      slot.outcome[2] = state === "fulfilled" ? 1 : 2; slot.outcome[3] = state === "rejected" ? kind(error) : null;
    },
    complete(ticket: any, observer: any, errors: unknown[], originals: Operation[]) {
      if (!ticket) return;
      const slot = slots[ticket.i];
      if (!slot || slot.ticket !== ticket || slot.finished || ticket.observer !== observer || ticket.generation !== observer.generation) throw new Error("stale LiteLLM role evidence");
      const api = ticket.i < 4 ? "streamSimple" : "stream", role = roles[ticket.i % 4];
      slot.outcome[1] = observer.witness.roleInvocation(ticket.id, api, role);
      slot.outcome[4] = errors.length; slot.outcome[5] = errors.some(error => error === undefined);
      slot.outcome[6] = [originals.length, originals.filter(op => op.state === "pending").length, originals.filter(op => op.state === "fulfilled").length, originals.filter(op => op.state === "rejected").length];
      const local = observer.witness.local(); if (local !== null) slot.outcome[7] = local;
      slot.finished = true;
    },
    snapshot() { return ["streamSimple", "stream"].map((api, n) => ({ api, outcomes: slots.slice(n * 4, n * 4 + 4).map(slot => slot ? structuredClone(slot.outcome) : null) })); },
  };
}
function litellmSelectWitness(selected: { drain: boolean; ownership: boolean }, at: string | undefined, ownershipFaults: number) {
  return [at === "original_drain" && !selected.drain, ownershipFaults > 0 && !selected.ownership];
}
function litellmCatalogTarget(baseUrl: string): string {
  // D8 extensions/litellm/index.ts selects the suffix before the shared join.
  const suffix = /\/v1\/*$/.test(baseUrl.trim()) ? "models" : "v1/models";
  return `${baseUrl.trim().replace(/\/+$/, "")}/${suffix}`;
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
  const prefix = "LITELLM_PROOF_V1 ", phases = new Set(["setup", "body", "catalog", "chat", "control", "join", "restore", "child_launch", "child_result", "retirement", "cleanup", "reporting", "overflow", "roles", "warm_a", "warm_b", "warm_cached", "warm_versioned", "warm_count", "warm_window", "held_started", "held_mutation", "held_release", "held_join", "held_result", "waiter_started", "waiter_mutation", "waiter_release", "waiter_join", "waiter_result"]);
  const names = new Set(["none", ...ids]), seen = new Set<string>(); let emitted = 0, ordinary = 0, suppressed = 0, bytes = 0, overflow = false, reporting = false;
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
    const fetchPredicates = ["fetch_acquisition", "fetch_registered", "fetch_context", "fetch_duplicate", "fetch_url", "fetch_credential", "fetch_method"];
    const relation = owner && array(owner.relation, fetchPredicates.includes(owner.first) ? 8 : 4, v => v === null || typeof v === "boolean");
    const transports = owner && array(owner.transports, 5, number);
    if (!ops || !resources || !owner || !relation || !transports || !(owner.defined === null || typeof owner.defined === "boolean") || !number(owner.faults) || !["none", "observer", "invoke", "guard", ...fetchPredicates, "response_unique", "attach_duplicate", "attach_bound", "reader", "reader_operation", "body_cancel", "reaction", "release_entry"].includes(owner.first)) return null;
    const first = j.first === null ? null : array(j.first, 2, v => typeof v === "string" || typeof v === "boolean");
    if (j.first !== null && (!first || !["body_cancel", "closed", "read", "cancel", "dispatcher", "native_acquisition", "response_observer", "guard_acquisition", "lease_observer", "release", "read_reaction"].includes(first[0]) || typeof first[1] !== "boolean")) return null;
    return { at: j.at, body: j.body, ops, first, resources, ownership: { first: owner.first, relation, faults: owner.faults, transports, defined: owner.defined } };
  }
  const number = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000;
  const bool = (v: unknown) => typeof v === "boolean", nullableBool = (v: unknown) => v === null || bool(v);
  const enumOf = (values: unknown[]) => (v: unknown) => values.includes(v);
  const valueKind = enumOf(["undefined", "null", "object", "primitive"]);
  const state = enumOf(["invoking", "pending", "fulfilled", "rejected", "sync_throw"]);
  const operation = enumOf(["none", "unknown", "read", "closed", "cancel", "getReader", "releaseLock", "body_cancel", "release", "native_acquisition", "guard_acquisition"]);
  // Compact only the closed witness wire, not the observed facts. Tuple positions
  // retain the full schema; enum and boolean codes avoid width-dependent quotas.
  const witnessKeys = [
    ["at", "body", "caseId", "role", "control", "api", "ids", "g", "op", "pred", "ctx", "time", "life", "counts", "failures", "source", "reaction", "invocation", "resource"],
    ["ids", "acquisition", "originals", "same", "signals", "cancel", "input", "output", "release", "locked", "eof", "otherRejected", "abortOperand", "local"],
  ];
  const words = ["unknown", "undefined", "null", "object", "primitive", "invoking", "pending", "fulfilled", "rejected", "sync_throw", "release_wait", "original_drain", "release_count", "acquisition_count", "reader_unlock", "body_unlocked", "dispatcher_count", "dispatcher_throw", "dispatcher_original", "dispatcher_result", "dispatcher_destroyed", "ownership", "original_observer", "catalog", "chat", "eof", "preabort", "partial_abort", "provider_error", "product", "stream", "streamSimple", "none", "read", "closed", "cancel", "getReader", "releaseLock", "body_cancel", "release", "native_acquisition", "guard_acquisition", "reader_missing", "body_missing", "reader_duplicate", "receiver", "context", "token", "absent", "same", "foreign", "unrecognized", "reaction", "release_entry", "registered", "unmatched", "resource"];
  const caseNames = [...names];
  function witnessWire(data: any, part: number, encode: boolean) {
    const tuple = (v: unknown, length: number) => array(v, length, () => true);
    const word = (v: any) => v === null ? null : encode ? words.indexOf(v) : Number.isInteger(v) && v >= 0 ? words[v] : undefined;
    const bit = (v: any) => v === null ? null : encode ? (v ? 1 : 0) : v === 1 ? true : v === 0 ? false : undefined;
    const map = (v: any, length: number, f: (x: any, i: number) => any) => tuple(v, length)?.map(f);
    const original = (v: any) => v === null ? null : map(v, 10, (x, i) => i === 1 || i === 6 ? word(x) : i === 5 || i >= 7 ? bit(x) : x);
    const signals = (v: any) => map(v, 3, row => map(row, 3, (x, i) => i === 0 ? bit(x) : i === 1 ? word(x) : x));
    const values = encode ? witnessKeys[part].map(k => k === "local" ? data[k] ?? null : data[k]) : tuple(data, witnessKeys[part].length);
    if (!values) return undefined;
    const d: any = Object.fromEntries(witnessKeys[part].map((k, i) => [k, values[i]]));
    if (part === 0) {
      for (const k of ["at", "body", "role", "control", "api", "op", "pred", "source"]) d[k] = word(d[k]);
      d.caseId = encode ? caseNames.indexOf(d.caseId) : Number.isInteger(d.caseId) && d.caseId >= 0 ? caseNames[d.caseId] : undefined;
      if (d.ctx !== null) d.ctx = map(d.ctx, 8, (x, i) => i === 0 ? word(x) : i === 6 ? x : bit(x));
      if (d.invocation !== null) d.invocation = map(d.invocation, 10, (x, i) => i === 3 ? word(x) : i === 8 ? bit(x) : i === 9 ? map(x, 12, bit) : x);
      if (d.resource !== null) d.resource = map(d.resource, 6, (x, i) => i === 1 || i === 4 ? word(x) : i === 5 ? map(x, 6, (v, j) => j < 3 ? bit(v) : j < 5 ? word(v) : map(v, 12, bit)) : x);
    } else {
      d.acquisition = original(d.acquisition); d.originals = map(d.originals, 3, original);
      d.same = map(d.same, 3, bit); d.signals = map(d.signals, 3, row => map(row, 3, bit));
      if (d.cancel !== null) d.cancel = map(d.cancel, 4, (x, i) => i === 0 ? word(x) : bit(x));
      d.input = signals(d.input); d.output = signals(d.output); d.release = word(d.release);
      d.locked = bit(d.locked); d.eof = bit(d.eof); d.abortOperand = word(d.abortOperand);
    }
    return encode ? witnessKeys[part].map(k => d[k]) : d;
  }
  function witnessPart(value: unknown) {
    const w = fields(value, ["part", "select", "data"]); if (!w || ![0, 1].includes(w.part)) return null;
    const select = array(w.select, 2, bool); if (!select || !select.some(Boolean)) return null;
    if (Array.isArray(w.data)) w.data = witnessWire(w.data, w.part, false);
    if (w.part === 0) {
      const d = fields(w.data, ["at", "body", "caseId", "role", "control", "api", "ids", "g", "op", "pred", "ctx", "time", "life", "counts", "failures", "source", "reaction", "invocation", "resource"]);
      if (!d || !names.has(d.caseId) || !enumOf(["catalog", "chat", "unknown"])(d.role) || !enumOf(["eof", "preabort", "partial_abort", "provider_error", "product", "unknown"])(d.control) || !enumOf(["release_wait", "original_drain", "release_count", "acquisition_count", "reader_unlock", "body_unlocked", "dispatcher_count", "dispatcher_throw", "dispatcher_original", "dispatcher_result", "dispatcher_destroyed", "ownership", "original_observer"])(d.at)
        || !enumOf(["unknown", "fulfilled", "rejected"])(d.body) || !enumOf(["catalog", "stream", "streamSimple", "unknown"])(d.api) || !operation(d.op)
        || !enumOf(["none", "reader_missing", "body_missing", "reader_duplicate", "receiver", "context", "token", "reaction", "release_entry", "resource"])(d.pred) || !number(d.failures) || d.source !== "unknown") return null;
      const ids = array(d.ids, 4, number), g = array(d.g, 3, number), time = d.time === null ? null : array(d.time, 5, number);
      const life = array(d.life, 7, number), counts = d.counts === null ? null : array(d.counts, 4, number);
      const ctx = d.ctx === null ? null : array(d.ctx, 8, (v: unknown) => typeof v === "string" || bool(v) || number(v));
      if (!ids || !g || !life || (d.counts !== null && !counts) || (d.time !== null && !time) || (d.ctx !== null && (!ctx || !enumOf(["absent", "same", "foreign", "unrecognized"])(ctx[0]) || !ctx.slice(1, 6).every(bool) || !number(ctx[6]) || !bool(ctx[7])))) return null;
      const reaction = d.reaction === null ? null : array(d.reaction, 9, number);
      if (d.reaction !== null && (!reaction || ![0, 1, 2, 3].includes(reaction[5]) || ![0, 1, 2].includes(reaction[7]) || ![0, 1].includes(reaction[8]))) return null;
      const invocation = d.invocation === null ? null : array(d.invocation, 10, () => true);
      if (d.invocation !== null) {
        if (!invocation || !invocation.slice(0, 2).every(number) || !(invocation[2] === null || number(invocation[2]))
          || !enumOf(["none", "registered", "unrecognized", "unmatched"])(invocation[3]) || !invocation.slice(4, 8).every(v => v === null || number(v))
          || !nullableBool(invocation[8]) || !array(invocation[9], 12, nullableBool)) return null;
        if (invocation[6] !== null && ![0, 1, 2, 3].includes(invocation[6])) return null;
        if (["none", "unrecognized"].includes(invocation[3]) && invocation.slice(4, 9).some(v => v !== null)) return null;
        if (invocation[3] === "registered" && invocation.slice(4, 8).some(v => v === null)) return null;
        invocation[9] = [...invocation[9]];
      }
      const resource = d.resource === null ? null : array(d.resource, 6, () => true);
      if (d.resource !== null) {
        if (!resource || ![resource[0], resource[2], resource[3]].every(number) || !["cancel", "releaseLock", "release"].includes(resource[1])
          || !enumOf(["absent", "same", "foreign", "unrecognized", "unknown"])(resource[4])) return null;
        const claims = array(resource[5], 6, () => true);
        if (!claims || !claims.slice(0, 3).every(bool) || claims[3] !== "unknown" || claims[4] !== "unknown" || !array(claims[5], 12, bool)) return null;
        if (claims[0] !== claims[5].every(Boolean) || claims[1] !== claims[5][10] || resource[2] !== g[0]
          || claims[0] && !["absent", "same"].includes(resource[4])) return null;
        claims[5] = [...claims[5]]; resource[5] = claims;
      }
      return { part: 0, select, data: { ...d, ids, g, time, life, counts, ctx, reaction, invocation, resource } };
    }
    const hasLocal = own(w.data, "local") !== undefined;
    const d = fields(w.data, ["ids", "acquisition", "originals", "same", "signals", "cancel", "input", "output", "release", "locked", "eof", "otherRejected", "abortOperand", ...(hasLocal ? ["local"] : [])]);
    if (hasLocal && d && !localFacts(d.local)) return null;
    if (!d || !nullableBool(d.locked) || !(state(d.release) || d.release === "unknown") || !bool(d.eof) || !number(d.otherRejected) || d.abortOperand !== "unknown") return null;
    const ids = array(d.ids, 4, number), same = array(d.same, 3, nullableBool);
    const original = (v: unknown) => {
      if (v === null) return null;
      const a = array(v, 10, () => true);
      return a && number(a[0]) && state(a[1]) && a.slice(2, 5).every(number) && bool(a[5]) && (a[6] === null || valueKind(a[6])) && a.slice(7).every(nullableBool) ? a : undefined;
    };
    const originals = array(d.originals, 3, v => original(v) !== undefined)?.map(original);
    const acquisition = original(d.acquisition);
    const signalRows = (v: unknown) => array(v, 3, row => { const a = array(row, 3, () => true); return !!a && nullableBool(a[0]) && (a[1] === null || valueKind(a[1])) && (a[2] === null || number(a[2])); })?.map(row => array(row, 3, () => true));
    const signals = array(d.signals, 3, row => !!array(row, 3, nullableBool))?.map(row => array(row, 3, nullableBool));
    const input = signalRows(d.input), output = signalRows(d.output);
    const cancel = d.cancel === null ? null : array(d.cancel, 4, () => true);
    if (acquisition === undefined || !ids || !same || !originals || !signals || !input || !output || (d.cancel !== null && (!cancel || !valueKind(cancel[0]) || !cancel.slice(1).every(nullableBool)))) return null;
    if (d.local?.[1] === 2 && (originals.some(row => !row || row[1] !== "rejected" || !row[5] || row[6] === "undefined")
      || !same.every(v => v === true) || d.release !== "fulfilled" || d.locked !== false || d.otherRejected !== 0)) return null;
    return { part: 1, select, data: { ...d, ids, acquisition, originals, same, signals, input, output, cancel, local: d.local ?? null } };
  }
  function localFacts(value: unknown) {
    if (value === null) return true;
    const a = array(value, 4, number);
    return !!a && [0, 1].includes(a[0]) && [0, 1, 2].includes(a[1])
      && (a[1] !== 2 || a[0] === 1 && a[2] === 3 && a[3] === 0);
  }
  function roleEvidence(value: unknown) {
    const r = fields(value, ["api", "outcomes"]);
    if (!r || !["streamSimple", "stream"].includes(r.api)) return null;
    const outcomes = array(r.outcomes, 4, value => {
      if (value === null) return true;
      const size = own(value, "length");
      const row = [7, 8].includes(size) ? array(value, size, () => true) : null; if (!row || row.length === 8 && !localFacts(row[7])) return false;
      const counts = row[6] === null ? null : array(row[6], 4, number);
      if (row[7]?.[1] === 2 && (row[2] !== 1 || row[4] !== 0 || row[5] !== false || !counts || counts[1] !== 0 || counts[3] !== 3)) return false;
      return number(row[0]) && row[0] > 0 && (row[1] === null || number(row[1]) && row[1] > 0)
        && [0, 1, 2].includes(row[2]) && (row[2] === 2 ? [0, 1, 2, 3].includes(row[3]) : row[3] === null)
        && (row[4] === null ? row[5] === null && row[6] === null && row[1] === null : number(row[4]) && bool(row[5]) && !(row[4] === 0 && row[5]) && !!counts && counts[0] === counts[1] + counts[2] + counts[3]);
    });
    if (!outcomes) return null;
    const generations = outcomes.filter(row => row !== null).map(row => row[0]);
    if (new Set(generations).size !== generations.length) return null;
    return { api: r.api, outcomes: outcomes.map(row => row === null ? null : [...row.slice(0, 6), row[6] === null ? null : [...row[6]], ...(row.length === 8 ? [row[7] === null ? null : [...row[7]]] : [])]) };
  }
  function workerResource(value: unknown) {
    if (value === null) return null;
    const a = array(value,7,()=>true), nullable = (v: unknown) => v===null||number(v);
    if (!a || !array(a[0],4,nullable) || !number(a[1]) || a[1]>63
      || !array(a[2],4,row=>{if(row===null)return true;const r=array(row,5,()=>true);return !!r&&r.slice(0,4).every(number)&&nullable(r[4]);})
      || !array(a[3],11,nullableBool) || !nullable(a[4]) || !array(a[5],3,nullable) || !bool(a[6])) return null;
    for(const row of a[2]) if(row && (row[1]>3||row[2]>7||(row[1]<2?row[2]!==0:!(row[2]&1))||(row[2]&4)&&!(row[2]&2)||(row[2]&2)&&!(row[2]&1)||(row[1]===0?row[4]!==null:row[4]===null))) return null;
    const ids=a[2].filter(Boolean).map(row=>row[0]);if(new Set(ids).size!==ids.length)return null;
    return a;
  }
  function workerLedger(v: unknown) {
    const width = own(v, "length");
    const a = [8,9].includes(width) ? array(v, width, (_: unknown) => true) : null;
    if (!a || !a.slice(0, 7).every(number) || a[1] > a[0]) return null;
    const rows = own(a[7], "length");
    if (!Number.isSafeInteger(rows) || rows < 0 || rows > 2) return null;
    const ops = array(a[7], rows, (v: unknown) => {
      const op = array(v, 10, (_: unknown) => true);
      return !!op && number(op[0]) && number(op[1]) && op[1] <= 10 && number(op[2]) && op[2] <= 3
        && op.slice(3, 6).every(v => v === null || number(v) && v > 0) && bool(op[6]) && nullableBool(op[7])
        && (op[6] ? bool(op[7]) : op[7] === null) && number(op[8]) && (op[9] === null || number(op[9]))
        && ((op[2] === 0 && !op[6] && op[9] === null) || (op[2] >= 2 && op[6] && op[9] !== null));
    });
    if (!ops || new Set(ops.map(op => op[0])).size !== ops.length || ops.some(op => op[0] >= a[0]) || ops.length + a[6] > a[0]) return null;
    const detail = a.length === 9 ? workerResource(a[8]) : null;
    if (a.length === 9 && a[8] !== null && !detail) return null;
    if (detail) {
      const raw = detail[2][0], op = raw && ops.find(op => op[0] === raw[0]);
      if (!op || op[1] !== 4 || op[2] !== raw[1] || op[6] !== !!(raw[2]&1) || op[7] !== !!(raw[2]&2) || op[8] !== raw[3] || op[9] !== raw[4]
        || JSON.stringify(op.slice(3,6)) !== JSON.stringify(detail[0].slice(1))) return null;
      for (const row of detail[2]) if (row && row[0] >= a[0]) return null;
      const derivative = detail[2][1], retained = derivative && ops.find(op=>op[0]===derivative[0]);
      if (retained && (retained[1]!==5 || retained[2]!==derivative[1] || retained[6]!==!!(derivative[2]&1) || retained[7]!==!!(derivative[2]&2) || retained[8]!==derivative[3] || retained[9]!==derivative[4]
        || JSON.stringify(retained.slice(3,6))!==JSON.stringify(detail[0].slice(1)))) return null;
    }
    return [...a.slice(0, 7), ops.map(op => [...op]), ...(a.length === 9 ? [detail] : [])];
  }
  function predicateFacts(v: unknown) {
    const a = array(v, 5, (_: unknown) => true), mask = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1073741823;
    if (!a || !(a[0] === null || Number.isInteger(a[0]) && a[0] >= 0 && a[0] < 30) || !a.slice(1, 4).every(mask)
      || (a[2] & a[3]) !== 0 || ((a[2] | a[3]) & ~a[1]) !== 0 || (a[0] === null ? a[3] !== 0 || a[4] !== null : !(a[3] & 2 ** a[0]) || !nullableBool(a[4]))) return null;
    return [...a];
  }
  function retirementWire(value: any, encode: boolean): any {
    if (encode) {
      const row = [...value]; row[0] = caseNames.indexOf(row[0]);
      const token = (v: any): string => Array.isArray(v) ? "["+v.map(token).join(",")+"]" : v===null ? "~" : v===true ? "T" : v===false ? "F" : v.toString(36);
      return "w1:" + token(row);
    }
    if (typeof value !== "string" || !value.startsWith("w1:") || value.length > 2048 || !/^[0-9a-zTF~,\[\]]+$/.test(value.slice(3))) return null;
    try {
      const row = JSON.parse(value.slice(3).replace(/[0-9a-z]+|T|F|~/g, token => {
        if (token === "T") return "true"; if (token === "F") return "false"; if (token === "~") return "null";
        const n = parseInt(token,36); if (!Number.isSafeInteger(n) || n.toString(36)!==token) throw undefined; return String(n);
      }));
      if (!Array.isArray(row) || !Number.isInteger(row[0]) || row[0]<0 || !caseNames[row[0]]) return null;
      row[0]=caseNames[row[0]]; return row;
    } catch { return null; }
  }
  function retirementFacts(v: unknown) {
    if (typeof v === "string") v = retirementWire(v, false);
    const a = array(v, 5, (_: unknown) => true);
    if (!a || a[0] === "none" || !names.has(a[0]) || !predicateFacts(a[1]) || a[1][0] === null
      || a[2] !== null && !predicateFacts(a[2]) || a[3] !== null && !workerLedger(a[3])
      || ![11,15].includes(own(a[4],"length")) || !array(a[4], own(a[4],"length"), (n: unknown) => n === null || number(n))) return null;
    return [a[0], predicateFacts(a[1]), a[2] === null ? null : predicateFacts(a[2]), a[3] === null ? null : workerLedger(a[3]), [...a[4]]];
  }
  const fixedStages = new Set(["warm_a", "warm_b", "warm_cached", "warm_versioned", "warm_count", "warm_window", "held_started", "held_mutation", "held_release", "held_join", "held_result", "waiter_started", "waiter_mutation", "waiter_release", "waiter_join", "waiter_result"]);
  const stageCase = (id: unknown, phase: unknown) => typeof phase === "string" && fixedStages.has(phase) && names.has(id as string)
    && (phase.startsWith("warm_") ? id === (phase === "warm_b" ? "sdk_warm_b" : "sdk_warm_a")
      : phase.startsWith("held_") ? ["sdk_held_narrow", "sdk_held_broaden", "sdk_held_revoke"].includes(id as string) : id === "sdk_waiter_abort");
  const stageFacts = (value: unknown) => {
    const a = array(value, 3, (_: unknown) => true);
    return a && stageCase(a[0], a[1]) && ["unknown", "undefined"].includes(a[2] as string) ? [...a] : null;
  };
  function validate(v: unknown) {
    try {
      if (!v || typeof v !== "object" || isProxy(v)) return null;
      const keys = ["v", "layer", "id", "role", "phase", "kind", "count", "code"];
      if (Object.hasOwn(v, "join")) keys.push("join");
      if (Object.hasOwn(v, "witness")) keys.push("witness");
      if (Object.hasOwn(v, "worker")) keys.push("worker");
      if (Object.hasOwn(v, "roles")) keys.push("roles");
      if (Object.hasOwn(v, "stage")) keys.push("stage");
      if (Object.hasOwn(v, "retire")) keys.push("retire");
      if (Reflect.ownKeys(v).length !== keys.length || keys.some(k => !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k) ?? {}, "value"))) return null;
      const r: any = Object.fromEntries(keys.map(k => [k, own(v, k)]));
      if (r.v !== 1 || !["sdk", "outer"].includes(r.layer) || !names.has(r.id) || !["unknown", "catalog", "chat"].includes(r.role) || !phases.has(r.phase)
        || !["undefined", "unknown", "child", "overflow"].includes(r.kind) || !(r.count === null || Number.isSafeInteger(r.count) && r.count >= 0 && r.count <= 1000000)
        || !["UNKNOWN", "FULFILLED", "EXIT_1", "TIMEOUT", "SIGTERM", "SIGKILL", "REPORT_INVALID", "REPORT_GROUP", "REPORT_QUOTA", "REPORT_WRITE", "REPORT_WORKER", "REPORT_WITNESS", "REPORT_FLUSH"].includes(r.code)) return null;
      if (fixedStages.has(r.phase) && (r.layer !== "sdk" || r.role !== "catalog" || !stageCase(r.id, r.phase) || keys.length !== 8 || !["unknown", "undefined"].includes(r.kind))) return null;
      if (keys.includes("stage") && (keys.length !== (keys.includes("retire") ? 10 : 9) || r.layer !== "outer" || r.id !== "none" || r.role !== "unknown"
        || r.phase !== "child_result" || r.kind !== "child" || !(r.stage = stageFacts(r.stage)))) return null;
      if (keys.includes("retire") && (r.layer !== "outer" || !(r.retire = retirementFacts(r.retire))
        || (r.phase === "child_result" ? r.id !== "none" || r.kind !== "child" || keys.length !== (keys.includes("stage") ? 10 : 9)
          : r.phase !== "retirement" || r.id !== r.retire[0] || keys.length !== 9))) return null;
      if (r.code === "FULFILLED" && (r.layer !== "outer" || r.id !== "none" || r.phase !== "child_result" || r.kind !== "child")) return null;
      if (r.code.startsWith("REPORT_") && r.phase !== "reporting") return null;
      if (r.phase === "reporting" && (r.id !== "none" || r.role !== "unknown" || !r.code.startsWith("REPORT_") || keys.length !== 8)) return null;
      if (keys.includes("roles")) {
        if (keys.length !== 9 || r.layer !== "sdk" || r.id !== "none" || r.role !== "chat" || r.phase !== "roles" || r.kind !== "unknown" || r.code !== "UNKNOWN" || r.count !== null || !(r.roles = roleEvidence(r.roles))) return null;
      } else if (r.phase === "roles") return null;
      if (keys.includes("join")) { if (r.phase !== "join" || !(r.join = joinFacts(r.join))) return null; }
      if (keys.includes("witness")) { if (keys.includes("join") || r.phase !== "join" || !(r.witness = witnessPart(r.witness)) || (r.witness.part === 0 && (r.id !== r.witness.data.caseId || r.role !== r.witness.data.role))) return null; }
      if (keys.includes("worker")) {
        if (keys.includes("join") || keys.includes("witness") || r.layer !== "outer" || r.phase !== "retirement") return null;
        const a = array(r.worker, 9, (_: unknown) => true);
        if (!a || !a.slice(0, 2).every(nullableBool) || !a.slice(2, 8).every(v => v === null || number(v))) return null;
        const ledger = a[8] === null ? null : workerLedger(a[8]);
        if (a[8] !== null && !ledger) return null;
        r.worker = [...a.slice(0, 8), ledger];
      }
      return r;
    } catch { return null; }
  }
  const record = (layer: string, id: string, phase: string, error: unknown, role = "unknown", count: number | null = null) => {
    const value = validate({ v: 1, layer, id, role, phase, kind: error === undefined ? "undefined" : "unknown", count, code: "UNKNOWN" });
    if (!value) throw new Error("invalid LiteLLM diagnostic"); return value;
  };
  const joined = (value: unknown, facts: unknown) => { const r = validate({ ...validate(value), join: facts }); if (!r) throw new Error("invalid LiteLLM join diagnostic"); return r; };
  const worker = (value: unknown, facts: unknown) => { const r = validate({ ...validate(value), worker: facts }); if (!r) throw new Error("invalid LiteLLM Worker witness"); return r; };
  const workerFailure = (id: string, checks: unknown, workerChecks: unknown, ledger: any, state: unknown) => {
    // One original bad-operation identity; omitted originals stay counted.
    const compact = ledger;
    const value = validate({ ...record("outer", id, "retirement", undefined), retire: [id, checks, workerChecks, compact, state] });
    if (!value) throw new Error("invalid Worker first predicate"); return value;
  };
  const witness = (value: unknown, select: boolean[], parts: unknown[]) => parts.map((data, part) => {
    const r = validate({ ...validate(value), witness: { part, select, data } });
    if (!r) throw new Error("invalid LiteLLM witness"); return r;
  });
  const roles = (facts: unknown) => {
    const r = validate({ v: 1, layer: "sdk", id: "none", role: "chat", phase: "roles", kind: "unknown", count: null, code: "UNKNOWN", roles: facts });
    if (!r) throw new Error("invalid LiteLLM role evidence"); return r;
  };
  function parse(text: unknown) {
    if (typeof text !== "string" || text.length > 2 * 1024 * 1024) return [];
    const records: any[] = [], roleRecords: any[] = [];
    for (const line of text.split("\n")) {
      const clean = line.trimStart(); if (!clean.startsWith(prefix) || clean.length > 768) continue;
      try { const r = validate(JSON.parse(clean.slice(prefix.length))); if (r?.roles) {
        // Reserved independently of old fragments; retain a conflicting variant
        // so the group is rejected, never silently choose its first version.
        if (!roleRecords.some(x => JSON.stringify(x) === JSON.stringify(r)) && roleRecords.filter(x => x.roles.api === r.roles.api).length < 2) roleRecords.push(r);
      } else if (r && (r.witness || records.filter(x => !x.witness).length < 60) && records.length < 64) records.push(r); } catch {}

    }
    return [...records, ...roleRecords];
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
  function json(value: unknown) {
    const r = validate(value); if (!r) throw new Error("invalid LiteLLM diagnostic");
    if (r.witness) r.witness = { ...r.witness, data: witnessWire(r.witness.data, r.witness.part, true) };
    if (r.retire) r.retire = retirementWire(r.retire, true);
    return JSON.stringify(r);
  }
  function boundary(code: string, error: unknown) {
    const r = validate({ v: 1, layer: "outer", id: "none", role: "unknown", phase: "reporting", kind: error === undefined ? "undefined" : "unknown", count: null, code });
    if (!r) throw new Error("invalid LiteLLM reporting boundary"); return r;
  }
  // Pure validation: no deduplication, quota, or emission state is consumed.
  function roleGroup(valid: any[]) {
    const records = valid.filter(r => r.roles); if (!records.length) return null;
    const parts = ["streamSimple", "stream"].map(api => [...new Map(records.filter(r => r.roles.api === api).map(r => [JSON.stringify(r), r])).values()]);
    const generations = parts.flat().flatMap(r => r.roles.outcomes.filter((row: any) => row !== null).map((row: any) => row[0]));
    if (parts.some(rows => rows.length !== 1) || new Set(generations).size !== generations.length) throw new Error("incomplete LiteLLM role evidence");
    return parts.map(rows => rows[0]);
  }
  function validateEnvelope(records: unknown[]) {
    const valid = records.map(value => { const r = validate(value); if (!r) throw new Error("invalid LiteLLM diagnostic"); return r; });
    roleGroup(valid); return valid;
  }
  function emit(records: unknown[], write: (s: string) => void) {
    const errors: unknown[] = [], valid: any[] = []; let failureCode: string | undefined;
    const failed = (code: string, error: unknown) => { errors.push(error); failureCode ??= code; };
    for (const value of records) {
      const r = validate(value);
      if (r) valid.push(r); else failed("REPORT_INVALID", new Error("invalid LiteLLM diagnostic"));
    }
    // The reserved helper record carries the first precise stage without taking
    // a slot from original witnesses, API roles or the generic primary failure.
    const firstStage = valid.find(r => fixedStages.has(r.phase));
    if (firstStage) for (let i = 0; i < valid.length; i++) if (valid[i].phase === "child_result") {
      const stage = [firstStage.id, firstStage.phase, firstStage.kind];
      if (valid[i].stage && JSON.stringify(valid[i].stage) !== JSON.stringify(stage)) {
        failed("REPORT_GROUP", new Error("conflicting LiteLLM stage witness"));
        const { stage: discarded, ...helper } = valid[i];
        valid[i] = validate({ ...helper, stage }); continue;
      }
      const retained = validate({ ...valid[i], stage });
      if (retained) valid[i] = retained; else failed("REPORT_INVALID", new Error("invalid LiteLLM stage envelope"));
    }
    const firstWorker = valid.find(r => r.retire && r.phase === "retirement");
    if (firstWorker) {
      const helper = valid.findIndex(r => r.phase === "child_result");
      if (helper < 0) failed("REPORT_GROUP", new Error("missing original helper verdict"));
      else {
        if (valid[helper].retire && JSON.stringify(valid[helper].retire) !== JSON.stringify(firstWorker.retire)) failed("REPORT_GROUP", new Error("conflicting Worker predicate"));
        const retained = validate({ ...valid[helper], retire: firstWorker.retire });
        if (retained) valid[helper] = retained; else failed("REPORT_INVALID", new Error("invalid Worker helper envelope"));
      }
    }
    const groups = new Map<string, any[]>();
    for (const r of valid) if (r.witness) { const key = [r.layer, r.role, r.id].join("/"); const group = groups.get(key) ?? []; group.push(r); groups.set(key, group); }
    const ordered: any[][] = [], selectedGroups: boolean[] = [false, false];
    for (const group of groups.values()) {
      const unique = [...new Map(group.map(r => [JSON.stringify(r), r])).values()];
      const parts = unique.sort((a, b) => a.witness.part - b.witness.part);
      if (parts.length !== 2 || parts[0].witness.part !== 0 || parts[1].witness.part !== 1 || JSON.stringify(parts[0].witness.select) !== JSON.stringify(parts[1].witness.select)
        || JSON.stringify(parts[0].witness.data.ids) !== JSON.stringify(parts[1].witness.data.ids)) { suppressed += group.length; failed("REPORT_GROUP", new Error("incomplete LiteLLM witness")); continue; }
      const resource = parts[0].witness.data.resource;
      if (parts[1].witness.data.local?.[1] === 2 && (parts[0].witness.data.body !== "fulfilled" || parts[0].witness.data.pred !== "none" || parts[0].witness.data.failures !== 0 || resource?.[5]?.[0] !== true)) {
        suppressed += group.length; failed("REPORT_GROUP", new Error("inconsistent local data witness")); continue;
      }
      if (resource && resource[1] !== parts[0].witness.data.op && (resource[1] !== "cancel" || resource[0] !== parts[1].witness.data.originals[2]?.[0])) {
        suppressed += group.length; failed("REPORT_GROUP", new Error("foreign LiteLLM cleanup operation")); continue;
      }
      if (parts[0].witness.select.some((v: boolean, i: number) => v && selectedGroups[i])) { suppressed += group.length; failed("REPORT_GROUP", new Error("duplicate LiteLLM witness class")); continue; }
      for (let i = 0; i < 2; i++) selectedGroups[i] ||= parts[0].witness.select[i];
      ordered.push(parts);
    }
    try { const roles = roleGroup(valid); if (roles) ordered.push(roles); }
    catch (error) { suppressed += valid.filter(r => r.roles).length; failed("REPORT_GROUP", error); }
    ordered.push(...valid.filter(r => r.worker).map(r => [r]), ...valid.filter(r => !r.witness && !r.worker && r.phase === "child_result").map(r => [r]),
      ...valid.filter(r => r.phase === "reporting").map(r => [r]), ...valid.filter(r => !r.witness && !r.worker && !r.roles && !["child_result", "reporting"].includes(r.phase)).map(r => [r]));
    for (const group of ordered) {
      const reserved = group[0].phase === "child_result" || group[0].phase === "reporting";
      const key = [group[0].layer, group[0].role, group[0].id, group[0].phase, group[0].witness ? "complete_witness" : group[0].roles ? "complete_roles" : "fragment"].join("/");
      if (seen.has(key) || group[0].phase === "reporting" && reporting) continue;
      let lines: string[];
      try { lines = group.map(r => `::error title=LiteLLM typed contract::${json(r).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`); }
      catch (error) { failed("REPORT_INVALID", error); continue; }
      const sizes = lines.map(line => new TextEncoder().encode(line).length);
      if (sizes.some(size => size > 768) || bytes + sizes.reduce((a, b) => a + b, 0) > 8192 - 768) { failed("REPORT_QUOTA", new Error("LiteLLM diagnostic quota")); continue; }
      // Seven ordinary slots leave one helper and one reporting-failure slot.
      if ((!reserved && ordinary + group.length > 7) || emitted + group.length > 9) { suppressed += group.length; seen.add(key); continue; }
      // Reserve the complete pair before writing; a failed physical write is not retried.
      seen.add(key);
      if (group[0].phase === "reporting") reporting = true;
      for (let i = 0; i < lines.length; i++) {
        bytes += sizes[i]; emitted++; if (!reserved) ordinary++;
        try { write(lines[i]); } catch (error) { failed("REPORT_WRITE", error); break; }
      }
    }
    if (failureCode && !reporting && emitted < 9) {
      reporting = true;
      const line = `::error title=LiteLLM typed contract::${json(boundary(failureCode, errors[0]))}\n`;
      const size = new TextEncoder().encode(line).length;
      if (size <= 768 && bytes + size <= 8192 - 768) {
        emitted++; bytes += size; try { write(line); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "LiteLLM reporting failures");
  }
  function flush(write: (s: string) => void) {
    if (!suppressed || overflow) return; overflow = true;
    const r = { v: 1, layer: "outer", id: "none", role: "unknown", phase: "overflow", kind: "overflow", count: Math.min(suppressed, 1000000), code: "UNKNOWN" };
    const line = `::error title=LiteLLM typed contract::${JSON.stringify(r)}\n`; const size = new TextEncoder().encode(line).length;
    if (size > 768 || bytes + size > 8192) throw new Error("LiteLLM diagnostic quota"); write(line); bytes += size;
  }
  return { workerFailure, prefix, own, validate, validateEnvelope, record, joined, witness, roles, worker, parse, child, json, boundary, emit, flush };
}
// END shared proof functions.

// BEGIN isolated wrapper proof.
function litellmControlMode(value: unknown) {
  if (value === undefined || value === "product") return "product";
  if (value === "control-only") return value;
  throw new Error("unknown LiteLLM contract mode");
}
function litellmControlRestore(errors: unknown[], callbacks: Array<() => void>) {
  let restored = true;
  for (const restore of callbacks) try { restore(); } catch (error) { restored = false; errors.push(error); }
  return restored;
}
// This is an entry witness, not a replacement for the product ownership verdict.
function litellmContinuation(owner: any) {
  const capabilities = new Map<object, any>(), faults: string[] = [];
  let registration: any, entered: any, active = true, entries = 0, adoptions = 0;
  const contexts = [0, 0], calls = [0, 0];
  const fault = (id: string) => { faults.push(id); };
  return {
    faults,
    registering(p: object, then: Function, receiver: unknown, args: unknown[]) {
      if (!active || registration || receiver !== p || args.length !== 2 || args.some(v => typeof v !== "function")) { fault("registration"); return; }
      registration = { p, then, receiver, args: Object.freeze([...args]), matches: [] };
    },
    init(q: object, p: object | undefined) { if (registration && p === registration.p) registration.matches.push(q); },
    registered(q: object) {
      const r = registration; registration = undefined;
      if (!r || r.matches.length !== 1 || r.matches[0] !== q || capabilities.has(q)) { fault("mapping"); return; }
      capabilities.set(q, { binding: Object.freeze({ ...r, q, owner }), state: "armed", calls: new Set() });
    },
    registrationFailed() { registration = undefined; fault("registration_throw"); },
    before(q: object) {
      const c = capabilities.get(q); if (!c) return;
      // Adoption jobs reuse Q after the original reaction. They never reopen it.
      if (c.state === "consumed") { adoptions++; return; }
      if (!active || entered || c.state !== "armed") { fault("entry"); return; }
      c.state = "entered"; entered = c; entries++;
    },
    after(q: object) {
      const c = capabilities.get(q); if (!c || c.state === "consumed") return;
      if (entered !== c || c.state !== "entered") { fault("boundary"); return; }
      c.state = "consumed"; entered = undefined;
    },
    operation(reader: object, receiver: unknown, method: Function, kind: string, generation: number, context: string) {
      let id = "none";
      if (!active || generation !== owner.generation) id = "generation";
      else if (!entered) id = "outside";
      else if (context !== "same" && context !== "absent") id = "context";
      else if (reader !== owner.reader || receiver !== reader) id = "receiver";
      else if (!Object.hasOwn(owner.methods, kind) || owner.methods[kind] !== method) id = "method";
      else if (entered.calls.has(kind)) id = "replay";
      if (id !== "none") fault(id); else { entered.calls.add(kind); contexts[context === "same" ? 0 : 1]++; calls[kind === "cancel" ? 0 : 1]++; }
      return id;
    },
    finish() {
      if (registration || entered || [...capabilities.values()].some(c => c.state !== "consumed")) fault("incomplete");
      active = false;
      return { entries, adoptions, faults: [...faults], contexts: [...contexts], calls: [...calls] };
    },
  };
}
function litellmControlWire() {
  const ids = ["eof", "source_error", "source_undefined", "held_cleanup", "cleanup_undefined"];
  const prefix = "LITELLM_WRAPPER_V1 ", keys = ["v", "id", "ok", "settled", "rejected", "entries", "adoptions", "faults", "restored", "sameContext", "absentContext", "cancels", "unlocks"];
  const deliveryKeys = ["recognized", "rejected", "absent", "unterminated", "inputsRejected"] as const;
  const delivery = () => ({ v: 1, mode: "wrapper-delivery", recognized: 0, rejected: 0, absent: 0, unterminated: 0, inputsRejected: 0 });
  function decode(value: unknown): any {
    try {
      if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) return null;
      if (Object.getOwnPropertyDescriptor(value, "mode")?.value === "wrapper-delivery") {
        const fields = ["v", "mode", ...deliveryKeys], r: any = {};
        if (Reflect.ownKeys(value).length !== fields.length) return null;
        for (const key of fields) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !Object.hasOwn(d, "value")) return null; r[key] = d.value; }
        if (r.v !== 1 || deliveryKeys.some(key => !Number.isSafeInteger(r[key]) || r[key] < 0 || r[key] > 100000)) return null;
        return r;
      }
      if (Object.getOwnPropertyDescriptor(value, "mode")?.value === "wrapper-control") {
        const fields = ["v", "mode", "helperFulfilled", "code", "records", "missing", "invalid", "undefinedFailure"], r: any = {};
        if (Reflect.ownKeys(value).length !== fields.length) return null;
        for (const key of fields) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !Object.hasOwn(d, "value")) return null; r[key] = d.value; }
        if (r.v !== 1 || typeof r.helperFulfilled !== "boolean" || typeof r.undefinedFailure !== "boolean"
          || !(r.code === null || Number.isInteger(r.code) && r.code >= 0 && r.code <= 255)
          || [r.records, r.missing, r.invalid].some(n => !Number.isSafeInteger(n) || n < 0 || n > 100000)) return null;
        return r;
      }
      if (Reflect.ownKeys(value).length !== keys.length) return null;
      const r: any = {};
      for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !Object.hasOwn(d, "value")) return null; r[key] = d.value; }
      if (r.v !== 1 || !ids.includes(r.id) || typeof r.ok !== "boolean" || typeof r.restored !== "boolean"
        || [r.settled, r.rejected, r.entries, r.adoptions, r.faults, r.sameContext, r.absentContext, r.cancels, r.unlocks].some(n => !Number.isSafeInteger(n) || n < 0 || n > 1000)) return null;
      return r;
    } catch { return null; }
  }
  const parse = (text: unknown, counts?: ReturnType<typeof delivery>) => {
    const count = (key: typeof deliveryKeys[number]) => { if (counts) counts[key] = Math.min(100000, counts[key] + 1); };
    if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024) { count("inputsRejected"); return []; }
    const records: any[] = [];
    const lines = text.split(/\r?\n/), tail = lines.pop();
    if (tail) count("unterminated");
    for (const line of lines) {
      if (!line.startsWith(prefix)) { count("absent"); continue; }
      const bare = line.slice(prefix.length);
      if (line.includes("\x1b") || Buffer.byteLength(bare) > 768) { count("rejected"); continue; }
      let record;
      try { record = decode(JSON.parse(bare)); } catch {}
      if (record && ids.includes(record.id)) { records.push(record); count("recognized"); }
      else count("rejected");
    }
    return records;
  };
  function collect(records: unknown[]) {
    const found = new Map<string, any>(), invalid: string[] = []; let helper: any = null, delivery: any = null;
    for (const value of records) { const r = decode(value); if (!r) { invalid.push("schema"); continue; }
      if (r.mode === "wrapper-delivery") { if (delivery) invalid.push("duplicate_delivery"); else delivery = r; continue; }
      if (r.mode === "wrapper-control") { if (helper) invalid.push("duplicate_helper"); else helper = r; continue; }
      if (found.has(r.id)) invalid.push("duplicate"); else found.set(r.id, r); }
    return { records: ids.flatMap(id => found.has(id) ? [found.get(id)] : []), missing: ids.filter(id => !found.has(id)), invalid, helper, delivery };
  }
  function emit(records: unknown[], write: (s: string) => unknown) {
    const result = collect(records); let bytes = 0;
    for (const r of [...(result.delivery ? [result.delivery] : []), ...result.records]) {
      if (r.ok) continue;
      const text = "::error title=LiteLLM wrapper control::" + JSON.stringify(r).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A") + "\n";
      bytes += Buffer.byteLength(text); if (Buffer.byteLength(text) > 768 || bytes > 8192) throw new Error("wrapper reporting quota");
      write(text);
    }
    return result;
  }
  function child(error: unknown, counts?: ReturnType<typeof delivery>) {
    const data = (key: string) => { try { return error && typeof error === "object" && !nodeTypes.isProxy(error) ? Object.getOwnPropertyDescriptor(error, key)?.value : undefined; } catch { return undefined; } };
    const code = data("code"), stdout = data("stdout"), stderr = data("stderr");
    return { records: [...parse(stdout, counts), ...parse(stderr, counts)], code: Number.isInteger(code) && code >= 0 && code <= 255 ? code : null,
      undefinedFailure: error === undefined };
  }
  return { ids, prefix, decode, parse, collect, emit, child, delivery };
}
// END isolated wrapper proof.

function registerLiteLLMWrapperControls() {
  nativeIt("D8 original wrapper continuation entry only", async () => {
    expect(process.version).toBe("v24.22.1");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sourceHead);
    const { wrapGuardedBodyStream } = await import("../../src/infra/net/guarded-body-stream.js");
    const { promiseHooks } = await import("node:v8");
    const wire = litellmControlWire();
    for (const id of wire.ids) {
      const errors: unknown[] = [], operations: any[] = [], restores: Array<() => void> = [];
      const storage = new AsyncLocalStorage<object>(), token = Object.freeze({}), generation = 1;
      const expected = id === "source_undefined" ? undefined : Object.freeze({});
      const sourceError = id === "source_error" || id === "source_undefined";
      let observer: ReturnType<typeof litellmContinuation> | undefined, stop: (() => void) | undefined;
      let unlocks = 0, cleanupCalls = 0, restored = false, summary: any;
      const remember = (kind: string, original: Promise<any>) => {
        const row: any = { kind, original, state: "pending" }; operations.push(row);
        // Observe using the prototype: never confuse our handlers with the wrapper's.
        row.observed = Reflect.apply(Promise.prototype.then, original, [
          (value: unknown) => { row.state = "fulfilled"; row.value = value; },
          (reason: unknown) => { row.state = "rejected"; row.reason = reason; },
        ]); return original;
      };
      const patch = (object: object, key: string, value: unknown) => {
        const prior = Object.getOwnPropertyDescriptor(object, key);
        Object.defineProperty(object, key, { configurable: true, writable: true, value });
        restores.push(() => { if (prior) Object.defineProperty(object, key, prior); else if (!Reflect.deleteProperty(object, key)) throw new Error("descriptor restoration failed"); });
      };
      const join = async () => { for (let cursor = 0; cursor < operations.length;) {
        const batch = operations.slice(cursor); cursor += batch.length;
        await Promise.all(batch.map(row => row.observed));
      } };
      let endHeld!: () => void;
      const held = new Promise<void>(resolve => { endHeld = resolve; });
      let cleanupStarted!: () => void;
      const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
      let pulls = 0;
      const source = new ReadableStream<Uint8Array>({ pull(c) {
        if (sourceError) c.error(expected);
        else if (pulls++ === 0) c.enqueue(new Uint8Array([7])); else c.close();
      } }, { highWaterMark: 0 });
      const response = new Response(source), body = response.body!;
      const originalGet = body.getReader;
      const cleanup = () => {
        cleanupCalls++; cleanupStarted();
        return remember("cleanup", id === "cleanup_undefined" ? Promise.reject(undefined) : id === "held_cleanup" ? held : Promise.resolve());
      };
      let client: ReadableStreamDefaultReader<Uint8Array> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        patch(body, "getReader", function (this: ReadableStream<Uint8Array>, ...args: unknown[]) {
          const reader = Reflect.apply(originalGet, this, args) as ReadableStreamDefaultReader<Uint8Array>;
          if (this !== body || observer) throw new Error("nonunique wrapper reader");
          const read = reader.read, cancel = reader.cancel, unlock = reader.releaseLock;
          const owner = Object.freeze({ generation, reader, response, body, methods: Object.freeze({ cancel, releaseLock: unlock }) });
          observer = litellmContinuation(owner);
          stop = promiseHooks.createHook({ init: (q, p) => observer!.init(q, p), before: q => observer!.before(q), after: q => observer!.after(q) });
          remember("closed", reader.closed);
          patch(reader, "read", function (this: typeof reader, ...values: unknown[]) {
            const p = Reflect.apply(read, this, values); remember("read", p);
            const then = p.then;
            patch(p, "then", function (this: typeof p, ...handlers: unknown[]) {
              observer!.registering(p, then, this, handlers);
              try { const q = Reflect.apply(then, this, handlers); observer!.registered(q); remember("continuation", q); return q; }
              catch (error) { observer!.registrationFailed(); throw error; }
            }); return p;
          });
          for (const [kind, original] of [["cancel", cancel], ["releaseLock", unlock]] as const) patch(reader, kind, function (this: typeof reader, ...values: unknown[]) {
            const raw = storage.getStore(), context = raw === undefined ? "absent" : raw === token ? "same" : "foreign";
            observer!.operation(reader, this, original, kind, generation, context);
            try { const value = Reflect.apply(original, this, values); if (kind === "cancel") remember(kind, value); else unlocks++; return value; }
            catch (error) { errors.push(error); throw error; }
          });
          return reader;
        });
        // Only construction has authoring context. Consumption is deliberately outside.
        const wrapped = storage.run(token, () => wrapGuardedBodyStream({ body, cleanup }));
        client = wrapped.getReader(); remember("client_closed", client.closed);
        const consume = (async () => { for (;;) { const chunk = await remember("client_read", client!.read()); if (chunk.done) break; } })();
        remember("consumer", consume);
        const proof = (async () => {
          if (id === "held_cleanup") {
            await started;
            try {
              expect(operations.find(row => row.kind === "cleanup")?.state).toBe("pending");
              expect(operations.some(row => row.kind === "continuation" && row.state === "pending")).toBe(true);
            } finally {
              // This control owns the original cleanup producer. Failure stays failure.
              endHeld();
            }
          }
          await consume.catch(() => {}); await join();
        })();
        await Promise.race([proof, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("wrapper control deadline")), 5000); })]);
        summary = observer!.finish();
        expect(summary.faults).toEqual([]); expect(summary.entries).toBeGreaterThan(0);
        if (id === "held_cleanup") expect(summary.adoptions).toBeGreaterThan(0);
        expect(cleanupCalls).toBe(1); expect(unlocks).toBe(1); expect(body.locked).toBe(false); expect(summary.calls).toEqual([1, 1]);
        const rejected = operations.filter(row => row.state === "rejected");
        if (sourceError) {
          for (const kind of ["read", "closed", "cancel", "client_read", "client_closed", "consumer"]) expect(rejected.some(row => row.kind === kind && Object.is(row.reason, expected))).toBe(true);
          expect(rejected.every(row => Object.is(row.reason, expected))).toBe(true);
        } else if (id === "cleanup_undefined") {
          expect(rejected.map(row => row.kind)).toEqual(["cleanup"]); expect(rejected[0].reason).toBeUndefined();
        } else expect(rejected).toEqual([]);
      } catch (error) { errors.push(error); }
      finally {
        if (deadline) clearTimeout(deadline);
        // Join originals even on assertion failure; the helper's process deadline is failure only.
        try { await join(); } catch (error) { errors.push(error); }
        if (!summary && observer) summary = observer.finish();
        restored = litellmControlRestore(errors, [() => client?.releaseLock(), () => stop?.(), ...restores.reverse(), () => storage.disable()]);
      }
      const record = wire.decode({ v: 1, id, ok: errors.length === 0, settled: operations.filter(row => row.state !== "pending").length,
        rejected: operations.filter(row => row.state === "rejected").length, entries: summary?.entries ?? 0, adoptions: summary?.adoptions ?? 0,
        faults: observer?.faults.length ?? 0, restored, sameContext: summary?.contexts[0] ?? 0, absentContext: summary?.contexts[1] ?? 0,
        cancels: summary?.calls[0] ?? 0, unlocks: summary?.calls[1] ?? 0 });
      try { if (!record) throw new Error("invalid wrapper control record"); process.stdout.write(wire.prefix + JSON.stringify(record) + "\n"); }
      catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "wrapper control and cleanup failed");
    }
  }, 45_000);
}

if (contractMode === "control-only") {
  registerLiteLLMWrapperControls();
} else {
const { stream, streamSimple } = await import("openclaw/plugin-sdk/llm");
const { promiseHooks: productPromiseHooks } = await import("node:v8");
const { registerSingleProviderPlugin } = await import("openclaw/plugin-sdk/plugin-test-runtime");
const { clearLiveCatalogCacheForTests } = await import("openclaw/plugin-sdk/provider-catalog-live-runtime");
const catalogGuard = await import("openclaw/plugin-sdk/ssrf-runtime");
const chatGuard = await import("../../src/agents/provider-transport-dispatcher-pool.js");
const { loadBundledPluginFacade } = await import("../../src/test-utils/bundled-plugin-public-surface.js");
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
type Row = { id: string; mode: string; action?: string; unrestricted?: boolean; versioned?: boolean; control?: string };
const rows = JSON.parse(process.env.CLAWROUTER_CONTRACT_CASES!) as Row[];
const selected = "tenant/private-alias";
const key = (id: string) => `clawrouter-live-${id}-fixture-secret`;
const originalFetch = globalThis.fetch;
const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
const originalCatalogGuard = catalogGuard.fetchWithSsrFGuard;
const originalChatGuard = chatGuard.fetchWithProviderHttpGuard;
type Acquisition = { kind: "catalog" | "chat"; promise: Promise<unknown>; releases: number; released: Promise<void>; markReleased: () => void };
const operations: Operation[] = [], acquisitions: Acquisition[] = [], failures: unknown[] = [];
const readRestores: Array<() => void> = [];
const retiredObservers: Array<ReturnType<typeof litellmObserverLedger>> = [];
const bodies = new Set<ReadableStream<Uint8Array>>();
const readers: Array<{ body: ReadableStream<Uint8Array>; unlocks: number }> = [];
const closes: Array<{ depth: number; original?: Promise<unknown>; threw: boolean; error?: unknown }> = [];
const dispatchers = new Set<object>();
const requests: Array<{ method: string; path: string; credential: string }> = [];

let observerGeneration = 0;
const selectedWitness = { drain: false, ownership: false };
const roleEvidence = litellmRoleEvidence();
let roleTicket: any = null;
let ownership = litellmOwnership(new AsyncLocalStorage(), observerGeneration);
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
  const errors: unknown[] = [];
  for (const record of diagnosticRecords.splice(0, 64)) {
    try { process.stdout.write(diagnostic.prefix + diagnostic.json(record) + "\n"); } catch (error) { errors.push(error); }
  }
  if (errors.length) {
    try { process.stdout.write(diagnostic.prefix + diagnostic.json(diagnostic.boundary("REPORT_FLUSH", errors[0])) + "\n"); } catch (error) { errors.push(error); }
    raise(errors);
  }
}
function remember<T extends Promise<unknown>>(kind: string, promise: T, captured?: Operation): T {
  const record: Operation = captured ?? { kind, promise, state: "pending" };
  if (!captured) operations.push(record);
  else if (record.kind !== kind || record.promise !== promise || !operations.includes(record)) throw new Error("foreign captured original");
  const derived = promise.then(() => { record.state = "fulfilled"; }, error => { record.state = "rejected"; record.reasonDefined = error !== undefined; });
  ownership.observers.terminal(ownership.generation, record, "original_bookkeeping", derived); return promise;
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
  const get = body.getReader, cancel = body.cancel, captured = ownership;
  vi.spyOn(body, "cancel").mockImplementation(function (this: typeof body, ...args) {
    const event = ownership.bodyCancel(body, this, captured, args[0], cancel, args);
    try { const original = Reflect.apply(cancel, this, args); captured.witness.promise(event, original); return remember("body_cancel", original); } catch (error) { captured.witness.threw(event, error); failures.push(error); throw error; }
  });
  vi.spyOn(body, "getReader").mockImplementation(function (this: typeof body, ...args) {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try { reader = Reflect.apply(get, this, args); } catch (error) { failures.push(error); throw error; }
    let native;
    try { native = litellmNativeCapture(nativeStreamProof, body, get, this, args, reader); } catch (error) { failures.push(error); throw error; }
    const capturedClosed: Operation = { kind: "closed", promise: native.closed, state: "pending" }; operations.push(capturedClosed);
    ownership.reader(body, reader, this, captured, { read: reader.read, cancel: reader.cancel, releaseLock: reader.releaseLock });
    captured.nativeReader(reader, native);
    const record = { body, unlocks: 0 }; readers.push(record); const closed = native.closed; captured.witness.closed(reader, closed); remember("closed", closed, capturedClosed);
    const read = reader.read;
    try {
      litellmReadBoundary(reader, read, {
        begin(receiver, values) { return ownership.operation(reader, receiver, "read", captured, values[0], read, values); },
        returned(event, pending) {
          const errors: unknown[] = [];
          for (const observe of [() => { if (event) captured.witness.promise(event, pending); }, () => remember("read", pending)]) try { observe(); } catch (error) { errors.push(error); }
          raise(errors);
        },
        arm(event, pending) { event.reaction = ownership.prepareRead(reader, pending, read, captured); },
        threw(event, error) { if (event) captured.witness.threw(event, error); },
      }, failures, readRestores);
    } catch (error) { failures.push(error); }
    for (const kind of ["cancel"] as const) {
      const original = reader[kind];
      vi.spyOn(reader, kind).mockImplementation(function (this: typeof reader, ...values: unknown[]) {
        const event = ownership.operation(reader, this, kind, captured, values[0], original, values);
        try {
          const pending = Reflect.apply(original, this, values); captured.witness.promise(event, pending); remember(kind, pending);
          return pending;
        } catch (error) { captured.witness.threw(event, error); failures.push(error); throw error; }
      });
    }
    const unlock = reader.releaseLock;
    vi.spyOn(reader, "releaseLock").mockImplementation(function (this: typeof reader, ...args: unknown[]) {
      const event = ownership.operation(reader, this, "releaseLock", captured, undefined, unlock, args);
      try { const value = Reflect.apply(unlock, this, args); captured.witness.returned(event); record.unlocks++; return value; } catch (error) { captured.witness.threw(event, error); failures.push(error); throw error; }
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
  const captured = ownership;
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
    ownership.releaseBinding(record, result, release);
    vi.spyOn(result, "release").mockImplementation(function (this: any, ...values: unknown[]) {
      record.releases++; const event = ownership.releaseEntry(record, result, release, this, values, captured);
      try { const value = Reflect.apply(release, this, values); captured.witness.promise(event, value); remember("release", value); const notification = value.then(markReleased, markReleased); captured.observers.terminal(captured.generation, record, "release_notification", notification); return value; }
      catch (error) { captured.witness.threw(event, error); failures.push(error); markReleased(); throw error; }
    });
    } catch (error) { failures.push(error); markReleased(); throw error; }
  }, () => { markReleased(); }));
  return pending;
}
const it = (name: string, body: () => Promise<void>, timeout: number) => nativeIt(name, async () => {
  try { roleTicket = roleEvidence.begin(name, ownership); } catch (error) { failures.push(error); }
  try { await body(); bodyOutcome = "fulfilled"; }
  catch (error) {
    bodyOutcome = "rejected";
    try { roleEvidence.body(roleTicket, "rejected", error); } catch (reportError) { failures.push(reportError); }
    try { reportSdk("body", error); flushSdk(); } catch (reportError) { throw new AggregateError([error, reportError], "LiteLLM body and reporting failed"); }
    throw error;
  }
  try { roleEvidence.body(roleTicket, "fulfilled"); } catch (error) { failures.push(error); }
}, timeout);
beforeEach(() => {
  roleTicket = null;
  diagnosticId = "none"; diagnosticRole = "unknown"; diagnosticRecords = []; diagnosticSuppressed = 0; bodyOutcome = "unknown";
  ownership = litellmOwnership(new AsyncLocalStorage(), ++observerGeneration);
  try {
  ownership.setReactionObserver(q => { remember("read_reaction", q); });
  ownership.setReactionHook(productPromiseHooks.createHook(ownership.reactionHooks));
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(sourceHead);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sourceHead);
  clearLiveCatalogCacheForTests(); operations.length = 0; acquisitions.length = 0; failures.length = 0;
  readRestores.length = 0;
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
  let errors: unknown[] = [];
  let failedCheckpoint: string | undefined;
  const failed = (phase: string, error: unknown) => { failedCheckpoint ??= phase; errors.push(error); };
  try { ownership.closeRegistration(); } catch (error) { failed("release_wait", error); }
  const drain = litellmRetirementJoin(ownership, acquisitions, operations);
  try { if ((await drain()).length) failedCheckpoint ??= "original_drain"; } catch (error) { failed("original_drain", error); }
  const checks: Array<[string, () => unknown]> = [];
  for (const row of acquisitions) checks.push(["release_count", () => expect(row.releases).toBe(1)]);
  checks.push(["acquisition_count", () => expect(acquisitions.length).toBe(requests.length)]);
  for (const reader of readers) checks.push(["reader_unlock", () => expect(reader.unlocks).toBe(1)]);
  for (const body of bodies) checks.push(["body_unlocked", () => expect(body.locked).toBe(false)]);
  const external = closes.filter(row => row.depth === 0);
  checks.push(["dispatcher_count", () => expect(external).toHaveLength(dispatchers.size)]);
  for (const row of external) {
    checks.push(["dispatcher_throw", () => expect(row.threw).toBe(false)]);
    checks.push(["dispatcher_original", () => expect(row.original).toBeDefined()]);
    checks.push(["dispatcher_result", async () => { if (!row.original) throw new Error("missing original dispatcher result"); expect(await row.original).toBeNull(); }]);
  }
  for (const dispatcher of dispatchers) checks.push(["dispatcher_destroyed", () => expect(Reflect.get(dispatcher, "destroyed")).toBe(true)]);
  await litellmAttemptAll(checks, failed);
  // Inference owns a pooled request lease, never the global pool lifetime.
  await litellmAttemptAll([...readRestores, () => ownership.restore(), () => vi.restoreAllMocks(), () => vi.unstubAllGlobals(), () => vi.unstubAllEnvs(), () => clearLiveCatalogCacheForTests()].map(restore => ["restore", restore]), failed);
  try { if ((await drain()).length) failedCheckpoint ??= "original_drain"; } catch (error) { failed("original_drain", error); }
  ownership.observers.seal(); retiredObservers.push(ownership.observers);
  try { drain.seal(); } catch (error) { failed("original_drain", error); }
  for (const error of ownership.settledFailures()) failed("ownership", error);
  for (const error of [...failures, ...ownership.observers.faults, ...ownership.witness.observerFailures]) failed("original_observer", error);
  const disposition = litellmDataDisposition(drain.audit, ownership, bodyOutcome, errors, operations);
  errors = disposition.fatal; ownership.witness.local(disposition.facts);
  // Snapshot before reporting; reporter failures cannot grow this iteration.
  const failureSnapshot = [...errors];
  let join: ReturnType<typeof litellmJoinFacts> | undefined;
  if (failureSnapshot.length) try { join = litellmJoinFacts(failedCheckpoint ?? "original_observer", bodyOutcome, operations, acquisitions, readers, bodies, failures, ownership); } catch (error) { errors.push(error); }
  for (const error of failureSnapshot) try { reportSdk("join", error, join); } catch (reportError) { errors.push(reportError); }
  if (failureSnapshot.length) try {
    const [drain, owned] = litellmSelectWitness(selectedWitness, failedCheckpoint, ownership.faults.length);
    if (drain || owned) {
      const parts = ownership.witness.projection(failedCheckpoint ?? "original_observer", bodyOutcome, observerGeneration,
        [operations.length, operations.filter(op => op.state === "pending").length, operations.filter(op => op.state === "fulfilled").length, operations.filter(op => op.state === "rejected").length], failures.length, operations);
      const pair = diagnostic.witness(diagnostic.record("sdk", parts[0].caseId, "join", undefined, parts[0].role), [drain, owned], parts);
      diagnosticRecords.unshift(...pair); selectedWitness.drain ||= drain; selectedWitness.ownership ||= owned;
    }
  } catch (error) { errors.push(error); try { diagnosticRecords.push(diagnostic.boundary("REPORT_WITNESS", error)); } catch (reportError) { errors.push(reportError); } }
  try { flushSdk(); } catch (error) { errors.push(error); }
  if (disposition.accepted && errors.length) ownership.witness.local([1, 1, 3, Math.min(3 + errors.length, 1_000_000)]);
  try { roleEvidence.complete(roleTicket, ownership, litellmFinalizeDisposition(disposition, errors), operations); } catch (error) { errors.push(error); }
  // Reporting cannot turn a provisional partition into a successful verdict.
  raise(litellmFinalizeDisposition(disposition, errors));
});
afterAll(() => {
  const errors: unknown[] = retiredObservers.flatMap(ledger => ledger.lateFaults);
  for (const facts of roleEvidence.snapshot()) try { process.stdout.write(diagnostic.prefix + diagnostic.json(diagnostic.roles(facts)) + "\n"); } catch (error) { errors.push(error); }
  if (errors.length) try { process.stdout.write(diagnostic.prefix + diagnostic.json(diagnostic.boundary("REPORT_FLUSH", errors[0])) + "\n"); } catch (error) { errors.push(error); }
  raise(errors);
});
// BEGIN held outcome helpers.
async function litellmHeldSequence(start: () => Promise<unknown>, mutate: () => Promise<unknown>, release: () => Promise<unknown>, joins: Array<() => Promise<unknown>>, report: (stage: string, error: unknown) => void, prefix: "held" | "waiter") {
  const failures: Array<{stage: string; error: unknown}> = [];
  let started = false;
  try { await start(); started = true; } catch (error) { failures.push({stage: prefix + "_started", error}); }
  if (started) try { await mutate(); } catch (error) { failures.push({stage: prefix + "_mutation", error}); }
  try { await release(); } catch (error) { failures.push({stage: prefix + "_release", error}); }
  for (const join of joins) try { await join(); } catch (error) { failures.push({stage: prefix + "_join", error}); }
  const errors = failures.map(failure => failure.error);
  for (const failure of failures) try { report(failure.stage, failure.error); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "LiteLLM held control, original outcomes and reporting failed");
}
async function litellmCatalogStage<T>(stage: string, run: () => Promise<T>, report: (stage: string, error: unknown) => void): Promise<T> {
  try { return await run(); } catch (error) {
    try { report(stage, error); } catch (reportError) { throw new AggregateError([error, reportError], "LiteLLM catalog assertion and reporting failed"); }
    throw error;
  }
}
// END held outcome helpers.
async function control(action: string, id: string): Promise<void> {
  try {
    const response = await originalFetch(`${origin}/__litellm/${action}/${id}`, { method: ["started", "retire"].includes(action) ? "GET" : "POST" });
    await response.arrayBuffer(); expect(response.status).toBe(200);
  } catch (error) { try { reportSdk("control", error); flushSdk(); } catch (reportError) { throw new AggregateError([error, reportError], "LiteLLM control and reporting failed"); } throw error; }
}
async function fixture(body: (discover: (row: Row, signal?: AbortSignal, authId?: string, capture?: (result: unknown) => void) => Promise<ModelProviderConfig | undefined>) => Promise<void>): Promise<void> {
  const { default: entry } = await loadBundledPluginFacade<{ default: Parameters<typeof registerSingleProviderPlugin>[0] }>({ pluginId: "litellm", artifactBasename: "index.js" });
  const provider = await registerSingleProviderPlugin(entry); expect(provider.catalog?.run).toBeTypeOf("function");
  await withOpenClawTestState({ label: "litellm-worker" }, async state => {
    const discover = async (row: Row, signal?: AbortSignal, authId = row.id, capture?: (result: unknown) => void) => {
      const baseUrl = origin + "/v1/native/litellm" + (row.versioned ? "/v1" : ""); let resolutions = 0;
      const auth = { apiKey: key(authId), discoveryApiKey: key(row.id), profileId: row.id, mode: "api_key" as const, source: "profile" as const };
      diagnosticId = row.id; diagnosticRole = "catalog";
      const result = await ownership.invoke({ id: row.id, role: "catalog", api: "catalog", signal, url: litellmCatalogTarget(baseUrl), credential: "Bearer " + key(row.id) }, provider.catalog!.run, provider.catalog, [{ config: { models: { providers: { litellm: { baseUrl, models: [] } } } }, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir, signal,
        resolveProviderAuth: () => { throw new Error("unexpected second auth resolver"); }, resolveProviderApiKey: () => { resolutions++; return auth; } }]);
      expect(resolutions).toBe(1); capture?.(result);
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
  return ownership.invoke({ id: row.id, role: "chat", api: simple ? "streamSimple" : "stream", control: row.control ?? "product", signal, url: catalog.baseUrl + "/chat/completions", credential: "Bearer " + key(row.id) }, simple ? streamSimple : stream, undefined,
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
  // These independently authored stream roles collect evidence only. A body
  // result never qualifies rejected originals or changes the strict afterEach.
  for (const id of ["sdk_stream_eof", "sdk_stream_preabort", "sdk_stream_partial_abort", "sdk_stream_provider_error"]) it(id, async () => {
    const row = rows.find(value => value.id === id)!;
    await fixture(async discover => {
      const catalog = await discover(row); expect(catalog).toBeDefined();
      const controller = new AbortController(); if (id === "sdk_stream_preabort") controller.abort();
      const events = await infer(catalog!, row, controller.signal, false);
      let partial = false;
      for await (const event of events) if (id === "sdk_stream_partial_abort" && event.type === "text_delta") { partial = true; controller.abort(); break; }
      const result = await events.result();
      if (id === "sdk_stream_eof") expect(result.stopReason).toBe("stop");
      else if (id === "sdk_stream_provider_error") { expect(controller.signal.aborted).toBe(false); expect(result.stopReason).toBe("error"); }
      else { expect(controller.signal.aborted).toBe(true); expect(result.stopReason).toBe(id === "sdk_stream_preabort" ? "error" : "aborted"); }
      if (id === "sdk_stream_partial_abort") expect(partial).toBe(true);
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
      const started = Date.now();
      await litellmCatalogStage("warm_a", async () => { expect((await discover(a))?.models.map(model => model.id)).toEqual([selected]); }, reportSdk);
      await litellmCatalogStage("warm_b", async () => { expect((await discover(b))?.models).toEqual([]); }, reportSdk);
      await litellmCatalogStage("warm_cached", async () => { expect((await discover(a))?.models.map(model => model.id)).toEqual([selected]); }, reportSdk);
      await litellmCatalogStage("warm_versioned", async () => { expect((await discover({ ...a, versioned: true }))?.models.map(model => model.id)).toEqual([selected]); }, reportSdk);
      // D8 retains successful strict rows for 60s. No refresh or clear occurs here.
      await litellmCatalogStage("warm_window", async () => { const elapsed = Date.now() - started; expect(elapsed).toBeGreaterThanOrEqual(0); expect(elapsed).toBeLessThan(60_000); }, reportSdk);
      await litellmCatalogStage("warm_count", async () => { expect(requests).toHaveLength(2); expect(requests[0].credential).not.toBe(requests[1].credential); }, reportSdk);
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
      let result: Awaited<typeof outcome> | undefined;
      await litellmHeldSequence(() => control("started", row.id), () => control(action, row.id), () => control("release", row.id), [async () => {
        result = await outcome; if ("error" in result) throw result.error;
      }], reportSdk, "held");
      await litellmCatalogStage("held_result", async () => {
        if (!result || "error" in result) throw new Error("missing held discovery result");
        if (action === "revoke") expect(result.value).toBeUndefined();
        else expect(result.value?.models.map(model => model.id)).toEqual(action === "narrow" ? [] : [selected]);
        expect(requests).toHaveLength(1);
      }, reportSdk);
    });
  }, 120_000);
  it("consumer abort rejects only its waiter while the same original acquisition completes for its survivor", async () => {
    await fixture(async discover => {
      const row = rows.find(value => value.id === "sdk_waiter_abort")!, controller = new AbortController();
      let publicResult: unknown;
      const first = discover(row, controller.signal, row.id, result => { publicResult = result; }), observed = first.then(value => ({ value }), error => ({ error }));
      const survivor = discover(row); const retained = survivor.then(value => ({ value }), error => ({ error }));
      let authoredAbort = false, result: Awaited<typeof retained> | undefined;
      await litellmHeldSequence(() => control("started", row.id), async () => {
        authoredAbort = true; controller.abort(); const completed = await observed;
        if ("error" in completed) throw completed.error;
        expect(publicResult).toEqual({ providers: {}, outcomes: [{ provider: "litellm", profileId: row.id, status: "unavailable" }] });
        expect(completed.value).toBeUndefined(); expect(requests).toHaveLength(1); expect(requests[0].method).toBe("GET");
      }, () => control("release", row.id), [async () => {
        const value = await observed; if ("error" in value) throw value.error;
      }, async () => { result = await retained; if ("error" in result) throw result.error; }], reportSdk, "waiter");
      await litellmCatalogStage("waiter_result", async () => {
        if (!result || "error" in result) throw new Error("missing surviving discovery result");
        expect(result.value?.models.map(model => model.id)).toEqual([selected]); expect(requests).toHaveLength(1);
      }, reportSdk);
    });
  }, 120_000);
});

}
