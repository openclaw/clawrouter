import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { DispatcherAwareRequestInit } from "../../src/infra/net/runtime-fetch.js";
import * as guardedFetch from "../../src/infra/net/fetch-guard.js";
import { registerSingleProviderPlugin } from "../../src/plugin-sdk/plugin-test-runtime.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";

type Scenario = "table" | "empty" | "maximum" | "policy" | "duplicate" | "totals" | "malformed" | "redirect" | "limit" | "revoked" | "rotated_old" | "rotated_new" | "grant_revoke" | "grant_rotate" | "abort";
type Case = { id: string; provider: string; scenario: Scenario; endpoint: string; format: string; status: number;
  native: boolean; path: string; route: string; models: Array<{ id: string; upstream: string }>; expected: string[]; urls: string[] };
const expectedHead = "1536faab19f2adf524b7ef1acef5c24501b35652";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const control = process.env.CLAWROUTER_CONTRACT_CONTROL!;
const cases = JSON.parse(process.env.CLAWROUTER_CONTRACT_CATALOG_CASES!) as Case[];

const originalFetch = globalThis.fetch;
const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
const originalRuntimeFetch = undici.fetch;
const originalGuard = guardedFetch.fetchWithSsrFGuard;
const key = (row: Case) => `clawrouter-live-${row.id}-${row.scenario === "rotated_new" ? "rotated-secret" : "fixture-secret"}`;
type Observation = {
  path: string; credential: string; status?: number; errorCode?: string;
  dispatcher: NonNullable<DispatcherAwareRequestInit["dispatcher"]>;
  guardObserved: boolean; released: boolean; leases: Promise<unknown>[];
  closeStarted: Promise<void>;
  closeCalls: Array<{ depth: number; args: unknown[]; outcome?: { value: unknown } | { error: unknown } }>;
  bodies: ReadableStream<Uint8Array>[]; reads: Promise<unknown>[]; cancels: Promise<unknown>[];
  readers: Array<{ unlock: ReturnType<typeof vi.spyOn> }>;
};
const observations: Observation[] = [];
const unexpected: unknown[] = [];
const caseFor = (scenario: Scenario) => {
  const row = cases.find(value => value.scenario === scenario);
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

// BEGIN catalog diagnostic protocol
const diagnosticIds = ["inventory", "maximum", "policy", "rotated_new", "duplicate", "totals", "malformed", "redirect", "limit", "revoked", "rotated_old", "grant_revoke", "grant_rotate", "abort"];
const diagnosticTestIds = new Set(["none", ...diagnosticIds]);
const diagnosticCaseIds = new Set(["none", "featherless_table", "featherless_empty", ...diagnosticIds.filter(id => id !== "inventory").map(id => "featherless_" + id)]);
const diagnosticPhases = new Set(["setup", "facade_load", "registration", "body", "native_fetch", "offer_observation", "offer_json", "provider_lookup", "routes_lookup", "offer_assert", "route_assert", "stale_revocation", "transport_join", "worker_join", "restoration", "state_cleanup", "worker_acquisition", "sdk_process", "case_verify", "worker_retirement", "sql_receipt", "upstream_contract", "producer_release", "control_close", "worker_dispose", "scratch_cleanup", "relay"]);
const diagnosticCategories = new Set(["error", "assertion", "aggregate", "undefined", "null", "unknown", "child_process", "limit"]);
const diagnosticNames = new Set(["Error", "TypeError", "RangeError", "AssertionError", "AggregateError", "AbortError", "TimeoutError", "undefined", "null", "unknown"]);
const diagnosticFields = new Set(["none", "assertion", "count", "presence", "endpoint", "methods", "path", "formats", "exit_code", "killed", "sdk_records", "suppressed", "status", "retirement", "receipt", "upstream", "close"]);
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
async function reportDiagnostic(phase: string, error: unknown, caseId = diagnosticCaseId, field = "none", values?: { expected: unknown; actual: unknown }): Promise<void> {
  // One independently bounded call for this new execution only. Reporting can
  // never replace the original failure or establish transport retirement.
  try {
    const record = failureDiagnostic("sdk", diagnosticTestId, caseId, phase, error, field);
    if (!record) return;
    if (values) for (const key of ["expected", "actual"] as const) if (diagnosticPrimitive(values[key])) record[key] = values[key];
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 2_048) return;
    const endpoint = new URL(control);
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) return;
    endpoint.pathname = "/diagnostic";
    const response = await originalFetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record), signal: AbortSignal.timeout(2_000), redirect: "error" });
    await response.arrayBuffer();
  } catch { /* Best-effort bounded reporting never masks the original throw. */ }
}

