import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { DispatcherAwareRequestInit } from "../../src/infra/net/runtime-fetch.js";
import * as guardedFetch from "../../src/infra/net/fetch-guard.js";
import { registerSingleProviderPlugin } from "../../src/plugin-sdk/plugin-test-runtime.js";
import { getLiveCatalogRetainedData } from "../../src/plugins/provider-live-catalog-cache.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";

type Scenario = "table" | "empty" | "stale" | "malformed" | "abort";
type Case = { id: string; provider: string; scenario: Scenario; endpoint: string; format: string;
  native: boolean; route: string; model: string; upstream: string; urls: string[] };
const expectedHead = "1536faab19f2adf524b7ef1acef5c24501b35652";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const control = process.env.CLAWROUTER_CONTRACT_CONTROL!;
const cases = JSON.parse(process.env.CLAWROUTER_CONTRACT_CATALOG_CASES!) as Case[];
const providers = ["cerebras", "nvidia", "chutes", "venice"];
const originalFetch = globalThis.fetch;
const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
const originalRuntimeFetch = undici.fetch;
const originalGuard = guardedFetch.fetchWithSsrFGuard;
const key = (row: Case) => "clawrouter-live-" + row.id + "-fixture-secret";
type Operation = {
  kind: "read" | "cancel" | "lease";
  pending: Promise<unknown>;
  rejection?: { reason: unknown; originalTransportAbort: boolean };
};
type Observation = {
  path: string; credential: string; status?: number; errorCode?: string; revocations: number;
  dispatcher: NonNullable<DispatcherAwareRequestInit["dispatcher"]>; signal: AbortSignal;
  response?: Response; guardObserved: boolean; released: boolean;
  closeStarted: Promise<void>;
  closeCalls: Array<{ depth: number; receiver: unknown; args: unknown[]; outcome?: { value: unknown } | { error: unknown } }>;
  bodies: ReadableStream<Uint8Array>[]; operations: Operation[]; synchronousFailures: unknown[];
  readers: Array<{ unlock: ReturnType<typeof vi.spyOn> }>;
};
const observations: Observation[] = [];
const unexpected: unknown[] = [];
const caseFor = (provider: string, scenario: Scenario) => {
  const row = cases.find(value => value.provider === provider && value.scenario === scenario);
  if (!row) throw new Error("missing compiled fixture contract");
  return row;
};
function throwFailures(failures: unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "catalog assertion or original cleanup failed");
}
function refuse(message: string): never {
  const error = new Error(message); unexpected.push(error); throw error;
}
function observeOperation<T>(row: Observation, kind: Operation["kind"], pending: Promise<T>): Promise<T> {
  const operation: Operation = { kind, pending }; row.operations.push(operation);
  void pending.then(() => undefined, reason => {
    operation.rejection = { reason, originalTransportAbort: row.signal.aborted && reason === row.signal.reason };
  });
  return pending;
}

function invokeOperation<T>(row: Observation, kind: Operation["kind"], invoke: () => Promise<T>): Promise<T> {
  try { return observeOperation(row, kind, invoke()); }
  catch (error) { row.synchronousFailures.push(error); throw error; }
}

