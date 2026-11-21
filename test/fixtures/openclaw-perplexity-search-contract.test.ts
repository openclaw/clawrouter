import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as guardedTransport from "../../src/infra/net/fetch-guard.js";
import { createWebSearchTool } from "../../src/agents/tools/web-search.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { createCapturedPluginRegistration, createEmptyPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { getPluginRuntimeGenerationRegistry, withPluginRuntimeGenerationRegistryScope } from "../../src/plugins/runtime/generation-state.js";
import { resolvePluginWebSearchProviders } from "../../src/plugins/web-search-providers.runtime.js";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

/* OWNED_LIFETIME_IMPLEMENTATION */

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const routeKind = process.env.CLAWROUTER_PERPLEXITY_SEARCH_PHASE;
assert.ok(routeKind === "native" || routeKind === "manifest");
const searchPath = routeKind === "native" ? "/v1/native/perplexity/search" : "/v1/proxy/perplexity/search";
const key = (id: string) => "clawrouter-live-psearch_" + id + "-fixture-secret";
const originalGuard = guardedTransport.fetchWithSsrFGuard;
const noCatalog = new Set(["preabort", "blank", "count"]);
const noSearch = new Set([...noCatalog, "invalid", "foreign", "budget", "revoked", "utf8_over", "retired"]);

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
  try { await preserveFailures(async () => {
    state = await createOpenClawTestState({ prefix: "router-perplexity-search-", applyEnv: true, prepareProfileCatalog: false,
      env: { OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("..", import.meta.url)), CLAWROUTER_API_KEY: undefined, PERPLEXITY_API_KEY: "must-not-fallback",
        HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, all_proxy: undefined } });
    assert.equal(process.env.CLAWROUTER_API_KEY, undefined, "case credential cannot be shadowed by Router environment auth");
    assert.equal(process.env.PERPLEXITY_API_KEY, "must-not-fallback");
    const token = id === "invalid" ? "clawrouter-live-psearch_standard-invalid" : key(id);
    vi.spyOn(guardedTransport, "fetchWithSsrFGuard").mockImplementation(observedGuard(lifetime, bindings));
    const config = { tools: { web: { search: { provider: "clawrouter", cacheTtlMinutes: 0 } } },
      plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
      models: { providers: { clawrouter: { baseUrl: origin + "/v1", apiKey: token, models: [] },
        perplexity: { baseUrl: "https://unused-upstream.example", apiKey: "must-not-fallback", models: [] } } } };
    const tool = createWebSearchTool({ config, agentDir: state.agentDir(), assertInvocationCurrent() {
      if (id === "retired" && lifetime.guards.some((row: any) => row.owner.kind === "catalog" && row.releaseCalls > 0)) throw new Error("retired synthetic Search invocation");
    } });
    assert.ok(tool, "actual registered web_search tool");
    const execute = (args: Record<string, unknown> = {}, signal?: AbortSignal) => {
      if (!noCatalog.has(id)) bindings.expect(id, "catalog", origin + "/v1/catalog", "GET", token, signal);
      if (!noSearch.has(id)) {
        const owner = bindings.expect(id, "chat", origin + searchPath, "POST", token, signal);
        owner.callerObservation = {}; lifetime.signal(owner.callerObservation, signal);
      }
      return tool.execute("perplexity-search-" + id, { query: "synthetic query", count: 2, ...args }, signal);
    };
    const captured = createCapturedPluginRegistration();
    plugin.register?.(captured.api);
    const providers = captured.webSearchProviders.filter(provider => provider.id === "clawrouter");
    assert.equal(providers.length, 1, "one actual registered Search provider");
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({ pluginId: "clawrouter", provider: providers[0], source: "test" });
    const previous = getPluginRuntimeGenerationRegistry();
    await withPluginRuntimeGenerationRegistryScope(registry, async () => {
      await Promise.resolve();
      assert.strictEqual(getPluginRuntimeGenerationRegistry(), registry);
      const selected = resolvePluginWebSearchProviders({ config, onlyPluginIds: ["clawrouter"] });
      assert.equal(selected.length, 1); assert.strictEqual(selected[0].createTool, providers[0].createTool);
      await body(execute, lifetime, bindings);
    });
    assert.strictEqual(getPluginRuntimeGenerationRegistry(), previous);
    succeeded = true;
  }, [() => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(), () => state?.cleanup()]);
  } finally { if (id === "cancel") console.error("PERPLEXITY_SEARCH_CANCEL_OBSERVATION " + JSON.stringify({ v: 1, summary: lifetime.summary(), join: lifetime.joinDiagnostic() })); }
  if (id === "cancel") console.log("PERPLEXITY_SEARCH_CANCEL_RETIRED " + routeKind);
}

function assertOriginalRejection(outcome: any, reason: unknown) {
  assert.ok("error" in outcome);
  assert.strictEqual(outcome.error, reason);
}

function searchLimitEvidence(lifetime: any, bindings: any) {
  const owners = bindings.bindings.filter((owner: any) => owner.id === "oversized" && owner.kind === "chat" && owner.claimed);
  assert.equal(owners.length, 1);
  const owner = owners[0], guards = lifetime.guards.filter((guard: any) => guard.owner === owner);
  assert.equal(guards.length, 1); const acquisition = guards[0];
  assert.equal(acquisition.acquired, true);
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
  assert.ok(Number.isSafeInteger(readBytes) && readBytes > 1024 * 1024, "original SDK reader crossed its pinned 1 MiB limit");
  return { id: "oversized", limitBytes: 1024 * 1024, readBytes, readOperations: reads.length, readerCount: readers.length };
}

