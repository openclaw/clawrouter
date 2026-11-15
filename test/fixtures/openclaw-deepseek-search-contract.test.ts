// Installed into the exact public SDK revision only by the native CI helper.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as guardedFetch from "../../infra/net/fetch-guard.js";
import { fetchWithRuntimeDispatcher, type DispatcherAwareRequestInit } from "../../infra/net/runtime-fetch.js";
import { registerTestPlugin } from "../../plugin-sdk/plugin-test-contracts.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { resolvePluginCapabilityCatalogContext } from "../../plugins/loader-runtime-load.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { disposePluginRegistryInstances } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../plugins/runtime/generation-state.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import type { OpenClawPluginDefinition } from "../../plugins/types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import manifest from "../../../extensions/clawrouter/openclaw.plugin.json" with { type: "json" };
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { ToolInputError } from "../tool-input-error.js";
import { createWebSearchTool } from "./web-search.js";

// BEGIN DeepSeek failure capsule.
function deepSeekFailureProtocol() {
  const pin = "82dd065e23b678e61ad497f9d57fbb4c3da10eae", prefix = "DS753_SDK_V1 ";
  const cases = ["default", "one", "ten", "empty", "fixed", "malformed", "truncated", "oversized", "non_success", "redirect", "unsafe", "encoding", "abort", "grant", "foreign", "policy", "revoked", "budget", "key", "long_query", "surrogate", "content", "country", "zero", "eleven", "fraction"];
  const phases = ["state_scope", "plugin_load", "registration", "tool", "body", "join", "worker_receipt", "registry_retirement", "complete"];
  type Pair = [number, number];
  type Row = { v: number; pin: string; caseId: string; phase: string; failurePresent: boolean; reasonDefined: boolean | null;
    failures: number; selectedRows: number | null; close: Pair | null; cancel: Pair | null; workerCommand: string };
  function validate(value: unknown): Row {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid DeepSeek capsule");
    const row = value as Row;
    if (Object.keys(row).sort().join() !== "cancel,caseId,close,failurePresent,failures,phase,pin,reasonDefined,selectedRows,v,workerCommand"
      || row.v !== 1 || row.pin !== pin || !cases.includes(row.caseId) || !phases.includes(row.phase)
      || typeof row.failurePresent !== "boolean" || !Number.isSafeInteger(row.failures) || row.failures < 0 || row.failures > 65535
      || row.failurePresent !== (row.failures > 0) || (row.failurePresent ? typeof row.reasonDefined !== "boolean" : row.reasonDefined !== null)
      || !["unknown", "fulfilled", "rejected"].includes(row.workerCommand)) throw new Error("invalid DeepSeek capsule identity");
    if (row.selectedRows !== null && (!Number.isSafeInteger(row.selectedRows) || row.selectedRows < 0 || row.selectedRows > 65535)) throw new Error("invalid selected-row count");
    for (const pair of [row.close, row.cancel]) if (pair !== null && (!Array.isArray(pair) || pair.length !== 2
      || pair.some(n => !Number.isSafeInteger(n) || n < 0 || n > 65535))) throw new Error("invalid original outcomes");
    if ((row.close === null) !== (row.cancel === null) || (row.selectedRows === null && row.close !== null)) throw new Error("unbound original outcomes");
    if (new TextEncoder().encode(JSON.stringify(row)).length > 640) throw new Error("DeepSeek capsule bound");
    return row;
  }
  function parse(text: string) {
    const rows: Row[] = [];
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error("DeepSeek input bound");
    for (const line of text.split(/\r?\n/)) {
      const start = line.indexOf(prefix); if (start < 0) continue;
      const bytes = line.slice(start + prefix.length), value = JSON.parse(bytes);
      if (JSON.stringify(value) !== bytes) throw new Error("noncanonical DeepSeek capsule");
      rows.push(validate(value)); if (rows.length > 26) throw new Error("DeepSeek capsule count");
    }
    return rows;
  }
  function owner(caseId: string, write: (line: string) => unknown) {
    let phase = "state_scope", first: { phase: string; error: unknown } | undefined, failures = 0;
    let selected: Set<object> | undefined, workerCommand = "unknown", finished = false;
    const outcomes = new Map<object, { close: Pair; cancel: Pair }>(), faults: unknown[] = [];
    const protect = (run: () => void) => { try { run(); } catch (error) { faults.push(error); } };
    return {
      at(value: string) { phase = value; },
      failed(error: unknown) { first ??= { phase, error }; failures++; },
      select(rows: object[]) { protect(() => { if (selected) throw new Error("repeated original join"); selected = new Set(rows); if (selected.size !== rows.length) throw new Error("aliased selected row"); }); },
      transport(row: object, close: PromiseSettledResult<unknown>[], cancel: PromiseSettledResult<unknown>[]) {
        protect(() => {
          if (!selected?.has(row) || outcomes.has(row)) throw new Error("foreign or repeated selected row");
          const count = (values: PromiseSettledResult<unknown>[]): Pair => [values.filter(value => value.status === "fulfilled").length, values.filter(value => value.status === "rejected").length];
          outcomes.set(row, { close: count(close), cancel: count(cancel) });
        });
      },
      worker(status: string) { workerCommand = status; },
      finish() {
        if (finished) return []; finished = true;
        protect(() => {
          const complete = selected !== undefined && outcomes.size === selected.size && faults.length === 0;
          const sum = (key: "close" | "cancel"): Pair => [...outcomes.values()].reduce<Pair>((pair, row) => [pair[0] + row[key][0], pair[1] + row[key][1]], [0, 0]);
          const row = validate({ v: 1, pin, caseId, phase: first?.phase ?? "complete", failurePresent: first !== undefined,
            reasonDefined: first ? first.error !== undefined : null, failures, selectedRows: selected?.size ?? null,
            close: complete ? sum("close") : null, cancel: complete ? sum("cancel") : null, workerCommand });
          write(prefix + JSON.stringify(row) + "\n");
        });
        return faults;
      },
    };
  }
  return { pin, prefix, cases, validate, parse, owner };
}
// END DeepSeek failure capsule.
const failureProtocol = deepSeekFailureProtocol();