// BEGIN catalog diagnostic protocol
const diagnosticProviders = ["cerebras", "nvidia", "chutes", "venice"];
const diagnosticTestIds = new Set(["none", ...diagnosticProviders.flatMap(provider => ["inventory", "stale", "malformed", "abort"].map(kind => provider + "_" + kind))]);
const diagnosticCaseIds = new Set(["none", ...diagnosticProviders.flatMap(provider => ["table", "empty", "stale", "malformed", "abort"].map(kind => provider + "_" + kind))]);
const diagnosticPhases = new Set(["setup", "facade_load", "registration", "body", "native_fetch", "offer_observation", "stale_revocation", "transport_join", "worker_join", "restoration", "state_cleanup", "worker_acquisition", "sdk_process", "case_verify", "worker_retirement", "sql_receipt", "upstream_contract", "producer_release", "control_close", "worker_dispose", "scratch_cleanup", "relay"]);
const diagnosticCategories = new Set(["error", "assertion", "aggregate", "undefined", "null", "unknown", "child_process", "limit"]);
const diagnosticNames = new Set(["Error", "TypeError", "RangeError", "AssertionError", "AggregateError", "AbortError", "TimeoutError", "undefined", "null", "unknown"]);
const diagnosticFields = new Set(["none", "assertion", "exit_code", "killed", "sdk_records", "suppressed", "status", "retirement", "receipt", "upstream", "close", "cache"]);
const diagnosticCodes = new Set(["ERR_ASSERTION", "ERR_ASSERTION_ERROR", "ECONNRESET", "ABORT_ERR", "UND_ERR_ABORTED", "UND_ERR_HEADERS_TIMEOUT", "ETIMEDOUT", "SIGTERM", "SIGKILL"]);
function diagnosticData(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}
function diagnosticPrimitive(value: unknown): boolean {
  return value === null || typeof value === "boolean" || typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000;
}
function safeDiagnosticRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const keys = Reflect.ownKeys(value), required = ["v", "layer", "testId", "caseId", "phase", "category", "name", "field"];
    if (keys.some(key => typeof key !== "string" || ![...required, "expected", "actual", "code"].includes(key))) return;
    const result: Record<string, unknown> = {};
    for (const key of required) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor)) return; result[key] = descriptor.value; }
    if (result.v !== 1 || !["sdk", "outer"].includes(result.layer as string)
      || !diagnosticTestIds.has(result.testId as string) || !diagnosticCaseIds.has(result.caseId as string)
      || !diagnosticPhases.has(result.phase as string) || !diagnosticCategories.has(result.category as string)
      || !diagnosticNames.has(result.name as string) || !diagnosticFields.has(result.field as string)) return;
    for (const key of ["expected", "actual", "code"]) if (keys.includes(key)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor)) return;
      if (key === "code" ? !diagnosticCodes.has(descriptor.value) : !diagnosticPrimitive(descriptor.value)) return;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return; }
}
function failureDiagnostic(layer: string, testId: string, caseId: string, phase: string, error: unknown, field = "none"): Record<string, unknown> | undefined {
  let name: unknown = error === undefined ? "undefined" : error === null ? "null" : diagnosticData(error, "name");
  if (name === undefined) { try { name = diagnosticData(Object.getPrototypeOf(error), "name"); } catch {} }
  if (typeof name !== "string" || !diagnosticNames.has(name)) name = "unknown";
  const category = error === undefined ? "undefined" : error === null ? "null" : name === "AssertionError" ? "assertion" : name === "AggregateError" ? "aggregate" : name === "unknown" ? "unknown" : "error";
  const record: Record<string, unknown> = { v: 1, layer, testId, caseId, phase, category, name, field };
  const code = diagnosticData(error, "code"); if (typeof code === "string" && diagnosticCodes.has(code)) record.code = code;
  if (category === "assertion") for (const key of ["expected", "actual"]) {
    const value = diagnosticData(error, key); if (diagnosticPrimitive(value)) record[key] = value;
  }
  return safeDiagnosticRecord(record);
}
// END catalog diagnostic protocol

let diagnosticTestId = "none", diagnosticCaseId = "none";
async function reportDiagnostic(phase: string, error: unknown, caseId = diagnosticCaseId, field = "none"): Promise<void> {
  // One independently bounded call for this new execution only. Reporting can
  // never replace the original failure or establish transport retirement.
  try {
    const record = failureDiagnostic("sdk", diagnosticTestId, caseId, phase, error, field);
    if (!record) return;
    const endpoint = new URL(control);
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) return;
    endpoint.pathname = "/diagnostic";
    const response = await originalFetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record), signal: AbortSignal.timeout(2_000), redirect: "error" });
    await response.arrayBuffer();
  } catch { /* Best-effort bounded reporting never masks the original throw. */ }
}