beforeEach(async context => {
  const name = context.task.name;
  diagnosticTestId = name === "replaces seeds only after a complete scan and isolates the next original key/profile" ? "inventory"
    : name === "rejects original caller abort while joining the still-owned later page and original dispatcher" ? "abort"
    : diagnosticIds.find(id => name === "accepts only the original compiled-policy intersection: " + id
      || name === "refuses " + id + " without seed fallback, partial inventory, replay or credential substitution") ?? "none";
  diagnosticCaseId = "none";
  try {
    expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(expectedHead);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(expectedHead);
    expect(cases).toHaveLength(15);
    clearLiveCatalogCacheForTests(); observations.length = 0; unexpected.length = 0;
    for (const name of ["FEATHERLESS_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(name, "must-not-fallback");
    vi.stubEnv("CLAWROUTER_API_KEY", "");
    // A plain pass-through avoids the guard's deliberate mocked-fetch bypass.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(new Request(input, init).url).origin !== origin) refuse("unexpected direct client provider egress");
      return originalFetch(input, init);
    });
    // Both native plugin and Vitest graphs consult this supported dependency hook.
    // Keep genuine constructors and call the captured installed Undici fetch.
    vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: observeRequest });
    const observeGuard: typeof originalGuard = async options => {
      const result = await originalGuard(options);
      const row = observations.find(value => value.path === new URL(String(options.url)).pathname
        && value.credential === new Headers(options.init?.headers).get("authorization"));
      if (!row) {
        const failures: unknown[] = [new Error("missing transport for observed original guard")];
        const results = await Promise.allSettled([result.response.body?.cancel(), result.release()]);
        for (const item of results) if (item.status === "rejected") failures.push(item.reason);
        throwFailures(failures);
        throw new Error("unreachable missing transport");
      }
      row.guardObserved = true;
      observeBody(result.response.body, row);
      return { ...result, release: () => {
        const pending = result.release(); row.leases.push(pending);
        void pending.then(() => { row.released = true; }, () => undefined);
        return pending;
      } };
    };
    // Supplementary only: actual transport/close evidence does not depend on a
    // namespace spy intercepting a different native module graph.
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
  const row = cases.find(value => credential === `Bearer ${key(value)}`);
  if (!row || url.origin !== origin || !["/v1/catalog", row.route].includes(url.pathname) || url.search
    || request.method !== "GET" || request.body || request.headers.has("x-api-key")) refuse("unexpected registered catalog route or key");
  if (observations.some(value => value.path === url.pathname && value.credential === credential)) refuse("repeated original catalog transport");
  const dispatcher = init?.dispatcher;
  if (!dispatcher) refuse("missing original catalog dispatcher");
  let closeStarted!: () => void;
  const observation: Observation = { path: url.pathname, credential, dispatcher, guardObserved: false, released: false, leases: [],
    closeStarted: new Promise(resolve => { closeStarted = resolve; }), closeCalls: [], bodies: [], reads: [], cancels: [], readers: [] };
  observations.push(observation);
  const close = dispatcher.close; let depth = 0;
  vi.spyOn(dispatcher, "close").mockImplementation(function (this: typeof dispatcher, ...args: unknown[]) {
    const call: Observation["closeCalls"][number] = { depth, args };
    observation.closeCalls.push(call); depth++;
    try { const value = Reflect.apply(close, this, args); call.outcome = { value }; return value; }
    catch (error) { call.outcome = { error }; throw error; }
    finally { depth--; if (call.depth === 0) closeStarted(); }
  } as typeof dispatcher.close);
  const response = await Reflect.apply(originalRuntimeFetch, undici, [input, init]) as unknown as Response;
  observation.status = response.status;
  let operation = "offer_json", field = "none", values: { expected: unknown; actual: unknown } | undefined;
  try {
    if (url.pathname === "/v1/catalog") {
      const body = await response.clone().json();
      assertRawCatalog(body, row, (next, item, expected, actual) => { operation = next; field = item; values = { expected, actual }; });
    } else if (!response.ok) observation.errorCode = (await response.clone().json()).error?.code;
  } catch (error) {
    await reportDiagnostic(operation, error, row.id, field, values);
    unexpected.push(error);
    // Start original cancellation, but let the genuine guard close transport
    // before joining it: awaiting a tee here can deadlock the error path.
    try {
      const pending = response.body?.cancel();
      if (pending) { observation.cancels.push(pending); void Promise.allSettled([pending]); }
    } catch (cleanup) { unexpected.push(cleanup); throw new AggregateError([error, cleanup], "catalog observation and cancellation failed"); }
    throw error;
  }
  observeBody(response.body, observation);
  return response;
}

