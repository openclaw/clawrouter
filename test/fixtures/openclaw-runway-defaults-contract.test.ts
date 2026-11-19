import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { generateVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MP4 = Buffer.from(process.env.CLAWROUTER_CONTRACT_VIDEO_BASE64!, "base64");
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const outputUrl = "https://93.184.216.34/clawrouter-runway-fixture.mp4";
const nativeFetch = globalThis.fetch;
beforeEach(() => {
  // Keep actual strict result admission and dispatcher lifetime. Replace only
  // this public fixture's network transport; never contact its public address.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === outputUrl) {
      expect(request.method).toBe("GET");
      expect([...request.headers]).toEqual([]);
      return nativeFetch(origin + "/fixture/output", { signal: request.signal });
    }
    expect(new URL(request.url).origin).toBe(origin);
    return nativeFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

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
const run = (id: string, model: string, durationSeconds?: number) => generateVideo({ cfg: config(id, model), prompt: `Synthetic ${id}`,
  aspectRatio: "16:9", ...(durationSeconds === undefined ? {} : { durationSeconds }), timeoutMs: 15_000, autoProviderFallback: false });
const defaults: [string, string][] = [["gen45default", "gen4.5"], ...["veo3.1", "veo3.1_fast", "veo3"].map((model, i) => [`default${i}`, model] as [string, string])];
const invalid = ["veo3.1", "veo3.1_fast", "veo3"].flatMap((model, i) => [3, 5, 7, 9, 4.5].map((duration, j) => ({ id: `invalid${i}${j}`, model, duration })));

async function completed(id: string, model: string, duration?: number) {
  await withTempHome(async () => {
    const result = await run(id, model, duration);
    expect(result).toMatchObject({ provider: "runway", model, attempts: [], metadata: { status: "SUCCEEDED", endpoint: "/v1/text_to_video" } });
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]).toMatchObject({ buffer: MP4, mimeType: "video/mp4" });
  }, environment);
}
describe("actual Runway native duration defaults through the Worker", () => {
  it.each(defaults)("omits duration through the actual host for %s", async (id, model) => { await completed(id, model); });
  it.each([4, 6, 8])("retains the frozen veo3 explicit duration %s", async duration => {
    await completed(`legacy${duration}`, "veo3", duration);
  });
  it.each(invalid)("rejects $model duration $duration before any request", async ({ id, model, duration }) => {
    await withTempHome(async () => {
      await expect(run(id, model, duration)).rejects.toThrow("4, 6, or 8");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }, environment);
  });
});
