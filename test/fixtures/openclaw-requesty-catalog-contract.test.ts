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

type Catalog = ModelProviderConfig;
type Model = Catalog["models"][number];

const expectedHead = "1536faab19f2adf524b7ef1acef5c24501b35652";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const control = process.env.CLAWROUTER_CONTRACT_CONTROL!;
const chatAnchor = "requesty/openai/gpt-6-luna";
const nativeFetch = globalThis.fetch;
const originalGuard = ssrfRuntime.fetchWithSsrFGuard;
const managedPath = "/v1/native/requesty/models/managed";
const id = (scenario: string) => `rq_native_${scenario}`;
const key = (scenario: string) => `clawrouter-live-${id(scenario)}-fixture-secret`;
const observations: Array<{ path: string; credential: string; released: boolean; done: Promise<unknown> }> = [];

beforeEach(() => {
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(expectedHead);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(expectedHead);
  expect(process.env.CLAWROUTER_CONTRACT_DISPATCH).toBe("native");
  clearLiveCatalogCacheForTests();
  observations.length = 0;
  vi.stubEnv("REQUESTY_API_KEY", "must-not-fallback-requesty");
  vi.stubEnv("OPENAI_API_KEY", "must-not-fallback-openai");
  vi.stubEnv("CLAWROUTER_API_KEY", "");
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== origin) throw new Error("unexpected client provider egress");
    return nativeFetch(request);
  });
  // Use the genuine SSRF transport/dispatcher and exact fixture-origin allowance.
  // Only observe its real release AFTER completion; never replace it with a no-op.
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async options => {
    const url = new URL(String(options.url));
    if (url.origin !== origin || !["/v1/catalog", managedPath].includes(url.pathname) || url.search) {
      throw new Error("unexpected discovery route");
    }
    let finished!: (error?: unknown) => void;
    const done = new Promise<unknown>(resolve => { finished = resolve; });
    const observation = { path: url.pathname, credential: new Headers(options.init?.headers).get("authorization") ?? "", released: false, done };
    observations.push(observation);
    try {
      const result = await originalGuard({ ...options, fetchImpl: fetchWithRuntimeDispatcher,
        policy: ssrfRuntime.ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin) });
      if (url.pathname === "/v1/catalog") {
        try {
          // Observe the genuine payload; return its original response untouched.
          const catalog = await result.response.clone().json();
          const requesty = catalog.providers.find((row: { id: string }) => row.id === "requesty");
          const offers = requesty.offers.filter((row: { endpoint: string }) => row.endpoint === "models_managed");
          expect(offers).toEqual([expect.objectContaining({ routeKind: "native", route: managedPath, eligible: true })]);
          expect(offers.some((row: { routeKind: string }) => row.routeKind === "manifest")).toBe(false);
        } catch (error) {
          // Failed observation still retires the actual acquisition, not just its clone.
          const failures = [error];
          try { await result.response.body?.cancel(); } catch (failure) { failures.push(failure); }
          try { await result.release(); } catch (failure) { failures.push(failure); }
          if (failures.length > 1) throw new AggregateError(failures, "catalog observation or cleanup failed");
          throw error;
        }
      }
      return { ...result, release: async () => {
        try { await result.release(); observation.released = true; finished(); }
        catch (error) { finished({ error }); throw error; }
      } };
    } catch (error) { finished({ error }); throw error; }
  });
});

afterEach(() => {
  // No successful cleanup assertion is inferred from clearing this cache.
  vi.restoreAllMocks(); vi.unstubAllEnvs(); clearLiveCatalogCacheForTests();
});

async function command(path: string, method = "GET", base = origin, signal?: AbortSignal) {
  const response = await nativeFetch(base + path, { method, signal });
  const body = await response.text();
  expect(response.status, path).toBe(200);
  return body;
}

async function releases(scenario: string) {
  const selected = observations.filter(row => row.credential === `Bearer ${key(scenario)}`);
  expect(selected.map(row => row.path)).toEqual(["/v1/catalog", managedPath]);
  for (const row of selected) {
    expect(await row.done).toBeUndefined();
    expect(row.released).toBe(true);
  }
}

