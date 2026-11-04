import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { synthesizeSpeech } from "openclaw/plugin-sdk/tts-runtime";
import { describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { invokeTalkSpeakDirect } from "./test-helpers.js";

const mp3 = Buffer.from(process.env.CLAWROUTER_CONTRACT_MP3!, "base64");
const format = "audio-24khz-48kbitrate-mono-mp3";
function config(id: string): OpenClawConfig {
  return {
    plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
    models: { providers: {
      clawrouter: { baseUrl: process.env.CLAWROUTER_CONTRACT_ORIGIN! + "/v1", apiKey: `clawrouter-live-${id}-fixture-secret`,
        headers: { "x-api-key": "must-not-forward", "Ocp-Apim-Subscription-Key": "must-not-forward", "Ocp-Apim-Subscription-Region": "must-not-forward" },
        models: [], request: { allowPrivateNetwork: true } },
      openai: { baseUrl: "https://unused-upstream.example/v1", apiKey: "must-not-fallback", models: [] },
    } },
    tts: { provider: "clawrouter", providers: { clawrouter: { upstreamProvider: "azure-speech", voiceId: "en-US-JennyNeural" } } },
    talk: { provider: "clawrouter", providers: { clawrouter: { upstreamProvider: "azure-speech", speakerVoiceId: "en-US-JennyNeural" } } },
  };
}
const environment = { env: { CLAWROUTER_API_KEY: undefined, OPENAI_API_KEY: "must-not-fallback", AZURE_SPEECH_API_KEY: "must-not-fallback", AZURE_SPEECH_REGION: "westus" } };

describe("actual Azure SSML TTS and Talk through workerd", () => {
  it("delivers complete MP3 from escaped Unicode SSML and rechecks a changed proxy key", async () => {
    await withTempHome(async home => {
      const cfg = config("azure_tts");
      const result = await synthesizeSpeech({ text: "Synthetic café & 中文 😀 <tag>", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result, result.error).toMatchObject({ success: true, provider: "clawrouter", audioBuffer: mp3, outputFormat: format });
      expect(result.providerModel).toBeUndefined();
      cfg.models!.providers!.clawrouter.apiKey = "clawrouter-live-azure_tts-invalid";
      const denied = await synthesizeSpeech({ text: "Do not synthesize", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(denied.success).toBe(false); expect(denied.audioBuffer).toBeUndefined(); expect(denied.error).toContain("401");
    }, environment);
  });

  it("runs the actual Talk handler with explicit voice override and refreshed provider grants", async () => {
    await withTempHome(async () => {
      const cfg = config("azure_talk"); setRuntimeConfigSnapshot(cfg, cfg);
      try {
        const result = await invokeTalkSpeakDirect({ text: "Synthetic Talk", voiceId: "en-US-AriaNeural" });
        expect(result, JSON.stringify(result?.error)).toMatchObject({ ok: true, payload: { provider: "clawrouter", audioBase64: mp3.toString("base64"), outputFormat: format, mimeType: "audio/mpeg" } });
        const restricted = config("azure_denied"); setRuntimeConfigSnapshot(restricted, restricted);
        const denied = await invokeTalkSpeakDirect({ text: "Do not synthesize" });
        expect(denied).toMatchObject({ ok: false, error: { message: expect.stringContaining("no eligible supported offer") } });
      } finally { clearRuntimeConfigSnapshot(); }
    }, environment);
  });

  it("rejects unknown upstream-dollar pricing without a synthesis request", async () => {
    await withTempHome(async home => {
      const result = await synthesizeSpeech({ text: "Do not synthesize", cfg: config("azure_budget"), prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false); expect(result.audioBuffer).toBeUndefined();
      expect(result.error).toMatch(/no eligible supported offer|pricing|402/i);
    }, environment);
  });

  it("does not use Azure or OpenAI credentials as a missing proxy key", async () => {
    await withTempHome(async home => {
      const cfg = config("azure_invalid"); delete cfg.models!.providers!.clawrouter.apiKey;
      const result = await synthesizeSpeech({ text: "Do not synthesize", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false); expect(result.audioBuffer).toBeUndefined();
    }, environment);
  });

  it.each([{ model: "azure-speech/invented" }, { region: "westus" }, { endpoint: "https://foreign.example" },
    { speed: 1.2 }, { instructions: "whisper" }, { outputFormat: "raw-8khz-8bit-mono-mulaw" }, { responseFormat: "ogg-24khz-16bit-mono-opus" }])("rejects unqualified settings before synthesis (%j)", async override => {
    await withTempHome(async home => {
      const cfg = config("azure_invalid"); Object.assign(cfg.tts!.providers!.clawrouter, override);
      const result = await synthesizeSpeech({ text: "Do not synthesize", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false); expect(result.audioBuffer).toBeUndefined();
    }, environment);
  });

  it.each(["error", "eof", "mime", "empty"])("returns no partial audio or fallback after %s", async failure => {
    await withTempHome(async home => {
      const result = await synthesizeSpeech({ text: `Synthetic ${failure}`, cfg: config(`azure_${failure}`), prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false); expect(result.audioBuffer).toBeUndefined(); expect(result.error).toContain("502");
      expect(result.error).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream|fixture-private/);
    }, environment);
  });
});
