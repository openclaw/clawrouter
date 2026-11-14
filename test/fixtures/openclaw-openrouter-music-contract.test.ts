import { createRequire } from "node:module";
import { types as nodeTypes } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as mediaStore from "../../media/store.js";
import { acquirePluginRegistryForInspection } from "../../plugins/loader.js";
import { writePlugin, resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import { prepareWorkspaceBuildGroup } from "../prepared-model-runtime.facts.js";
import { discardPreparedPluginGeneration } from "../prepared-model-runtime.plugin-lifetime.js";
import { snapshot } from "./media-resource-fixtures.test-support.js";
import { createMusicGenerateTool } from "./music-generate-tool.js";

// BEGIN music diagnostic protocol.
function musicDiagnosticProtocol(isProxy: (value: unknown) => boolean) {
  type Data = Record<string, string | number | boolean | null>;
  const prefix = "CLAWROUTER_MUSIC_DIAGNOSTIC_V1 ";
  const ids = new Set(["none", "m0_wav", "m0_mp3", "m1_wav", "m1_mp3", "reference", "options", "preabort", "missing", "foreign", "revoked", "unpriced", "stalegrant", "empty", "eof", "json", "utf8", "base64", "ambiguous", "partial", "error", "redirect", "wire", "audio", "transcript", "abort_headers", "abort_body", "deadline_body"]);
  const phases = new Set(["module_entered", "setup", "registry_acquire", "registry_assert", "case_setup", "prepare_runtime", "tool_create", "execute", "caller_abort", "body_assert", "original_join", "prepared_discard", "runtime_restore", "registry_release", "cache_reset", "state_cleanup", "media_fixture", "worker_prepare", "grant_setup", "helper", "worker_retirement", "upstream_state", "upstream_assert", "sqlite_read", "sqlite_assert", "header_disposition", "worker_dispose", "scratch_cleanup", "final_cleanup", "capacity"]);
  const names = new Set(["Error", "TypeError", "RangeError", "AssertionError", "AggregateError", "AbortError", "TimeoutError", "unknown"]);
  const codes = new Set(["ERR_ASSERTION", "ERR_ASSERTION_ERROR", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_REQUIRE_ESM", "ABORT_ERR", "ECONNRESET", "ETIMEDOUT"]);
  const keys = ["v", "layer", "route", "caseId", "phase", "role", "outcome", "category", "name", "code", "exit", "killed", "signal", "records", "suppressed", "acquisitions", "readers", "operations", "settled", "rejected", "releases", "returned", "dispatchers", "callerAborted", "partialDelivery", "restored", "actual", "expected", "invalid"];
  const own = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== "object" || isProxy(value)) return undefined;
    try { const d = Object.getOwnPropertyDescriptor(value, key); return d && "value" in d ? d.value : undefined; } catch { return undefined; }
  };
  const scalar = (value: unknown) => value === null || typeof value === "boolean" || typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000;
  function validate(value: unknown): Data | undefined {
    try {
      if (!value || typeof value !== "object" || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
      const out: Data = {}, found = Reflect.ownKeys(value);
      if (found.length > keys.length || found.some(key => typeof key !== "string" || !keys.includes(key))) return;
      for (const key of found as string[]) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !("value" in d)) return; out[key] = d.value; }
      if (out.v !== 1 || !["sdk", "outer"].includes(out.layer as string) || !["none", "native", "manifest"].includes(out.route as string)
        || !ids.has(out.caseId as string) || !phases.has(out.phase as string) || !["progress", "primary", "cleanup", "summary"].includes(out.role as string)
        || !["entered", "fulfilled", "rejected", "unknown"].includes(out.outcome as string)
        || !["none", "error", "assertion", "aggregate", "undefined", "null", "unknown", "child_process", "limit"].includes(out.category as string)) return;
      for (const key of found as string[]) {
        if (keys.indexOf(key) < 8) continue;
        if (key === "name" ? !names.has(out[key] as string) : key === "code" ? !codes.has(out[key] as string)
          : key === "signal" ? ![null, "SIGTERM", "SIGKILL", "SIGABRT", "SIGINT", "SIGHUP"].includes(out[key] as string | null) : !scalar(out[key])) return;
      }
      if (out.partialDelivery !== undefined && out.partialDelivery !== null || new TextEncoder().encode(JSON.stringify(out)).length > 640) return;
      return out;
    } catch { return; }
  }
  function record(context: Data, failed = false, error?: unknown): Data {
    let name = own(error, "name");
    if (name === undefined && error && typeof error === "object" && !isProxy(error)) { try { name = own(Object.getPrototypeOf(error), "name"); } catch {} }
    const allowedName = typeof name === "string" && names.has(name) ? name : "unknown";
    const category = !failed ? "none" : error === undefined ? "undefined" : error === null ? "null" : allowedName === "AssertionError" ? "assertion" : allowedName === "AggregateError" ? "aggregate" : allowedName === "unknown" ? "unknown" : "error";
    const data: Data = { v: 1, ...context, category, ...(failed ? { name: allowedName } : {}) };
    const code = own(error, "code"); if (typeof code === "string" && codes.has(code)) data.code = code;
    if (category === "assertion") for (const key of ["actual", "expected"]) { const v = own(error, key); if (scalar(v)) data[key] = v as number | boolean | null; }
    const valid = validate(data); if (!valid) throw new Error("invalid music diagnostic"); return valid;
  }
  function parse(text: unknown, accept: (value: Data) => void) {
    let records = 0, invalid = 0, observedCode: string | null = null;
    if (typeof text !== "string") return { records, invalid, observedCode };
    if (text.length > 2 * 1024 * 1024) return { records, invalid: 1, observedCode };
    // Only fresh child bytes are examined. No raw line, path or diagnostic message is returned.
    const code = text.match(/(?:^|[^A-Z0-9_])(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM)(?=$|[^A-Z0-9_])/);
    if (code) observedCode = code[1]!;
    for (const line of text.split("\n")) {
      if (!line.startsWith(prefix)) continue;
      if (records >= 512 || line.length > prefix.length + 640) { invalid++; continue; }
      try { const value = validate(JSON.parse(line.slice(prefix.length))); if (!value || value.layer !== "sdk") { invalid++; continue; } accept(value); records++; }
      catch { invalid++; }
    }
    return { records, invalid, observedCode };
  }
  const keyFor = (r: Data) => [r.layer, r.route, r.caseId, r.phase, r.role].join("/");
  function emitter(write: (line: string) => unknown) {
    const records = new Map<string, Data>(), emitted = new Set<string>();
    let suppressed = 0, failed = false, finished = false, bytes = 0;
    const priority = (r: Data) => r.phase === "helper" ? 0 : r.role === "primary" ? 1 : r.role === "cleanup" && r.category !== "none" ? 2
      : r.phase === "final_cleanup" ? 3 : r.phase === "worker_retirement" ? 4 : r.phase === "upstream_assert" ? 5 : r.phase === "sqlite_assert" ? 6 : 7;
    const put = (value: unknown) => {
      const r = validate(value); if (!r) throw new Error("invalid music diagnostic");
      const key = keyFor(r), old = records.get(key);
      if (old) { suppressed++; if (old.category !== "none" && r.category === "none") return; }
      if (!old && records.size >= 256) {
        const disposable = [...records].find(([, item]) => item.role === "progress");
        if (disposable) records.delete(disposable[0]); else { suppressed++; return; }
        suppressed++;
      }
      records.set(key, r);
    };
    const command = (r: Data) => {
      const escaped = JSON.stringify(r).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
      const line = "::error title=Music contract diagnostic::" + escaped + "\n", length = new TextEncoder().encode(line).length;
      if (length > 768 || bytes + length > 8192) throw new Error("music diagnostic budget exceeded");
      bytes += length; write(line);
    };
    return { put, fail(value: unknown) {
      put(value); failed = true;
      // One early envelope survives a later cleanup stall; reserve the other slots.
      if (!finished && emitted.size === 0) { const r = validate(value)!; emitted.add(keyFor(r)); command(r); }
    }, flush() {
      if (finished) return; finished = true;
      if (!failed) return;
      const remaining = [...records.values()].filter(r => !emitted.has(keyFor(r))).sort((a, b) => priority(a) - priority(b));
      for (const r of remaining) {
        if (emitted.size >= 9) { suppressed++; continue; }
        emitted.add(keyFor(r)); command(r);
      }
      if (suppressed) command(record({ layer: "outer", route: "none", caseId: "none", phase: "capacity", role: "summary", outcome: "unknown", suppressed: Math.min(suppressed, 1_000_000_000) }));
    }, get count() { return records.size; } };
  }
  return { prefix, validate, record, parse, emitter, own, ids };
}
// END music diagnostic protocol.
const musicProtocol = musicDiagnosticProtocol(nodeTypes.isProxy);
const musicDiagnosticErrors: unknown[] = [];
let musicCase = "none", musicPhase = "module_entered", musicRecords = 0;
const musicRoute = ["native", "manifest"].includes(process.env.CLAWROUTER_CONTRACT_ROUTE ?? "") ? process.env.CLAWROUTER_CONTRACT_ROUTE! : "none";
function musicMark(phase: string, outcome = "entered", role = "progress", failed = false, error?: unknown, facts: Record<string, number | boolean | null> = {}) {
  musicPhase = phase;
  try {
    if (musicRecords >= 512) throw new Error("music SDK diagnostic capacity exceeded");
    const record = musicProtocol.record({ layer: "sdk", route: musicRoute, caseId: musicCase, phase, role, outcome, partialDelivery: null, ...facts }, failed, error);
    musicRecords++; process.stdout.write("\n" + musicProtocol.prefix + JSON.stringify(record) + "\n");
  } catch (failure) { musicDiagnosticErrors.push(failure); }
}
musicMark("module_entered");

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const route = process.env.CLAWROUTER_CONTRACT_ROUTE;
if (route !== "native" && route !== "manifest") throw new Error("explicit real music configuration required");
const audio = JSON.parse(process.env.CLAWROUTER_CONTRACT_AUDIO!) as Record<string, string>;
type Case = { id: string; kind: string; model: string; format: "wav" | "mp3" };
const cases = JSON.parse(process.env.CLAWROUTER_CONTRACT_CASES!) as Case[];
const nativeFetch = globalThis.fetch;
const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
const runtimeKey = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const globals = globalThis as Record<string, unknown>;
const previousRuntime = Object.getOwnPropertyDescriptor(globalThis, runtimeKey);
type Operation = { kind: "read" | "cancel" | "body_cancel"; pending: Promise<unknown>; signal?: AbortSignal; body: ReadableStream<Uint8Array>; expectedAbort: boolean;
  invokeAborted: boolean; invokeReason: unknown; rejected?: boolean; reason?: unknown; rejectAborted?: boolean; rejectReason?: unknown };
