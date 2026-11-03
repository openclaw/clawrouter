// Installed only into the pinned public OpenClaw checkout by the router CI job.
// Import the actual plugin and SDK; no copied catalog parser or client transport.
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("ClawRouter registered web search through workerd", () => {
  useIsolatedStateGuard();
  const captured = createCapturedPluginRegistration();
  plugin.register?.(captured.api);
  const baseUrl = process.env.CLAWROUTER_CONTRACT_ORIGIN! + "/v1";
  const providers = process.env.CLAWROUTER_CONTRACT_PROVIDERS!.split(",");
  const tool = (id: string, key = `clawrouter-live-${id}-fixture-${id}`) =>
    captured.webSearchProviders.find((provider) => provider.id === "clawrouter")!.createTool({
      config: {
        models: {
          providers: {
            clawrouter: { baseUrl, apiKey: key, models: [] },
            [id]: { baseUrl: "https://unused-upstream.example", apiKey: "must-not-fallback", models: [] },
          },
        },
      },
    })!;

  for (const id of providers) {
    it(`${id}: selects the real scoped catalog, returns safe results and marks untrusted content`, async () => {
      const result = await tool(id).execute({ query: "synthetic contract query", count: 2 });
      expect(result).toMatchObject({
        provider: "clawrouter", count: 1,
        results: [{ title: expect.stringContaining("Synthetic result"), url: "https://example.com/result" }],
      });
      expect(JSON.stringify(result.results)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
      expect(JSON.stringify(result.results)).toContain("Fixture snippet");
      expect(JSON.stringify(result.results)).not.toContain("javascript:");
    });

    it(`${id}: an invalid router key never falls back to provider credentials`, async () => {
      await expect(tool(id, `clawrouter-live-${id}-invalid`).execute({ query: "rejected", count: 1 })).rejects.toThrow(/401/);
    });

    it(`${id}: an unknown upstream tariff cannot consume a hard dollar budget`, async () => {
      await expect(tool(id, `clawrouter-live-unpriced_${id}-fixture-${id}`).execute({ query: "unpriced", count: 1 })).rejects.toThrow(/eligible|pricing|HTTP 400/);
    });

    it(`${id}: caller cancellation before admission does not discover or dispatch`, async () => {
      const signal = AbortSignal.abort(new Error("contract canceled"));
      await expect(tool(id).execute({ query: "canceled", count: 1 }, { signal })).rejects.toThrow("contract canceled");
    });
  }
});