async function joined(scenario: string) {
  await releases(scenario);
  const state = JSON.parse(await command(`/__requesty/join/${id(scenario)}`));
  expect(state).toMatchObject({ calls: 1, retired: true, activeReads: 0, unlocked: true,
    sourceLocked: false, physicalLocked: false, charged: 0 });
  expect(state.eof || state.canceled || state.readRejected).toBe(true);
  return state;
}

function retained() {
  const rows = getLiveCatalogRetainedData();
  expect(rows.find(row => row.structure === "catalog-request")?.entries).toBe(0);
  return rows.find(row => row.structure === "catalog-source")?.entries;
}

// A failed assertion still releases the original producer and joins its real
// acquisition. Releasing a barrier is test cleanup, never a PASS observation.
async function held<T>(scenario: string, outcome: Promise<T>, run: (release: () => Promise<unknown>) => Promise<void>) {
  const controlWait = new AbortController();
  const release = () => command(`/release/${id(scenario)}`, "POST", control);
  try {
    await Promise.race([
      command(`/seen/${id(scenario)}`, "GET", control, controlWait.signal),
      outcome.then(() => { throw new Error("acquisition ended before the held producer"); }),
    ]);
    await run(release);
  } finally {
    controlWait.abort();
    try { await release(); }
    finally { await outcome; await joined(scenario); }
  }
}

async function fixture(run: (discover: (scenario: string, signal?: AbortSignal) => Promise<Catalog>) => Promise<void>) {
  const { default: entry } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  const plugin = await registerSingleProviderPlugin(entry);
  expect(plugin.catalog?.run).toBeTypeOf("function");
  await withOpenClawTestState({ label: "clawrouter-requesty-catalog-worker" }, async state => {
    const config: OpenClawConfig = { models: { providers: { clawrouter: { baseUrl: `${origin}/v1`, models: [] } } } };
    const discover = async (scenario: string, signal?: AbortSignal) => {
      const auth = { apiKey: key(scenario), discoveryApiKey: key(scenario), mode: "api_key" as const, source: "profile" as const };
      const result = await plugin.catalog!.run({ config, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir, signal,
        resolveProviderAuth: () => auth, resolveProviderApiKey: () => auth });
      if (!result || !("provider" in result) || !result.provider) throw new Error("missing actual registered catalog");
      expect(result.provider.models.map(row => row.id)).not.toContain(chatAnchor);
      return result.provider;
    };
    try { await run(discover); }
    finally {
      // Also join /v1/catalog's original waitUntil work. Do this before the
      // client state closes and before afterEach restores observers/clears caches.
      const releaseResults = await Promise.allSettled(observations.map(row => row.done));
      const credentials = new Set(observations.map(row => row.credential));
      const joinResults = await Promise.allSettled([...credentials].map(async credential => {
        const credentialId = /^Bearer clawrouter-live-([a-z_]+)-fixture-secret$/.exec(credential)?.[1];
        if (!credentialId) throw new Error("unknown observed proxy credential");
        await command(`/__requesty/join/${credentialId}`);
      }));
      // All actual joins are attempted before reporting any observer failure.
      for (const result of [...releaseResults, ...joinResults]) expect(result).toEqual({ status: "fulfilled", value: undefined });
    }
  });
}