beforeEach(async context => {
  const names = ["uses its real format, preserves unknown facts and isolates authoritative empty inventory by original key", "denies a previously advertised offer after original-grant revocation with zero provider attempts", "rejects a malformed upstream catalog without partial caching or alternate dispatch", "rejects caller abort and joins the original shared acquisition, physical reads and dispatcher release"];
  const provider = providers.find(value => context.task.suite?.name === value + " registered public discovery");
  const index = names.indexOf(context.task.name);
  diagnosticTestId = provider && index >= 0 ? provider + "_" + ["inventory", "stale", "malformed", "abort"][index] : "none";
  diagnosticCaseId = "none";
  try {
    expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(expectedHead);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(expectedHead);
    expect(cases).toHaveLength(20);
    clearLiveCatalogCacheForTests(); observations.length = 0; unexpected.length = 0;
    for (const name of ["CEREBRAS_API_KEY", "NVIDIA_API_KEY", "CHUTES_API_KEY", "VENICE_API_KEY", "OPENAI_API_KEY"]) {
      vi.stubEnv(name, "must-not-fallback");
    }
    vi.stubEnv("CLAWROUTER_API_KEY", "");
    // A plain pass-through preserves the real guard's dispatcher selection.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(new Request(input, init).url).origin !== origin) refuse("unexpected direct client provider egress");
      return originalFetch(input, init);
    });
    // The native plugin and Vitest graphs both consult this supported hook.
    // Constructors, actual fetch operands, signals and responses remain original.
    vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: observeRequest });
    const observeGuard: typeof originalGuard = async options => {
      if (options.dispatcherPool) refuse("unexpected pooled catalog transport");
      const result = await originalGuard(options);
      const row = observations.find(value => value.path === new URL(String(options.url)).pathname
        && value.credential === new Headers(options.init?.headers).get("authorization"));
      if (!row) {
        const failures: unknown[] = [new Error("missing transport for observed original guard")];
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => result.response.body?.cancel()),
          Promise.resolve().then(() => result.release()),
        ]);
        for (const item of cleanup) if (item.status === "rejected") failures.push(item.reason);
        throwFailures(failures);
        throw new Error("unreachable missing transport");
      }
      row.guardObserved = true; observeBody(result.response.body, row);
      return { ...result, release: () => {
        const pending = invokeOperation(row, "lease", () => result.release());
        void pending.then(() => { row.released = true; }, () => undefined);
        return pending;
      } };
    };
    // Supplementary evidence only; native transport and revocation do not depend
    // on intercepting a namespace from another module graph.
    vi.spyOn(guardedFetch, "fetchWithSsrFGuard").mockImplementation(observeGuard);
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(observeGuard);
  } catch (error) { await reportDiagnostic("setup", error); throw error; }
});

async function observeRequest(input: RequestInfo | URL, supplied?: RequestInit): Promise<Response> {
  try { return await observeNativeRequest(input, supplied); }
  catch (error) { await reportDiagnostic("native_fetch", error); throw error; }
}
async function observeNativeRequest(input: RequestInfo | URL, supplied?: RequestInit): Promise<Response> {
  const init = supplied as DispatcherAwareRequestInit | undefined;
  const request = new Request(input, supplied), url = new URL(request.url);
  const credential = request.headers.get("authorization") ?? "";
  const row = cases.find(value => credential === "Bearer " + key(value));
  if (!row || url.origin !== origin || !["/v1/catalog", row.route].includes(url.pathname) || url.search
    || request.method !== "GET" || request.body || request.headers.has("x-api-key")) refuse("unexpected registered catalog route or key");
  if (observations.some(value => value.path === url.pathname && value.credential === credential)) refuse("repeated original catalog transport");
  const dispatcher = init?.dispatcher, signal = init?.signal;
  if (!(dispatcher instanceof undici.Agent) || !signal || dispatcher.closed || dispatcher.destroyed
    || observations.some(value => value.dispatcher === dispatcher)) refuse("missing fresh original catalog Agent or signal");
  let closeStarted!: () => void;
  const observation: Observation = { path: url.pathname, credential, dispatcher, signal, revocations: 0,
    guardObserved: false, released: false, closeStarted: new Promise(resolve => { closeStarted = resolve; }),
    closeCalls: [], bodies: [], operations: [], synchronousFailures: [], readers: [] };
  observations.push(observation);
  const close = dispatcher.close; let depth = 0;
  vi.spyOn(dispatcher, "close").mockImplementation(function (this: typeof dispatcher, ...args: unknown[]) {
    const call: Observation["closeCalls"][number] = { depth, receiver: this, args };
    observation.closeCalls.push(call); depth++;
    try { const value = Reflect.apply(close, this, args); call.outcome = { value }; return value; }
    catch (error) { call.outcome = { error }; throw error; }
    finally { depth--; if (call.depth === 0) closeStarted(); }
  } as typeof dispatcher.close);
  const response = await Reflect.apply(originalRuntimeFetch, undici, [input, supplied]) as unknown as Response;
  observation.response = response; observation.status = response.status;
  try {
    if (url.pathname === "/v1/catalog") {
      const body = await observeOperation(observation, "read", response.clone().json());
      const provider = body.providers.find((value: { id: string }) => value.id === row.provider);
      const offers = provider.offers.filter((value: { endpoint: string }) => value.endpoint === row.endpoint);
      expect(offers).toEqual([expect.objectContaining({ routeKind: row.native ? "native" : "manifest",
        route: row.route, eligible: true, requestFormat: row.format, responseFormat: row.format })]);
      // Genuine old offer observed; mutate the original Worker owner exactly
      // once before returning this same response to the registered client.
      if (row.scenario === "stale") {
        observation.revocations++;
        try { expect(JSON.parse(await command("/__catalog/revoke/" + row.id, "POST"))).toEqual({ changed: true }); }
        catch (error) { await reportDiagnostic("stale_revocation", error, row.id); throw error; }
      }
    } else if (!response.ok) observation.errorCode = (await observeOperation(observation, "read", response.clone().json())).error?.code;
  } catch (error) {
    await reportDiagnostic("offer_observation", error, row.id);
    unexpected.push(error);
    // Do not await a tee cancellation inside fetch: the original guard must
    // first get its rejection and retire its original transport.
    try { if (response.body) observeOperation(observation, "cancel", response.body.cancel()); }
    catch (cleanup) { unexpected.push(cleanup); throw new AggregateError([error, cleanup], "catalog observation and cancellation failed"); }
    throw error;
  }
  observeBody(response.body, observation);
  return response;
}

