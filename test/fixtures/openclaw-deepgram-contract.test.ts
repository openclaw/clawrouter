import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { describe, expect, it } from "vitest";
import { withClawRouterAudioFixture as sourceFixture } from "./audio-transcription.test-support.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
type Fixture = Parameters<Parameters<typeof sourceFixture>[0]>[0];

async function fixture(id: string, run: (p: Fixture) => Promise<void>) {
  await sourceFixture(async p => {
    p.cfg.models!.providers!.clawrouter!.baseUrl = origin + "/v1";
    p.cfg.models!.providers!.clawrouter!.apiKey = "clawrouter-live-" + id + "-fixture-secret";
    const model = p.cfg.tools!.media!.models![0]!;
    model.model = "deepgram/nova-3";
    model.providerOptions = { clawrouter: {
      keyterm: ["synthetic one", "synthetic two"], tag: [id],
      punctuate: false, multichannel: true,
    } };
    expect(p.audio).toHaveLength(2048);
    await run(p);
    // Only the source-owned playable input/setup is reused. Every catalog and
    // transcription request must reach the real Worker, never this mock server.
    expect(p.catalogRequests).toHaveLength(0);
    expect(p.rawRequests).toHaveLength(0);
    expect(p.requests).toHaveLength(0);
  });
}

describe("actual registered Deepgram raw audio through Worker and SQLite", () => {
  it.each([
    ["tracks", "left\n\nright"],
    ["silent", "right"],
    ["repeat", "repeat\n\nrepeat"],
  ])("preserves complete ordered %s tracks and the current caller", async (name, text) => {
    await fixture("deepgram_" + name, async ({ cfg, filePath }) => {
      const result = await transcribeAudioFile({ cfg, filePath, mime: "audio/wav", language: "en" });
      expect(result).toMatchObject({ text, provider: "clawrouter", model: "deepgram/nova-3" });
      if (name === "tracks") {
        cfg.models!.providers!.clawrouter!.apiKey = "clawrouter-live-deepgram_tracks-invalid";
        await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/401|catalog/);
      }
    });
  });

  it.each(["malformed", "eof", "mime", "error", "redirect"])(
    "rejects %s without partial transcript, replay, or another provider",
    async name => {
      await fixture("deepgram_" + name, async ({ cfg, filePath }) => {
        const error = await transcribeAudioFile({ cfg, filePath, mime: "audio/wav", language: "en" })
          .then(() => { throw new Error("incomplete transcription unexpectedly succeeded"); }, error => error);
        expect(String(error)).toContain("502");
        expect(String(error)).not.toMatch(/fixture-secret|fixture-upstream|fixture-private|must-not-forward|never-router/);
      });
    },
  );

  it.each(["denied", "budget"])("closes %s before raw upload", async name => {
    await fixture("deepgram_" + name, async ({ cfg, filePath }) => {
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/catalog|eligible|pricing|budget/i);
    });
  });

  it("never substitutes the configured native Deepgram key for a missing proxy key", async () => {
    await fixture("deepgram_invalid", async ({ cfg, filePath }) => {
      delete cfg.models!.providers!.clawrouter!.apiKey;
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/API key|credential/i);
    });
  });

  it("rejects a configured vendor credential header before upload", async () => {
    await fixture("deepgram_invalid", async ({ cfg, filePath }) => {
      cfg.models!.providers!.clawrouter!.headers = { "x-api-key": "must-not-forward" };
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/credential|header|configured/i);
    });
  });

  it.each([
    { callback: "https://callback.example" },
    { url: "https://audio.example/file.wav" },
    { keywords: ["unsupported legacy hint"] },
    { model: "flux-general-en" },
    { api_key: "must-not-forward" },
  ])("rejects unsupported native query %j before discovery/upload", async query => {
    await fixture("deepgram_invalid", async ({ cfg, filePath }) => {
      cfg.tools!.media!.models![0]!.providerOptions = { clawrouter: query };
      await expect(transcribeAudioFile({ cfg, filePath })).rejects.toThrow(/Deepgram|query|option/i);
    });
  });

  it("cancels the actual host and separately qualifies controlled incoming Worker cleanup", async () => {
    await fixture("deepgram_cancel", async ({ cfg, filePath }) => {
      const caller = new AbortController();
      const reason = new DOMException("synthetic caller cancellation", "AbortError");
      let completed = false;
      const pending = transcribeAudioFile({ cfg, filePath, mime: "audio/wav", language: "en" },
        { signal: caller.signal, assertCurrent: () => {} })
        .then(value => { completed = true; return { value }; }, error => { completed = true; return { error }; });
      let state: { activeReads?: number; bytes?: number; status?: number; canceled?: boolean } = {};
      for (let attempt = 0; attempt < 100 && !completed; attempt++) {
        const response = await fetch(origin + "/fixture/state");
        expect(response.status).toBe(200);
        state = (await response.json()).calls.find((call: { id: string }) => call.id === "deepgram_cancel") ?? {};
        if (state.activeReads === 1 && state.bytes === 11 && state.status === 200) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(completed, JSON.stringify(state)).toBe(false);
      expect(state).toMatchObject({ activeReads: 1, bytes: 11, status: 200, canceled: false });
      caller.abort(reason);
      const result = await pending;
      expect("value" in result).toBe(false);
      const errors: string[] = [];
      let current: unknown = "error" in result ? result.error : undefined;
      for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
        errors.push(String((current as { name?: string }).name));
        current = (current as { cause?: unknown }).cause;
      }
      expect(errors).toContain("AbortError");
      // The locked local runtime's physical pre-header disconnect propagation
      // remains separate. This explicit test-only signal owns the same request.
      const control = await fetch(origin + "/fixture/abort", { method: "POST" });
      expect(control.status).toBe(200);
      expect(await control.json()).toEqual({ injected: true });
    });
  });
});
