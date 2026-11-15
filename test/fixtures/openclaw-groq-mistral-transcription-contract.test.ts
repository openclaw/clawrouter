import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { types as nodeTypes } from "node:util";
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
  const phases = ["module", "setup", "execute", "body", "original_join", "worker_join", "state_scope", "runtime_restore", "case_outcome", "helper", "worker_abort", "worker_retirement", "upstream_sqlite", "worker_dispose", "scratch_cleanup", "report", "capacity"];
  const keys = ["v", "pin", "source", "caseId", "phase", "role", "outcome", "failurePresent", "reasonDefined", "reasonType", "partialDelivery", "records", "invalid", "suppressed"];
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
      || !(ids.has(data.caseId as string) || data.caseId === null && (data.source === "outer" || data.phase === "module"))
      || !phases.includes(data.phase as string) || !["progress", "primary", "cleanup", "summary"].includes(data.role as string)
      || !["entered", "fulfilled", "rejected", "unknown"].includes(data.outcome as string)
      || typeof data.failurePresent !== "boolean" || data.partialDelivery !== null) return;
    if (data.failurePresent) {
      if (!["undefined", "null", "boolean", "number", "bigint", "string", "symbol", "object", "function"].includes(data.reasonType as string)
        || data.reasonDefined !== (data.reasonType !== "undefined") || data.outcome !== "rejected") return;
    } else if (data.reasonDefined !== null || data.reasonType !== "none" || data.outcome === "rejected") return;
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
        row.source === "outer" && row.role === "primary" ? "outer_primary" : null, row.role === "cleanup" && row.failurePresent ? "cleanup" : null];
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
  return { prefix, pin, ids, own, validate, record, parse, emitter };
}
// END audio diagnostic protocol.
const audioProtocol = audioDiagnosticProtocol(nodeTypes.isProxy);
let audioRecordCount = 0;
function audioCaseDiagnostics(caseId: string) {
  const failures: unknown[] = [], observers: Promise<unknown>[] = [];
  function mark(phase: string, role: string, outcome: string, failed = false, error?: unknown) {
    try {
      if (++audioRecordCount > 512) throw new Error("audio child diagnostic capacity");
      const value = audioProtocol.record({ source: "sdk", caseId, phase, role, outcome }, failed, error);
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
  diagnostic.mark("setup", "progress", "entered");
  const failures: unknown[] = [], transports: Transport[] = [], unexpected: unknown[] = [];
  let callbackFailure: { error: unknown } | undefined;
  try {
    await withOpenClawTestState({ prefix: "openclaw-native-transcription-", env: { CLAWROUTER_API_KEY: undefined, GROQ_API_KEY: "must-not-fallback", MISTRAL_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" } }, async state => {
      const bodyFailures: unknown[] = [];
      let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;
      const caller = new AbortController(), callerReason = new Error("original transcription caller abort");
      try {
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
          models: { providers: { clawrouter: { baseUrl: origin + "/v1", apiKey: token(row), request: { allowPrivateNetwork: true }, models: [] } } },
          tools: { media: { models: [{ provider: "clawrouter", model: row.model, capabilities: ["audio"] }], audio: { enabled: true } } } };
        const agentDir = state.agentDir();
        const provider = cfg.models!.providers!.clawrouter!, model = cfg.tools!.media!.models![0]!;
        const params = { cfg, filePath, agentDir, mime: "audio/wav", language: "en", ...(row.provider === "groq" ? { prompt: "Synthetic café 東京" } : {}) };
        const call = () => transcribeAudioFile(params, { signal: caller.signal, assertCurrent: () => caller.signal.throwIfAborted() });
        diagnostic.mark("execute", "progress", "entered");
        if (row.scenario === "success") {
          await upsertAuthProfileAsync({ agentDir, profileId: "clawrouter:audio", credential: { type: "api_key", provider: "clawrouter", key: token(row) } });
          await upsertAuthProfileAsync({ agentDir, profileId: `${row.provider}:audio`, credential: { type: "api_key", provider: row.provider, key: "must-not-fallback" } });
          model.profile = `${row.provider}:audio`; await expect(call()).rejects.toThrow(/unavailable for ClawRouter/);
          expect(transports).toHaveLength(0); model.profile = "clawrouter:audio";
        }
        if (row.scenario === "rotation") {
          await control("rotate", row); await expect(call()).rejects.toThrow();
          expect(transports.filter(value => value.path === row.route)).toHaveLength(0);
          expect(transports.at(-1)?.status).toBe(401); provider.apiKey = token(row, true);
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
          expect(await call()).toMatchObject({ text: "café 東京 🦊", provider: "clawrouter", model: row.model });
        } else await expect(call()).rejects.toThrow();
        const uploads = transports.filter(value => value.path === row.route);
        expect(uploads).toHaveLength(["success", "rotation", "stale", "malformed", "partial", "error", "redirect", "truncated", "abort"].includes(row.scenario) ? 1 : 0);
        if (row.scenario === "stale") expect(uploads[0]?.status).toBe(403);
      } catch (error) { bodyFailures.push(error); diagnostic.mark("body", "primary", "rejected", true, error); }
      try {
        await finishOwned(bodyFailures, [
          () => { if (!caller.signal.aborted) caller.abort(callerReason); },
          () => row.scenario === "abort" && control("abort", row),
          async () => { if (pending) { const result = await pending; expect("error" in result).toBe(true); } },
          ...transports.map(transport => () => diagnostic.track("original_join", () => joinOriginal(transport))),
          () => diagnostic.track("worker_join", () => control("join", row)),
          () => { if (unexpected.length) throw new AggregateError(unexpected, "unexpected transport"); },
        ]);
      } catch (error) { callbackFailure = { error }; throw error; }
    });
  } catch (error) {
    if (callbackFailure && error !== callbackFailure.error) failures.push(callbackFailure.error);
    failures.push(error);
    diagnostic.mark("state_scope", "cleanup", "rejected", true, error);
  }
  let finalFailure: { error: unknown } | undefined;
  try {
    await finishOwned(failures, [() => diagnostic.track("runtime_restore", () => vi.restoreAllMocks()),
      () => diagnostic.track("runtime_restore", () => vi.unstubAllGlobals()), () => diagnostic.track("runtime_restore", () => vi.unstubAllEnvs())]);
    diagnostic.mark("case_outcome", "summary", "fulfilled");
  } catch (error) { finalFailure = { error }; diagnostic.mark("case_outcome", "summary", "rejected", true, error); }
  await finishOwned(finalFailure ? [finalFailure.error] : [], [() => diagnostic.join()]);
}

describe("registered native Groq/Mistral transcription against shipping Worker", () => {
  it.each(cases)("$id", runCase, 30000);
});
