import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { generateVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { describe, expect, it } from "vitest";

function config(id: string): OpenClawConfig {
  return {
    plugins: { allow: ["pixverse"], entries: { pixverse: { enabled: true } } },
    agents: { defaults: { mediaModels: { video: { primary: "pixverse/" + (id === "c1" ? "c1" : "v6") } } } },
    models: { providers: { pixverse: {
      baseUrl: process.env.CLAWROUTER_CONTRACT_ORIGIN! + "/v1/native/pixverse/openapi/v2",
      apiKey: `clawrouter-live-pixverse_${id}-fixture-secret`, models: [], request: { allowPrivateNetwork: true },
    } } },
  };
}
const environment = { env: { PIXVERSE_API_KEY: undefined } };
const run = (id: string) => generateVideo({ cfg: config(id), prompt: `Synthetic ${id}`,
  aspectRatio: "16:9", resolution: "540P", durationSeconds: 5, audio: false, providerOptions: { seed: 0 },
  timeoutMs: 15_000, autoProviderFallback: false });

describe("actual PixVerse video host through the native Worker route", () => {
  it.each([["v6", 1001], ["c1", 1002]] as const)("creates and polls frozen %s with a proxy key", async (model, id) => {
    await withTempHome(async () => {
      const result = await run(model);
      expect(result).toMatchObject({ provider: "pixverse", model, attempts: [], metadata: { videoId: id, status: 1 } });
      expect(result.videos).toHaveLength(1);
      // The actual PixVerse host returns an opaque asset URL, not downloaded bytes.
      expect(result.videos[0]).toMatchObject({ url: `https://media.example/pixverse-${id}.mp4`, mimeType: "video/mp4" });
    }, environment);
  });
  it("rejects terminal success without an output URL", async () => {
    await withTempHome(async () => { await expect(run("empty")).rejects.toThrow(/without output URL/i); }, environment);
  });
  it("stops on deleted observation without replaying creation", async () => {
    await withTempHome(async () => { await expect(run("deleted")).rejects.toThrow(/410|observation_unavailable/i); }, environment);
  });
  it.each(["budget", "denied", "invalid"])("does not bypass the router's %s admission", async id => {
    await withTempHome(async () => { await expect(run(id)).rejects.toThrow(/pricing_required|400|401|403|not allowed/i); }, environment);
  });
});
