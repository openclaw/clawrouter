import { createRequire } from "node:module";
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

function configuration(row: Case): OpenClawConfig {
  return {
    plugins: { allow: ["clawrouter", alternate.id], entries: { clawrouter: { enabled: true } }, load: { paths: [alternate.file] }, slots: { memory: "none" } },
    models: { providers: { clawrouter: { baseUrl: origin, apiKey: `clawrouter-live-orm_${row.id}-fixture-secret`, models: [] } } },
    agents: { defaults: { workspace: state.workspaceDir, mediaModels: { music: { primary: `clawrouter/openrouter/${row.model}`, fallbacks: [`${alternate.id}/fixture`], timeoutMs: 120000 } } } },
  };
}
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "openrouter-music-worker", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined, CLAWROUTER_API_KEY: undefined, OPENROUTER_API_KEY: "must-not-fallback", GOOGLE_API_KEY: "must-not-fallback" } });
  alternate = writePlugin({ id: "music-alternate-fixture", dir: state.statePath("alternate"),
    registration: `api.registerMusicGenerationProvider({ id: "music-alternate-fixture", defaultModel: "fixture", capabilities: {}, async generateMusic() { await fetch(${JSON.stringify(origin + "/fixture/alternate")}); throw new Error("unexpected paid fallback"); } });` });
  await state.writeJson("alternate/openclaw.plugin.json", { id: alternate.id, contracts: { musicGenerationProviders: [alternate.id] }, configSchema: { type: "object", additionalProperties: false, properties: {} } });
  acquired = await acquirePluginRegistryForInspection({ config: configuration(cases[0]!) });
  expect(acquired.registry.musicGenerationProviders.some(row => row.provider.id === "clawrouter")).toBe(true);
});
beforeEach(() => {
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
});
afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const acquisition of acquisitions) {
      await acquisition.observed;
      const [result] = await Promise.allSettled([acquisition.pending]);
      if (result!.status === "rejected" && !(acquisition.expectedAbort && acquisition.rejectAborted && result.reason !== undefined && result.reason === acquisition.rejectReason)) failures.push(result!.reason);
    }
    const operations = [...bodyOperations, ...readers.flatMap(row => row.operations)];
    for (const row of readers) [row.closedOutcome] = await Promise.allSettled([row.closed]);
    for (const [index, result] of (await Promise.allSettled(operations.map(row => row.pending))).entries()) {
      const operation = operations[index]!;
      if (result.status !== "rejected") continue;
      const owner = readers.find(row => row.body === operation.body && (operation.kind === "body_cancel" || row.operations.includes(operation)) && ownedStoredAbort(row, result.reason));
      const expectedRead = operation.kind === "read" && operation.expectedAbort && operation.rejectAborted && result.reason !== undefined && operation.rejectReason === result.reason;
      const storedCancellation = operation.kind !== "read" && operation.expectedAbort && operation.invokeAborted && operation.invokeReason === result.reason && owner !== undefined;
      if (!expectedRead && !storedCancellation) failures.push(result.reason);
    }
    for (const row of readers) {
      if (row.closedOutcome?.status === "rejected" && !ownedStoredAbort(row, row.closedOutcome.reason)) failures.push(row.closedOutcome.reason);
      if (row.releases !== 1 || row.returned !== 1 || row.body.locked) failures.push(new Error("original SDK reader not released"));
    }
    for (const row of agents) {
      for (const result of await Promise.allSettled(row.pending)) if (result.status === "rejected") failures.push(result.reason);
      if (row.retirements !== 1 || row.pending.length !== 1) failures.push(new Error("missing exact external dispatcher retirement"));
    }
    failures.push(...observationErrors);
  } catch (error) { failures.push(error); }
  finally {
    try { if (prepared) await discardPreparedPluginGeneration(prepared.pluginGeneration); prepared = undefined; } catch (error) { failures.push(error); }
    try { if (previousRuntime) Object.defineProperty(globalThis, runtimeKey, previousRuntime); else delete globals[runtimeKey]; vi.restoreAllMocks(); resetGeneratedMediaTaskActivityForTests(); } catch (error) { failures.push(error); }
  }
  // Vitest retains the independent body failure. Never discard a cleanup rejection.
  if (failures.length) throw new AggregateError(failures, "original SDK operations or cleanup failed");
});
afterAll(async () => {
  const failures: unknown[] = [];
  try { await acquired?.release(); } catch (error) { failures.push(error); }
  try { clearPluginMetadataLifecycleCaches(); resetPluginLoaderTestStateForTest(); } catch (error) { failures.push(error); }
  try { await state?.cleanup(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "registered runtime cleanup failed");
});

for (const row of cases) it(`real registered music ${route}/${row.id}`, async () => {
  const config = configuration(row), controller = new AbortController();
  prepared = await prepareWorkspaceBuildGroup([{ agentId: "main", agentDir: state.agentDir(), workspaceDir: state.workspaceDir, config, skipCredentials: true }], "static", { includeCredentialProviders: false }, () => acquired.registry);
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
  const pending = withPluginRuntimeRegistryScope(acquired.registry, () => tool!.execute(`music-${route}-${row.id}`, args, controller.signal));
  // The observation is attached immediately; a later await never leaves a rejection unhandled.
  const outcome = pending.then(value => ({ ok: true as const, value }), reason => ({ ok: false as const, reason }));
  if (row.kind.startsWith("abort_")) {
    expect((await nativeFetch(origin + "/fixture/started?id=" + row.id)).status).toBe(204);
    controller.abort(new Error("owned caller cancellation"));
  }
  const result = await outcome;
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
// The actual tool minimum is 120s. This new case encloses that real deadline;
// the unchanged native consumer helper still owns its independent 240s ceiling.
}, row.kind === "deadline_body" ? 180000 : 120000);
