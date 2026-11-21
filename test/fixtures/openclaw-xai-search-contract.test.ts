import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as guardedTransport from "../../src/infra/net/fetch-guard.js";
import { createWebSearchTool } from "../../src/agents/tools/web-search.js";
import { createCapturedPluginRegistration } from "../../src/plugins/captured-registration.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope, getPluginRuntimeGenerationRegistry } from "../../src/plugins/runtime/generation-scope.js";
import { resolvePluginWebSearchProviders } from "../../src/plugins/web-search-providers.runtime.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { describe, expect, it, vi } from "vitest";

/* OWNED_LIFETIME_IMPLEMENTATION */

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const phase = process.env.CLAWROUTER_XAI_SEARCH_PHASE;
assert.ok(phase === "native" || phase === "manifest");
const searchPath = phase === "native" ? "/v1/native/xai/v1/responses" : "/v1/proxy/xai/responses";
const token = (id: string) => "clawrouter-live-xsearch_" + id + "-fixture-secret";
const originalGuard = guardedTransport.fetchWithSsrFGuard;
const noCatalog = new Set(["preabort", "blank", "count"]);
const noSearch = new Set([...noCatalog, "invalid", "foreign", "budget", "revoked", "retired"]);

function observedGuard(lifetime: any, bindings: any) {
  return function (this: unknown, ...args: Parameters<typeof originalGuard>) {
    const options = args[0], kind = options.url === origin + "/v1/catalog" ? "catalog" : "chat";
    let owner;
    try { owner = bindings.claim(options.url, options.init, kind); }
    catch (error) { lifetime.errors.push(error); throw error; }
    lifetime.signal(owner, options.signal ?? options.init?.signal);
    return lifetime.guard(originalGuard, this, args, owner);
  };
}

async function runCase(id: string, body: (execute: (args?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>, lifetime: any, bindings: any) => Promise<void>) {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let succeeded = false;
  const bindings = createRequestBindings();
  const lifetime = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => succeeded });
  await preserveFailures(async () => {
    state = await createOpenClawTestState({ label: "clawrouter-xai-search", applyEnv: true,
      env: { CLAWROUTER_API_KEY: undefined, XAI_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback",
        HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, all_proxy: undefined } });
    assert.equal(process.env.CLAWROUTER_API_KEY, undefined);
    assert.equal(process.env.XAI_API_KEY, "must-not-fallback");
    const key = id === "invalid" ? "clawrouter-live-xsearch_success-invalid" : token(id);
    const config = { plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
      tools: { web: { search: { provider: "clawrouter", cacheTtlMinutes: 0 } } },
      models: { providers: { clawrouter: { baseUrl: origin + "/v1", apiKey: key, models: [] },
        xai: { baseUrl: "https://unused-upstream.example", apiKey: "must-not-fallback", models: [] } } } };
    const captured = createCapturedPluginRegistration();
    const facade = await loadBundledPluginFacade<{ default: { register: (api: typeof captured.api) => void } }>({ pluginId: "clawrouter", artifactBasename: "index.ts" });
    facade.default.register(captured.api);
    const providers = captured.webSearchProviders.filter(provider => provider.id === "clawrouter");
    assert.equal(providers.length, 1, "one actual registered web_search provider");
    const rootDir = fileURLToPath(new URL(".", import.meta.url));
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.webSearchProviders = providers.map(provider => ({ pluginId: "clawrouter", source: "fixture", rootDir, provider }));
    const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [{ id: "clawrouter", rootDir,
      providers: ["clawrouter"], contracts: { webSearchProviders: ["clawrouter"] } }] });
    vi.spyOn(guardedTransport, "fetchWithSsrFGuard").mockImplementation(observedGuard(lifetime, bindings));
    const previous = getPluginRuntimeGenerationRegistry();
    await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, async () => {
      await Promise.resolve(); assert.strictEqual(getPluginRuntimeGenerationRegistry(), pluginRegistry);
      const selected = resolvePluginWebSearchProviders({ config, onlyPluginIds: ["clawrouter"] });
      assert.equal(selected.length, 1); assert.strictEqual(selected[0].createTool, providers[0].createTool);
      const tool = createWebSearchTool({ config, agentDir: state!.agentDir(), assertInvocationCurrent() {
        if (id === "retired" && lifetime.guards.some((row: any) => row.owner.kind === "catalog" && row.releaseCalls > 0)) throw new Error("retired synthetic xAI search invocation");
      } });
      assert.ok(tool);
      const execute = (args: Record<string, unknown> = {}, signal?: AbortSignal) => {
        if (!noCatalog.has(id)) bindings.expect(id, "catalog", origin + "/v1/catalog", "GET", key, signal);
        if (!noSearch.has(id)) {
          const owner = bindings.expect(id, "chat", origin + searchPath, "POST", key, signal);
          owner.callerObservation = {}; lifetime.signal(owner.callerObservation, signal);
        }
        return tool.execute("xai-search-" + id, { query: "synthetic query", count: 2, ...args }, signal);
      };
      await body(execute, lifetime, bindings);
    });
    assert.strictEqual(getPluginRuntimeGenerationRegistry(), previous);
    assert.equal(lifetime.guards.length, noCatalog.has(id) ? 0 : noSearch.has(id) ? 1 : 2, id + " original catalog/search acquisitions");
    assert.ok(lifetime.guards.every((row: any) => row.acquired && row.releaseCalls === 1), id + " original acquisition and release");
    succeeded = true;
  }, [() => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(), () => state?.cleanup()]);
  if (id === "cancel") console.log("XAI_SEARCH_CANCEL_RETIRED " + phase);
}