type RawCatalog = { providers: Array<{ id: string; offers: Array<{ endpoint: string; routeKind: string; route: string; eligible: boolean }>;
  routes: Array<{ endpoint: string; methods: string[]; path: string; requestFormat: string; responseFormat: string }> }> };
function assertRawCatalog(body: RawCatalog, row: Case, mark: (phase: string, field: string, expected: number | boolean, actual: number | boolean) => void): void {
  mark("provider_lookup", "presence", true, Array.isArray(body.providers));
  expect(Array.isArray(body.providers)).toBe(true);
  const provider = body.providers.find(value => value.id === row.provider);
  mark("provider_lookup", "presence", true, provider !== undefined); expect(provider !== undefined).toBe(true);
  if (!provider) throw new Error("missing catalog provider");
  mark("routes_lookup", "presence", true, Array.isArray(provider.routes)); expect(Array.isArray(provider.routes)).toBe(true);
  const routes = provider.routes.filter(value => value.endpoint === row.endpoint);
  mark("offer_assert", "presence", true, Array.isArray(provider.offers)); expect(Array.isArray(provider.offers)).toBe(true);
  const offers = provider.offers.filter(value => value.endpoint === row.endpoint);
  mark("offer_assert", "count", 1, offers.length); expect(offers).toHaveLength(1);
  mark("offer_assert", "endpoint", true, offers[0]!.eligible === true && offers[0]!.routeKind === (row.native ? "native" : "manifest") && offers[0]!.route === row.route);
  expect(offers[0]!.eligible).toBe(true); expect(offers[0]!.routeKind).toBe(row.native ? "native" : "manifest"); expect(offers[0]!.route).toBe(row.route);
  mark("route_assert", "count", 1, routes.length); expect(routes).toHaveLength(1);
  mark("route_assert", "methods", true, routes[0]!.methods.length === 1 && routes[0]!.methods[0] === "GET"); expect(routes[0]!.methods).toEqual(["GET"]);
  mark("route_assert", "path", true, routes[0]!.path === row.path); expect(routes[0]!.path).toBe(row.path);
  mark("route_assert", "formats", true, routes[0]!.requestFormat === row.format && routes[0]!.responseFormat === row.format);
  expect(routes[0]!.requestFormat).toBe(row.format); expect(routes[0]!.responseFormat).toBe(row.format);
}

function observeBody(body: ReadableStream<Uint8Array> | null, row: Observation): void {
  if (!body || row.bodies.includes(body)) return;
  row.bodies.push(body);
  const cancel = body.cancel, getReader = body.getReader;
  vi.spyOn(body, "cancel").mockImplementation(function (this: typeof body, ...args) {
    const pending = Reflect.apply(cancel, this, args); row.cancels.push(pending); return pending;
  });
  vi.spyOn(body, "getReader").mockImplementation(function (this: typeof body, options) {
    if (options !== undefined) refuse("unexpected catalog reader mode");
    const reader = Reflect.apply(getReader, this, []) as ReadableStreamDefaultReader<Uint8Array>;
    row.readers.push({ unlock: vi.spyOn(reader, "releaseLock") });
    const read = reader.read, cancelReader = reader.cancel;
    vi.spyOn(reader, "read").mockImplementation(function (this: typeof reader) {
      const pending = Reflect.apply(read, this, []); row.reads.push(pending); return pending;
    });
    vi.spyOn(reader, "cancel").mockImplementation(function (this: typeof reader, ...args) {
      const pending = Reflect.apply(cancelReader, this, args); row.cancels.push(pending); return pending;
    });
    return reader;
  });
}

async function restoreTestState(steps: Array<() => unknown>): Promise<void> {
  const failures: unknown[] = [];
  for (const restore of steps) {
    try { await restore(); } catch (error) { failures.push(error); await reportDiagnostic("restoration", error); }
  }
  throwFailures(failures);
}
afterEach(() => restoreTestState([
  () => vi.restoreAllMocks(), () => vi.unstubAllGlobals(), () => vi.unstubAllEnvs(), () => clearLiveCatalogCacheForTests(),
]));

