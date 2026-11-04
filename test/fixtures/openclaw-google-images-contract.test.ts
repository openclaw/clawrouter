import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { generateImage } from "openclaw/plugin-sdk/image-generation-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["google/gemini-3.1-flash-image", "google/gemini-3-pro-image"];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=", "base64");
async function run(id: string, model = models[0], edit = false, signal?: AbortSignal, invalid = false) {
  const captured = createCapturedPluginRegistration(); plugin.register?.(captured.api);
  expect(captured.imageGenerationProviders.some(p => p.id === "clawrouter")).toBe(true);
  const cfg: OpenClawConfig = { models: { providers: {
    clawrouter: { baseUrl: origin, apiKey: invalid ? "clawrouter-live-gimage_model0_text-invalid" : `clawrouter-live-gimage_${id}-fixture-secret`, models: [], request: { allowPrivateNetwork: true } },
    google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "must-not-fallback", models: [] },
  } } };
  return generateImage({ cfg, prompt: `synthetic gimage_${id}`, modelOverride: "clawrouter/" + model, autoProviderFallback: false,
    timeoutMs: 10_000, signal, aspectRatio: "1:1", resolution: "1K", ...(edit ? { inputImages: [{ buffer: png, mimeType: "image/png" }] } : {}) },
    { getProvider: id => captured.imageGenerationProviders.find(p => p.id === id), listProviders: () => captured.imageGenerationProviders, log: { warn() {} } });
}

describe("actual registered Google image host through credential-scoped Worker offers", () => {
  useIsolatedStateGuard();
  it.each(models.flatMap((model, i) => [false, true].map(edit => ({ model, id: `model${i}_${edit ? "edit" : "text"}`, edit }))))("selects $id through the actual image host", async ({ model, id, edit }) => {
    const result = await run(id, model, edit);
    expect(result).toMatchObject({ provider: "clawrouter", model, images: [{ buffer: png, mimeType: "image/png" }] });
  });
  it("denies unknown upstream-dollar pricing and invalid proxy credentials without Google fallback", async () => {
    await expect(run("unpriced")).rejects.toThrow();
    await expect(run("model0_text", models[0], false, undefined, true)).rejects.toThrow();
  });
  it("rejects an already-aborted host request without any paid create", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(run("aborted", models[0], false, controller.signal)).rejects.toThrow();
  });
  it("does not expose incomplete native output or retry paid generation", async () => {
    await expect(run("incomplete")).rejects.toThrow();
  });
});
