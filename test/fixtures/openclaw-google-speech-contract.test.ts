// Installed into the exact public SDK revision only by the native CI helper.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { types as nodeTypes } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as guardedFetch from "../../infra/net/fetch-guard.js";
import type { DispatcherAwareRequestInit } from "../../infra/net/runtime-fetch.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import fs from "node:fs/promises";
import { synthesizeSpeech } from "openclaw/plugin-sdk/tts-runtime";
import { getSpeechProvider } from "../../tts/provider-registry.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { invokeTalkSpeakDirect } from "../../gateway/talk/test-helpers.js";
import { createTtsTool } from "./tts-tool.js";

// BEGIN google diagnostic protocol. Executed unchanged by the outer validator.
function googleDiagnosticProtocol(isProxy: (value: unknown) => boolean) {
  type Data = Record<string, string | number | boolean | null>;
  const pin = "ff34cf8e236ca698c7190c63087f2ecd37f94a7e", prefix = "GOOGLE1102_SDK_V1 ";
  const ids = new Set(["model0", "model1", "model2", "model3", "model4", "talk", "unknown", "key_a", "key_b", "later", "truncated", "non200", "redirect", "encoding", "abort_headers", "abort_body", "deadline", "grant", "foreign", "policy", "revoked", "stale_policy", "budget", "key", "voice", "alias", "cutoff0", "cutoff1", "cutoff2"]);
  const phases = ["module", "setup", "body", "acquisition", "acquisition_observer", "original_join", "worker_join", "state_scope", "runtime_restore", "case_outcome", "compile", "barrier", "temporary", "worker_start", "initialize", "helper", "upstream", "worker_retirement", "accounting", "barrier_close", "worker_dispose", "scratch_cleanup", "report", "capacity"];
  const counts = ["records", "invalid", "suppressed", "reads", "readRejected", "cancels", "cancelRejected", "readers", "unlocks", "externalCloses", "closeRejected", "activeReads", "events", "spentMicros", "exitCode"];
  const flags = ["callerAborted", "effectiveAborted", "releaseReturned", "guardObserved", "destroyed", "unlocked", "retired", "killed"];
  const keys = ["v", "pin", "source", "caseId", "route", "phase", "role", "outcome", "failurePresent", "reasonDefined", "reasonType", "partialDelivery", "closed", "signal", "moduleCode", ...counts, ...flags];
  function own(value: unknown, key: string): unknown {
    if (!value || typeof value !== "object" || isProxy(value)) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
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
      || !(ids.has(data.caseId as string) || data.caseId === null)
      || !["catalog", "native", "manifest", "none"].includes(data.route as string)
      || !phases.includes(data.phase as string) || !["progress", "primary", "cleanup", "summary"].includes(data.role as string)
      || !["entered", "fulfilled", "rejected", "unknown"].includes(data.outcome as string)
      || typeof data.failurePresent !== "boolean" || data.partialDelivery !== null) return;
    if (data.failurePresent) {
      if (!["undefined", "null", "boolean", "number", "bigint", "string", "symbol", "object", "function"].includes(data.reasonType as string)
        || data.reasonDefined !== (data.reasonType !== "undefined") || data.outcome !== "rejected") return;
    } else if (data.reasonDefined !== null || data.reasonType !== "none" || data.outcome === "rejected") return;
    for (const key of counts) if (Object.hasOwn(data, key) && data[key] !== null
      && !(Number.isSafeInteger(data[key]) && Number(data[key]) >= 0 && Number(data[key]) <= 65535)) return;
    for (const key of flags) if (Object.hasOwn(data, key) && data[key] !== null && typeof data[key] !== "boolean") return;
    if (Object.hasOwn(data, "closed") && data.closed !== null) return; // No original reader.closed observation exists here.
    if (Object.hasOwn(data, "signal") && ![null, "SIGTERM", "SIGKILL", "SIGABRT", "SIGINT"].includes(data.signal as null | string)) return;
    if (Object.hasOwn(data, "moduleCode") && ![null, "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_UNKNOWN_FILE_EXTENSION"].includes(data.moduleCode as null | string)) return;
    if (new TextEncoder().encode(JSON.stringify(data)).length > 640) return;
    return data;
  }
  function record(context: Data, failed = false, error?: unknown): Data {
    const value = validate({ v: 1, pin, ...context, failurePresent: failed, reasonDefined: failed ? error !== undefined : null,
      reasonType: failed ? error === null ? "null" : typeof error : "none", partialDelivery: null });
    if (!value) throw new Error("invalid google diagnostic");
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
  const keyFor = (row: Data) => [row.source, row.route, row.caseId, row.phase, row.role].join("/");
  const priority = (row: Data) => row.phase === "helper" ? 0 : row.source === "sdk" && row.role === "primary" ? 1
    : row.role === "cleanup" && row.failurePresent ? 2 : row.phase === "original_join" ? 3
    : row.phase === "worker_retirement" ? 4 : row.phase === "upstream" ? 5 : row.phase === "accounting" ? 6
    : ["barrier_close", "worker_dispose", "scratch_cleanup"].includes(row.phase as string) ? 7 : row.phase === "report" ? 8 : 9;
  function emitter(write: (line: string) => unknown) {
    const records = new Map<string, Data>(), essential = new Map<string, Data>(), emitted = new Set<string>();
    let suppressed = 0, failed = false, finished = false, bytes = 0;
    const suppress = () => { suppressed = Math.min(65535, suppressed + 1); };
    function command(row: Data) {
      const line = "::error title=Google contract diagnostic::" + JSON.stringify(row).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A") + "\n";
      const size = new TextEncoder().encode(line).length;
      if (size > 768 || bytes + size > 8192) throw new Error("google annotation budget");
      bytes += size; emitted.add(keyFor(row)); write(line);
    }
    function put(value: unknown) {
      const row = validate(value); if (!row) throw new Error("invalid google annotation");
      failed ||= row.failurePresent === true && row.role !== "progress";
      const groups = [row.phase === "helper" ? "helper" : null,
        row.source === "sdk" && row.role === "primary" ? "sdk_primary" : null,
        row.source === "outer" && row.role === "primary" ? "outer_primary" : null,
        row.role === "cleanup" && row.failurePresent ? "cleanup" : null,
        ["original_join", "worker_retirement", "upstream", "accounting", "report"].includes(row.phase as string) ? row.phase : null,
        ["barrier_close", "worker_dispose", "scratch_cleanup"].includes(row.phase as string) ? "final_cleanup" : null];
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
      const early = [essential.get("helper"), essential.get("sdk_primary") ?? essential.get("outer_primary"), essential.get("cleanup")];
      const failures: unknown[] = [];
      for (const row of early) if (row && !emitted.has(keyFor(row))) {
        try { command(row); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Google early diagnostic delivery failed");
    }, flush() {
      if (finished) return; finished = true; if (!failed) return;
      const sorted = [...records.values()].sort((a, b) => priority(a) - priority(b)), selected: Data[] = [];
      // Reserve a representative for each essential failure/retirement family.
      const selectedKeys = new Set(emitted);
      for (const row of [...[...essential.values()].sort((a, b) => priority(a) - priority(b)), ...sorted]) if (!selectedKeys.has(keyFor(row))) {
        if (selectedKeys.size < 9) { selected.push(row); selectedKeys.add(keyFor(row)); } else suppress();
      }
      if (suppressed) selected.push(record({ source: "outer", caseId: null, route: "none", phase: "capacity", role: "summary", outcome: "unknown", suppressed }));
      const failures: unknown[] = [];
      for (const row of selected) {
        try { command(row); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "google annotation delivery failed");
    } };
  }
  return { prefix, pin, ids, own, validate, record, parse, emitter };
}
// END google diagnostic protocol.
const googleProtocol = googleDiagnosticProtocol(nodeTypes.isProxy);
let diagnosticCase: string | null = null;
let diagnosticCaller: AbortSignal | undefined;
const diagnosticFailures: unknown[] = [];
let diagnosticRecords = 0;
function mark(phase: string, role: string, outcome: string, failed = false, error?: unknown,
  fields: Record<string, string | number | boolean | null> = {}, caseId = diagnosticCase, route = "none") {
  try {
    if (++diagnosticRecords > 512) throw new Error("Google child diagnostic capacity");
    const row = googleProtocol.record({ source: "sdk", caseId, route, phase, role, outcome, ...fields }, failed, error);
    process.stdout.write("\n" + googleProtocol.prefix + JSON.stringify(row) + "\n");
  } catch (failure) { diagnosticFailures.push(failure); }
}
function reportIdentity(row: Observation) {
  const caseId = [...googleProtocol.ids].find(id => row.credential === `Bearer ${key(id)}`) ?? null;
  return { caseId, route: row.path === "/v1/catalog" ? "catalog" : row.path.startsWith("/v1/native/") ? "native" : "manifest" };
}
mark("module", "progress", "entered");

const expectedHead = "ff34cf8e236ca698c7190c63087f2ecd37f94a7e";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const control = process.env.CLAWROUTER_CONTRACT_CONTROL!;
const models = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
const speechPath = (path: string) => path === "/v1/proxy/google-gemini/speech_interactions" || /^\/v1\/native\/google-gemini\/v1beta\/models\/gemini-[a-z0-9.-]+:generateContent$/.test(path);
const text = "Synthetic speech 😀 café";
const wav = "524946462c00000057415645666d74201000000001000100c05d000080bb00000200100064617461080000000000ff7f0000ff7f";
const nativeFetch = globalThis.fetch;
// Same installed CommonJS module used by loadUndiciModule in both SDK graphs.
const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
const originalRuntimeFetch = undici.fetch;
const originalGuard = guardedFetch.fetchWithSsrFGuard;
const key = (name: string) => `clawrouter-live-gs_${name}-fixture-secret`;
type Observation = {
  path: string;
  credential: string;
  releaseReturned: boolean;
  failedBeforeResponse: boolean;
  deadlineAt?: number;
  signal?: AbortSignal | null;
  dispatcher?: DispatcherAwareRequestInit["dispatcher"];
  closeCalls: Array<{ depth: number; args: unknown[]; outcome?: { value: unknown } | { error: unknown } }>;
  guardObserved: boolean;
  bodies: ReadableStream<Uint8Array>[];
  cancels: Array<Promise<unknown>>;
  reads: Array<Promise<unknown>>;
  readers: Array<{ reader: ReadableStreamDefaultReader<Uint8Array>; unlock: ReturnType<typeof vi.spyOn> }>;
  closeStarted: Promise<void>;
};
const observations: Observation[] = [];
const unexpected: string[] = [];
function refuse(reason: string): never { unexpected.push(reason); throw new Error(reason); }

async function command(path: string, method = "GET", base = origin, signal?: AbortSignal) {
  const response = await nativeFetch(base + path, { method, signal });
  const body = await response.text();
  expect(response.status, path).toBe(200);
  return body;
}

beforeEach(() => {
  diagnosticCase = null; diagnosticCaller = undefined;
  mark("setup", "progress", "entered");
  try {
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(expectedHead);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(expectedHead);
  // Fake Date alone: actual timers, signals, I/O and cleanup remain native.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
  observations.length = 0;
  unexpected.length = 0;
  // A plain pass-through keeps the real guard's DNS/dispatcher route. A Vitest
  // fetch spy would select its deliberate no-dispatcher unit-test bypass.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(new Request(input, init).url).origin !== origin) refuse("unexpected client egress");
    return nativeFetch(input, init);
  });
  // The supported runtime-dependency hook is shared by native plugin and Vitest
  // module graphs. All constructors remain original; only real fetch is observed.
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: observeRequest });
  const observeGuard: typeof originalGuard = async options => {
    const deadlineAt = options.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs;
    const result = await originalGuard(options);
    const row = observations.find(actual => actual.path === new URL(String(options.url)).pathname
      && actual.credential === new Headers(options.init?.headers).get("authorization"));
    if (!row) throw new Error("missing original guard request");
    row.guardObserved = true;
    row.deadlineAt = deadlineAt;
    observeBody(result.response.body, row);
    return { ...result, release: async () => {
      await result.release();
      if (!row) throw new Error("missing original guard request");
      row.releaseReturned = true;
    } };
  };
  // Registered speech uses its genuine host context. Neither path fabricates
  // a catalog/response or calls an adapter in place of the registered provider.
  vi.spyOn(guardedFetch, "fetchWithSsrFGuard").mockImplementation(observeGuard);
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(observeGuard);
  mark("setup", "progress", "fulfilled");
  } catch (error) { mark("setup", "primary", "rejected", true, error); throw error; }
});