type Reader = { body: ReadableStream<Uint8Array>; closed: Promise<unknown>; releases: number; returned: number; operations: Operation[]; closedOutcome?: PromiseSettledResult<unknown> };
type Acquisition = { pending: Promise<unknown>; observed: Promise<unknown>; expectedAbort: boolean; rejectAborted?: boolean; rejectReason?: unknown };
const readers: Reader[] = [], bodyOperations: Operation[] = [], acquisitions: Acquisition[] = [], observationErrors: unknown[] = [];
const agents: Array<{ retirements: number; pending: Promise<unknown>[] }> = [];
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let acquired: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>;
let prepared: Awaited<ReturnType<typeof prepareWorkspaceBuildGroup>> | undefined;
let alternate: ReturnType<typeof writePlugin>;

// The pinned loader reads this supported runtime surface in both source and
// compiled plugin graphs. Every constructor, fetch and returned Promise is real.
function observedConstructor<T extends new (...args: any[]) => any>(Original: T): T {
  return new Proxy(Original, { construct(target, args, newTarget) {
    const agent = Reflect.construct(target, args, newTarget), row = { retirements: 0, pending: [] as Promise<unknown>[] };
    agents.push(row);
    let closing = false, depth = 0;
    for (const kind of ["close", "destroy"] as const) {
      const original = agent[kind];
      agent[kind] = function(...operands: unknown[]) {
        const external = depth === 0 && !(kind === "destroy" && closing);
        if (external) { row.retirements++; if (kind === "close") closing = true; }
        depth++;
        try {
          const pending = Reflect.apply(original, this, operands);
          if (external) {
            if (!pending || typeof pending.then !== "function") observationErrors.push(new Error("external dispatcher retirement did not return its original Promise"));
            else { row.pending.push(pending); void pending.catch(() => {}); }
          }
          return pending;
        } catch (error) { observationErrors.push(error); throw error; }
        finally { depth--; }
      };
    }
    return agent;
  } });
}
function observeOperation(kind: Operation["kind"], pending: Promise<unknown>, body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined, expectedAbort: boolean,
  invocation: { aborted: boolean; reason: unknown }): Operation {
  const operation: Operation = { kind, pending, body, signal, expectedAbort, invokeAborted: invocation.aborted, invokeReason: invocation.reason };
  void pending.then(() => {}, reason => { operation.rejected = true; operation.reason = reason; operation.rejectAborted = signal?.aborted === true; operation.rejectReason = signal?.reason; });
  return operation;
}
function ownedStoredAbort(row: Reader, reason: unknown) {
  return reason !== undefined && row.closedOutcome?.status === "rejected" && row.closedOutcome.reason === reason &&
    row.operations.some(operation => operation.kind === "read" && operation.expectedAbort && operation.rejected && operation.reason === reason && operation.rejectAborted && operation.rejectReason === reason);
}
function observeResponse(response: Response, signal: AbortSignal | undefined, expectedAbort: boolean) {
  const body = response.body;
  if (!body) return;
  const originalCancel = body.cancel;
  body.cancel = function(reason) {
    const invocation = { aborted: signal?.aborted === true, reason: signal?.reason };
    try { const pending = Reflect.apply(originalCancel, this, [reason]); bodyOperations.push(observeOperation("body_cancel", pending, body, signal, expectedAbort, invocation)); return pending; }
    catch (error) { observationErrors.push(error); throw error; }
  };
  const originalGetReader = body.getReader;
  body.getReader = function(...args: any[]) {
    const reader = Reflect.apply(originalGetReader, this, args) as ReadableStreamDefaultReader<Uint8Array>;
    const row: Reader = { body, closed: reader.closed, releases: 0, returned: 0, operations: [] }; readers.push(row); void row.closed.catch(() => {});
    for (const kind of ["read", "cancel"] as const) {
      const original = reader[kind];
      (reader as any)[kind] = function(...operands: unknown[]) {
        const invocation = { aborted: signal?.aborted === true, reason: signal?.reason };
        try { const pending = Reflect.apply(original, this, operands) as Promise<unknown>; row.operations.push(observeOperation(kind, pending, body, signal, expectedAbort, invocation)); return pending; }
        catch (error) { observationErrors.push(error); throw error; }
      };
    }
    const release = reader.releaseLock;
    reader.releaseLock = function() { row.releases++; try { const result = Reflect.apply(release, this, []); row.returned++; return result; } catch (error) { observationErrors.push(error); throw error; } };
    return reader;
  } as typeof body.getReader;
}

