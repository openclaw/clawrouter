import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { fetchWithRuntimeDispatcher } from "../../src/infra/net/runtime-fetch.js";
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
const originalGuard = ssrfRuntime.fetchWithSsrFGuard;
const key = (row: Case) => `clawrouter-live-${row.id}-fixture-secret`;
const observations: Array<{ path: string; credential: string; released: boolean; done: Promise<unknown>; status?: number; errorCode?: string }> = [];
const caseFor = (provider: string, scenario: Scenario) => {
  const row = cases.find(value => value.provider === provider && value.scenario === scenario);
  if (!row) throw new Error("missing compiled fixture contract");
  return row;
};

beforeEach(() => {
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(expectedHead);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(expectedHead);
  expect(cases).toHaveLength(20);
  clearLiveCatalogCacheForTests(); observations.length = 0;
  for (const name of ["CEREBRAS_API_KEY", "NVIDIA_API_KEY", "CHUTES_API_KEY", "VENICE_API_KEY", "OPENAI_API_KEY"]) {
    vi.stubEnv(name, "must-not-fallback");
  }
  vi.stubEnv("CLAWROUTER_API_KEY", "");
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== origin) throw new Error("unexpected direct client provider egress");
    return originalFetch(request);
  });
  // Keep the real SSRF guard/dispatcher. The only allowance is this exact local
  // fixture origin; no fabricated offer, native credential or release substitute.
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async options => {
    const url = new URL(String(options.url));
    const credential = new Headers(options.init?.headers).get("authorization") ?? "";
    const row = cases.find(value => credential === `Bearer ${key(value)}`);
    if (!row || url.origin !== origin || !["/v1/catalog", row.route].includes(url.pathname) || url.search) {
      throw new Error("unexpected registered catalog route or key");
    }
    let finished!: (error?: unknown) => void;
    const done = new Promise<unknown>(resolve => { finished = resolve; });
    const observation = { path: url.pathname, credential, released: false, done } as typeof observations[number];
    observations.push(observation);
    try {
      const result = await originalGuard({ ...options, fetchImpl: fetchWithRuntimeDispatcher,
        policy: ssrfRuntime.ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin) });
      observation.status = result.response.status;
      try {
        if (url.pathname === "/v1/catalog") {
          const body = await result.response.clone().json();
          const provider = body.providers.find((value: { id: string }) => value.id === row.provider);
          const offers = provider.offers.filter((value: { endpoint: string }) => value.endpoint === row.endpoint);
          expect(offers).toEqual([expect.objectContaining({ routeKind: row.native ? "native" : "manifest",
            route: row.route, eligible: true, requestFormat: row.format, responseFormat: row.format })]);
          // Revoke after observing the genuine old offer, before the registered
          // client receives the original response and dispatches that offer.
          if (row.scenario === "stale") await command(`/__catalog/revoke/${row.id}`, "POST");
        } else if (!result.response.ok) {
          const body = await result.response.clone().json();
          observation.errorCode = body.error?.code;
        }
      } catch (error) {
        const failures = [error];
        try { await result.response.body?.cancel(); } catch (failure) { failures.push(failure); }
        try { await result.release(); } catch (failure) { failures.push(failure); }
        if (failures.length > 1) throw new AggregateError(failures, "catalog observation or cleanup failed");
        throw error;
      }
      return { ...result, release: async () => {
        try { await result.release(); observation.released = true; finished(); }
        catch (error) { finished({ error }); throw error; }
      } };
    } catch (error) { finished({ error }); throw error; }
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearLiveCatalogCacheForTests(); });

async function command(path: string, method = "GET", base = origin, signal?: AbortSignal) {
  const response = await originalFetch(base + path, { method, signal });
  const text = await response.text(); expect(response.status, path).toBe(200); return text;
}
async function joined(row: Case) {
  const selected = observations.filter(value => value.credential === `Bearer ${key(row)}`);
  expect(selected.map(value => value.path)).toEqual(["/v1/catalog", row.route]);
  for (const observation of selected) {
    expect(await observation.done).toBeUndefined(); expect(observation.released).toBe(true);
  }
  const state = JSON.parse(await command(`/__catalog/join/${row.id}`));
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
  const { default: entry } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  const plugin = await registerSingleProviderPlugin(entry);
  expect(plugin.catalog?.run).toBeTypeOf("function");
  await withOpenClawTestState({ label: "clawrouter-public-catalog-worker" }, async state => {
    const config: OpenClawConfig = { models: { providers: { clawrouter: { baseUrl: `${origin}/v1`, models: [] } } } };
    const discover = async (row: Case, signal?: AbortSignal) => {
      await command(`/__catalog/activate/${row.id}`, "POST");
      const auth = { apiKey: key(row), discoveryApiKey: key(row), mode: "api_key" as const, source: "profile" as const };
      const result = await plugin.catalog!.run({ config, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir, signal,
        resolveProviderAuth: () => auth, resolveProviderApiKey: () => auth });
      if (!result || !("provider" in result) || !result.provider) throw new Error("missing registered catalog result");
      return result.provider;
    };
    try { await run(discover); }
    finally {
      const releases = await Promise.allSettled(observations.map(row => row.done));
      const credentials = new Set(observations.map(row => row.credential));
      const joins = await Promise.allSettled([...credentials].map(async credential => {
        const row = cases.find(value => credential === `Bearer ${key(value)}`);
        if (!row) throw new Error("unknown observed credential");
        await command(`/__catalog/join/${row.id}`);
      }));
      for (const result of [...releases, ...joins]) expect(result).toEqual({ status: "fulfilled", value: undefined });
    }
  });
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
      } finally {
        wait.abort();
        try { await release(); } finally { await outcome; await joined(row); }
      }
    });
  }, 120_000);
});