describe("published Requesty discovery uses the original managed owner", () => {
  it("keeps real filtered identities/observations and isolates two credentials without a cache clear", async () => {
    await fixture(async discover => {
      const first = await discover("table");
      await joined("table");
      expect(first.models.map(row => row.id).sort()).toEqual([
        "requesty/MyPolicy", "requesty/StringLimits", "requesty/Unknown", "requesty/Zero", "requesty/vendor/model",
      ].sort());
      const models: Model[] = JSON.parse(JSON.stringify(first.models));
      const byId = (name: string) => {
        const model = models.find(row => row.id === `requesty/${name}`);
        if (!model) throw new Error(`missing discovered ${name}`);
        return model;
      };
      expect(byId("MyPolicy")).toMatchObject({ reasoning: false, input: ["text"], params: {
        clawrouterDiscovery: { provider: "requesty", upstream: "MyPolicy", observations: { pricing: { input_price: "0.25", output_price: 0 } } },
      } });
      expect(byId("vendor/model")).toMatchObject({ contextWindow: 32000, maxTokens: 4096, input: ["text", "image"] });
      expect(byId("Zero").params?.clawrouterDiscovery).toMatchObject({ observations: {
        pricing: { input_price: 0, output_price: "0", cached_price: "0", caching_price: 0 }, context_window: 0, max_output_tokens: 0,
      } });
      for (const name of ["Unknown", "StringLimits"]) {
        expect(byId(name).params?.clawrouterDiscovery).toEqual({ provider: "requesty", upstream: name, observations: {} });
        expect(byId(name)).not.toHaveProperty("contextWindow");
        expect(byId(name)).not.toHaveProperty("maxTokens");
        expect(byId(name).reasoning).toBe(false); // Existing client heuristic, not an upstream observation.
      }
      for (const row of models) expect(row.cost).toBeUndefined();
      // Deliberately no cache clearing here. B has a different real proxy key,
      // managed grant and policy, but the same router and metadata endpoint.
      const second = await discover("other");
      await joined("other");
      expect(second.models.map(row => row.id)).toEqual(["requesty/OnlyB"]);
      expect(retained()).toBe(4);
    });
  }, 120_000);

  it("treats an empty complete inventory as authoritative, without the static Chat seed", async () => {
    await fixture(async discover => {
      expect((await discover("empty")).models).toEqual([]);
      await joined("empty"); expect(retained()).toBe(2);
    });
  }, 120_000);

  it.each(["malformed", "truncated", "non_success", "too_many", "long_id"])("rejects %s without partial caching, another route or fallback", async scenario => {
    await fixture(async discover => {
      await expect(discover(scenario)).rejects.toThrow();
      await joined(scenario);
      expect(retained()).toBe(1); // Only the complete real /v1/catalog is retained.
    });
  }, 120_000);

  it("intersects a fresh in-flight acquisition with the current policy, without widening its original grant", async () => {
    await fixture(async discover => {
      const result = discover("narrow");
      // Attach a rejection consumer before waiting for any separate event.
      const outcome = result.then(value => ({ value }), error => ({ error }));
      await held("narrow", outcome, async release => {
        await command(`/__requesty/narrow/${id("narrow")}`, "POST");
        await release();
        const settled = await outcome;
        expect("error" in settled).toBe(false);
        if (!("value" in settled)) throw new Error("fresh policy acquisition rejected");
        expect(settled.value.models.map(row => row.id)).toEqual(["requesty/Keep"]);
      });
    });
  }, 120_000);

  it("refuses a fresh in-flight acquisition after original managed-grant revocation", async () => {
    await fixture(async discover => {
      const outcome = discover("revoke").then(value => ({ value }), error => ({ error }));
      await held("revoke", outcome, async release => {
        await command(`/__requesty/revoke/${id("revoke")}`, "POST");
        await release();
        expect(await outcome).toHaveProperty("error");
      });
      expect(retained()).toBe(1);
      // Neither case asserts invalidation of a previously cached catalog.
    });
  }, 120_000);

  it("rejects an aborted caller while the original shared load finishes and releases its real transport", async () => {
    await fixture(async discover => {
      const controller = new AbortController(), reason = new Error("synthetic catalog caller abort");
      const outcome = discover("abort", controller.signal).then(value => ({ value }), error => ({ error }));
      await held("abort", outcome, async release => {
        controller.abort(reason);
        expect(await outcome).toEqual({ error: reason });
        const before = JSON.parse(await command(`/__requesty/state/${id("abort")}`));
        expect(before).toMatchObject({ calls: 1, eof: false, canceled: false, aborted: false, retired: false });
        expect(observations.find(row => row.path === managedPath)?.released).toBe(false);
        // No immediate upstream cancellation is promised by the shared cache.
        // Join dispatcher AND Worker retirement before cache clearing/teardown.
        await release();
        const after = await joined("abort");
        expect(after.eof).toBe(true);
        expect(after.canceled).toBe(false);
      });
      expect(retained()).toBe(2);
    });
  }, 120_000);
});