async function waitForOriginalRead(lifetime: any, owner: any) {
  for (let attempt = 0; attempt < 1500; attempt++) {
    const reader = lifetime.readers.find((row: any) => row.owner === owner);
    const delivered = lifetime.operations.find((op: any) => op.reader === reader && op.kind === "reader.read" && op.state === "fulfilled" && op.value?.done === false && op.value.value?.byteLength > 0);
    const pending = lifetime.operations.find((op: any) => op.reader === reader && op.kind === "reader.read" && op.state === "pending");
    if (reader && delivered && pending) { lifetime.partial(owner); return; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("xAI Search original response never reached a pending read after delivered bytes");
}

function originalLimitEvidence(lifetime: any, bindings: any) {
  const owners = bindings.bindings.filter((row: any) => row.id === "oversized" && row.kind === "chat" && row.claimed);
  assert.equal(owners.length, 1); const owner = owners[0];
  const acquisitions = lifetime.guards.filter((row: any) => row.owner === owner);
  assert.equal(acquisitions.length, 1); const acquisition = acquisitions[0]; assert.equal(acquisition.acquired, true);
  const readers = lifetime.readers.filter((row: any) => row.owner === owner && row.acquisition === acquisition);
  assert.equal(readers.length, 1); const reader = readers[0];
  assert.strictEqual(reader.body, acquisition.result.response.body); assert.strictEqual(reader.receivedBody, reader.body);
  const reads = lifetime.operations.filter((op: any) => op.reader === reader && op.kind === "reader.read");
  let readBytes = 0;
  for (const op of reads) {
    assert.strictEqual(op.owner, owner); assert.strictEqual(op.acquisition, acquisition); assert.strictEqual(op.receiver, reader.reader);
    assert.ok(op.pending && typeof op.pending.then === "function"); assert.equal(op.state, "fulfilled");
    if (op.value.done === false) { assert.ok(ArrayBuffer.isView(op.value.value)); readBytes += op.value.value.byteLength; }
  }
  assert.ok(Number.isSafeInteger(readBytes) && readBytes > 1024 * 1024);
  return { id: "oversized", limitBytes: 1024 * 1024, readBytes, readOperations: reads.length, readerCount: 1 };
}

describe("registered xAI Search through Worker and SQLite", { concurrent: false }, () => {
  it("keeps metadata and provider ownership across async scopes without fallback", () => runCase("preabort", async () => {
    const current = getPluginRuntimeGenerationRegistry()!;
    const rootDir = fileURLToPath(new URL(".", import.meta.url));
    const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [{ id: "clawrouter", rootDir,
      providers: ["clawrouter"], contracts: { webSearchProviders: ["clawrouter"] } }] });
    const empty = createEmptyPluginRegistry(), foreign = createEmptyPluginRegistry();
    foreign.webSearchProviders.push({ ...current.webSearchProviders[0], pluginId: "foreign" });
    const options = { onlyPluginIds: ["clawrouter"] };
    await Promise.all([empty, foreign].map(pluginRegistry => withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, async () => {
      await Promise.resolve(); assert.strictEqual(getPluginRuntimeGenerationRegistry(), pluginRegistry);
      assert.deepEqual(resolvePluginWebSearchProviders(options), []);
      await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: current }, async () => {
        await Promise.resolve(); assert.equal(resolvePluginWebSearchProviders(options).length, 1);
      });
      assert.strictEqual(getPluginRuntimeGenerationRegistry(), pluginRegistry);
    })));
    assert.strictEqual(getPluginRuntimeGenerationRegistry(), current);
    let threw = false;
    try { withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: empty }, () => { throw undefined; }); }
    catch (error) { threw = true; assert.strictEqual(error, undefined); }
    assert.equal(threw, true); assert.strictEqual(getPluginRuntimeGenerationRegistry(), current);
  }));
  it.each(["success", "rotated", "count_ignored"])("selects the real Responses offer for %s", id => runCase(id, async execute => {
    const result = await execute(id === "count_ignored" ? { count: 9 } : {});
    expect(result.details).toMatchObject({ kind: "answer", provider: "clawrouter", query: "synthetic query",
      content: expect.stringContaining("Synthetic answer."), citations: [{ url: "https://example.com/source" }],
      externalContent: { untrusted: true, wrapped: true, provider: "clawrouter" } });
    expect(result.details.content).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(JSON.stringify(result)).not.toMatch(/javascript:|password|fixture-secret|synthetic-xsearch|must-not-fallback|x_posts_fetched|inlineCitations/);
  }));
  it.each(["invalid", "foreign", "budget", "revoked"])("denies %s without a paid POST", id => runCase(id, async (execute, lifetime) => {
    expect((await execute()).details).toMatchObject({ kind: "error", provider: "clawrouter" });
    if (id === "invalid") {
      const catalogs = lifetime.guards.filter((row: any) => row.owner.kind === "catalog");
      assert.equal(catalogs.length, 1); assert.equal(catalogs[0].result.response.status, 401);
    }
  }));
  it.each(["blank", "count"])("rejects %s before catalog dispatch", id => runCase(id, async execute => {
    const result = await execute(id === "blank" ? { query: " " } : { count: 11 }).then(value => ({ value }), error => ({ error }));
    if ("error" in result) expect(result.error).toBeInstanceOf(Error);
    else expect(result.value.details).toMatchObject({ kind: "error" });
  }));
  it("refuses an invocation retired after its real catalog request", () => runCase("retired", async execute => {
    await expect(execute()).rejects.toThrow("retired synthetic xAI search invocation");
  }));
  it.each(["malformed", "model_mismatch", "incomplete", "error"])("preserves %s and its original cleanup", id => runCase(id, async execute => {
    expect((await execute()).details).toMatchObject({ kind: "error", provider: "clawrouter" });
  }));
  it("bounds the original response reader and retains its completed cleanup", async () => {
    let evidence;
    await runCase("oversized", async (execute, lifetime, bindings) => {
      expect((await execute()).details).toMatchObject({ kind: "error", provider: "clawrouter" });
      evidence = originalLimitEvidence(lifetime, bindings);
    });
    console.log("XAI_SEARCH_LIMIT " + phase + " " + JSON.stringify(evidence));
  });
  it("pre-abort makes no catalog or search request", () => runCase("preabort", async execute => {
    const reason = new Error("synthetic xAI Search caller canceled");
    await expect(execute({}, AbortSignal.abort(reason))).rejects.toBe(reason);
  }));
  it("cancels after actual original bytes and a pending read", () => runCase("cancel", async (execute, lifetime, bindings) => {
    const controller = new AbortController(), reason = new Error("synthetic xAI Search caller canceled");
    const outcome = execute({}, controller.signal).then(value => ({ value }), error => ({ error }));
    const owner = bindings.bindings.find((row: any) => row.id === "cancel" && row.kind === "chat" && row.method === "POST");
    assert.ok(owner); await waitForOriginalRead(lifetime, owner); controller.abort(reason);
    const settled = await outcome; assert.ok("error" in settled); assert.strictEqual(settled.error, reason);
  }));
});
