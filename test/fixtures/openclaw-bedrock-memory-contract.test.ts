import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCapturedPluginRegistration, getActivePluginRegistry, setActivePluginRegistry, createEmptyPluginRegistry, registerEmbeddingProvider } from "../plugin-sdk/plugin-test-runtime.js";
import { useIsolatedStateGuard } from "../plugin-sdk/test-env.js";
import type { EmbeddingProviderCreateOptions, EmbeddingProviderCreateResult } from "../plugins/embedding-provider-types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";

type MemoryOptions = Omit<EmbeddingProviderCreateOptions, "dimensions"> & { provider: string; fallback: string; outputDimensionality?: number };
type Case = { credential: string; model: string; family: string; dimensions: number[]; defaultDimensions: number };
const cases: Case[] = JSON.parse(process.env.CLAWROUTER_CONTRACT_CASES!);
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const axis = (size: number, index: number) => Array.from({ length: size }, (_, column) => column === index ? 1 : 0);
async function control(path: string) {
  const response = await fetch(origin + "/fixture/" + path, { headers: { "x-fixture-control": "bedrock-memory" } });
  expect(response.ok).toBe(true);
  return response.json();
}

describe("Bedrock through the registered ClawRouter memory provider and real Worker", () => {
  useIsolatedStateGuard();
  const captured = createCapturedPluginRegistration();
  let memory: { createEmbeddingProvider: (options: MemoryOptions) => Promise<EmbeddingProviderCreateResult> };
  let previousRegistry: ReturnType<typeof getActivePluginRegistry>;
  beforeAll(async () => {
    const entry = await loadBundledPluginFacade<{ default: { register?: (api: typeof captured.api) => void } }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
    expect(entry.default.register).toBeTypeOf("function");
    entry.default.register!(captured.api);
    expect(captured.embeddingProviders.filter(provider => provider.id === "clawrouter")).toHaveLength(1);
    memory = await loadBundledPluginFacade<typeof memory>({ pluginId: "memory-core", artifactBasename: "runtime-api.js" });
  });
  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
    registerEmbeddingProvider(captured.embeddingProviders.find(provider => provider.id === "clawrouter")!);
  });
  afterEach(() => setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry()));
  const options = (entry: Case, suffix = "", dimensions?: number): MemoryOptions => ({
    provider: "clawrouter", fallback: "none", model: entry.model,
    ...(dimensions === undefined ? {} : { outputDimensionality: dimensions }),
    config: { plugins: { enabled: false }, models: { providers: {
      clawrouter: { baseUrl: origin + "/v1", models: [] },
      "amazon-bedrock": { baseUrl: "https://unused-upstream.example", apiKey: "must-not-fallback", models: [] },
    } } },
    remote: { apiKey: `clawrouter-live-${entry.credential}${suffix}-fixture-secret` },
  });

  for (const entry of cases) {
    it(`${entry.model}: defaults and every supported dimension preserve Unicode batch order and roles`, async () => {
      for (const dimensions of [undefined, ...entry.dimensions]) {
        const { provider } = await memory.createEmbeddingProvider(options(entry, "", dimensions));
        expect(provider?.id).toBe("clawrouter");
        const size = dimensions ?? entry.defaultDimensions, onUsage = vi.fn();
        expect(await provider!.embed(`query fixture ${entry.credential} café 東京 🦊`, { inputType: "query", onUsage })).toEqual(axis(size, 0));
        expect(onUsage).toHaveBeenCalledExactlyOnceWith(entry.family.startsWith("titan-") ? { promptTokens: 7, totalTokens: 7 } : undefined);
        expect(await provider!.embedBatch([`first fixture ${entry.credential} café`, `second fixture ${entry.credential} 東京 🦊`], { inputType: "document" })).toEqual([axis(size, 0), axis(size, 1)]);
      }
    }, 30_000);

    it(`${entry.model}: original signal, grants and unknown-price hard budgets deny before egress`, async () => {
      for (const suffix of ["_unpriced", "_denied"]) {
        const { provider } = await memory.createEmbeddingProvider(options(entry, suffix));
        await expect(provider!.embed(`denied fixture ${entry.credential} request`)).rejects.toThrow(/no eligible/);
      }
      const { provider } = await memory.createEmbeddingProvider(options(entry));
      const controller = new AbortController(), reason = new Error("original caller canceled");
      controller.abort(reason);
      await expect(provider!.embed(`aborted fixture ${entry.credential} request`, { signal: controller.signal })).rejects.toThrow("original caller canceled");
      // The actual client validates every planned body before issuing any POST.
      await expect(provider!.embedBatch([`first fixture ${entry.credential} withheld`, "x".repeat(2 * 1024 * 1024)], { inputType: "document" })).rejects.toThrow(/byte limit|body/);
    });

    it(`${entry.model}: an original eligible catalog cannot bypass subsequent revocation`, async () => {
      const { provider } = await memory.createEmbeddingProvider(options(entry, "_stale"));
      await expect(provider!.embed(`stale fixture ${entry.credential} request`)).rejects.toThrow(/403/);
    });

    for (const [suffix, marker] of [["_error", "embedded error"], ["_eof", "broken EOF"], ["_invalid", "invalid vector"]]) {
      it(`${entry.model}: ${marker} rejects without replay or a partial result`, async () => {
        const { provider } = await memory.createEmbeddingProvider(options(entry, suffix));
        await expect(provider!.embed(`${marker} fixture ${entry.credential} response`)).rejects.toThrow();
      });
    }

    it(`${entry.model}: a malformed later vector never returns the valid prefix`, async () => {
      const { provider } = await memory.createEmbeddingProvider(options(entry, "_later"));
      await expect(provider!.embedBatch([`first fixture ${entry.credential} valid prefix`, `second invalid vector fixture ${entry.credential} malformed suffix`], { inputType: "document" })).rejects.toThrow();
    });
  }

  it("the same real provider rereads the rotated router key without native AWS fallback", async () => {
    const entry = cases[0], config = options(entry);
    const { provider } = await memory.createEmbeddingProvider(config);
    expect(await control("rotate")).toEqual({ rotated: true });
    await expect(provider!.embed(`old key fixture ${entry.credential} denied`)).rejects.toThrow(/401/);
    config.remote!.apiKey = `clawrouter-live-${entry.credential}-rotated-secret`;
    expect(await provider!.embed(`query fixture ${entry.credential} rotated key`)).toEqual(axis(entry.defaultDimensions, 0));
  });

  it("the original caller aborts a held response and teardown closes the actual producer", async () => {
    const entry = cases[0], config = options(entry), controller = new AbortController();
    config.remote!.apiKey = `clawrouter-live-${entry.credential}-rotated-secret`;
    const { provider } = await memory.createEmbeddingProvider(config);
    // Observe rejection immediately; retain and join this original call in finally.
    const outcome = provider!.embed(`held body fixture ${entry.credential} pending`, { signal: controller.signal })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
      await vi.waitFor(async () => expect((await control("state")).held).toBe(1), { timeout: 10_000, interval: 20 });
      controller.abort(new Error("original caller stopped reading"));
      expect((await outcome).value).toBeUndefined();
      expect((await outcome).error).toBeDefined();
    } finally {
      controller.abort(new Error("fixture teardown"));
      await control("release");
      await outcome;
    }
    expect((await control("state")).held).toBe(0);
  }, 30_000);
});
