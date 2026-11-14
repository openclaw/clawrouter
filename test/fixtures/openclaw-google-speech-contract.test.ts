// Installed into the exact public SDK revision only by the native CI helper.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as guardedFetch from "../../infra/net/fetch-guard.js";
import { fetchWithRuntimeDispatcher, type DispatcherAwareRequestInit } from "../../infra/net/runtime-fetch.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import fs from "node:fs/promises";
import { synthesizeSpeech } from "openclaw/plugin-sdk/tts-runtime";
import { getSpeechProvider } from "../../tts/provider-registry.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { invokeTalkSpeakDirect } from "../../gateway/talk/test-helpers.js";
import { createTtsTool } from "./tts-tool.js";

const expectedHead = "55fb53b54f5f430439ade866f68a18626890610c";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const control = process.env.CLAWROUTER_CONTRACT_CONTROL!;
const models = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"];
const speechPath = (path: string) => path === "/v1/proxy/google-gemini/speech_interactions" || /^\/v1\/native\/google-gemini\/v1beta\/models\/gemini-[a-z0-9.-]+:generateContent$/.test(path);
const text = "Synthetic speech 😀 café";
const wav = "524946462c00000057415645666d74201000000001000100c05d000080bb00000200100064617461080000000000ff7f0000ff7f";
const nativeFetch = globalThis.fetch;
const originalGuard = guardedFetch.fetchWithSsrFGuard;
const key = (name: string) => `clawrouter-live-gs_${name}-fixture-secret`;
type Observation = {
  path: string;
  credential: string;
  releaseReturned: boolean;
  failedBeforeResponse: boolean;
  deadlineAt?: number;
  signal?: AbortSignal | null;
  dispatcher?: DispatcherAwareRequestInit["dispatcher"];
  close?: ReturnType<typeof vi.spyOn>;
  body?: ReadableStream<Uint8Array> | null;
  cancels: Array<Promise<unknown>>;
  reads: Array<Promise<unknown>>;
  readers: Array<{ reader: ReadableStreamDefaultReader<Uint8Array>; unlock: ReturnType<typeof vi.spyOn> }>;
  done: Promise<unknown>;
};
const observations: Observation[] = [];
const unexpected: string[] = [];
function refuse(reason: string): never { unexpected.push(reason); throw new Error(reason); }

async function command(path: string, method = "GET", base = origin, signal?: AbortSignal) {
  const response = await nativeFetch(base + path, { method, signal });
  const body = await response.text();
  expect(response.status, path).toBe(200);
  return body;
}

