import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCapturedPluginRegistration, getActivePluginRegistry, setActivePluginRegistry, createEmptyPluginRegistry, registerEmbeddingProvider } from "../plugin-sdk/plugin-test-runtime.js";
import { useIsolatedStateGuard } from "../plugin-sdk/test-env.js";
import type { EmbeddingProviderCreateOptions, EmbeddingProviderCreateResult } from "../plugins/embedding-provider-types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";

type MemoryOptions = Omit<EmbeddingProviderCreateOptions, "dimensions"> & { provider: string; fallback: string; outputDimensionality?: number };
const axis = (index: number) => Array.from({ length: 256 }, (_, column) => column === index ? 1 : 0);

describe("native ClawRouter offers through the actual memory-core factory and workerd", () => {
  useIsolatedStateGuard();
  const captured = createCapturedPluginRegistration();
  let memory: { createEmbeddingProvider: (options: MemoryOptions) => Promise<EmbeddingProviderCreateResult> };
  let previousRegistry: ReturnType<typeof getActivePluginRegistry>;
  const cases: Array<{ credential: string; model: string; format: string; dispatch: string }> = JSON.parse(process.env.CLAWROUTER_CONTRACT_CASES!);
  beforeAll(async () => {
    const entry = await loadBundledPluginFacade<{ default: { register?: (api: typeof captured.api) => void } }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
    entry.default.register?.(captured.api);
    memory = await loadBundledPluginFacade<typeof memory>({ pluginId: "memory-core", artifactBasename: "runtime-api.js" });
  });
  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
    registerEmbeddingProvider(captured.embeddingProviders.find(provider => provider.id === "clawrouter")!);
  });
  afterEach(() => setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry()));

  for (const entry of cases) {
    const options = (suffix = ""): MemoryOptions => ({
      provider: "clawrouter", fallback: "none", model: entry.model, outputDimensionality: 256,
      config: { plugins: { enabled: false }, models: { providers: {
        clawrouter: { baseUrl: process.env.CLAWROUTER_CONTRACT_ORIGIN! + "/v1", models: [] },
        ...Object.fromEntries(["cohere", "voyage", "google"].map(id => [id, { baseUrl: "https://unused-upstream.example", apiKey: "must-not-fallback", models: [] }])),
      } } },
      remote: { apiKey: `clawrouter-live-${entry.credential}${suffix}-fixture-secret` },
    });

    it(`${entry.model}/${entry.format}/${entry.dispatch}: preserves query/document roles, dimensions, batch order and billed usage`, async () => {
      const config = options();
      const { provider } = await memory.createEmbeddingProvider(config);
      const onUsage = vi.fn();
      expect(await provider!.embed(`query fixture ${entry.credential}`, { inputType: "query", onUsage })).toEqual(axis(0));
      expect(onUsage).toHaveBeenCalledExactlyOnceWith({ promptTokens: 7, totalTokens: 7 });
      expect(await provider!.embedBatch([`first fixture ${entry.credential}`, `second fixture ${entry.credential}`], { inputType: "document" })).toEqual([axis(0), axis(1)]);
      config.remote!.apiKey = `clawrouter-live-${entry.credential}-invalid`;
      await expect(provider!.embed("not admitted")).rejects.toThrow(/401/);
    });

    it(`${entry.model}/${entry.format}/${entry.dispatch}: denies unknown-price hard budgets and cancels before egress`, async () => {
      const { provider } = await memory.createEmbeddingProvider(options("_unpriced"));
      await expect(provider!.embed("not admitted")).rejects.toThrow(/no eligible/);
      await expect(provider!.embed("canceled", { signal: AbortSignal.abort(new Error("contract canceled")) })).rejects.toThrow("contract canceled");
    });

    it(`${entry.model}/${entry.format}/${entry.dispatch}: rejects HTTP-200 embedded errors without returning vectors`, async () => {
      const { provider } = await memory.createEmbeddingProvider(options("_error"));
      await expect(provider!.embed(`embedded error fixture ${entry.credential}`)).rejects.toThrow();
    });

    it(`${entry.model}/${entry.format}/${entry.dispatch}: rejects invalid vector dimensions`, async () => {
      const { provider } = await memory.createEmbeddingProvider(options("_invalid"));
      await expect(provider!.embed(`invalid vector fixture ${entry.credential}`)).rejects.toThrow();
    });

    it(`${entry.model}/${entry.format}/${entry.dispatch}: rejects incomplete JSON without replaying the dispatched request`, async () => {
      const { provider } = await memory.createEmbeddingProvider(options("_eof"));
      await expect(provider!.embed(`broken EOF fixture ${entry.credential}`)).rejects.toThrow();
    });
  }
});