const expectedHead = "82dd065e23b678e61ad497f9d57fbb4c3da10eae";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const control = process.env.CLAWROUTER_CONTRACT_CONTROL!;
const nativePath = "/v1/native/deepseek/v1/tools/search";
const query = "site:example.com synthetic search";
const nativeFetch = globalThis.fetch;
const originalGuard = guardedFetch.fetchWithSsrFGuard;
const key = (name: string) => `clawrouter-live-ds_${name}-fixture-secret`;
type Observation = {
  path: string;
  credential: string;
  releaseReturned: boolean;
  failedBeforeResponse: boolean;
  deadlineAt?: number;
  signal?: AbortSignal | null;
  dispatcher?: DispatcherAwareRequestInit["dispatcher"];
  closes: Array<{ receiver: DispatcherAwareRequestInit["dispatcher"]; argumentCount: number; result: unknown }>;
  body?: ReadableStream<Uint8Array> | null;
  cancels: Array<Promise<unknown>>;
  readers: Array<{ reader: ReadableStreamDefaultReader<Uint8Array>; unlock: ReturnType<typeof vi.spyOn> }>;
  done: Promise<unknown>;
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
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(expectedHead);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(expectedHead);
  observations.length = 0;
  unexpected.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== origin) refuse("unexpected client egress");
    // Preserve the actual init, including its dispatcher, signal and body.
    return nativeFetch(input, init);
  });
  const observeGuard: typeof originalGuard = async options => {
    if (options.dispatcherPool) refuse("unexpected pooled Search dispatcher");
    const url = new URL(String(options.url));
    if (url.origin !== origin || !["/v1/catalog", nativePath].includes(url.pathname) || url.search) refuse("unexpected Search route");
    const headers = new Headers(options.init?.headers);
    if (headers.has("x-api-key") || headers.has("x-deepseek-api-key")) refuse("client forwarded a vendor credential override");
    const credential = headers.get("authorization") ?? "";
    if (observations.some(row => row.path === url.pathname && row.credential === credential)) refuse("repeated Search route");
    let finished!: (value?: unknown) => void;
    const row: Observation = { path: url.pathname, credential, releaseReturned: false, failedBeforeResponse: false,
      deadlineAt: options.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs,
      closes: [], cancels: [], readers: [], done: new Promise(resolve => { finished = resolve; }) };
    observations.push(row);
    try {
      const result = await originalGuard({ ...options,
        policy: ssrfRuntime.ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin),
        fetchImpl: async (input, supplied) => {
          const init = supplied as DispatcherAwareRequestInit | undefined;
          if (!init?.dispatcher || row.dispatcher) throw new Error("missing or repeated real dispatcher");
          row.dispatcher = init.dispatcher;
          row.signal = init.signal;
          // Undici's promise overload recursively calls close(callback). Observe
          // only the external call and return its original promise unchanged.
          const dispatcher = init.dispatcher, close = dispatcher.close;
          let closeDepth = 0;
          vi.spyOn(dispatcher, "close").mockImplementation(function (this: typeof dispatcher, ...args) {
            const external = closeDepth === 0;
            closeDepth++;
            try {
              const result = Reflect.apply(close, this, args);
              if (external) row.closes.push({ receiver: this, argumentCount: args.length, result });
              return result;
            } finally { closeDepth--; }
          });
          return fetchWithRuntimeDispatcher(input, init);
        },
      });
      if (url.pathname === "/v1/catalog" && result.response.ok) {
        try {
          const catalog = await result.response.clone().json();
          const provider = catalog.providers.find((value: { id: string }) => value.id === "deepseek");
          const offers = provider?.offers.filter((value: { endpoint: string }) => value.endpoint === "search") ?? [];
          expect(offers.some((value: { routeKind: string }) => value.routeKind === "manifest")).toBe(false);
          if (!/ds_(grant|foreign|policy|budget)-/.test(credential)) {
            expect(catalog.scope).toMatchObject({ authType: "proxy_key", credentialId: credential.split("-")[2] });
            expect(offers).toEqual([expect.objectContaining({ routeKind: "native", route: nativePath, modelId: null, eligible: true })]);
          }
          // The real catalog was produced before the real grant revocation.
          // Return the unmodified response; only the following POST must refuse.
          if (credential === `Bearer ${key("revoked")}`) await command("/__deepseek/revoke/ds_revoked", "POST");
        } catch (error) {
          const failures = [error];
          try { await result.response.body?.cancel(); } catch (failure) { failures.push(failure); }
          try { await result.release(); } catch (failure) { failures.push(failure); }
          if (failures.length > 1) throw new AggregateError(failures, "catalog observation or cleanup failed");
          throw error;
        }
      }
      row.body = result.response.body;
      if (row.body) {
        const body = row.body, cancel = body.cancel.bind(body);
        const getReader = body.getReader.bind(body) as () => ReadableStreamDefaultReader<Uint8Array>;
        vi.spyOn(body, "cancel").mockImplementation(reason => {
          const actual = cancel(reason); row.cancels.push(actual); return actual;
        });
        vi.spyOn(body, "getReader").mockImplementation(options => {
          expect(options).toBeUndefined(); // The pinned SDK uses the default reader.
          const reader = getReader();
          row.readers.push({ reader, unlock: vi.spyOn(reader, "releaseLock") });
          const cancelReader = reader.cancel.bind(reader);
          vi.spyOn(reader, "cancel").mockImplementation(reason => {
            const actual = cancelReader(reason); row.cancels.push(actual); return actual;
          });
          return reader;
        });
      }
      return { ...result, release: async () => {
        try { await result.release(); row.releaseReturned = true; finished(); }
        catch (error) { finished({ error }); throw error; }
      } };
    } catch (error) { row.failedBeforeResponse = true; finished({ error }); throw error; }
  };
  // Capability discovery imports the source guard through provider-http;
  // Search imports its SDK facade. Both enter the same genuine implementation.
  vi.spyOn(guardedFetch, "fetchWithSsrFGuard").mockImplementation(observeGuard);
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(observeGuard);
});