beforeEach(() => {
  expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(expectedHead);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(expectedHead);
  // Fake Date alone: actual timers, signals, I/O and cleanup remain native.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
  observations.length = 0;
  unexpected.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== origin) refuse("unexpected client egress");
    return nativeFetch(request);
  });
  const observeGuard: typeof originalGuard = async options => {
    const url = new URL(String(options.url));
    if (url.origin !== origin || (url.pathname !== "/v1/catalog" && !speechPath(url.pathname)) || url.search) refuse("unexpected speech route");
    const headers = new Headers(options.init?.headers);
    if (headers.has("x-api-key") || headers.has("x-goog-api-key")) refuse("client forwarded a vendor credential override");
    const credential = headers.get("authorization") ?? "";
    if (observations.some(row => row.path === url.pathname && row.credential === credential)) refuse("repeated speech route");
    let finished!: (value?: unknown) => void;
    const row: Observation = { path: url.pathname, credential, releaseReturned: false, failedBeforeResponse: false,
      deadlineAt: options.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs,
      cancels: [], reads: [], readers: [], done: new Promise(resolve => { finished = resolve; }) };
    observations.push(row);
    try {
      const result = await originalGuard({ ...options,
        policy: ssrfRuntime.ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin),
        fetchImpl: async (input, supplied) => {
          const init = supplied as DispatcherAwareRequestInit | undefined;
          if (!init?.dispatcher || row.dispatcher) throw new Error("missing or repeated real dispatcher");
          row.dispatcher = init.dispatcher;
          row.signal = init.signal;
          // Pass-through spy on this exact owned dispatcher, including the
          // pre-response abort path. No fake release and no global prototype patch.
          row.close = vi.spyOn(init.dispatcher, "close");
          return fetchWithRuntimeDispatcher(input, init);
        },
      });
      if (url.pathname === "/v1/catalog" && result.response.ok) {
        try {
          const catalog = await result.response.clone().json();
          const provider = catalog.providers.find((value: { id: string }) => value.id === "google-gemini");
          expect(catalog.providers.some((value: { id: string }) => value.id === "google")).toBe(false);
          const offers = provider?.offers.filter((value: { endpoint: string }) => value.endpoint.startsWith("speech_")) ?? [];
          for (const offer of offers) {
            expect(offer.routeKind).toBe(offer.endpoint === "speech_generate_content" ? "native" : "manifest");
            expect(offer.modelId).toMatch(/^google\/gemini-/);
          }
          if (!/gs_(grant|foreign|policy|budget|key)-/.test(credential)) {
            expect(catalog.scope).toMatchObject({ authType: "proxy_key", credentialId: credential.split("-")[2] });
            expect(offers.filter((value: { eligible: boolean }) => value.eligible)).toHaveLength(5);
          }
          // Genuine current-authority mutations after the unmodified catalog.
          if (credential === `Bearer ${key("revoked")}`) await command("/__google/revoke/gs_revoked", "POST");
          if (credential === `Bearer ${key("stale_policy")}`) await command("/__google/restrict/gs_stale_policy", "POST");
        } catch (error) {
          const failures = [error];
          let cancel: Promise<unknown> | undefined;
          try { cancel = result.response.body?.cancel(); } catch (failure) { failures.push(failure); }
          // Observe cancellation immediately, but preserve release-before-join:
          // waiting for a tee cancellation first can deadlock the transport.
          const cancellation = cancel ? Promise.allSettled([cancel]) : undefined;
          try { await result.release(); } catch (failure) { failures.push(failure); }
          for (const value of await cancellation ?? []) if (value.status === "rejected") failures.push(value.reason);
          if (failures.length > 1) throw new AggregateError(failures, "catalog observation or cleanup failed");
          throw error;
        }
      }
      row.body = result.response.body;
      if (row.body) {
        const body = row.body, cancel = body.cancel.bind(body);
        const getReader = body.getReader.bind(body) as () => ReadableStreamDefaultReader<Uint8Array>;
        vi.spyOn(body, "cancel").mockImplementation(reason => {
          const actual = cancel(reason); row.cancels.push(actual); return actual;
        });
        vi.spyOn(body, "getReader").mockImplementation(options => {
          expect(options).toBeUndefined(); // The pinned SDK uses the default reader.
          const reader = getReader();
          row.readers.push({ reader, unlock: vi.spyOn(reader, "releaseLock") });
          const read = reader.read.bind(reader);
          vi.spyOn(reader, "read").mockImplementation(() => { const actual = read(); row.reads.push(actual); return actual; });
          const cancelReader = reader.cancel.bind(reader);
          vi.spyOn(reader, "cancel").mockImplementation(reason => {
            const actual = cancelReader(reason); row.cancels.push(actual); return actual;
          });
          return reader;
        });
      }
      return { ...result, release: async () => {
        try { await result.release(); row.releaseReturned = true; finished(); }
        catch (error) { finished({ error }); throw error; }
      } };
    } catch (error) { row.failedBeforeResponse = true; finished({ error }); throw error; }
  };
  // Both the catalog reader and registered speech transport enter the genuine guard.
  vi.spyOn(guardedFetch, "fetchWithSsrFGuard").mockImplementation(observeGuard);
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(observeGuard);
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); expect(unexpected).toEqual([]); });