function observeBody(body: ReadableStream<Uint8Array> | null, row: Observation): void {
  if (!body || row.bodies.includes(body)) return;
  row.bodies.push(body);
  const cancel = body.cancel, getReader = body.getReader;
  vi.spyOn(body, "cancel").mockImplementation(function (this: typeof body, ...args) {
    return invokeOperation(row, "cancel", () => Reflect.apply(cancel, this, args));
  });
  vi.spyOn(body, "getReader").mockImplementation(function (this: typeof body, options) {
    if (options !== undefined) refuse("unexpected catalog reader mode");
    const reader = Reflect.apply(getReader, this, []) as ReadableStreamDefaultReader<Uint8Array>;
    row.readers.push({ unlock: vi.spyOn(reader, "releaseLock") });
    const read = reader.read, cancelReader = reader.cancel;
    vi.spyOn(reader, "read").mockImplementation(function (this: typeof reader) {
      return invokeOperation(row, "read", () => Reflect.apply(read, this, []));
    });
    vi.spyOn(reader, "cancel").mockImplementation(function (this: typeof reader, ...args) {
      return invokeOperation(row, "cancel", () => Reflect.apply(cancelReader, this, args));
    });
    return reader;
  });
}

afterEach(async () => {
  const results = await Promise.allSettled(observations.map(joinTransport));
  const failures: unknown[] = results.filter((item): item is PromiseRejectedResult => item.status === "rejected").map(item => item.reason);
  for (const restore of [() => vi.restoreAllMocks(), () => vi.unstubAllGlobals(), () => vi.unstubAllEnvs(), () => clearLiveCatalogCacheForTests()]) {
    try { restore(); } catch (error) { await reportDiagnostic("restoration", error); failures.push(error); }
  }
  throwFailures(failures);
});