// Drain only observed originals and their response hooks. Stable membership is
// not a claim about arbitrary unscheduled work; closed/retirement outcomes and
// the existing release invariants below remain required.
async function joinOriginalSdkOperations(input: {
  readers: Reader[]; bodyOperations: Operation[]; acquisitions: Acquisition[];
  agents: Array<{ retirements: number; pending: Promise<unknown>[] }>;
  observationErrors: unknown[];
}, storedAbort: typeof ownedStoredAbort): Promise<unknown[]> {
  const { readers, bodyOperations, acquisitions, agents, observationErrors } = input;
  const outcomes = new Map<Promise<unknown>, PromiseSettledResult<unknown> | undefined>();
  for (;;) {
    const joining: Promise<void>[] = [];
    const include = (pending: Promise<unknown>) => {
      if (outcomes.has(pending)) return;
      outcomes.set(pending, undefined);
      joining.push(Promise.allSettled([pending]).then(([result]) => { outcomes.set(pending, result!); }));
    };
    for (const acquisition of acquisitions) { include(acquisition.pending); include(acquisition.observed); }
    for (const row of readers) { include(row.closed); for (const operation of row.operations) include(operation.pending); }
    for (const operation of bodyOperations) include(operation.pending);
    for (const row of agents) for (const pending of row.pending) include(pending);
    if (!joining.length) break;
    await Promise.all(joining);
  }
  const failures: unknown[] = [];
  for (const acquisition of acquisitions) {
    const observed = outcomes.get(acquisition.observed)!;
    if (observed.status === "rejected") failures.push(observed.reason);
    const result = outcomes.get(acquisition.pending)!;
    if (result.status === "rejected" && !(acquisition.expectedAbort && acquisition.rejectAborted && result.reason !== undefined && result.reason === acquisition.rejectReason)) failures.push(result.reason);
  }
  for (const row of readers) row.closedOutcome = outcomes.get(row.closed)!;
  for (const operation of new Set([...bodyOperations, ...readers.flatMap(row => row.operations)])) {
    const result = outcomes.get(operation.pending)!;
    if (result.status !== "rejected") continue;
    const owner = readers.find(row => row.body === operation.body && (operation.kind === "body_cancel" || row.operations.includes(operation)) && storedAbort(row, result.reason));
    const expectedRead = operation.kind === "read" && operation.expectedAbort && operation.rejectAborted && result.reason !== undefined && operation.rejectReason === result.reason;
    const storedCancellation = operation.kind !== "read" && operation.expectedAbort && operation.invokeAborted && operation.invokeReason === result.reason && owner !== undefined;
    if (!expectedRead && !storedCancellation) failures.push(result.reason);
  }
  for (const row of readers) {
    if (row.closedOutcome?.status === "rejected" && !storedAbort(row, row.closedOutcome.reason)) failures.push(row.closedOutcome.reason);
    if (row.releases !== 1 || row.returned !== 1 || row.body.locked) failures.push(new Error("original SDK reader not released"));
  }
  for (const row of agents) {
    for (const pending of new Set(row.pending)) { const result = outcomes.get(pending)!; if (result.status === "rejected") failures.push(result.reason); }
    if (row.retirements !== 1 || row.pending.length !== 1) failures.push(new Error("missing exact external dispatcher retirement"));
  }
  failures.push(...observationErrors);
  return failures;
}

