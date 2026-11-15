import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
type Operation = { kind: string; promise: Promise<unknown> };
type Acquisition = { kind: "catalog" | "chat"; promise: Promise<unknown>; releases: number; released: Promise<void>; markReleased: () => void };
const operations: Operation[] = [], acquisitions: Acquisition[] = [], failures: unknown[] = [];
const bodies = new Set<ReadableStream<Uint8Array>>();
const readers: Array<{ body: ReadableStream<Uint8Array>; unlocks: number }> = [];
const closes: Array<{ depth: number; original?: Promise<unknown>; threw: boolean; error?: unknown }> = [];
const dispatchers = new Set<object>();
const requests: Array<{ method: string; path: string; credential: string }> = [];
function remember<T extends Promise<unknown>>(kind: string, promise: T): T {
  operations.push({ kind, promise }); void promise.then(() => {}, () => {}); return promise;
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
    try { return remember("body_cancel", Reflect.apply(cancel, this, args)); } catch (error) { failures.push(error); throw error; }
  });
  vi.spyOn(body, "getReader").mockImplementation(function (this: typeof body, ...args) {
    const reader = Reflect.apply(get, this, args) as ReadableStreamDefaultReader<Uint8Array>;
    const record = { body, unlocks: 0 }; readers.push(record); remember("closed", reader.closed);
    for (const kind of ["read", "cancel"] as const) {
      const original = reader[kind];
      vi.spyOn(reader, kind).mockImplementation(function (this: typeof reader, ...values: unknown[]) {
        try { return remember(kind, Reflect.apply(original, this, values)); } catch (error) { failures.push(error); throw error; }
      });
    }
    const unlock = reader.releaseLock;
    vi.spyOn(reader, "releaseLock").mockImplementation(function (this: typeof reader) {
      try { const value = Reflect.apply(unlock, this, []); record.unlocks++; return value; } catch (error) { failures.push(error); throw error; }
    });
    return reader;
  });
}
function observeTransport(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init), url = new URL(request.url);
  const credential = request.headers.get("authorization") ?? "";
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
  const pending = Reflect.apply(undici.fetch, undici, [input, init]) as unknown as Promise<Response>;
  remember("native_acquisition", pending);
  remember("response_observer", pending.then(response => { observeBody(response.body); }));
  return pending;
}
function observeLease<T extends { response: Response; release: () => Promise<void> }>(kind: Acquisition["kind"], pending: Promise<T>): Promise<T> {
  let markReleased!: () => void;
  const released = new Promise<void>(resolve => { markReleased = resolve; });
  const record = { kind, promise: pending, releases: 0, released, markReleased }; acquisitions.push(record);
  remember("guard_acquisition", pending);
  // The original Promise and result object stay intact. This reaction is
  // registered before the provider's continuation and observes its own lease.
  remember("lease_observer", pending.then(result => {
    observeBody(result.response.body); const release = result.release;
    result.release = function (...args) {
      record.releases++;
      try { const value = Reflect.apply(release, this, args); remember("release", value); void value.then(markReleased, markReleased); return value; }
      catch (error) { failures.push(error); markReleased(); throw error; }
    };
  }, () => { markReleased(); }));
  return pending;
}
beforeEach(() => {
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(sourceHead);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sourceHead);
  clearLiveCatalogCacheForTests(); operations.length = 0; acquisitions.length = 0; failures.length = 0;
  bodies.clear(); readers.length = 0; closes.length = 0; dispatchers.clear(); requests.length = 0;
  for (const name of ["LITELLM_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(name, "poison-environment");
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: observeTransport });
  vi.spyOn(catalogGuard, "fetchWithSsrFGuard").mockImplementation(function (options) {
    return observeLease("catalog", Reflect.apply(originalCatalogGuard, this, [options]));
  });
  vi.spyOn(chatGuard, "fetchWithProviderHttpGuard").mockImplementation(function (options) {
    return observeLease("chat", Reflect.apply(originalChatGuard, this, [options]));
  });
});
afterEach(async () => {
  const errors: unknown[] = [];
  try {
    // A fulfilled response is not release completion. Follow each original
    // guard through its consumed release before draining dynamically added work.
    await Promise.all(acquisitions.map(row => row.released));
    await drainOriginals(operations);
    for (const row of acquisitions) { expect(row.releases).toBe(1); }
    expect(acquisitions.length).toBe(requests.length);
    for (const reader of readers) expect(reader.unlocks).toBe(1);
    for (const body of bodies) expect(body.locked).toBe(false);
    const external = closes.filter(row => row.depth === 0);
    expect(external).toHaveLength(dispatchers.size);
    for (const row of external) { expect(row.threw).toBe(false); expect(row.original).toBeDefined(); expect(await row.original).toBeNull(); }
    for (const dispatcher of dispatchers) expect(Reflect.get(dispatcher, "destroyed")).toBe(true);
    // Inference owns a pooled request lease, never the global pool lifetime.
  } catch (error) { errors.push(error); }
  errors.push(...failures);
  for (const restore of [() => vi.restoreAllMocks(), () => vi.unstubAllGlobals(), () => vi.unstubAllEnvs(), () => clearLiveCatalogCacheForTests()]) {
    try { restore(); } catch (error) { errors.push(error); }
  }
  raise(errors);
});
async function control(action: string, id: string): Promise<void> {
  const response = await originalFetch(`${origin}/__litellm/${action}/${id}`, { method: ["started", "retire"].includes(action) ? "GET" : "POST" });
  await response.arrayBuffer(); expect(response.status).toBe(200);
}
async function fixture(body: (discover: (row: Row, signal?: AbortSignal, authId?: string) => Promise<ModelProviderConfig | undefined>) => Promise<void>): Promise<void> {
  const { default: entry } = await loadBundledPluginFacade<{ default: Parameters<typeof registerSingleProviderPlugin>[0] }>({ pluginId: "litellm", artifactBasename: "index.js" });
  const provider = await registerSingleProviderPlugin(entry); expect(provider.catalog?.run).toBeTypeOf("function");
  await withOpenClawTestState({ label: "litellm-worker" }, async state => {
    const discover = async (row: Row, signal?: AbortSignal, authId = row.id) => {
      const baseUrl = origin + "/v1/native/litellm" + (row.versioned ? "/v1" : ""); let resolutions = 0;
      const auth = { apiKey: key(authId), discoveryApiKey: key(row.id), profileId: row.id, mode: "api_key" as const, source: "profile" as const };
      const result = await provider.catalog!.run({ config: { models: { providers: { litellm: { baseUrl, models: [] } } } }, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir, signal,
        resolveProviderAuth: () => { throw new Error("unexpected second auth resolver"); }, resolveProviderApiKey: () => { resolutions++; return auth; } });
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
  return (simple ? streamSimple : stream)({ ...model, provider: "litellm", api: "openai-completions", baseUrl: catalog.baseUrl } as Model<"openai-completions">,
    { messages: [{ role: "user", content: "synthetic fixture", timestamp: 1 }] }, { apiKey: key(row.id), maxTokens: 16, signal });
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
