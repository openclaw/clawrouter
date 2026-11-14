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
import { createWebSearchTool } from "./web-search.js";

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
  close?: ReturnType<typeof vi.spyOn>;
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
    const url = new URL(String(options.url));
    if (url.origin !== origin || !["/v1/catalog", nativePath].includes(url.pathname) || url.search) refuse("unexpected Search route");
    const headers = new Headers(options.init?.headers);
    if (headers.has("x-api-key") || headers.has("x-deepseek-api-key")) refuse("client forwarded a vendor credential override");
    const credential = headers.get("authorization") ?? "";
    if (observations.some(row => row.path === url.pathname && row.credential === credential)) refuse("repeated Search route");
    let finished!: (value?: unknown) => void;
    const row: Observation = { path: url.pathname, credential, releaseReturned: false, failedBeforeResponse: false,
      deadlineAt: options.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs,
      cancels: [], readers: [], done: new Promise(resolve => { finished = resolve; }) };
    observations.push(row);
    try {
      const result = await originalGuard({ ...options,
        policy: ssrfRuntime.ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin),
        fetchImpl: async (input, supplied) => {
          const init = supplied as DispatcherAwareRequestInit | undefined;
          if (!init?.dispatcher || row.dispatcher) throw new Error("missing or repeated real dispatcher");
          row.dispatcher = init.dispatcher;
          row.signal = init.signal;
          // Pass-through spy on this exact owned dispatcher, including the
          // pre-response abort path. No fake release and no global prototype patch.
          row.close = vi.spyOn(init.dispatcher, "close");
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

async function join(name: string) {
  const selected = observations.filter(row => row.credential.startsWith(`Bearer clawrouter-live-ds_${name}-`));
  const transport = selected.map(async row => {
    const completion = await row.done;
    expect(row.dispatcher).toBeDefined();
    expect(row.close).toHaveBeenCalledOnce();
    const closeResult = row.close!.mock.results[0];
    if (!closeResult) throw new Error("missing original dispatcher close result");
    expect(closeResult.type).toBe("return");
    expect(closeResult.value).toBeInstanceOf(Promise);
    await closeResult.value;
    expect(row.dispatcher!.closed || row.dispatcher!.destroyed).toBe(true);
    if (row.failedBeforeResponse) {
      expect(name).toBe("abort");
      expect(completion).toHaveProperty("error");
    } else {
      expect(completion).toBeUndefined();
      expect(row.releaseReturned).toBe(true);
      // These are the SDK's own unawaited cancel promises. The test joins them
      // after execute/release; it does not change the SDK's ordering.
      const cancellations = await Promise.allSettled(row.cancels);
      expect(cancellations.every(value => value.status === "fulfilled")).toBe(true);
      for (const entry of row.readers) expect(entry.unlock).toHaveBeenCalledOnce();
      expect(row.body?.locked ?? false).toBe(false);
    }
  });
  // Attempt every original transport and the Worker join before any one
  // observation failure can prevent another owned resource's cleanup.
  const results = await Promise.allSettled([...transport, command(`/__deepseek/join/ds_${name}`)]);
  const failures = results.filter((value): value is PromiseRejectedResult => value.status === "rejected").map(value => value.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Search transport or Worker join failed");
  const worker = results.at(-1);
  if (worker?.status !== "fulfilled" || typeof worker.value !== "string") throw new Error("missing Worker join result");
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
  await withOpenClawTestState({ label: "clawrouter-deepseek-worker", env: {
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
    const failures: unknown[] = [];
    try {
      registerTestPlugin({ registry: builder, config, record, register: plugin.register });
      expect(builder.registry.diagnostics.filter(row => row.level === "error")).toEqual([]);
      expect(builder.registry.webSearchProviders.map(row => [row.pluginId, row.provider.id])).toEqual([["clawrouter", "clawrouter"]]);
      await withPluginRuntimeGenerationRegistryScope(builder.registry, async () => {
        const tool = createWebSearchTool({ config, agentDir: state.agentDir() });
        if (!tool) throw new Error("missing actual registered Search tool");
        const execute = async (args: Record<string, unknown> = {}, signal?: AbortSignal) => {
          const result = await tool.execute("worker-deepseek-search", { query, ...args }, signal);
          expect(JSON.stringify(result)).not.toMatch(/fixture-secret|must-not-fallback|managed-ds_/);
          return result.details as Record<string, unknown>;
        };
        try { await run(execute); } catch (error) { failures.push(error); }
        try { await join(name); } catch (error) { failures.push(error); }
      });
    } catch (error) { failures.push(error); }
    try {
      const retired = await disposePluginRegistryInstances(builder.registry, undefined, { cfg: config });
      expect(retired.failures).toEqual([]);
      expect(retired.deferredPluginIds ?? []).toEqual([]);
    } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Search assertion or original cleanup failed");
  });
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
    ["zero", { count: 0 }], ["eleven", { count: 11 }], ["fraction", { count: 1.5 }],
  ] as const)("%s input is rejected before paid egress", async (name, args) => {
    await fixture(name, async execute => {
      expect(await execute(args)).toMatchObject({ kind: "error", provider: "clawrouter" });
      expect((await join(name)).calls).toBe(0);
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
