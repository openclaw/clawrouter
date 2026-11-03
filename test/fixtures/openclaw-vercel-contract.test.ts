import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fetchWithRuntimeDispatcher } from "../infra/net/runtime-fetch.js";
import { streamSimple } from "../llm/stream.js";
import type { Model } from "../llm/types.js";
import { registerSingleProviderPlugin } from "../plugin-sdk/plugin-test-runtime.js";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "./embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "./embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "./runtime/index.js";
import { convertToLlm } from "./sessions/messages.js";
import { resolveTranscriptPolicy } from "./transcript-policy.js";
import { makeZeroUsageSnapshot } from "./usage.js";

const trace = vi.hoisted(() => ({ started: Date.now(), events: [] as Array<Record<string, unknown>>, modules: [] as Array<Record<string, unknown>> }));
vi.mock("./ai-transport-runtime-host.js", async importOriginal => {
  trace.modules.push({ phase: "runtime-host-init-start", at: Date.now() });
  const actual = await importOriginal<typeof import("./ai-transport-runtime-host.js")>();
  trace.modules.push({ phase: "runtime-host-init-end", at: Date.now() });
  return actual;
});
vi.mock("./provider-transport-dispatcher-pool.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./provider-transport-dispatcher-pool.js")>();
  return { ...actual, fetchWithProviderHttpGuard: async (...args: Parameters<typeof actual.fetchWithProviderHttpGuard>) => {
    note({ phase: "guard-enter", timeoutMs: args[0].timeoutMs ?? null, aborted: args[0].signal?.aborted ?? false });
    try { const result = await actual.fetchWithProviderHttpGuard(...args); note({ phase: "guard-response", status: result.response.status }); return result; }
    catch (error) { note({ phase: "guard-error", error: cleanError(error) }); throw error; }
  } };
});

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const modelId = "vercel-ai-gateway/anthropic/claude-sonnet-4.6";
const key = (id: string) => `clawrouter-live-${id}-fixture-secret`;
const nativeFetch = globalThis.fetch;
const nativeCatalogGuard = ssrfRuntime.fetchWithSsrFGuard;
const nativeSetTimeout = globalThis.setTimeout;
function note(value: Record<string, unknown>) {
  if (value.phase === "timer-created" && value.owner !== "anthropic-sdk" && trace.events.filter(event => event.phase === "timer-created").length >= 12) return;
  if (trace.events.length < 60) trace.events.push({ ms: Date.now() - trace.started, ...value });
}
function cleanError(error: unknown): unknown {
  const value = error as { name?: string; message?: string; code?: string; cause?: { name?: string; message?: string; code?: string } };
  const scrub = (text: unknown) => String(text ?? "").replaceAll(origin, "<router>").replace(/clawrouter-live-[^\s"'<>]+/g, "<proxy-key>").replace(/(?:\/Users\/|\/home\/)[^\s"']+/g, "<path>").slice(0, 512);
  return { name: scrub(value?.name), message: scrub(value?.message), code: scrub(value?.code),
    ...(value?.cause ? { cause: { name: scrub(value.cause.name), message: scrub(value.cause.message), code: scrub(value.cause.code) } } : {}) };
}
beforeEach(() => {
  trace.started = Date.now(); trace.events = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    if (typeof args[1] === "number" && args[1] >= 1000) note({ phase: "timer-created", delayMs: args[1], owner: new Error().stack?.includes("@anthropic-ai") ? "anthropic-sdk" : "client-runtime" });
    return Reflect.apply(nativeSetTimeout, globalThis, args);
  }) as typeof setTimeout);
  clearLiveCatalogCacheForTests();
  vi.stubEnv("ANTHROPIC_API_KEY", "must-not-fallback-anthropic");
  vi.stubEnv("AI_GATEWAY_API_KEY", "must-not-fallback-vercel");
  vi.stubEnv("CLAWROUTER_API_KEY", "");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    note({ phase: "fetch-enter", path: new URL(request.url).pathname, aborted: request.signal.aborted });
    request.signal.addEventListener("abort", () => note({ phase: "fetch-abort", error: cleanError(request.signal.reason) }), { once: true });
    try {
      expect(new URL(request.url).origin).toBe(origin);
      const response = await nativeFetch(request); note({ phase: "fetch-response", status: response.status, connection: response.headers.get("connection") }); return response;
    } catch (error) { note({ phase: "fetch-error", error: cleanError(error) }); throw error; }
  });
  // Trust only this isolated loopback catalog. The production parser, discovery,
  // replay and SDK stay real; this fixture does not certify production SSRF policy.
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async options => {
    expect(String(options.url)).toBe(`${origin}/v1/catalog`);
    const result = await nativeCatalogGuard({ ...options, fetchImpl: fetchWithRuntimeDispatcher,
      policy: ssrfRuntime.ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin) });
    note({ phase: "catalog-guard-response", status: result.response.status });
    return { ...result, release: async () => { await result.release(); note({ phase: "catalog-guard-released" }); } };
  });
});
afterEach(() => {
  if (process.env.CLAWROUTER_VERCEL_DIAGNOSTIC === "first") console.info("Vercel first-call trace", JSON.stringify({ startedAt: trace.started, modules: trace.modules, events: trace.events }));
  vi.restoreAllMocks(); vi.unstubAllEnvs(); clearLiveCatalogCacheForTests();
});

