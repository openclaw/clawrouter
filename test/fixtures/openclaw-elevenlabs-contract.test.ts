import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { channel } from "node:diagnostics_channel";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { synthesizeSpeech } from "openclaw/plugin-sdk/tts-runtime";
import { describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { invokeTalkSpeakDirect } from "./test-helpers.js";

// The source-owned, offline-generated MP3 is supplied by the outer Worker fixture.
const MP3 = Buffer.from(process.env.CLAWROUTER_CONTRACT_AUDIO_BASE64!, "base64");
function config(id: string): OpenClawConfig {
  return {
    plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
    models: { providers: {
      clawrouter: {
        baseUrl: process.env.CLAWROUTER_CONTRACT_ORIGIN! + "/v1",
        apiKey: `clawrouter-live-${id}-fixture-secret`,
        headers: { "x-api-key": "must-not-forward", "xi-api-key": "must-not-forward" },
        models: [], request: { allowPrivateNetwork: true },
      },
      openai: { baseUrl: "https://unused-upstream.example/v1", apiKey: "must-not-fallback", models: [] },
    } },
    tts: { provider: "clawrouter", providers: { clawrouter: {
      upstreamProvider: "elevenlabs", voiceId: "syntheticVoice1234567", modelId: "eleven_multilingual_v2",
      seed: 42, languageCode: "en", applyTextNormalization: "auto", latencyTier: 2,
      voiceSettings: { stability: 0.4, similarityBoost: 0.7, style: 0.1, useSpeakerBoost: false, speed: 1.2 },
    } } },
    talk: { provider: "clawrouter", providers: { clawrouter: { upstreamProvider: "elevenlabs", speakerVoiceId: "syntheticVoice1234567" } } },
  };
}
const environment = { env: { CLAWROUTER_API_KEY: undefined, OPENAI_API_KEY: "must-not-fallback", ELEVENLABS_API_KEY: "must-not-fallback" } };

describe("actual model-less ElevenLabs TTS and Talk through workerd", () => {
  it("delivers complete fragmented MP3 and re-admits the current proxy key", async () => {
    await withTempHome(async home => {
      const cfg = config("elevenlabs_tts");
      const result = await synthesizeSpeech({ text: "Synthetic café 😀", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result, result.error).toMatchObject({ success: true, provider: "clawrouter", audioBuffer: MP3, outputFormat: "mp3_44100_128", fileExtension: ".mp3" });
      // Client metadata may retain native model_id; the router offer/usage stays model-less.
      expect(result.providerModel).toBe("eleven_multilingual_v2");
      cfg.models!.providers!.clawrouter.apiKey = "clawrouter-live-elevenlabs_tts-invalid";
      const denied = await synthesizeSpeech({ text: "Do not synthesize", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(denied.success).toBe(false);
      expect(denied.audioBuffer).toBeUndefined();
      expect(denied.error).toContain("401");
    }, environment);
  });

  it("runs the real talk.speak handler with a native voice override and refreshed grants", async () => {
    await withTempHome(async () => {
      const cfg = config("elevenlabs_talk");
      setRuntimeConfigSnapshot(cfg, cfg);
      try {
        const result = await invokeTalkSpeakDirect({ text: "Synthetic Talk", voiceId: "syntheticOverride123" });
        expect(result, JSON.stringify(result?.error)).toMatchObject({ ok: true, payload: { provider: "clawrouter", audioBase64: MP3.toString("base64"), outputFormat: "mp3_44100_128", mimeType: "audio/mpeg" } });
        const restricted = config("elevenlabs_denied");
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
      const result = await synthesizeSpeech({ text: "Do not synthesize", cfg: config("elevenlabs_budget"), prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false);
      expect(result.audioBuffer).toBeUndefined();
      expect(result.error).toMatch(/no eligible supported offer|pricing|402/i);
    }, environment);
  });

  it("never substitutes a native upstream key for a missing proxy key", async () => {
    await withTempHome(async home => {
      const cfg = config("elevenlabs_invalid");
      delete cfg.models!.providers!.clawrouter.apiKey;
      const result = await synthesizeSpeech({ text: "Do not synthesize", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false);
      expect(result.audioBuffer).toBeUndefined();
    }, environment);
  });

  it.each([{ model: "elevenlabs/fake-model" }, { voiceId: "../foreign" }, { responseFormat: "opus" }, { stream: true }, { query: { api_key: "must-not-forward" } }])("rejects unqualified settings before synthesis (%j)", async override => {
    await withTempHome(async home => {
      const cfg = config("elevenlabs_invalid");
      Object.assign(cfg.tts!.providers!.clawrouter, override);
      const result = await synthesizeSpeech({ text: "Do not synthesize", cfg, prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false);
      expect(result.audioBuffer).toBeUndefined();
    }, environment);
  });

  it.each(["error", "eof", "mime"])("does not return partial audio, replay or fall back after %s", async failure => {
    await withTempHome(async home => {
      const result = await synthesizeSpeech({ text: `Synthetic ${failure}`, cfg: config(`elevenlabs_${failure}`), prefsPath: home + "/tts-prefs.json", disableFallback: true });
      expect(result.success).toBe(false);
      expect(result.audioBuffer).toBeUndefined();
      expect(result.error).toContain("502");
      expect(result.error).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream|fixture-private/);
    }, environment);
  });

  it("cancels an incomplete synthesis at the actual caller deadline without replay", async () => {
    await withTempHome(async home => {
      const started = performance.now();
      const events: Record<string, unknown>[] = [];
      const record = (phase: string) => (message: unknown) => {
        const value = message as { request?: { path?: string }; error?: { name?: string; code?: string; cause?: { name?: string; code?: string } } };
        events.push({ phase, elapsedMs: Math.round(performance.now() - started),
          catalog: value.request?.path?.includes("/catalog") ?? false,
          name: value.error?.name, code: value.error?.code,
          causeName: value.error?.cause?.name, causeCode: value.error?.cause?.code });
      };
      const created = record("request"), failed = record("error");
      channel("undici:request:create").subscribe(created);
      channel("undici:request:error").subscribe(failed);
      try {
        const result = await synthesizeSpeech({ text: "Synthetic cancel", cfg: config("elevenlabs_cancel"), prefsPath: home + "/tts-prefs.json", disableFallback: true, timeoutMs: 2000 });
        const observed = { elapsedMs: Math.round(performance.now() - started), error: result.error, events };
        console.info("ElevenLabs caller deadline evidence: " + JSON.stringify(observed));
        expect(result.success).toBe(false);
        expect(result.audioBuffer).toBeUndefined();
        expect(result.error, JSON.stringify(observed)).toMatch(/timed out|abort/i);
      } finally {
        channel("undici:request:create").unsubscribe(created);
        channel("undici:request:error").unsubscribe(failed);
      }
    }, environment);
  });
});
