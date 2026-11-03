import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { synthesizeSpeech } from "openclaw/plugin-sdk/tts-runtime";
import { describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { invokeTalkSpeakDirect } from "./test-helpers.js";

// Synthetic transport fixtures, not decoder/playback or live inference proof.
const WAV = Buffer.from("UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA", "base64");
const OPUS = Buffer.from("OggS\0synthetic OpusHead transport fixture", "utf8");
function config(id: string): OpenClawConfig {
  return {
    plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
    models: { providers: {
      clawrouter: {
        baseUrl: process.env.CLAWROUTER_CONTRACT_ORIGIN! + "/v1",
        apiKey: `clawrouter-live-${id}-fixture-secret`,
        headers: { "x-api-key": "must-not-forward" },
        models: [], request: { allowPrivateNetwork: true },
      },
      openai: { baseUrl: "https://unused-upstream.example/v1", apiKey: "must-not-fallback", models: [] },
    } },
    tts: { provider: "clawrouter", providers: { clawrouter: { upstreamProvider: "gradium", voiceId: "synthetic-voice" } } },
    talk: { provider: "clawrouter", providers: { clawrouter: { upstreamProvider: "gradium", speakerVoiceId: "synthetic-voice", responseFormat: "wav" } } },
  };
}
const environment = { env: { CLAWROUTER_API_KEY: undefined, OPENAI_API_KEY: "must-not-fallback", GRADIUM_API_KEY: "must-not-fallback" } };

describe("actual model-less Gradium TTS and Talk through workerd", () => {
  it("delivers complete fragmented WAV and re-admits the current proxy key", async () => {
    await withTempHome(async home => {
      const cfg = config("gradium_wav");
      const result = await synthesizeSpeech({ text: "Synthetic café WAV", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result, result.error).toMatchObject({ success: true, provider: "clawrouter", audioBuffer: WAV, outputFormat: "wav" });
      expect(result.providerModel).toBeUndefined();
      cfg.models!.providers!.clawrouter.apiKey = "clawrouter-live-gradium_wav-invalid";
      const denied = await synthesizeSpeech({ text: "Do not synthesize", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(denied.success).toBe(false);
      expect(denied.audioBuffer).toBeUndefined();
      expect(denied.error).toContain("401");
    }, environment);
  });

  it("preserves explicit Ogg Opus transport bytes", async () => {
    await withTempHome(async home => {
      const cfg = config("gradium_opus");
      cfg.tts!.providers!.clawrouter.responseFormat = "opus";
      const result = await synthesizeSpeech({ text: "Synthetic Opus", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result, result.error).toMatchObject({ success: true, provider: "clawrouter", audioBuffer: OPUS, outputFormat: "opus" });
      expect(result.providerModel).toBeUndefined();
    }, environment);
  });

  it("runs the real talk.speak handler with native voice override and refreshed grants", async () => {
    await withTempHome(async () => {
      const cfg = config("gradium_talk");
      setRuntimeConfigSnapshot(cfg, cfg);
      try {
        const result = await invokeTalkSpeakDirect({ text: "Synthetic Talk", voiceId: "synthetic-override" });
        expect(result, JSON.stringify(result?.error)).toMatchObject({ ok: true, payload: { provider: "clawrouter", audioBase64: WAV.toString("base64"), outputFormat: "wav", mimeType: "audio/wav" } });
        const restricted = config("gradium_denied");
        setRuntimeConfigSnapshot(restricted, restricted);
        const denied = await invokeTalkSpeakDirect({ text: "Do not synthesize" });
        expect(denied).toMatchObject({ ok: false, error: { message: expect.stringContaining("no eligible supported offer") } });
      } finally {
        clearRuntimeConfigSnapshot();
      }
    }, environment);
  });

  it("keeps unknown upstream pricing closed under a hard-dollar budget", async () => {
    await withTempHome(async home => {
      const result = await synthesizeSpeech({ text: "Do not synthesize", cfg: config("gradium_budget"), prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false);
      expect(result.audioBuffer).toBeUndefined();
      expect(result.error).toMatch(/no eligible supported offer|pricing|402/i);
    }, environment);
  });

  it("never substitutes the native upstream key for a missing proxy key", async () => {
    await withTempHome(async home => {
      const cfg = config("gradium_invalid");
      delete cfg.models!.providers!.clawrouter.apiKey;
      const result = await synthesizeSpeech({ text: "Do not synthesize", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false);
      expect(result.audioBuffer).toBeUndefined();
    }, environment);
  });

  it.each([{ model: "gradium/fake-model" }, { speed: 1.2 }, { instructions: "whisper" }, { responseFormat: "ulaw_8000" }])("rejects unqualified settings before synthesis (%j)", async override => {
    await withTempHome(async home => {
      const cfg = config("gradium_invalid");
      Object.assign(cfg.tts!.providers!.clawrouter, override);
      const result = await synthesizeSpeech({ text: "Do not synthesize", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false);
      expect(result.audioBuffer).toBeUndefined();
    }, environment);
  });

  it.each(["error", "eof", "mime"])("does not return partial audio, replay or fall back after %s", async failure => {
    await withTempHome(async home => {
      const result = await synthesizeSpeech({ text: `Synthetic ${failure}`, cfg: config(`gradium_${failure}`), prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false);
      expect(result.audioBuffer).toBeUndefined();
      expect(result.error).toContain("502");
      expect(result.error).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream|fixture-private/);
    }, environment);
  });
});