async function command(path: string, method = "GET", base = origin, signal?: AbortSignal) {
  const response = await originalFetch(base + path, { method, signal });
  const text = await response.text(); expect(response.status, path).toBe(200); return text;
}
async function joinTransport(row: Observation): Promise<void> {
  try { await joinOriginalTransport(row); }
  catch (error) {
    const known = cases.find(value => row.credential === `Bearer ${key(value)}`);
    await reportDiagnostic("transport_join", error, known?.id ?? "none", "close"); throw error;
  }
}
async function joinOriginalTransport(row: Observation): Promise<void> {
  await row.closeStarted;
  const external = row.closeCalls.filter(call => call.depth === 0);
  const closes = external.flatMap(call => call.outcome && "value" in call.outcome && call.outcome.value instanceof Promise ? [call.outcome.value] : []);
  const closed = await Promise.allSettled(closes);
  const results = [...closed, ...await Promise.allSettled([...row.reads, ...row.cancels, ...row.leases])];
  const failures: unknown[] = results.filter((item): item is PromiseRejectedResult => item.status === "rejected").map(item => item.reason);
  for (const call of external) if (call.outcome && "error" in call.outcome) failures.push(call.outcome.error);
  throwFailures(failures); // Cancellation/read/lease failures are never silently settled.
  expect(external).toHaveLength(1); expect(external[0]!.args).toEqual([]);
  expect(closes).toHaveLength(1); expect(await closes[0]).toBeNull();
  expect(row.closeCalls.map(call => [call.depth, call.args.length])).toEqual([[0, 0], [1, 1]]);
  expect(typeof row.closeCalls[1]!.args[0]).toBe("function");
  expect(row.dispatcher.destroyed).toBe(true);
  if (row.guardObserved) { expect(row.leases).toHaveLength(1); expect(row.released).toBe(true); }
  for (const reader of row.readers) expect(reader.unlock).toHaveBeenCalledOnce();
  for (const body of row.bodies) expect(body.locked).toBe(false);
}
async function joined(row: Case) {
  try { return await joinCase(row); }
  catch (error) { await reportDiagnostic("worker_join", error, row.id, "retirement"); throw error; }
}
async function joinCase(row: Case) {
  const selected = observations.filter(value => value.credential === `Bearer ${key(row)}`);
  const results = await Promise.allSettled([...selected.map(joinTransport), command(`/__catalog/join/${row.id}`)]);
  throwFailures(results.filter((item): item is PromiseRejectedResult => item.status === "rejected").map(item => item.reason));
  expect(selected.map(value => value.path)).toEqual(["/v1/catalog", row.route]);
  const worker = results.at(-1);
  if (worker?.status !== "fulfilled" || typeof worker.value !== "string") throw new Error("missing original Worker join");
  const state = JSON.parse(worker.value);
  expect(state).toMatchObject({ calls: row.urls.length, retired: true, charged: 0 });
  for (const input of state.inputs) {
    expect(input).toMatchObject({ activeReads: 0, unlocked: true, sourceLocked: false, physicalLocked: false, pendingSettled: true });
    expect(input.eof || input.canceled || input.readRejected).toBe(true);
  }
  return state;
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
    await withOpenClawTestState({ label: "clawrouter-featherless-catalog-worker" }, async state => {
      const config: OpenClawConfig = { models: { providers: { clawrouter: { baseUrl: `${origin}/v1`, models: [] } } } };
      const activated = new Set<Case>();
      const discover = async (row: Case, signal?: AbortSignal) => {
        diagnosticCaseId = row.id;
        await command(`/__catalog/activate/${row.id}`, "POST"); activated.add(row);
        const auth = { apiKey: key(row), discoveryApiKey: key(row), mode: "api_key" as const, source: "profile" as const };
        const result = await plugin.catalog!.run({ config, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir, signal,
          resolveProviderAuth: () => auth, resolveProviderApiKey: () => auth });
        if (!result || !("provider" in result) || !result.provider) throw new Error("missing registered catalog result");
        return result.provider;
      };
      phase = "body";
      try { await run(discover); } catch (error) { failures.push(error); await reportDiagnostic("body", error, diagnosticCaseId, "assertion"); }
      const joins = await Promise.allSettled([...activated].map(joined));
      for (const result of joins) if (result.status === "rejected") failures.push(result.reason);
      failures.push(...unexpected);
      phase = "state_cleanup";
      if (failures.length) { callbackFailure = new AggregateError([...failures], "catalog body or original cleanup failed"); throw callbackFailure; }
    });
  } catch (error) {
    if (callbackFailure === undefined || error !== callbackFailure) { failures.push(error); await reportDiagnostic(phase, error); }
  }
  throwFailures(failures);
}