afterEach(() => { vi.restoreAllMocks(); expect(unexpected).toEqual([]); });

async function join(name: string, evidence: ReturnType<typeof failureProtocol.owner>) {
  const selected = observations.filter(row => row.credential.startsWith(`Bearer clawrouter-live-ds_${name}-`));
  evidence.select(selected);
  const transport = selected.map(async row => {
    const completion = await row.done;
    // Join every original close/cancel before checking the observation contract.
    const [closures, cancellations] = await Promise.all([
      Promise.allSettled(row.closes.map(entry => entry.result)),
      Promise.allSettled(row.cancels),
    ]);
    evidence.transport(row, closures, cancellations);
    expect(row.dispatcher).toBeDefined();
    expect(row.closes).toHaveLength(1);
    expect(row.closes[0].receiver).toBe(row.dispatcher);
    expect(row.closes[0].argumentCount).toBe(0);
    expect(row.closes[0].result).toBeInstanceOf(Promise);
    expect(closures).toEqual([{ status: "fulfilled", value: null }]);
    expect(row.dispatcher!.closed || row.dispatcher!.destroyed).toBe(true);
    if (row.failedBeforeResponse) {
      expect(name).toBe("abort");
      expect(completion).toHaveProperty("error");
    } else {
      expect(completion).toBeUndefined();
      expect(row.releaseReturned).toBe(true);
      // These are the SDK's own unawaited cancel promises. The test joins them
      // after execute/release; it does not change the SDK's ordering.
      expect(cancellations.every(value => value.status === "fulfilled")).toBe(true);
      for (const entry of row.readers) expect(entry.unlock).toHaveBeenCalledOnce();
      expect(row.body?.locked ?? false).toBe(false);
    }
  });
  // Attempt every original transport and the Worker join before any one
  // observation failure can prevent another owned resource's cleanup.
  const results = await Promise.allSettled([...transport, command(`/__deepseek/join/ds_${name}`)]);
  evidence.worker(results[results.length - 1].status);
  const failures = results.filter((value): value is PromiseRejectedResult => value.status === "rejected").map(value => value.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Search transport or Worker join failed");
  const worker = results.at(-1);
  if (worker?.status !== "fulfilled" || typeof worker.value !== "string") throw new Error("missing Worker join result");
  evidence.at("worker_receipt");
  const state = JSON.parse(worker.value);
  expect(selected.map(row => row.path)).toEqual(state.paths);
  expect(state).toMatchObject({ retired: true, charged: 0 });
  if (state.calls) {
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
}

async function fixture(name: string, run: (execute: (args?: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>) => Promise<void>) {
  const failures: unknown[] = [];
  const evidence = failureProtocol.owner(name, line => process.stdout.write(line));
  let callbackFailed = false;
  let callbackFailure: unknown;
  try { await withOpenClawTestState({ label: "clawrouter-deepseek-worker", env: {
    OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../../extensions", import.meta.url)),
    CLAWROUTER_API_KEY: undefined, DEEPSEEK_API_KEY: "must-not-fallback-deepseek",
    HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined,
    http_proxy: undefined, https_proxy: undefined, all_proxy: undefined,
  } }, async state => {
    const config: OpenClawConfig = {
      tools: { web: { search: { provider: "clawrouter", cacheTtlMinutes: 0 } } },
      plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
      models: { providers: {
        clawrouter: { baseUrl: `${origin}/v1`, apiKey: name === "key" ? "clawrouter-live-ds_key-invalid" : key(name), models: [],
          headers: { "X-API-Key": "must-not-fallback", "X-DeepSeek-API-Key": "must-not-fallback" } },
        deepseek: { baseUrl: "https://api.deepseek.com", apiKey: "must-not-fallback", models: [] },
      } },
    };
    // The synchronous public-artifact loader has a separate module graph from
    // Vitest. Use the pinned SDK's fixture loader after installing the spies,
    // then the real registration API and request-owned registry scope. This
    // keeps the unchanged AgentTool caller and the plugin's actual factories
    // on the same guarded-fetch instance; no provider result is substituted.
    evidence.at("plugin_load");
    const { default: plugin } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
      pluginId: "clawrouter", artifactBasename: "index.js",
    });
    if (!plugin.register) throw new Error("missing actual ClawRouter registration");
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime(), resolveCapabilityCatalogContext: resolvePluginCapabilityCatalogContext,
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: manifest.id, source: fileURLToPath(new URL("../../../extensions/clawrouter/index.ts", import.meta.url)),
      rootDir: fileURLToPath(new URL("../../../extensions/clawrouter", import.meta.url)),
      origin: "bundled", enabled: true, configSchema: true, contracts: manifest.contracts,
    });
    try {
      evidence.at("registration");
      registerTestPlugin({ registry: builder, config, record, register: plugin.register });
      expect(builder.registry.diagnostics.filter(row => row.level === "error")).toEqual([]);
      expect(builder.registry.webSearchProviders.map(row => [row.pluginId, row.provider.id])).toEqual([["clawrouter", "clawrouter"]]);
      await withPluginRuntimeGenerationRegistryScope(builder.registry, async () => {
        evidence.at("tool");
        const tool = createWebSearchTool({ config, agentDir: state.agentDir() });
        if (!tool) throw new Error("missing actual registered Search tool");
        const execute = async (args: Record<string, unknown> = {}, signal?: AbortSignal) => {
          const result = await tool.execute("worker-deepseek-search", { query, ...args }, signal);
          expect(JSON.stringify(result)).not.toMatch(/fixture-secret|must-not-fallback|managed-ds_/);
          return result.details as Record<string, unknown>;
        };
        evidence.at("body");
        try { await run(execute); } catch (error) { failures.push(error); evidence.failed(error); }
        evidence.at("join");
        try { await join(name, evidence); } catch (error) { failures.push(error); evidence.failed(error); }
      });
    } catch (error) { failures.push(error); evidence.failed(error); }
    evidence.at("registry_retirement");
    try {
      const retired = await disposePluginRegistryInstances(builder.registry, undefined, { cfg: config });
      expect(retired.failures).toEqual([]);
      expect(retired.deferredPluginIds ?? []).toEqual([]);
    } catch (error) { failures.push(error); evidence.failed(error); }
    evidence.at("state_scope");
    if (failures.length) {
      callbackFailed = true;
      callbackFailure = failures.length === 1 ? failures[0] : new AggregateError(failures, "Search assertion or original cleanup failed");
      throw callbackFailure;
    }
  }); } catch (error) {
    // Test-state cleanup can throw before it rethrows the callback failure.
    // Keep both; still throw inside the callback so its retention guard runs.
    if (!callbackFailed || error !== callbackFailure) { failures.push(error); evidence.failed(error); }
  }
  failures.push(...evidence.finish());
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Search assertion or original cleanup failed");
}

