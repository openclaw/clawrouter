import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { generateVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { describe, expect, it } from "vitest";

const MP4 = Buffer.from(process.env.CLAWROUTER_CONTRACT_VIDEO_BASE64!, "base64");
function config(id: string): OpenClawConfig {
  return {
    plugins: { allow: ["alibaba"], entries: { alibaba: { enabled: true } } },
    agents: { defaults: { mediaModels: { video: { primary: "alibaba/wan2.6-t2v" } } } },
    models: { providers: { alibaba: {
      baseUrl: process.env.CLAWROUTER_CONTRACT_ORIGIN! + "/v1/native/alibaba",
      apiKey: `clawrouter-live-wan_${id}-fixture-secret`, models: [], request: { allowPrivateNetwork: true },
    } } },
  };
}
const environment = { env: { MODELSTUDIO_API_KEY: undefined, DASHSCOPE_API_KEY: undefined, QWEN_API_KEY: undefined } };
const run = (id: string) => generateVideo({ cfg: config(id), prompt: `Synthetic ${id}`,
  size: "1280*720", durationSeconds: 5, watermark: true, timeoutMs: 15_000, autoProviderFallback: false });

describe("actual Alibaba video host through the native Worker route", () => {
  it("creates, polls and downloads complete video using only the proxy credential", async () => {
    await withTempHome(async () => {
      const result = await run("complete");
      expect(result).toMatchObject({ provider: "alibaba", model: "wan2.6-t2v", attempts: [],
        metadata: { taskId: "wan_complete", taskStatus: "SUCCEEDED" } });
      expect(result.videos).toHaveLength(1);
      expect(result.videos[0]).toMatchObject({ buffer: MP4, mimeType: "video/mp4" });
    }, environment);
  });
  it("rejects a successful native task without a deliverable", async () => {
    await withTempHome(async () => { await expect(run("empty")).rejects.toThrow(/without output video URLs/i); }, environment);
  });
  it("stops on unavailable observation instead of polling or replaying creation", async () => {
    await withTempHome(async () => { await expect(run("unknown")).rejects.toThrow(/410|observation_unavailable/i); }, environment);
  });
  it.each(["budget", "denied", "invalid"])("does not bypass the router's %s admission", async id => {
    await withTempHome(async () => { await expect(run(id)).rejects.toThrow(/pricing_required|400|401|403|not allowed/i); }, environment);
  });
});
