import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream, streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as catalogGuard from "openclaw/plugin-sdk/ssrf-runtime";
import * as chatGuard from "../../src/agents/provider-transport-dispatcher-pool.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const origin = process.env.CLAWROUTER_EDGE_PROOF_ORIGIN!;
type Row = { id: string; api: "stream" | "streamSimple"; role: "eof" | "preabort" | "partial_abort" | "provider_error"; proxy: string; control: string };
const rows = JSON.parse(process.env.CLAWROUTER_EDGE_PROOF_CASES!) as Row[];
const admin = process.env.CLAWROUTER_EDGE_PROOF_ADMIN!;
const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
const originalFetch = globalThis.fetch, originalCatalog = catalogGuard.fetchWithSsrFGuard, originalChat = chatGuard.fetchWithProviderHttpGuard;
type Operation = { kind: string; original: Promise<unknown> };
const operations: Operation[] = [], failures: unknown[] = [];
const bodies = new Map<ReadableStream, { readers: number; cancels: number }>(), readers: Array<{ unlocks: number }> = [];
const leases: Array<{ calls: number; released: Promise<void>; settle: () => void; pooled?: boolean }> = [];
const requests: Array<{ exactOrigin: boolean; exactCredential: boolean; method: string; path: string; dispatcher: object }> = [];
const closes: Array<{ dispatcher: object; depth: number; original?: Promise<unknown>; threw: boolean }> = [];
const dispatchers = new Set<object>();
let selected: Row | undefined, passed = false, partial = false, caller: AbortSignal | undefined;
function track<T extends Promise<unknown>>(kind: string, original: T): T { operations.push({ kind, original }); void original.then(() => {}, () => {}); return original; }
function raise(errors: unknown[]) { if (errors.length === 1) throw errors[0]; if (errors.length) throw new AggregateError(errors, "edge proof body or original cleanup failed"); }
// Extracted directly by the outer offline test. Strict for ALL four controls;
// no stored-error, cancellation-name or late-abort disposition is installed.
async function drainOriginals(records: Operation[], acquisitions: Array<{ released: Promise<void> }> = []) {
  const errors: unknown[] = []; let cursor = 0, leaseCursor = 0;
  while (cursor < records.length || leaseCursor < acquisitions.length) {
    const batch = records.slice(cursor), releases = acquisitions.slice(leaseCursor);
    cursor += batch.length; leaseCursor += releases.length;
    // Original acquisition/observer, reader.closed and release promises are
    // lifecycle boundaries. Revisit work registered while any of them was pending.
    const outcomes = await Promise.allSettled([...batch.map(record => record.original), ...releases.map(record => record.released)]);
    for (const outcome of outcomes) if (outcome.status === "rejected") errors.push(outcome.reason);
  }
  raise(errors);
}
function observeBody(body: ReadableStream | null) {
  if (!body || bodies.has(body)) return;
  const bodyState = { readers: 0, cancels: 0 }; bodies.set(body, bodyState);
  const getReader = body.getReader, bodyCancel = body.cancel;
  vi.spyOn(body, "cancel").mockImplementation(function (...args) { try { const value = Reflect.apply(bodyCancel, this, args); bodyState.cancels++; return track("body_cancel", value); } catch (error) { failures.push(error); throw error; } });
  vi.spyOn(body, "getReader").mockImplementation(function (...args) {
    let reader: ReturnType<typeof getReader>;
    try { reader = Reflect.apply(getReader, this, args); } catch (error) { failures.push(error); throw error; }
    bodyState.readers++; const state = { unlocks: 0 }; readers.push(state);
    track("closed", reader.closed);
    for (const method of ["read", "cancel"] as const) {
      const original = reader[method];
      vi.spyOn(reader, method).mockImplementation(function (...values: unknown[]) { try { return track(method, Reflect.apply(original, this, values)); } catch (error) { failures.push(error); throw error; } });
    }
    const unlock = reader.releaseLock;
    vi.spyOn(reader, "releaseLock").mockImplementation(function (...values: unknown[]) { try { const value = Reflect.apply(unlock, this, values); state.unlocks++; return value; } catch (error) { failures.push(error); throw error; } });
    return reader;
  });
}
function observeDispatcher(dispatcher: object) {
  if (dispatchers.has(dispatcher)) return;
  dispatchers.add(dispatcher); let depth = 0;
  const close = Reflect.get(dispatcher, "close");
  vi.spyOn(dispatcher as { close: (...args: unknown[]) => unknown }, "close").mockImplementation(function (...args) {
    const record: typeof closes[number] = { dispatcher, depth, threw: false }; closes.push(record); depth++;
    try { const value = Reflect.apply(close, this, args); if (value instanceof Promise) { record.original = value; track("dispatcher", value); } return value; }
    catch (error) { record.threw = true; failures.push(error); throw error; }
    finally { depth--; }
  });
}
function observeTransport(...args: Parameters<typeof undici.fetch>) {
  const [input, init] = args;
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  const headers = new Headers(init?.headers !== undefined ? init.headers : typeof input === "object" && "headers" in input ? input.headers : undefined);
  const dispatcher = init?.dispatcher;
  if (!dispatcher) failures.push(new Error("unobserved original dispatcher"));
  else observeDispatcher(dispatcher);
  requests.push({ exactOrigin: url.origin === origin, exactCredential: headers.get("authorization") === `Bearer clawrouter-live-${selected!.id}-${selected!.proxy}`, method: init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET"), path: url.pathname, dispatcher: dispatcher! });
  let pending: ReturnType<typeof undici.fetch>;
  try { pending = Reflect.apply(undici.fetch, this, args); } catch (error) { failures.push(error); throw error; }
  track("transport", pending); track("response_observer", pending.then(response => observeBody(response.body), () => {}));
  return pending;
}
function observeLease<T extends ReturnType<typeof originalCatalog>>(original: T): T {
  let settle!: () => void;
  const record: typeof leases[number] = { calls: 0, released: new Promise<void>(resolve => { settle = resolve; }), settle: () => settle() }; leases.push(record);
  track("acquisition", original);
  track("lease_observer", original.then(result => {
    record.pooled = typeof result.dispatcherReused === "boolean";
    observeBody(result.response.body); const release = result.release;
    result.release = function (...args) {
      record.calls++;
      try { const pending = Reflect.apply(release, this, args); track("release", pending); void pending.then(record.settle, record.settle); return pending; }
      catch (error) { failures.push(error); record.settle(); throw error; }
    };
  }, record.settle));
  return original;
}
beforeEach(() => {
  expect(process.env.CLAWROUTER_EDGE_PROOF_SOURCE_HEAD).toBe(sourceHead);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sourceHead);
  operations.length = failures.length = leases.length = requests.length = readers.length = closes.length = 0; bodies.clear(); dispatchers.clear(); passed = partial = false; caller = undefined; selected = undefined;
  clearLiveCatalogCacheForTests();
  vi.stubEnv("LITELLM_API_KEY", "poison-unselected"); vi.stubEnv("OPENAI_API_KEY", "poison-unselected");
  const runtime = { ...undici, fetch: observeTransport };
  for (const name of ["Agent", "ProxyAgent"] as const) runtime[name] = new Proxy(undici[name], { construct(target, args, newTarget) { const value = Reflect.construct(target, args, newTarget); observeDispatcher(value); return value; } }) as never;
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", runtime);
  vi.spyOn(catalogGuard, "fetchWithSsrFGuard").mockImplementation(function (...args) { try { return observeLease(Reflect.apply(originalCatalog, this, args)); } catch (error) { failures.push(error); throw error; } });
  vi.spyOn(chatGuard, "fetchWithProviderHttpGuard").mockImplementation(function (...args) { try { return observeLease(Reflect.apply(originalChat, this, args)); } catch (error) { failures.push(error); throw error; } });
});
afterEach(async () => {
  const errors: unknown[] = [];
  try {
    await drainOriginals(operations, leases);
    expect(requests.length).toBe(selected?.role === "preabort" ? 1 : 2);
    expect(leases).toHaveLength(requests.length);
    expect(requests.every(row => row.exactOrigin && row.exactCredential)).toBe(true);
    expect(leases.every(row => row.calls === 1)).toBe(true);
    expect(readers.length).toBeGreaterThan(0); expect(readers.every(row => row.unlocks === 1)).toBe(true);
    for (const [body, state] of bodies) { expect(state.readers + state.cancels).toBeGreaterThan(0); expect(body.locked).toBe(false); }
    const catalogs = requests.filter(row => row.method === "GET" && row.path === "/v1/native/litellm/v1/models");
    expect(catalogs).toHaveLength(1);
    expect(leases.filter(row => row.pooled === false)).toHaveLength(1);
    expect(leases.filter(row => row.pooled === true)).toHaveLength(selected?.role === "preabort" ? 0 : 1);
    const external = closes.filter(row => row.depth === 0);
    const catalogClose = external.filter(row => row.dispatcher === catalogs[0].dispatcher); expect(catalogClose).toHaveLength(1);
    for (const row of external) { expect(row.threw).toBe(false); expect(row.original).toBeDefined(); expect(await row.original).toBeNull(); }
    for (const row of external) expect(Reflect.get(row.dispatcher, "destroyed")).toBe(true);
    // Inference releases its original request lease. The SDK owns the pooled
    // dispatcher's lifetime; this fixture neither closes nor credits its pool.
  } catch (error) { errors.push(error); }
  errors.push(...failures);
  for (const restore of [() => vi.restoreAllMocks(), () => vi.unstubAllGlobals(), () => vi.unstubAllEnvs(), () => clearLiveCatalogCacheForTests()]) try { restore(); } catch (error) { errors.push(error); }
  if (!passed) errors.push(new Error("original case did not pass"));
  const record = { version: 1, pin: sourceHead, id: selected?.id ?? null, api: selected?.api ?? null, role: selected?.role ?? null, body: passed, callerAborted: caller?.aborted ?? null, partial, operations: operations.length, leases: leases.length, errors: errors.length, joined: errors.length === 0 };
  try { process.stdout.write("EDGE_PROOF_V1 " + JSON.stringify(record) + "\n"); } catch (error) { errors.push(error); }
  raise(errors);
});
describe.sequential("actual registered LiteLLM on the isolated edge candidate", () => {
  for (const row of rows) it(`${row.api}/${row.role}`, async () => {
    selected = row;
    const setup = await originalFetch(`${origin}/__proof/init/${row.id}`, { method: "POST", headers: { authorization: "Bearer " + admin }, redirect: "error" });
    await setup.arrayBuffer(); expect(setup.status).toBe(204);
    const { default: plugin } = await loadBundledPluginFacade<{ default: Parameters<typeof registerSingleProviderPlugin>[0] }>({ pluginId: "litellm", artifactBasename: "index.js" });
    const provider = await registerSingleProviderPlugin(plugin);
    await withOpenClawTestState({ label: "edge-native-proof" }, async state => {
      const baseUrl = origin + "/v1/native/litellm/v1", key = `clawrouter-live-${row.id}-${row.proxy}`;
      let resolutions = 0;
      const result = await provider.catalog!.run({ config: { models: { providers: { litellm: { baseUrl, models: [] } } } }, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir,
        resolveProviderAuth: () => { throw new Error("unexpected alternate auth"); }, resolveProviderApiKey: () => { resolutions++; return { apiKey: key, discoveryApiKey: key, profileId: row.id, mode: "api_key", source: "profile" }; } });
      expect(resolutions).toBe(1); expect(result && "provider" in result && result.provider).toBeTruthy();
      if (!result || !("provider" in result) || !result.provider) throw new Error("missing real catalog");
      expect(result.provider.baseUrl).toBe(baseUrl); expect(result.provider.apiKey === key).toBe(true);
      expect(result.provider.models).toHaveLength(1);
      const model = result.provider.models[0]; expect(model.id).toBe("tenant/edge-proof");
      const controller = new AbortController(); caller = controller.signal;
      if (row.role === "preabort") controller.abort();
      const events = (row.api === "stream" ? stream : streamSimple)({ ...model, api: "openai-completions", provider: "litellm", baseUrl } as Model<"openai-completions">,
        { messages: [{ role: "user", content: "synthetic proof", timestamp: 1 }] }, { apiKey: key, maxTokens: 16, signal: controller.signal });
      for await (const event of events) if (event.type === "text_delta" && row.role === "partial_abort") { partial = true; controller.abort(); break; }
      const outcome = await events.result();
      if (row.role === "eof") expect(outcome.stopReason).toBe("stop");
      else expect(["error", "aborted"]).toContain(outcome.stopReason);
      if (row.role === "partial_abort") { expect(partial).toBe(true); expect(controller.signal.aborted).toBe(true); }
      if (row.role === "provider_error") expect(controller.signal.aborted).toBe(false);
    });
    passed = true;
  }, 20000);
});
