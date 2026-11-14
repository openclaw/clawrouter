import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { type DispatcherAwareRequestInit, fetchWithRuntimeDispatcher } from "../../src/infra/net/runtime-fetch.js";
import { registerSingleProviderPlugin } from "../../src/plugin-sdk/plugin-test-runtime.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";

type Scenario = "table" | "empty" | "maximum" | "policy" | "duplicate" | "totals" | "malformed" | "redirect" | "limit" | "revoked" | "rotated_old" | "rotated_new" | "grant_revoke" | "grant_rotate" | "abort";
type Case = { id: string; provider: string; scenario: Scenario; endpoint: string; format: string; status: number;
  native: boolean; route: string; models: Array<{ id: string; upstream: string }>; expected: string[]; urls: string[] };
const expectedHead = "1536faab19f2adf524b7ef1acef5c24501b35652";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const control = process.env.CLAWROUTER_CONTRACT_CONTROL!;
const cases = JSON.parse(process.env.CLAWROUTER_CONTRACT_CATALOG_CASES!) as Case[];

const originalFetch = globalThis.fetch;
const originalGuard = ssrfRuntime.fetchWithSsrFGuard;
const key = (row: Case) => `clawrouter-live-${row.id}-${row.scenario === "rotated_new" ? "rotated-secret" : "fixture-secret"}`;
const observations: Array<{ path: string; credential: string; released: boolean; done: Promise<unknown>; status?: number; errorCode?: string; closes: Promise<unknown>[]; destroys: number; dispatchers: number }> = [];
const caseFor = (scenario: Scenario) => {
  const row = cases.find(value => value.scenario === scenario);
  if (!row) throw new Error("missing compiled fixture contract");
  return row;
};

beforeEach(() => {
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(expectedHead);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(expectedHead);
  expect(cases).toHaveLength(15);
  clearLiveCatalogCacheForTests(); observations.length = 0;
  for (const name of ["FEATHERLESS_API_KEY", "OPENAI_API_KEY"]) {
    vi.stubEnv(name, "must-not-fallback");
  }
  vi.stubEnv("CLAWROUTER_API_KEY", "");
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== origin) throw new Error("unexpected direct client provider egress");
    return originalFetch(input, init);
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
    const observation = { path: url.pathname, credential, released: false, done, closes: [], destroys: 0, dispatchers: 0 } as typeof observations[number];
    observations.push(observation);
    try {
      const result = await originalGuard({ ...options, fetchImpl: (input, init) => {
        const dispatcher = (init as DispatcherAwareRequestInit | undefined)?.dispatcher;
        if (!dispatcher || observation.dispatchers++) throw new Error("missing or repeated original dispatcher");
        const close = dispatcher.close, destroy = dispatcher.destroy;
        vi.spyOn(dispatcher, "close").mockImplementation((...args) => {
          const pending = Reflect.apply(close, dispatcher, args);
          observation.closes.push(pending);
          return pending;
        });
        vi.spyOn(dispatcher, "destroy").mockImplementation((...args) => {
          observation.destroys++;
          return Reflect.apply(destroy, dispatcher, args);
        });
        return fetchWithRuntimeDispatcher(input, init);
      },
        policy: ssrfRuntime.ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin) });
      observation.status = result.response.status;
      try {
        if (url.pathname === "/v1/catalog") {
          const body = await result.response.clone().json();
          const provider = body.providers.find((value: { id: string }) => value.id === row.provider);
          const offers = provider.offers.filter((value: { endpoint: string }) => value.endpoint === row.endpoint);
          expect(offers).toEqual([expect.objectContaining({ routeKind: row.native ? "native" : "manifest",
            route: row.route, eligible: true, requestFormat: row.format, responseFormat: row.format })]);

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
    expect(observation.dispatchers).toBe(1); expect(observation.closes).toHaveLength(1);
    expect(await observation.closes[0]).toBeNull(); // Undici close fulfills with null.
    expect(observation.destroys).toBe(0);
  }
  const state = JSON.parse(await command(`/__catalog/join/${row.id}`));
  expect(state).toMatchObject({ calls: row.urls.length, retired: true, charged: 0 });
  for (const input of state.inputs) {
    expect(input).toMatchObject({ activeReads: 0, unlocked: true, sourceLocked: false, physicalLocked: false, pendingSettled: true });
    expect(input.eof || input.canceled || input.readRejected).toBe(true);
  }
  return state;
}

async function fixture(run: (discover: (row: Case, signal?: AbortSignal) => Promise<ModelProviderConfig>) => Promise<void>) {
  const { default: entry } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  const plugin = await registerSingleProviderPlugin(entry);
  expect(plugin.catalog?.run).toBeTypeOf("function");
  await withOpenClawTestState({ label: "clawrouter-featherless-catalog-worker" }, async state => {
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
      const closes = await Promise.allSettled(observations.flatMap(row => row.closes));
      const credentials = new Set(observations.map(row => row.credential));
      const joins = await Promise.allSettled([...credentials].map(async credential => {
        const row = cases.find(value => credential === `Bearer ${key(value)}`);
        if (!row) throw new Error("unknown observed credential");
        await command(`/__catalog/join/${row.id}`);
      }));
      for (const result of [...releases, ...joins]) expect(result).toEqual({ status: "fulfilled", value: undefined });
      for (const row of observations) { expect(row.dispatchers).toBe(1); expect(row.closes).toHaveLength(1); expect(row.destroys).toBe(0); }
      for (const result of closes) expect(result).toEqual({ status: "fulfilled", value: null });
    }
  });
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
      try {
        await Promise.race([command(`/seen/${row.id}`, "GET", control, wait.signal), outcome.then(() => { throw new Error("acquisition ended before held later page"); })]);
        controller.abort(reason); expect(await outcome).toEqual({ error: reason });
        const before = JSON.parse(await command(`/__catalog/state/${row.id}`));
        expect(before.calls).toBe(2); expect(before.retired).toBe(false);
        expect(before.inputs[0]).toMatchObject({ eof: true, unlocked: true });
        expect(before.inputs[1]).toMatchObject({ eof: false, canceled: false, aborted: false });
        expect(observations.find(value => value.path === row.route)?.released).toBe(false);
        // Shared acquisition survives the waiter. Release real I/O; do not
        // claim a pre-header disconnect or infer closure from zero counters.
        await release(); const after = await joined(row);
        expect(after.inputs.every((input: { eof: boolean; canceled: boolean }) => input.eof && !input.canceled)).toBe(true);
      } finally {
        wait.abort();
        try { await release(); } finally { await outcome; await joined(row); }
      }
    });
  }, 120_000);
});
