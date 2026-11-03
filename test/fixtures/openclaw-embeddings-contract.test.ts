import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("ClawRouter memory transport through workerd", () => {
  useIsolatedStateGuard();
  const captured = createCapturedPluginRegistration();
  plugin.register?.(captured.api);
  const adapter = captured.embeddingProviders.find((provider) => provider.id === "clawrouter")!;
  const baseUrl = process.env.CLAWROUTER_CONTRACT_ORIGIN! + "/v1";
  const cases: Array<{ credential: string; model: string }> = JSON.parse(process.env.CLAWROUTER_CONTRACT_CASES!);

  for (const entry of cases) {
    const options = () => ({
      config: { models: { providers: {
        clawrouter: { baseUrl, models: [] },
        openai: { baseUrl: "https://unused-upstream.example/v1", apiKey: "must-not-fallback", models: [] },
      } } },
      model: entry.model,
      remote: { apiKey: `clawrouter-live-${entry.credential}-fixture-secret` },
    });

    it(`${entry.model}: restores batch order, reports usage and re-admits a rotated key`, async () => {
      const config = options();
      const { provider } = await adapter.create(config);
      const onUsage = vi.fn();
      expect(await provider!.embedBatch(["first fixture text", "second fixture text"], { onUsage })).toEqual([[1, 2], [3, 4]]);
      expect(provider!.model).toBe(entry.model);
      expect(onUsage).toHaveBeenCalledOnce();
      config.remote.apiKey = `clawrouter-live-${entry.credential}-invalid`;
      await expect(provider!.embed("not admitted")).rejects.toThrow(/401/);
    });

    it(`${entry.model}: cancels and rejects unsupported inputs before egress`, async () => {
      const { provider } = await adapter.create(options());
      await expect(provider!.embed("canceled", { signal: AbortSignal.abort(new Error("contract canceled")) })).rejects.toThrow("contract canceled");
      await expect(provider!.embed({ text: "image", parts: [{ type: "inline-data", mimeType: "image/png", data: "AA==" }] })).rejects.toThrow("text-only");
      await expect(adapter.create({ ...options(), dimensions: 256 })).rejects.toThrow("default text format");
    });
  }
});