async function command(path: string, method = "GET", base = origin, signal?: AbortSignal) {
  const response = await originalFetch(base + path, { method, signal });
  const text = await response.text(); expect(response.status, path).toBe(200); return text;
}
async function joinTransport(row: Observation): Promise<void> {
  try { await joinOriginalTransport(row); }
  catch (error) {
    const known = cases.find(value => row.credential === "Bearer " + key(value));
    await reportDiagnostic("transport_join", error, known?.id ?? "none", "close"); throw error;
  }
}
async function joinOriginalTransport(row: Observation): Promise<void> {
  await row.closeStarted;
  const external = row.closeCalls.filter(call => call.depth === 0);
  const closes = external.flatMap(call => call.outcome && "value" in call.outcome && call.outcome.value instanceof Promise ? [call.outcome.value] : []);
  const closed = await Promise.allSettled(closes);
  const failures: unknown[] = closed.filter((item): item is PromiseRejectedResult => item.status === "rejected").map(item => item.reason);
  // Closing can append final body operations. Join each original product,
  // including any appended during a previous batch, before validating flags.
  for (let cursor = 0; cursor < row.operations.length;) {
    const batch = row.operations.slice(cursor); cursor += batch.length;
    const results = await Promise.allSettled(batch.map(operation => operation.pending));
    for (const [index, result] of results.entries()) if (result.status === "rejected") {
      const operation = batch[index]!;
      if (operation.kind !== "read" || operation.rejection?.originalTransportAbort !== true) failures.push(result.reason);
    }
  }
  failures.push(...row.synchronousFailures);
  for (const call of external) if (call.outcome && "error" in call.outcome) failures.push(call.outcome.error);
  throwFailures(failures);
  expect(external).toHaveLength(1); expect(external[0]!.receiver).toBe(row.dispatcher); expect(external[0]!.args).toEqual([]);
  expect(closes).toHaveLength(1); expect(await closes[0]).toBeNull();
  expect(row.closeCalls.map(call => [call.depth, call.args.length])).toEqual([[0, 0], [1, 1]]);
  expect(row.closeCalls[1]!.receiver).toBe(row.dispatcher); expect(typeof row.closeCalls[1]!.args[0]).toBe("function");
  expect(row.dispatcher.destroyed).toBe(true);
  if (row.guardObserved) { expect(row.operations.filter(operation => operation.kind === "lease")).toHaveLength(1); expect(row.released).toBe(true); }
  for (const reader of row.readers) { expect(reader.unlock).toHaveBeenCalledOnce(); expect(reader.unlock).toHaveReturnedTimes(1); }
  for (const body of row.bodies) expect(body.locked).toBe(false);
}
async function joined(row: Case) {
  try { return await joinCase(row); }
  catch (error) { await reportDiagnostic("worker_join", error, row.id, "retirement"); throw error; }
}
async function joinCase(row: Case) {
  const selected = observations.filter(value => value.credential === "Bearer " + key(row));
  const results = await Promise.allSettled([...selected.map(joinTransport), command("/__catalog/join/" + row.id)]);
  throwFailures(results.filter((item): item is PromiseRejectedResult => item.status === "rejected").map(item => item.reason));
  expect(selected.map(value => value.path)).toEqual(["/v1/catalog", row.route]);
  expect(selected.map(value => value.revocations)).toEqual([row.scenario === "stale" ? 1 : 0, 0]);
  const worker = results.at(-1);
  if (worker?.status !== "fulfilled" || typeof worker.value !== "string") throw new Error("missing original Worker join");
  const state = JSON.parse(worker.value);
  expect(state).toMatchObject({ calls: row.scenario === "stale" ? 0 : row.urls.length, retired: true, charged: 0 });
  for (const input of state.inputs) {
    expect(input).toMatchObject({ activeReads: 0, unlocked: true, sourceLocked: false, physicalLocked: false, pendingSettled: true });
    expect(input.eof || input.canceled || input.readRejected).toBe(true);
  }
  return state;
}
function retainedSources() {
  const rows = getLiveCatalogRetainedData();
  expect(rows.find(row => row.structure === "catalog-request")?.entries).toBe(0);
  return rows.find(row => row.structure === "catalog-source")?.entries;
}

async function fixture(run: (discover: (row: Case, signal?: AbortSignal) => Promise<ModelProviderConfig>) => Promise<void>) {
  const failures: unknown[] = []; let callbackFailure: AggregateError | undefined, phase = "facade_load";
  try {
    const { default: entry } = await loadBundledPluginFacade<{
      default: Parameters<typeof registerSingleProviderPlugin>[0];
    }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
    phase = "registration";
    const plugin = await registerSingleProviderPlugin(entry);
    expect(plugin.catalog?.run).toBeTypeOf("function");
    await withOpenClawTestState({ label: "clawrouter-public-catalog-worker" }, async state => {
      const config: OpenClawConfig = { models: { providers: { clawrouter: { baseUrl: origin + "/v1", models: [] } } } };
      const activated = new Set<Case>();
      const discover = async (row: Case, signal?: AbortSignal) => {
        diagnosticCaseId = row.id;
        await command("/__catalog/activate/" + row.id, "POST"); activated.add(row);
        const auth = { apiKey: key(row), discoveryApiKey: key(row), mode: "api_key" as const, source: "profile" as const };
        const result = await plugin.catalog!.run({ config, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir, signal,
          resolveProviderAuth: () => auth, resolveProviderApiKey: () => auth });
        if (!result || !("provider" in result) || !result.provider) throw new Error("missing registered catalog result");
        return result.provider;
      };
      phase = "body";
      try { await run(discover); } catch (error) { await reportDiagnostic("body", error, diagnosticCaseId, "assertion"); failures.push(error); }
      const joins = await Promise.allSettled([...activated].map(joined));
      for (const result of joins) if (result.status === "rejected") failures.push(result.reason);
      failures.push(...unexpected);
      phase = "state_cleanup";
      if (failures.length) { callbackFailure = new AggregateError([...failures], "catalog body or original cleanup failed"); throw callbackFailure; }
    });
  } catch (error) {
    if (callbackFailure === undefined || error !== callbackFailure) { await reportDiagnostic(phase, error); failures.push(error); }
  }
  throwFailures(failures);
}