async function observeRequest(input: RequestInfo | URL, supplied?: RequestInit) {
  const init = supplied as DispatcherAwareRequestInit | undefined;
  const request = new Request(input, supplied), url = new URL(request.url);
  if (url.origin !== origin || (url.pathname !== "/v1/catalog" && !speechPath(url.pathname)) || url.search) refuse("unexpected speech route");
  if (request.headers.has("x-api-key") || request.headers.has("x-goog-api-key")) refuse("client forwarded a vendor credential override");
  const credential = request.headers.get("authorization") ?? "";
  if (observations.some(row => row.path === url.pathname && row.credential === credential)) refuse("repeated speech route");
  const dispatcher = init?.dispatcher;
  if (!dispatcher) refuse("missing original request dispatcher");
  let closeStarted!: () => void;
  const row: Observation = { path: url.pathname, credential, releaseReturned: false, failedBeforeResponse: false,
    dispatcher, signal: init?.signal, guardObserved: false, closeCalls: [], bodies: [], cancels: [], reads: [], readers: [],
    closeStarted: new Promise(resolve => { closeStarted = resolve; }) };
  observations.push(row);
  const originalClose = dispatcher.close;
  let depth = 0;
  vi.spyOn(dispatcher, "close").mockImplementation(function (this: typeof dispatcher, ...args: unknown[]) {
    const call: Observation["closeCalls"][number] = { depth, args };
    row.closeCalls.push(call); depth++;
    try { const value = Reflect.apply(originalClose, this, args); call.outcome = { value }; return value; }
    catch (error) { call.outcome = { error }; throw error; }
    finally { depth--; if (call.depth === 0) closeStarted(); }
  } as typeof dispatcher.close);
  const identity = reportIdentity(row);
  mark("acquisition", "progress", "entered", false, undefined, {}, identity.caseId, identity.route);
  let response: Response;
  try {
    // Preserve the genuine guard's dispatcher and composed signal through
    // the original installed Undici fetch, not Node's dispatcher-unaware fetch.
    response = await Reflect.apply(originalRuntimeFetch, undici, [input, init]) as unknown as Response;
  } catch (error) { row.failedBeforeResponse = true; mark("acquisition", "progress", "rejected", true, error, { effectiveAborted: row.signal?.aborted ?? null }, identity.caseId, identity.route); throw error; }
  mark("acquisition", "progress", "fulfilled", false, undefined, {}, identity.caseId, identity.route);
  if (url.pathname === "/v1/catalog" && response.ok) {
    // Inspect the actual response, then return that same response to the guard.
    // The clone is fully consumed before the caller reads the original branch.
    try {
      const catalog = await response.clone().json();
      const provider = catalog.providers.find((value: { id: string }) => value.id === "google-gemini");
      expect(catalog.providers.some((value: { id: string }) => value.id === "google")).toBe(false);
      const offers = provider?.offers.filter((value: { endpoint: string }) => value.endpoint.startsWith("speech_")) ?? [];
      for (const offer of offers) {
        expect(offer.routeKind).toBe(offer.endpoint === "speech_generate_content" ? "native" : "manifest");
        expect(offer.modelId).toMatch(/^google\/gemini-/);
      }
      if (!/gs_(grant|foreign|policy|budget|key)-/.test(credential)) {
        expect(catalog.scope).toMatchObject({ authType: "proxy_key", credentialId: credential.split("-")[2] });
        expect(offers.filter((value: { eligible: boolean }) => value.eligible)).toHaveLength(5);
      }
      if (credential === `Bearer ${key("revoked")}`) await command("/__google/revoke/gs_revoked", "POST");
      if (credential === `Bearer ${key("stale_policy")}`) await command("/__google/restrict/gs_stale_policy", "POST");
    } catch (error) {
      mark("acquisition_observer", "progress", "rejected", true, error, {}, identity.caseId, identity.route);
      // The original guard will close its dispatcher on this rejection. Start
      // cancellation now, but join only after close to avoid a tee deadlock.
      try {
        const original = response.body?.cancel();
        if (original) { row.cancels.push(original); void Promise.allSettled([original]); }
      } catch (cleanup) { throw new AggregateError([error, cleanup], "catalog observation and cancellation failed"); }
      throw error;
    }
  }
  observeBody(response.body, row);
  return response;
}