async function waitForOriginalRead(lifetime: any, owner: any) {
  for (let attempt = 0; attempt < 1500; attempt++) {
    const row = lifetime.readers.find((row: any) => row.owner === owner);
    const delivered = lifetime.operations.find((op: any) => op.reader === row && op.kind === "reader.read" && op.state === "fulfilled" && op.value?.done === false && op.value.value?.byteLength > 0);
    const pending = lifetime.operations.find((op: any) => op.reader === row && op.kind === "reader.read" && op.state === "pending");
    if (row && delivered && pending) { lifetime.partial(owner); return; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Search original response never reached a pending read after delivered bytes");
}

describe("registered Perplexity Search through Worker and SQLite", { concurrent: false }, () => {
  it("keeps the captured provider across async scopes without empty or foreign fallback", () => runCase("preabort", async () => {
    const registry = getPluginRuntimeGenerationRegistry()!;
    const options = { onlyPluginIds: ["clawrouter"] };
    const selected = resolvePluginWebSearchProviders(options);
    assert.equal(selected.length, 1);
    const empty = createEmptyPluginRegistry(), foreign = createEmptyPluginRegistry();
    foreign.webSearchProviders.push({ pluginId: "foreign", provider: registry.webSearchProviders[0].provider, source: "test" });
    await Promise.all([empty, foreign].map(other => withPluginRuntimeGenerationRegistryScope(other, async () => {
      await Promise.resolve(); assert.strictEqual(getPluginRuntimeGenerationRegistry(), other);
      assert.deepEqual(resolvePluginWebSearchProviders(options), []);
      await withPluginRuntimeGenerationRegistryScope(registry, async () => {
        await Promise.resolve(); assert.strictEqual(resolvePluginWebSearchProviders(options)[0].createTool, selected[0].createTool);
      });
      assert.strictEqual(getPluginRuntimeGenerationRegistry(), other);
    })));
    assert.strictEqual(getPluginRuntimeGenerationRegistry(), registry);
    let threw = false;
    try { withPluginRuntimeGenerationRegistryScope(empty, () => { throw undefined; }); } catch (error) { threw = true; assert.strictEqual(error, undefined); }
    assert.equal(threw, true); assert.strictEqual(getPluginRuntimeGenerationRegistry(), registry);
  }));
  it.each(["standard", "fixed", "spurious", "default_count", "utf8", "rotated"])("selects the actual model-less offer for %s", id => runCase(id, async execute => {
    const query = id === "utf8" ? "界".repeat(2730) + "ab" : "synthetic query";
    const result = await execute({ query, ...(id === "default_count" ? { count: undefined } : {}) });
    expect(result.details).toMatchObject({ kind: "results", provider: "clawrouter", count: 1, results: [{ url: "https://example.com/result" }], externalContent: { untrusted: true, wrapped: true } });
    expect(result.details.results[0].snippet).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(result.details.results[0].snippet).toContain("Synthetic snippet");
    expect(JSON.stringify(result)).not.toMatch(/javascript:|fixture-secret|synthetic-upstream|must-not-fallback/);
  }));
  it("bills an empty complete result once", () => runCase("empty", async execute => {
    expect((await execute()).details).toMatchObject({ kind: "results", provider: "clawrouter", count: 0, results: [] });
  }));
  it.each(["invalid", "foreign", "budget", "revoked"])("denies %s without an inference fallback", id => runCase(id, async (execute, lifetime) => {
    const result = await execute(); expect(result.details).toMatchObject({ kind: "error", provider: "clawrouter" });
    if (id === "invalid") {
      const catalog = lifetime.guards.filter((row: any) => row.owner.kind === "catalog");
      assert.equal(catalog.length, 1); assert.equal(catalog[0].result.response.status, 401);
      expect(JSON.stringify(result.details)).not.toContain("fixture-secret");
    }
  }));
  it.each(["blank", "count", "utf8_over"])("rejects %s without search dispatch", id => runCase(id, async execute => {
    const args = id === "blank" ? { query: " " } : id === "count" ? { count: 11 } : { query: "界".repeat(2731) };
    const outcome = await execute(args).then(result => ({ result }), error => ({ error }));
    if ("error" in outcome) expect(outcome.error).toBeInstanceOf(Error);
    else expect(outcome.result.details).toMatchObject({ kind: "error" });
  }));
  it("refuses an invocation retired after catalog completion", () => runCase("retired", async execute => {
    await expect(execute()).rejects.toThrow("retired synthetic Search invocation");
  }));
  it.each(["malformed", "error", "invalid_request", "rate_limit", "oversized"])("preserves the controlled %s failure and original cleanup", async id => {
    let limit;
    await runCase(id, async (execute, lifetime, bindings) => {
      expect((await execute()).details).toMatchObject({ kind: "error", provider: "clawrouter" });
      if (id === "oversized") limit = searchLimitEvidence(lifetime, bindings);
    });
    if (limit) console.log("PERPLEXITY_SEARCH_LIMIT " + JSON.stringify(limit));
  });
  it("pre-abort performs no catalog or search request", () => runCase("preabort", async execute => {
    const reason = new Error("synthetic Search caller canceled");
    await expect(execute({}, AbortSignal.abort(reason))).rejects.toBe(reason);
  }));
  it("cancels the actual registered read after original response progress", () => runCase("cancel", async (execute, lifetime, bindings) => {
    const controller = new AbortController(), reason = new Error("synthetic Search caller canceled");
    const pending = execute({}, controller.signal);
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    const owner = bindings.bindings.find((row: any) => row.id === "cancel" && row.kind === "chat" && row.method === "POST");
    assert.ok(owner);
    await waitForOriginalRead(lifetime, owner);
    controller.abort(reason);
    const settled = await outcome; assertOriginalRejection(settled, reason);
    expect(lifetime.operations.some((op: any) => op.owner === owner && op.kind === "reader.read")).toBe(true);
  }));
});
