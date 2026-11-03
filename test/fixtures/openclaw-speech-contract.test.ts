import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { synthesizeSpeech } from "openclaw/plugin-sdk/tts-runtime";
import { describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { invokeTalkSpeakDirect } from "./test-helpers.js";

const AUDIO = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
function config(id: string): OpenClawConfig {
  return {
    plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
    models: { providers: {
      clawrouter: {
        baseUrl: process.env.CLAWROUTER_CONTRACT_ORIGIN! + "/v1",
        apiKey: `clawrouter-live-${id}-fixture-secret`,
        models: [], request: { allowPrivateNetwork: true },
      },
      openai: { baseUrl: "https://unused-upstream.example/v1", apiKey: "must-not-fallback", models: [] },
    } },
    tts: { provider: "clawrouter", providers: { clawrouter: { model: "openai/tts-1" } } },
    talk: { provider: "clawrouter", providers: { clawrouter: { modelId: "openai/tts-1", speakerVoiceId: "shimmer", responseFormat: "wav" } } },
  };
}
const environment = { env: { CLAWROUTER_API_KEY: undefined, OPENAI_API_KEY: "must-not-fallback" } };

describe("actual TTS and Talk catalog transports through workerd", () => {
  it("delivers fragmented binary audio through TTS and re-admits the current key", async () => {
    await withTempHome(async home => {
      const cfg = config("speech_tts");
      const result = await synthesizeSpeech({ text: "Synthetic TTS", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result, result.error).toMatchObject({ success: true, provider: "clawrouter", providerModel: "openai/tts-1", audioBuffer: AUDIO, outputFormat: "mp3" });
      cfg.models!.providers!.clawrouter.apiKey = "clawrouter-live-speech_tts-invalid";
      const denied = await synthesizeSpeech({ text: "Do not synthesize", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(denied.success).toBe(false);
      expect(denied.error).toContain("401");
    }, environment);
  });

  it("runs the real talk.speak handler, preserves voice overrides and refreshes grants", async () => {
    await withTempHome(async () => {
      const cfg = config("speech_talk");
      setRuntimeConfigSnapshot(cfg, cfg);
      try {
        const result = await invokeTalkSpeakDirect({ text: "Synthetic Talk", voiceId: "nova", speed: 1.25 });
        expect(result, JSON.stringify(result?.error)).toMatchObject({ ok: true, payload: { provider: "clawrouter", audioBase64: AUDIO.toString("base64"), outputFormat: "wav", mimeType: "audio/wav" } });
        const restricted = config("speech_denied");
        setRuntimeConfigSnapshot(restricted, restricted);
        const denied = await invokeTalkSpeakDirect({ text: "Do not synthesize" });
        expect(denied).toMatchObject({ ok: false, error: { message: expect.stringContaining("no eligible supported offer") } });
      } finally {
        clearRuntimeConfigSnapshot();
      }
    }, environment);
  });

  it("preserves Unicode input for character settlement without synthesizing token usage", async () => {
    await withTempHome(async home => {
      const result = await synthesizeSpeech({ text: "one 😀", cfg: config("speech_priced"), prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result, result.error).toMatchObject({ success: true, audioBuffer: AUDIO });
    }, environment);
  });

  it("rejects an insufficient hard budget before upstream synthesis", async () => {
    await withTempHome(async home => {
      const result = await synthesizeSpeech({ text: "Do not synthesize", cfg: config("speech_budget"), prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no eligible supported offer|budget|402/i);
    }, environment);
  });

  it("preserves upstream failure without returning audio or falling back to OpenAI", async () => {
    await withTempHome(async home => {
      const result = await synthesizeSpeech({ text: "Synthetic rejection", cfg: config("speech_error"), prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false);
      expect(result.audioBuffer).toBeUndefined();
      expect(result.error).toContain("502");
      expect(result.error).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
    }, environment);
  });
});