function observeBody(body: ReadableStream<Uint8Array> | null, row: Observation) {
  if (body && !row.bodies.includes(body)) {
    row.bodies.push(body);
    const cancel = body.cancel.bind(body);
    const getReader = body.getReader.bind(body) as () => ReadableStreamDefaultReader<Uint8Array>;
    vi.spyOn(body, "cancel").mockImplementation(reason => {
      const actual = cancel(reason); row.cancels.push(actual); return actual;
    });
    vi.spyOn(body, "getReader").mockImplementation(options => {
      expect(options).toBeUndefined();
      const reader = getReader();
      row.readers.push({ reader, unlock: vi.spyOn(reader, "releaseLock") });
      const read = reader.read.bind(reader);
      vi.spyOn(reader, "read").mockImplementation(() => { const actual = read(); row.reads.push(actual); return actual; });
      const cancelReader = reader.cancel.bind(reader);
      vi.spyOn(reader, "cancel").mockImplementation(reason => {
        const actual = cancelReader(reason); row.cancels.push(actual); return actual;
      });
      return reader;
    });
  }
}

afterEach(() => {
  mark("runtime_restore", "progress", "entered");
  try { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); expect(unexpected).toEqual([]); }
  catch (error) { mark("runtime_restore", "cleanup", "rejected", true, error); throw error; }
  mark("runtime_restore", "progress", "fulfilled");
  // Diagnostics never substitute for the original test failure or restoration.
  if (diagnosticFailures.length) throw new AggregateError(diagnosticFailures, "Google diagnostic delivery failed");
});