for (const provider of providers) describe(`${provider} registered public discovery`, () => {
  it("uses its real format, preserves unknown facts and isolates authoritative empty inventory by original key", async () => {
    await fixture(async discover => {
      const row = caseFor(provider, "table"), empty = caseFor(provider, "empty");
      const first = await discover(row); await joined(row);
      expect(first.models.map(model => model.id)).toEqual([row.model]);
      const model = first.models[0];
      expect(model.cost).toBeUndefined();
      expect(model.params?.clawrouterDiscovery).toMatchObject({ provider, upstream: row.upstream });
      if (provider === "cerebras") expect(model).toMatchObject({ contextWindow: 4096, maxTokens: 512 });
      if (provider === "chutes") {
        expect(model.contextWindow).toBeUndefined(); expect(model.maxTokens).toBeUndefined();
        expect(model.params?.clawrouterDiscovery).toEqual({ provider, upstream: row.upstream, observations: {} });
      }
      if (provider === "nvidia") {
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.maxTokens).toBeUndefined(); // Suggested output budget is not an output ceiling.
        expect(model.params?.clawrouterDiscovery).toMatchObject({ observations: { metadataSource: "frozen", outputTokenBudget: expect.any(Number) } });
      }
      if (provider === "venice") expect(model).toMatchObject({ contextWindow: 1000000, maxTokens: 131072 });
      // Same endpoint and cache, no intervening clear. A second key must not
      // reuse the first owner's inventory or restore any compiled seed model.
      expect((await discover(empty)).models).toEqual([]); await joined(empty);
      expect(retainedSources()).toBe(4);
    });
  }, 120_000);

  it("denies a previously advertised offer after original-grant revocation with zero provider attempts", async () => {
    await fixture(async discover => {
      const row = caseFor(provider, "stale");
      await expect(discover(row)).rejects.toThrow(); await joined(row);
      expect(observations.find(value => value.path === row.route)).toMatchObject({ status: 503, errorCode: "upstream_grant_pool_unavailable" });
      expect(retainedSources()).toBe(1);
    });
  }, 120_000);

  it("rejects a malformed upstream catalog without partial caching or alternate dispatch", async () => {
    await fixture(async discover => {
      const row = caseFor(provider, "malformed");
      await expect(discover(row)).rejects.toThrow(); await joined(row);
      expect(observations.find(value => value.path === row.route)).toMatchObject({ status: 502, errorCode: row.native ? "invalid_model_discovery_response" : "provider_catalog_invalid" });
      expect(retainedSources()).toBe(1);
    });
  }, 120_000);

  it("rejects caller abort and joins the original shared acquisition, physical reads and dispatcher release", async () => {
    await fixture(async discover => {
      const row = caseFor(provider, "abort"), controller = new AbortController(), wait = new AbortController();
      const reason = new Error("synthetic catalog caller abort");
      const outcome = discover(row, controller.signal).then(value => ({ value }), error => ({ error }));
      const release = () => command(`/release/${row.id}`, "POST", control);
      const failures: unknown[] = [];
      try {
        await Promise.race([
          command(`/seen/${row.id}`, "GET", control, wait.signal),
          outcome.then(() => { throw new Error("acquisition ended before held physical read"); }),
        ]);
        controller.abort(reason); expect(await outcome).toEqual({ error: reason });
        const before = JSON.parse(await command(`/__catalog/state/${row.id}`));
        expect(before.retired).toBe(false);
        expect(before.inputs[0]).toMatchObject({ eof: false, canceled: false, aborted: false });
        expect(observations.find(value => value.path === row.route)?.released).toBe(false);
        // Shared live-catalog loads outlive an individual waiter. This is not a
        // physical pre-header disconnect claim. Release real I/O and join it.
        await release(); const after = await joined(row);
        expect(after.inputs.every((input: { eof: boolean; canceled: boolean }) => input.eof && !input.canceled)).toBe(true);
        expect(retainedSources()).toBe(2);
      } catch (error) { failures.push(error); }
      wait.abort();
      try { await release(); } catch (error) { failures.push(error); }
      try { await outcome; } catch (error) { failures.push(error); }
      try { await joined(row); } catch (error) { failures.push(error); }
      throwFailures(failures);
    });
  }, 120_000);
});