async function join(name: string) {
  const selected = observations.filter(row => row.credential.startsWith(`Bearer clawrouter-live-gs_${name}-`));
  const transport = selected.map(async row => {
    const completion = await row.done;
    expect(row.dispatcher).toBeDefined();
    expect(row.close).toHaveBeenCalledOnce();
    const closeResult = row.close!.mock.results[0];
    if (!closeResult) throw new Error("missing original dispatcher close result");
    expect(closeResult.type).toBe("return");
    expect(closeResult.value).toBeInstanceOf(Promise);
    await closeResult.value;
    expect(row.dispatcher!.closed || row.dispatcher!.destroyed).toBe(true);
    if (row.failedBeforeResponse) {
      expect(["abort_headers", "abort_body", "deadline"]).toContain(name);
      expect(completion).toHaveProperty("error");
    } else {
      expect(completion).toBeUndefined();
      expect(row.releaseReturned).toBe(true);
      // These are the SDK's own unawaited cancel promises. The test joins them
      // after execute/release; it does not change the SDK's ordering.
      await Promise.allSettled(row.reads);
      const cancellations = await Promise.allSettled(row.cancels);
      expect(cancellations.every(value => value.status === "fulfilled")).toBe(true);
      for (const entry of row.readers) expect(entry.unlock).toHaveBeenCalledOnce();
      expect(row.body?.locked ?? false).toBe(false);
    }
  });
  // Attempt every original transport and the Worker join before any one
  // observation failure can prevent another owned resource's cleanup.
  const results = await Promise.allSettled([...transport, command(`/__google/join/gs_${name}`)]);
  const failures = results.filter((value): value is PromiseRejectedResult => value.status === "rejected").map(value => value.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "speech transport or Worker join failed");
  const worker = results.at(-1);
  if (worker?.status !== "fulfilled" || typeof worker.value !== "string") throw new Error("missing Worker join result");
  const state = JSON.parse(worker.value);
  expect(selected.map(row => row.path)).toEqual(state.paths);
  expect(state).toMatchObject({ retired: true, charged: 0 });
  if (state.hasBody) {
    expect(state).toMatchObject({ calls: 1, activeReads: 0, unlocked: true, sourceLocked: false, physicalLocked: false });
    expect(state.eof || state.canceled || state.readRejected).toBe(true);
    expect(state.readResults).toHaveLength(state.readCalls);
    expect(state.readResults.every((status: string) => status === "fulfilled" || status === "rejected")).toBe(true);
    expect(state.readResults.includes("rejected")).toBe(state.readRejected);
    expect(state.cancelCalls).toBe(state.canceled ? 1 : 0);
    expect(state.cancelResults).toHaveLength(state.cancelCalls);
    expect(state.cancelResults.every((status: string) => status === "fulfilled")).toBe(true);
  }
  return state;
}

async function fixture(name: string, run: (cfg: OpenClawConfig, prefsPath: string) => Promise<void>, model = models[3]!) {
  await withOpenClawTestState({ label: "clawrouter-google-speech-worker", env: {
    OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../../extensions", import.meta.url)),
    CLAWROUTER_API_KEY: undefined, GOOGLE_API_KEY: "must-not-fallback", GEMINI_API_KEY: "must-not-fallback",
    HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined,
    http_proxy: undefined, https_proxy: undefined, all_proxy: undefined,
  } }, async state => {
    const cfg: OpenClawConfig = {
      plugins: { allow: ["clawrouter", "openai"], entries: { clawrouter: { enabled: true }, openai: { enabled: true } } },
      models: { providers: {
        clawrouter: { baseUrl: origin + "/v1", apiKey: name === "key" ? "clawrouter-live-gs_key-invalid" : key(name), models: [],
          request: { allowPrivateNetwork: true }, headers: { "x-goog-api-key": "must-not-fallback", "x-api-key": "must-not-fallback" } },
        openai: { baseUrl: "https://alternate.example/v1", apiKey: "must-not-fallback", models: [] },
      } },
      agents: { defaults: { voiceModel: { primary: `clawrouter/google/${model}`, fallbacks: ["openai/tts-1"] } } },
      tts: { provider: "clawrouter", providers: { clawrouter: { upstreamProvider: "google", model: `google/${model}`, voice: "Kore" } } },
      talk: { provider: "clawrouter", providers: { clawrouter: { upstreamProvider: "google", modelId: `google/${model}`, speakerVoiceId: "Kore" } } },
    };
    const failures: unknown[] = [];
    try { await run(cfg, state.home + "/tts-prefs.json"); } catch (error) { failures.push(error); }
    try { await join(name); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "speech assertion or original cleanup failed");
  });
}

function direct(cfg: OpenClawConfig, signal?: AbortSignal, timeoutMs = 30_000) {
  const provider = getSpeechProvider("clawrouter", cfg);
  if (!provider) throw new Error("missing genuine registered speech provider");
  return provider.synthesize({ cfg, providerConfig: cfg.tts!.providers!.clawrouter!, text, target: "audio-file", signal, timeoutMs });
}