function configuration(row: Case): OpenClawConfig {
  return {
    plugins: { allow: ["clawrouter", alternate.id], entries: { clawrouter: { enabled: true } }, load: { paths: [alternate.file] }, slots: { memory: "none" } },
    models: { providers: { clawrouter: { baseUrl: origin, apiKey: `clawrouter-live-orm_${row.id}-fixture-secret`, models: [] } } },
    agents: { defaults: { workspace: state.workspaceDir, mediaModels: { music: { primary: `clawrouter/openrouter/${row.model}`, fallbacks: [`${alternate.id}/fixture`], timeoutMs: 120000 } } } },
  };
}
beforeAll(async () => {
  musicMark("setup");
  try {
  state = await createOpenClawTestState({ label: "openrouter-music-worker", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined, CLAWROUTER_API_KEY: undefined, OPENROUTER_API_KEY: "must-not-fallback", GOOGLE_API_KEY: "must-not-fallback" } });
  alternate = writePlugin({ id: "music-alternate-fixture", dir: state.statePath("alternate"),
    registration: `api.registerMusicGenerationProvider({ id: "music-alternate-fixture", defaultModel: "fixture", capabilities: {}, async generateMusic() { await fetch(${JSON.stringify(origin + "/fixture/alternate")}); throw new Error("unexpected paid fallback"); } });` });
  await state.writeJson("alternate/openclaw.plugin.json", { id: alternate.id, contracts: { musicGenerationProviders: [alternate.id] }, configSchema: { type: "object", additionalProperties: false, properties: {} } });
  musicMark("registry_acquire");
  acquired = await acquirePluginRegistryForInspection({ config: configuration(cases[0]!) });
  musicMark("registry_assert");
  expect(acquired.registry.musicGenerationProviders.some(row => row.provider.id === "clawrouter")).toBe(true);
  musicMark("setup", "fulfilled");
  } catch (error) { musicMark(musicPhase, "rejected", "primary", true, error); throw error; }
});
beforeEach(context => {
  musicCase = cases.find(row => context.task.name === `real registered music ${route}/${row.id}`)?.id ?? "none";
  if (!musicProtocol.ids.has(musicCase)) musicCase = "none";
  musicMark("case_setup");
  try {
  readers.length = bodyOperations.length = acquisitions.length = observationErrors.length = agents.length = 0;
  Object.defineProperty(globalThis, runtimeKey, { configurable: true, writable: true, value: {
    ...undici, Agent: observedConstructor(undici.Agent), ProxyAgent: observedConstructor(undici.ProxyAgent), EnvHttpProxyAgent: observedConstructor(undici.EnvHttpProxyAgent),
    fetch(input: Parameters<typeof undici.fetch>[0], init?: Parameters<typeof undici.fetch>[1]) {
      const pending = undici.fetch(input, init);
      const signal = init?.signal ?? undefined;
      const authorization = new Headers(init?.headers as HeadersInit | undefined).get("authorization");
      const expectedAbort = ["abort_headers", "abort_body", "deadline_body"].some(id => authorization === `Bearer clawrouter-live-orm_${id}-fixture-secret`);
      const acquisition: Acquisition = { pending, observed: pending, expectedAbort };
      acquisition.observed = pending.then(response => { try { observeResponse(response as unknown as Response, signal, expectedAbort); } catch (error) { observationErrors.push(error); } }, () => {
        acquisition.rejectAborted = signal?.aborted === true; acquisition.rejectReason = signal?.reason;
      });
      acquisitions.push(acquisition); void pending.catch(() => {}); return pending;
    },
  } });
  musicMark("case_setup", "fulfilled");
  } catch (error) { musicMark("case_setup", "rejected", "primary", true, error); throw error; }
});
afterEach(async () => {
  const failures: unknown[] = [];
  musicMark("original_join");
  try {
    failures.push(...await joinOriginalSdkOperations({ readers, bodyOperations, acquisitions, agents, observationErrors }, ownedStoredAbort));
    musicMark("original_join", failures.length ? "rejected" : "fulfilled", "summary", false, undefined, { acquisitions: acquisitions.length, readers: readers.length,
      operations: bodyOperations.length + readers.reduce((n, row) => n + row.operations.length, 0),
      rejected: bodyOperations.filter(row => row.rejected).length + readers.reduce((n, row) => n + row.operations.filter(op => op.rejected).length, 0),
      releases: readers.reduce((n, row) => n + row.releases, 0), returned: readers.reduce((n, row) => n + row.returned, 0), dispatchers: agents.length });
    for (const failure of failures) musicMark("original_join", "rejected", "cleanup", true, failure);
  } catch (error) { musicMark("original_join", "rejected", "cleanup", true, error); failures.push(error); }
  finally {
    musicMark("prepared_discard");
    try { if (prepared) await discardPreparedPluginGeneration(prepared.pluginGeneration); prepared = undefined; musicMark("prepared_discard", "fulfilled", "cleanup"); } catch (error) { musicMark("prepared_discard", "rejected", "cleanup", true, error); failures.push(error); }
    musicMark("runtime_restore");
    try { if (previousRuntime) Object.defineProperty(globalThis, runtimeKey, previousRuntime); else delete globals[runtimeKey]; vi.restoreAllMocks(); resetGeneratedMediaTaskActivityForTests(); musicMark("runtime_restore", "fulfilled", "cleanup", false, undefined, { restored: true }); } catch (error) { musicMark("runtime_restore", "rejected", "cleanup", true, error, { restored: false }); failures.push(error); }
  }
  failures.push(...musicDiagnosticErrors.splice(0));
  // Vitest retains the independent body failure. Never discard a cleanup rejection.
  if (failures.length) throw new AggregateError(failures, "original SDK operations or cleanup failed");
});
afterAll(async () => {
  const failures: unknown[] = [];
  musicMark("registry_release");
  try { await acquired?.release(); musicMark("registry_release", "fulfilled", "cleanup"); } catch (error) { musicMark("registry_release", "rejected", "cleanup", true, error); failures.push(error); }
  musicMark("cache_reset");
  try { clearPluginMetadataLifecycleCaches(); resetPluginLoaderTestStateForTest(); musicMark("cache_reset", "fulfilled", "cleanup"); } catch (error) { musicMark("cache_reset", "rejected", "cleanup", true, error); failures.push(error); }
  musicMark("state_cleanup");
  try { await state?.cleanup(); musicMark("state_cleanup", "fulfilled", "cleanup"); } catch (error) { musicMark("state_cleanup", "rejected", "cleanup", true, error); failures.push(error); }
  failures.push(...musicDiagnosticErrors.splice(0));
  if (failures.length) throw new AggregateError(failures, "registered runtime cleanup failed");
});