async function join(name: string) {
  mark("original_join", "progress", "entered", false, undefined, { closed: null }, name);
  try {
  const selected = observations.filter(row => row.credential.startsWith(`Bearer clawrouter-live-gs_${name}-`));
  const transport = selected.map(async row => {
    await row.closeStarted;
    const external = row.closeCalls.filter(call => call.depth === 0);
    // Joining the actual promise precedes every retirement assertion. Undici's
    // promise overload calls this.close(callback) internally; that is not a
    // second external release. Do not count entry as physical completion.
    const closes = await Promise.allSettled(external.flatMap(call =>
      call.outcome && "value" in call.outcome && call.outcome.value instanceof Promise ? [call.outcome.value] : []));
    const [reads, cancellations] = await Promise.all([
      Promise.allSettled(row.reads), Promise.allSettled(row.cancels),
    ]);
    const identity = reportIdentity(row);
    mark("original_join", "progress", "fulfilled", false, undefined, {
      reads: reads.length, readRejected: reads.filter(value => value.status === "rejected").length,
      cancels: cancellations.length, cancelRejected: cancellations.filter(value => value.status === "rejected").length,
      readers: row.readers.length, unlocks: row.readers.reduce((n, entry) => n + entry.unlock.mock.calls.length, 0),
      externalCloses: external.length, closeRejected: closes.filter(value => value.status === "rejected").length,
      releaseReturned: row.releaseReturned, guardObserved: row.guardObserved, destroyed: row.dispatcher!.destroyed,
      effectiveAborted: row.signal?.aborted ?? null, closed: null,
    }, identity.caseId, identity.route);
    expect(external).toHaveLength(1);
    expect(external[0]!.args).toEqual([]);
    expect(external[0]!.outcome).toHaveProperty("value");
    expect(closes).toEqual([{ status: "fulfilled", value: null }]);
    expect(row.closeCalls.map(call => [call.depth, call.args.length])).toEqual([[0, 0], [1, 1]]);
    expect(typeof row.closeCalls[1]!.args[0]).toBe("function");
    expect(row.dispatcher!.destroyed).toBe(true);
    expect(reads).toHaveLength(row.reads.length);
    expect(cancellations.every(value => value.status === "fulfilled")).toBe(true);
    if (row.failedBeforeResponse) expect(["abort_headers", "abort_body", "deadline"]).toContain(name);
    else {
      if (row.guardObserved) expect(row.releaseReturned).toBe(true);
      for (const entry of row.readers) expect(entry.unlock).toHaveBeenCalledOnce();
      for (const body of row.bodies) expect(body.locked).toBe(false);
    }
  });
  // Attempt every original transport and the Worker join before any one
  // observation failure can prevent another owned resource's cleanup.
  const results = await Promise.allSettled([...transport, command(`/__google/join/gs_${name}`)]);
  const failures = results.filter((value): value is PromiseRejectedResult => value.status === "rejected").map(value => value.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "speech transport or Worker join failed");
  const worker = results.at(-1);
  if (worker?.status !== "fulfilled" || typeof worker.value !== "string") throw new Error("missing Worker join result");
  const state = JSON.parse(worker.value);
  mark("worker_join", "progress", "fulfilled", false, undefined, { retired: typeof state.retired === "boolean" ? state.retired : null }, name);
  expect(selected.map(row => row.path)).toEqual(state.paths);
  expect(state).toMatchObject({ retired: true, charged: 0 });
  if (state.hasBody) {
    expect(state).toMatchObject({ calls: 1, activeReads: 0, unlocked: true, sourceLocked: false, physicalLocked: false });
    expect(state.eof || state.canceled || state.readRejected).toBe(true);
    expect(state.readResults).toHaveLength(state.readCalls);
    expect(state.readResults.every((status: string) => status === "fulfilled" || status === "rejected")).toBe(true);
    expect(state.readResults.includes("rejected")).toBe(state.readRejected);
    expect(state.cancelCalls).toBe(state.canceled ? 1 : 0);
    expect(state.cancelResults).toHaveLength(state.cancelCalls);
    expect(state.cancelResults.every((status: string) => status === "fulfilled")).toBe(true);
  }
  return state;
  } catch (error) { mark("original_join", "cleanup", "rejected", true, error, { closed: null }, name); throw error; }
}

