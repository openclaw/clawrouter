import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { generateVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { describe, expect, it } from "vitest";

const MP4 = Buffer.from(process.env.CLAWROUTER_CONTRACT_VIDEO_BASE64!, "base64");
function config(id: string, model: string): OpenClawConfig {
  return {
    plugins: { allow: ["runway"], entries: { runway: { enabled: true } } },
    agents: { defaults: { mediaModels: { video: { primary: "runway/" + model } } } },
    models: { providers: { runway: {
      baseUrl: process.env.CLAWROUTER_CONTRACT_ORIGIN! + "/v1/native/runway",
      apiKey: `clawrouter-live-runway_${id}-fixture-secret`, models: [], request: { allowPrivateNetwork: true },
    } } },
  };
}
const environment = { env: { RUNWAYML_API_SECRET: undefined, RUNWAY_API_KEY: undefined } };
const run = (id: string, model = "gen4.5", durationSeconds = 5) => generateVideo({ cfg: config(id, model), prompt: `Synthetic ${id}`,
  aspectRatio: "16:9", durationSeconds, timeoutMs: 15_000, autoProviderFallback: false });
const cases: [string, string, number][] = [["gen45", "gen4.5", 5],
  ...["veo3.1", "veo3.1_fast"].flatMap(model => [4, 6, 8].map(duration => [model === "veo3.1" ? `veo${duration}` : `fast${duration}`, model, duration] as [string, string, number]))];

describe("actual Runway video host through the native Worker route", () => {
  it.each(cases)("creates, polls and downloads %s with explicit duration", async (id, model, duration) => {
    await withTempHome(async () => {
      const result = await run(id, model, duration);
      expect(result).toMatchObject({ provider: "runway", model, attempts: [], metadata: { status: "SUCCEEDED", endpoint: "/v1/text_to_video" } });
      expect(result.videos).toHaveLength(1);
      expect(result.videos[0]).toMatchObject({ buffer: MP4, mimeType: "video/mp4" });
    }, environment);
  });
  it("rejects a successful native task without a deliverable", async () => {
    await withTempHome(async () => { await expect(run("empty")).rejects.toThrow(/without output URLs/i); }, environment);
  });
  it("stops on native failure instead of replaying creation", async () => {
    await withTempHome(async () => { await expect(run("failed")).rejects.toThrow(/Synthetic failure/i); }, environment);
  });
  it.each(["budget", "denied", "invalid"])("does not bypass the router's %s admission", async id => {
    await withTempHome(async () => { await expect(run(id)).rejects.toThrow(/pricing_required|400|401|403|not allowed/i); }, environment);
  });
});