describe("Featherless registered complete catalog", () => {
  it("replaces seeds only after a complete scan and isolates the next original key/profile", async () => {
    await fixture(async discover => {
      const row = caseFor("table");
      const first = await discover(row); await joined(row);
      expect(first.models.map(model => model.id)).toEqual(row.models.map(model => model.id).sort());
      const seed = first.models.find(model => model.id === row.models[0].id)!;
      expect(seed.cost).toBeUndefined(); expect(seed.contextWindow).toBeUndefined(); expect(seed.maxTokens).toBeUndefined();
      expect(seed.params?.clawrouterDiscovery).toMatchObject({ provider: "featherless", upstream: row.models[0].upstream });
      const qualified = first.models.find(model => model.id === row.models[1].id)!;
      expect(qualified.contextWindow).toBe(32768); expect(qualified.cost).toBeUndefined();
      const empty = caseFor("empty");
      expect((await discover(empty)).models).toEqual([]); await joined(empty);
      // No intervening cache clear: the second original proxy key cannot reuse
      // the previous owner's complete inventory or restore compiled seeds.
    });
  }, 120_000);

  for (const scenario of ["maximum", "policy", "rotated_new"] as const) it(`accepts only the original compiled-policy intersection: ${scenario}`, async () => {
    await fixture(async discover => {
      const row = caseFor(scenario), result = await discover(row); await joined(row);
      expect(result.models.map(model => model.id)).toEqual(row.expected.map(id => "featherless/" + id).sort());
      expect(result.models.some(model => model.id.includes("unlisted/"))).toBe(false);
      expect(observations.map(value => value.path)).toEqual(["/v1/catalog", row.route]);
    });
  }, 120_000);

  for (const scenario of ["duplicate", "totals", "malformed", "redirect", "limit", "revoked", "rotated_old", "grant_revoke", "grant_rotate"] as const) {
    it(`refuses ${scenario} without seed fallback, partial inventory, replay or credential substitution`, async () => {
      await fixture(async discover => {
        const row = caseFor(scenario);
        await expect(discover(row)).rejects.toThrow(); await joined(row);
        const failure = observations.find(value => value.path === row.route);
        expect(failure?.status).toBe(row.status);
        expect(failure?.errorCode).toBe(row.status === 403 ? "proxy_key_revoked" : row.status === 401 ? "invalid_proxy_key" : row.status === 503 ? "model_discovery_owner_unavailable" : "invalid_model_discovery_response");
        expect(observations.map(value => value.path)).toEqual(["/v1/catalog", row.route]);
      });
    }, 120_000);
  }

  it("rejects original caller abort while joining the still-owned later page and original dispatcher", async () => {
    await fixture(async discover => {
      const row = caseFor("abort"), controller = new AbortController(), wait = new AbortController();
      const reason = new Error("synthetic catalog caller abort");
      const outcome = discover(row, controller.signal).then(value => ({ value }), error => ({ error }));
      const release = () => command(`/release/${row.id}`, "POST", control);
      const failures: unknown[] = [];
      try {
        await Promise.race([command(`/seen/${row.id}`, "GET", control, wait.signal), outcome.then(() => { throw new Error("acquisition ended before held later page"); })]);
        controller.abort(reason); expect(await outcome).toEqual({ error: reason });
        const before = JSON.parse(await command(`/__catalog/state/${row.id}`));
        expect(before.calls).toBe(2); expect(before.retired).toBe(false);
        expect(before.inputs[0]).toMatchObject({ eof: true, unlocked: true });
        expect(before.inputs[1]).toMatchObject({ eof: false, canceled: false, aborted: false });
        expect(observations.find(value => value.path === row.route)?.closeCalls).toEqual([]);
        // Shared acquisition survives the waiter. Release real I/O; do not
        // claim a pre-header disconnect or infer closure from zero counters.
        await release(); const after = await joined(row);
        expect(after.inputs.every((input: { eof: boolean; canceled: boolean }) => input.eof && !input.canceled)).toBe(true);
      } catch (error) { failures.push(error); }
      wait.abort();
      try { await release(); } catch (error) { failures.push(error); }
      try { await outcome; } catch (error) { failures.push(error); }
      try { await joined(row); } catch (error) { failures.push(error); }
      throwFailures(failures);
    });
  }, 120_000);
});