describe("published canonical Google speech with real Worker/SQLite", () => {
  it.each(models.map((model, i) => [model, `model${i}`] as const))("registered TTS tool returns complete WAV for %s", async (model, name) => {
    await fixture(name, async cfg => {
      const result = await createTtsTool({ config: cfg }).execute("google-worker", { text });
      const details = result.details as { provider: string; audioPath: string; media: { audioAsVoice?: boolean } };
      expect(details.provider).toBe("clawrouter"); expect(details.audioPath).toMatch(/\.wav$/);
      expect(details.media.audioAsVoice).not.toBe(true);
      expect((await fs.readFile(details.audioPath)).toString("hex")).toBe(wav);
      expect(observations.map(row => row.path)).toEqual(["/v1/catalog", model.startsWith("gemini-3.8-") ? "/v1/proxy/google-gemini/speech_interactions" : `/v1/native/google-gemini/v1beta/models/${model}:generateContent`]);
    }, model);
  }, 120_000);

  it("actual Talk handler returns WAV without claiming remote macOS stop", async () => {
    await fixture("talk", async cfg => {
      setRuntimeConfigSnapshot(cfg, cfg);
      try {
        const result = await invokeTalkSpeakDirect({ text });
        expect(result).toMatchObject({ ok: true, payload: { provider: "clawrouter", mimeType: "audio/wav", outputFormat: "wav", audioBase64: Buffer.from(wav, "hex").toString("base64") } });
      } finally { clearRuntimeConfigSnapshot(); }
    });
  }, 120_000);

  it("synthesizeSpeech preserves unknown pricing without inventing a free tariff", async () => {
    await fixture("unknown", async (cfg, prefsPath) => {
      const result = await synthesizeSpeech({ cfg, prefsPath, text, disableFallback: true });
      expect(result, result.error).toMatchObject({ success: true, outputFormat: "wav", audioBuffer: Buffer.from(wav, "hex") });
    });
  }, 120_000);

  it("reuses the same config with a new proxy key without borrowing the earlier grant", async () => {
    await fixture("key_a", async cfg => {
      expect((await direct(cfg)).audioBuffer.toString("hex")).toBe(wav);
      cfg.models!.providers!.clawrouter!.apiKey = key("key_b");
      try { expect((await direct(cfg)).audioBuffer.toString("hex")).toBe(wav); }
      finally { await join("key_b"); }
      expect(observations.map(row => row.credential)).toEqual([`Bearer ${key("key_a")}`, `Bearer ${key("key_a")}`, `Bearer ${key("key_b")}`, `Bearer ${key("key_b")}`]);
    });
  }, 120_000);

  it.each(["grant", "foreign", "policy", "revoked", "stale_policy", "budget", "key"])("%s refuses before paid upstream egress", async name => {
    await fixture(name, async cfg => { await expect(direct(cfg)).rejects.toThrow(); expect((await join(name)).calls).toBe(0); });
  }, 120_000);

  it.each(["voice", "alias"])("%s rejects invalid config before catalog", async name => {
    await fixture(name, async cfg => {
      cfg.tts!.providers!.clawrouter![name === "voice" ? "voice" : "voiceName"] = name === "voice" ? "" : "Puck";
      await expect(direct(cfg)).rejects.toThrow(); expect(observations).toHaveLength(0);
    });
  });

  it.each(models.slice(0, 3).map((model, i) => [model, `cutoff${i}`] as const))("%s denies at the exact qualification cutoff before discovery", async (model, name) => {
    await fixture(name, async cfg => {
      vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
      await expect(direct(cfg)).rejects.toThrow(/qualification expired/);
      expect(observations).toHaveLength(0);
    }, model);
  });

  it.each(["later", "truncated", "non200", "redirect", "encoding"])("%s does not return partial audio or buy another provider", async name => {
    await fixture(name, async (cfg, prefsPath) => {
      const result = await synthesizeSpeech({ cfg, prefsPath, text });
      expect(result.success).toBe(false); expect(result.audioBuffer).toBeUndefined();
      expect(observations.map(row => row.path)).toEqual(["/v1/catalog", "/v1/proxy/google-gemini/speech_interactions"]);
    });
  }, 120_000);

  it.each(["abort_headers", "abort_body", "deadline"])("%s joins actual original transport before teardown", async name => {
    await fixture(name, async cfg => {
      const controller = new AbortController(), reason = new Error("synthetic caller cancellation");
      const result = direct(cfg, controller.signal, name === "deadline" ? 2000 : 30_000).then(value => ({ value }), error => ({ error }));
      await command(`/${name}/seen`, "GET", control, AbortSignal.timeout(30_000));
      if (name !== "deadline") controller.abort(reason);
      const settled = await result;
      expect(settled).toHaveProperty("error");
      const post = observations.find(row => speechPath(row.path));
      expect(post?.signal?.aborted).toBe(true);
      if (name === "deadline") { expect(controller.signal.aborted).toBe(false); expect(post?.signal?.reason?.name).toBe("TimeoutError"); }
      else { expect(controller.signal.reason).toBe(reason); expect(post?.signal?.reason).toBe(reason); }
      await command(`/${name}/closed`, "GET", control, AbortSignal.timeout(30_000));
      // join() also observes the SDK's original cancel promises; this does not
      // claim that synthesizeSpeech itself awaits fire-and-forget cancellation.
    });
  }, 120_000);
});