for (const row of cases) it(`real registered music ${route}/${row.id}`, async () => {
  const config = configuration(row), controller = new AbortController();
  musicMark("prepare_runtime");
  try {
  prepared = await prepareWorkspaceBuildGroup([{ agentId: "main", agentDir: state.agentDir(), workspaceDir: state.workspaceDir, config, skipCredentials: true }], "static", { includeCredentialProviders: false }, () => acquired.registry);
  musicMark("tool_create");
  const tool = createMusicGenerateTool({ config, agentDir: state.agentDir(), workspaceDir: state.workspaceDir, preparedModelRuntime: snapshot(prepared) });
  expect(tool).not.toBeNull();
  if (row.kind === "revoked") expect((await nativeFetch(origin + "/fixture/revoke?id=" + row.id, { method: "POST" })).status).toBe(204);
  if (row.kind === "preabort") controller.abort(new Error("owned caller preabort"));
  // Record the real persisted bytes; this spy calls the original implementation.
  const saved = vi.spyOn(mediaStore, "saveMediaBuffer");
  const args: Record<string, unknown> = { prompt: `Synthetic ${row.id}`, model: `clawrouter/openrouter/${row.model}`, format: row.format, lyrics: "Synthetic lyrics", instrumental: true, durationSeconds: 180 };
  if (row.kind === "reference") args.image = origin + "/unowned-reference.png";
  if (row.kind === "options") args.format = "pcm";
  if (row.kind === "stalegrant") {
    const catalog = await nativeFetch(origin + "/v1/catalog", { headers: { authorization: `Bearer clawrouter-live-orm_${row.id}-fixture-secret` } });
    expect(catalog.status).toBe(200); await catalog.json();
    expect((await nativeFetch(origin + "/fixture/revoke?id=" + row.id, { method: "POST" })).status).toBe(204);
  }
  musicMark("execute");
  const pending = withPluginRuntimeRegistryScope(acquired.registry, () => tool!.execute(`music-${route}-${row.id}`, args, controller.signal));
  // The observation is attached immediately; a later await never leaves a rejection unhandled.
  const outcome = pending.then(value => ({ ok: true as const, value }), reason => ({ ok: false as const, reason }));
  if (row.kind.startsWith("abort_")) {
    expect((await nativeFetch(origin + "/fixture/started?id=" + row.id)).status).toBe(204);
    controller.abort(new Error("owned caller cancellation"));
    musicMark("caller_abort", "fulfilled", "progress", false, undefined, { callerAborted: controller.signal.aborted });
  }
  const result = await outcome;
  musicMark("execute", result.ok ? "fulfilled" : "rejected", "progress", false, undefined, { callerAborted: controller.signal.aborted });
  musicMark("body_assert");
  if (row.kind === "success") {
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.reason;
    expect(saved).toHaveBeenCalledTimes(1);
    expect(Buffer.from(saved.mock.calls[0]![0])).toEqual(Buffer.from(audio[row.format]!, "base64"));
    expect(result.value.details).toMatchObject({ provider: "clawrouter", model: `openrouter/${row.model}`, lyrics: ["café synthetic music"] });
    expect(readers.length).toBeGreaterThan(0); expect(agents.length).toBeGreaterThan(0);
  } else {
    expect(result.ok).toBe(false); expect(saved).not.toHaveBeenCalled();
    if (row.kind.startsWith("abort") || row.kind === "preabort") expect(controller.signal.aborted).toBe(true);
  }
  musicMark("body_assert", "fulfilled", "progress", false, undefined, { callerAborted: controller.signal.aborted });
  } catch (error) { musicMark(musicPhase, "rejected", "primary", true, error, { callerAborted: controller.signal.aborted }); throw error; }
// The actual tool minimum is 120s. This new case encloses that real deadline;
// the unchanged native consumer helper still owns its independent 240s ceiling.
}, row.kind === "deadline_body" ? 180000 : 120000);