async function fixture(name: string, run: (cfg: OpenClawConfig, prefsPath: string) => Promise<void>, model = models[3]!) {
  diagnosticCase = name;
  mark("state_scope", "progress", "entered");
  try {
  await withOpenClawTestState({ label: "clawrouter-google-speech-worker", env: {
    OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../../extensions", import.meta.url)),
    CLAWROUTER_API_KEY: undefined, GOOGLE_API_KEY: "must-not-fallback", GEMINI_API_KEY: "must-not-fallback",
    HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined,
    http_proxy: undefined, https_proxy: undefined, all_proxy: undefined,
  } }, async state => {
    const cfg: OpenClawConfig = {
      plugins: { allow: ["clawrouter", "openai"], entries: { clawrouter: { enabled: true }, openai: { enabled: true } } },
      models: { providers: {
        clawrouter: { baseUrl: origin + "/v1", apiKey: name === "key" ? "clawrouter-live-gs_key-invalid" : key(name), models: [],
          request: { allowPrivateNetwork: true }, headers: { "x-goog-api-key": "must-not-fallback", "x-api-key": "must-not-fallback" } },
        openai: { baseUrl: "https://alternate.example/v1", apiKey: "must-not-fallback", models: [] },
      } },
      agents: { defaults: { voiceModel: { primary: `clawrouter/google/${model}`, fallbacks: ["openai/tts-1"] } } },
      tts: { provider: "clawrouter", providers: { clawrouter: { upstreamProvider: "google", model: `google/${model}`, voice: "Kore" } } },
      talk: { provider: "clawrouter", providers: { clawrouter: { upstreamProvider: "google", modelId: `google/${model}`, speakerVoiceId: "Kore" } } },
    };
    const failures: unknown[] = [];
    mark("body", "progress", "entered");
    try { await run(cfg, state.home + "/tts-prefs.json"); mark("body", "progress", "fulfilled", false, undefined, { callerAborted: diagnosticCaller?.aborted ?? null }); } catch (error) { failures.push(error); mark("body", "primary", "rejected", true, error, { callerAborted: diagnosticCaller?.aborted ?? null }); }
    try { await join(name); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "speech assertion or original cleanup failed");
  });
  mark("case_outcome", "progress", "fulfilled");
  } catch (error) { mark("state_scope", "primary", "rejected", true, error); throw error; }
}