async function fixture(run: (f: {
  discover: (id: string) => Promise<{ models: Array<{ id: string }> }>;
  start: (id: string, options?: { apiKey?: string; signal?: AbortSignal; simple?: boolean }) => Promise<Awaited<ReturnType<typeof streamSimple>>>;
}) => Promise<void>) {
  const { default: entry } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  const plugin = await registerSingleProviderPlugin(entry);
  await withOpenClawTestState({ label: "clawrouter-vercel-worker" }, async state => {
    const config: OpenClawConfig = { models: { providers: { clawrouter: { baseUrl: `${origin}/v1`, apiKey: key("vercel_stream"), models: [] } } } };
    const discover = async (id: string) => {
      const catalog = await plugin.catalog?.run({ config, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir,
        resolveProviderAuth: () => ({ apiKey: key(id), discoveryApiKey: key(id), mode: "api_key", source: "profile" }),
        resolveProviderApiKey: () => ({ apiKey: key(id), discoveryApiKey: key(id) }),
      });
      if (!catalog || !("provider" in catalog) || !catalog.provider) throw new Error("Missing actual catalog");
      return catalog.provider;
    };
    const catalog = await discover("vercel_stream");
    const selected = catalog.models.find(row => row.id === modelId);
    expect(selected).toMatchObject({ id: modelId, api: "anthropic-messages", baseUrl: `${origin}/v1/native/vercel-ai-gateway` });
    const model = { ...selected, provider: "clawrouter" } as Model;
    const start = async (id: string, options: { apiKey?: string; signal?: AbortSignal; simple?: boolean } = {}) => {
      const history: AgentMessage[] = [
        { role: "user", content: "look up a synthetic record", timestamp: 1 },
        { role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-6-luna",
          content: [{ type: "toolCall", id: "call_previous|fc_one", name: "lookup", arguments: { index: 1 } }],
          usage: makeZeroUsageSnapshot(), stopReason: "toolUse", timestamp: 2 },
        { role: "toolResult", toolCallId: "call_previous|fc_one", toolName: "lookup",
          content: [{ type: "text", text: "synthetic record" }], isError: false, timestamp: 3 },
        { role: "user", content: `fixture ${id}`, timestamp: 4 },
      ];
      const replay = await sanitizeSessionHistory({ provider: "clawrouter", modelId, modelApi: model.api, model,
        policy: resolveTranscriptPolicy({ provider: "clawrouter", modelId, modelApi: model.api, model, runtimeHandle: { provider: "clawrouter", plugin } }),
        config, env: {}, workspaceDir: state.workspaceDir, sessionId: `vercel-${id}`,
        sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "openai", modelApi: "openai-responses", modelId: "gpt-6-luna" })]),
        messages: history,
      });
      const hook = options.simple ? plugin.wrapSimpleCompletionStreamFn : plugin.wrapStreamFn;
      const stream = hook?.({ provider: "clawrouter", modelId, model, streamFn: streamSimple });
      expect(stream).toBeDefined();
      note({ phase: "stream-invoke", timeoutMs: null, modelTimeoutMs: (model as Model & { requestTimeoutMs?: number }).requestTimeoutMs ?? null, signalAborted: options.signal?.aborted ?? false });
      return stream!(model, { messages: convertToLlm(replay), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: { index: { type: "integer" } } } }] },
        { apiKey: options.apiKey ?? key(id), maxTokens: 100, signal: options.signal });
    };
    await run({ discover, start });
  });
}

describe("actual Vercel native Anthropic SDK through Worker", () => {
  it.each([false, true])("preserves catalog selection, native replay and fragmented stream usage (simple=%s)", async simple => {
    await fixture(async ({ start }) => {
      const result = await (await start(simple ? "vercel_simple" : "vercel_stream", { simple })).result();
      expect(result.errorMessage?.replaceAll(origin, "<router>").replace(/clawrouter-live-[^\s"'<>]+/g, "<proxy-key>").slice(0, 512), "actual SDK terminal error").toBeUndefined();
      expect(result).toMatchObject({ stopReason: "stop", model: modelId, content: [{ type: "text", text: "synthetic-answer" }], usage: { input: 11, output: 3, totalTokens: 14 } });
    });
  });

  it("re-admits a selected model against invalid keys, foreign grants and unknown prices", async () => {
    await fixture(async ({ start }) => {
      for (const [id, apiKey] of [["invalid", "clawrouter-live-vercel_stream-invalid"], ["vercel_foreign", key("vercel_foreign")], ["vercel_unpriced", key("vercel_unpriced")], ["missing", ""]]) {
        const result = await (await start(id, { apiKey })).result();
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
      }
    });
  });

  it("does not replace a denied Messages offer with the real eligible Chat offer", async () => {
    await fixture(async ({ discover }) => {
      const catalog = await discover("vercel_chat_only");
      expect(catalog.models.some(model => model.id === modelId)).toBe(false);
    });
  });

  it("preserves a late SSE error without replay or successful terminal usage", async () => {
    await fixture(async ({ start }) => {
      const result = await (await start("vercel_error")).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("synthetic-upstream-error");
    });
  });

  it("cancels the actual SDK stream after partial output", async () => {
    await fixture(async ({ start }) => {
      const controller = new AbortController();
      const stream = await start("vercel_cancel", { signal: controller.signal });
      for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
      expect(controller.signal.aborted).toBe(true);
      expect(["aborted", "error"]).toContain((await stream.result()).stopReason);
    });
  });
});