describe("published OpenClaw DeepSeek Search through the real native catalog", () => {
  it.each([["default", undefined], ["one", 1], ["ten", 10]] as const)("%s count returns complete nonempty metadata", async (name, count) => {
    await fixture(name, async execute => {
      const result = await execute(count === undefined ? {} : { count });
      expect(result).toMatchObject({ kind: "results", provider: "clawrouter", count: 1, results: [{
        title: expect.stringContaining("Synthetic result"), url: "https://example.com/result", snippet: expect.stringContaining("Synthetic summary"),
        published: "2026-11-01T00:00:00Z", siteName: expect.stringContaining("Example"),
      }], externalContent: { untrusted: true, wrapped: true, provider: "clawrouter" } });
      expect(JSON.stringify(result)).not.toContain("Lower-priority snippet");
    });
  }, 120_000);

  it.each(["empty", "fixed"])("%s returns complete empty results without changing billing authority", async name => {
    await fixture(name, async execute => {
      expect(await execute()).toMatchObject({ kind: "results", provider: "clawrouter", count: 0, results: [] });
    });
  }, 120_000);

  it.each(["grant", "foreign", "policy", "revoked", "budget", "key"])("%s denial never makes a paid POST", async name => {
    await fixture(name, async execute => {
      expect(await execute()).toMatchObject({ kind: "error", provider: "clawrouter" });
      expect((await join(name)).calls).toBe(0);
    });
  }, 120_000);

  it.each([
    ["long_query", { query: "x".repeat(129) }], ["surrogate", { query: "\ud800" }],
    ["content", { need_content: true }], ["country", { country: "US" }],
  ] as const)("%s input is rejected before paid egress", async (name, args) => {
    await fixture(name, async execute => {
      expect(await execute(args)).toMatchObject({ kind: "error", provider: "clawrouter" });
      expect((await join(name)).calls).toBe(0);
    });
  }, 120_000);

  it.each([["zero", 0], ["eleven", 11], ["fraction", 1.5]] as const)("%s count is rejected before catalog or paid egress", async (name, count) => {
    await fixture(name, async execute => {
      await expect(execute({ count })).rejects.toThrow(ToolInputError);
      expect(observations).toEqual([]);
      expect(await join(name)).toMatchObject({ paths: [], calls: 0 });
    });
  }, 120_000);

  it.each(["malformed", "truncated", "oversized", "non_success", "redirect", "unsafe", "encoding"])("%s refuses partial success, alternate routes and retries", async name => {
    await fixture(name, async execute => {
      expect(await execute()).toMatchObject({ kind: "error", provider: "clawrouter" });
      expect(observations.map(row => row.path)).toEqual(["/v1/catalog", nativePath]);
    });
  }, 120_000);

  it("caller abort after upstream start joins the original transport and conservative settlement", async () => {
    await fixture("abort", async execute => {
      const controller = new AbortController(), waiting = new AbortController();
      const reason = new Error("synthetic Search caller abort");
      const outcome = execute({}, controller.signal).then(value => ({ value }), error => ({ error }));
      try {
        await Promise.race([
          command("/seen", "GET", control, waiting.signal),
          outcome.then(() => { throw new Error("search ended before upstream acquisition"); }),
        ]);
        const request = observations.find(row => row.path === nativePath);
        if (!request?.signal || request.deadlineAt === undefined) throw new Error("missing original transport signal or deadline");
        expect(request.signal.aborted).toBe(false);
        expect(performance.now()).toBeLessThan(request.deadlineAt);
        controller.abort(reason);
        // Observe the signal actually supplied to the real runtime fetch, not
        // the tool's later error projection. A timeout has a different reason.
        expect(request.signal.aborted).toBe(true);
        expect(request.signal.reason).toBe(reason);
        expect(await outcome).toEqual({ error: reason });
        const state = await join("abort");
        expect(state.canceled || state.readRejected).toBe(true);
        expect(await command("/closed", "GET", control)).toBe("closed");
        // Every original physical join must precede the unchanged provider
        // deadline; eventual timeout cleanup cannot satisfy caller-abort proof.
        expect(performance.now()).toBeLessThan(request.deadlineAt);
      } finally {
        waiting.abort(); controller.abort(reason);
        await outcome;
      }
    });
  }, 120_000);
});