function direct(cfg: OpenClawConfig, signal?: AbortSignal, timeoutMs = 30_000) {
  diagnosticCaller = signal; // Only an actual direct caller signal; tool-owned signals stay unknown.
  const provider = getSpeechProvider("clawrouter", cfg);
  if (!provider) throw new Error("missing genuine registered speech provider");
  return provider.synthesize({ cfg, providerConfig: cfg.tts!.providers!.clawrouter!, text, target: "audio-file", signal, timeoutMs });
}

describe("published canonical Google speech with real Worker/SQLite", () => {
  it.each(models.map((model, i) => [model, `model${i}`] as const))("registered TTS tool returns complete WAV for %s", async (model, name) => {
    await fixture(name, async cfg => {
      const result = await createTtsTool({ config: cfg }).execute("google-worker", { text });
      const details = result.details as { provider: string; audioPath: string; media: { audioAsVoice?: boolean } };
      expect(details.provider).toBe("clawrouter"); expect(details.audioPath).toMatch(/\.wav$/);
      expect(details.media.audioAsVoice).not.toBe(true);
      expect((await fs.readFile(details.audioPath)).toString("hex")).toBe(wav);
      expect(observations.map(row => row.path)).toEqual(["/v1/catalog", model.startsWith("gemini-3.8-") ? "/v1/proxy/google-gemini/speech_interactions" : `/v1/native/google-gemini/v1beta/models/${model}:generateContent`]);
    }, model);
  }, 120_000);

  it("actual Talk handler returns WAV without claiming remote macOS stop", async () => {
    await fixture("talk", async cfg => {
      setRuntimeConfigSnapshot(cfg, cfg);
      try {
        const result = await invokeTalkSpeakDirect({ text });
        expect(result).toMatchObject({ ok: true, payload: { provider: "clawrouter", mimeType: "audio/wav", outputFormat: "wav", audioBase64: Buffer.from(wav, "hex").toString("base64") } });
      } finally { clearRuntimeConfigSnapshot(); }
    });
  }, 120_000);

  it("synthesizeSpeech preserves unknown pricing without inventing a free tariff", async () => {
    await fixture("unknown", async (cfg, prefsPath) => {
      const result = await synthesizeSpeech({ cfg, prefsPath, text, disableFallback: true });
      expect(result, result.error).toMatchObject({ success: true, outputFormat: "wav", audioBuffer: Buffer.from(wav, "hex") });
    });
  }, 120_000);

  it("reuses the same config with a new proxy key without borrowing the earlier grant", async () => {
    await fixture("key_a", async cfg => {
      expect((await direct(cfg)).audioBuffer.toString("hex")).toBe(wav);
      cfg.models!.providers!.clawrouter!.apiKey = key("key_b");
      try { expect((await direct(cfg)).audioBuffer.toString("hex")).toBe(wav); }
      finally { await join("key_b"); }
      expect(observations.map(row => row.credential)).toEqual([`Bearer ${key("key_a")}`, `Bearer ${key("key_a")}`, `Bearer ${key("key_b")}`, `Bearer ${key("key_b")}`]);
    });
  }, 120_000);

  it.each(["grant", "foreign", "policy", "revoked", "stale_policy", "budget", "key"])("%s refuses before paid upstream egress", async name => {
    await fixture(name, async cfg => { await expect(direct(cfg)).rejects.toThrow(); expect((await join(name)).calls).toBe(0); });
  }, 120_000);

  it.each(["voice", "alias"])("%s rejects invalid config before catalog", async name => {
    await fixture(name, async cfg => {
      cfg.tts!.providers!.clawrouter![name === "voice" ? "voice" : "voiceName"] = name === "voice" ? "" : "Puck";
      await expect(direct(cfg)).rejects.toThrow(); expect(observations).toHaveLength(0);
    });
  });

  it.each(models.slice(0, 3).map((model, i) => [model, `cutoff${i}`] as const))("%s denies at the exact qualification cutoff before discovery", async (model, name) => {
    await fixture(name, async cfg => {
      vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
      await expect(direct(cfg)).rejects.toThrow(/qualification expired/);
      expect(observations).toHaveLength(0);
    }, model);
  });

  it.each(["later", "truncated", "non200", "redirect", "encoding"])("%s does not return partial audio or buy another provider", async name => {
    await fixture(name, async (cfg, prefsPath) => {
      const result = await synthesizeSpeech({ cfg, prefsPath, text });
      expect(result.success).toBe(false); expect(result.audioBuffer).toBeUndefined();
      expect(observations.map(row => row.path)).toEqual(["/v1/catalog", "/v1/proxy/google-gemini/speech_interactions"]);
    });
  }, 120_000);

  it.each(["abort_headers", "abort_body", "deadline"])("%s joins actual original transport before teardown", async name => {
    await fixture(name, async cfg => {
      const controller = new AbortController(), reason = new Error("synthetic caller cancellation");
      const result = direct(cfg, controller.signal, name === "deadline" ? 2000 : 30_000).then(value => ({ value }), error => ({ error }));
      await command(`/${name}/seen`, "GET", control, AbortSignal.timeout(30_000));
      if (name !== "deadline") controller.abort(reason);
      const settled = await result;
      expect(settled).toHaveProperty("error");
      const post = observations.find(row => speechPath(row.path));
      expect(post?.signal?.aborted).toBe(true);
      if (name === "deadline") { expect(controller.signal.aborted).toBe(false); expect(post?.signal?.reason?.name).toBe("TimeoutError"); }
      else { expect(controller.signal.reason).toBe(reason); expect(post?.signal?.reason).toBe(reason); }
      await command(`/${name}/closed`, "GET", control, AbortSignal.timeout(30_000));
      // join() also observes the SDK's original cancel promises; this does not
      // claim that synthesizeSpeech itself awaits fire-and-forget cancellation.
    });
  }, 120_000);
});
