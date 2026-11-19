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

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const modelId = "anthropic-vertex/claude-sonnet-4-6";
const key = (id: string) => `clawrouter-live-${id}-fixture-secret`;
const nativeFetch = globalThis.fetch;
const nativeCatalogGuard = ssrfRuntime.fetchWithSsrFGuard;
beforeEach(() => {
  clearLiveCatalogCacheForTests();
  vi.stubEnv("ANTHROPIC_API_KEY", "must-not-fallback-anthropic");
  vi.stubEnv("GOOGLE_API_KEY", "must-not-fallback-google");
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "must-not-fallback-adc");
  vi.stubEnv("CLAWROUTER_API_KEY", "");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe(origin);
    return nativeFetch(request);
  });
  // Preserve the actual guard's dispatcher release. A no-op release couples the
  // catalog's idle global-fetch socket to SDK dispatch after cold replay setup.
  // Trust only this fixture origin; production SSRF policy is not certified here.
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(options => {
    expect(String(options.url)).toBe(`${origin}/v1/catalog`);
    return nativeCatalogGuard({ ...options, fetchImpl: fetchWithRuntimeDispatcher,
      policy: ssrfRuntime.ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin) });
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearLiveCatalogCacheForTests(); });

async function fixture(run: (f: {
  discover: (id: string) => Promise<{ models: Array<{ id: string }> }>;
  start: (id: string, options?: { apiKey?: string; signal?: AbortSignal; simple?: boolean; thinking?: boolean }) => Promise<Awaited<ReturnType<typeof streamSimple>>>;
}) => Promise<void>) {
  const { default: entry } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  const plugin = await registerSingleProviderPlugin(entry);
  await withOpenClawTestState({ label: "clawrouter-vertex-worker" }, async state => {
    const config: OpenClawConfig = { models: { providers: { clawrouter: { baseUrl: `${origin}/v1`, apiKey: key("vertex_stream"), models: [] } } } };
    const discover = async (id: string) => {
      const catalog = await plugin.catalog?.run({ config, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir,
        resolveProviderAuth: () => ({ apiKey: key(id), discoveryApiKey: key(id), mode: "api_key", source: "profile" }),
        resolveProviderApiKey: () => ({ apiKey: key(id), discoveryApiKey: key(id) }),
      });
      if (!catalog || !("provider" in catalog) || !catalog.provider) throw new Error("Missing actual catalog");
      return catalog.provider;
    };
    const catalog = await discover("vertex_stream");
    const selected = catalog.models.find(row => row.id === modelId);
    expect(selected).toMatchObject({ id: modelId, api: "anthropic-messages", baseUrl: `${origin}/v1/native/anthropic-vertex`, contextWindow: 1_000_000, maxTokens: 128_000 });
    const model = { ...selected, provider: "clawrouter" } as Model;
    const start = async (id: string, options: { apiKey?: string; signal?: AbortSignal; simple?: boolean; thinking?: boolean } = {}) => {
      const history: AgentMessage[] = [
        { role: "user", content: "look up a synthetic record", timestamp: 1 },
        { role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-6-luna",
          content: [{ type: "toolCall", id: "call_previous|fc_one", name: "lookup", arguments: { index: 1 } }],
          usage: makeZeroUsageSnapshot(), stopReason: "toolUse", timestamp: 2 },
        { role: "toolResult", toolCallId: "call_previous|fc_one", toolName: "lookup",
          content: [{ type: "text", text: "synthetic record" }], isError: false, timestamp: 3 },
        { role: "user", content: `fixture ${id}`, timestamp: 4 },
      ];
      if (options.thinking) history.push({ role: "assistant", api: "anthropic-messages", provider: "clawrouter", model: modelId, content: [{ type: "text", text: "synthetic prefill" }], usage: makeZeroUsageSnapshot(), stopReason: "stop", timestamp: 5 });
      const replay = await sanitizeSessionHistory({ provider: "clawrouter", modelId, modelApi: model.api, model,
        policy: resolveTranscriptPolicy({ provider: "clawrouter", modelId, modelApi: model.api, model, runtimeHandle: { provider: "clawrouter", plugin } }),
        config, env: {}, workspaceDir: state.workspaceDir, sessionId: `vertex-${id}`,
        sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "openai", modelApi: "openai-responses", modelId: "gpt-6-luna" })]),
        messages: history,
      });
      const hook = options.simple ? plugin.wrapSimpleCompletionStreamFn : plugin.wrapStreamFn;
      const stream = hook?.({ provider: "clawrouter", modelId, model, streamFn: streamSimple });
      expect(stream).toBeDefined();
      return stream!(model, { messages: convertToLlm(replay), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: { index: { type: "integer" } } } }] },
        { apiKey: options.apiKey ?? key(id), maxTokens: 2048, ...(options.thinking ? { reasoning: "medium" as const } : {}), signal: options.signal, headers: { "x-goog-user-project": "caller-foreign-project" } });
    };
    await run({ discover, start });
  });
}

describe("actual Vertex native Anthropic SDK through Worker", () => {
  it.each([false, true])("preserves catalog selection, native replay and fragmented stream usage (simple=%s)", async simple => {
    await fixture(async ({ start }) => {
      const result = await (await start(simple ? "vertex_simple" : "vertex_stream", { simple })).result();
      expect(result.errorMessage?.replaceAll(origin, "<router>").replace(/clawrouter-live-[^\s"'<>]+/g, "<proxy-key>").slice(0, 512), "actual SDK terminal error").toBeUndefined();
      expect(result).toMatchObject({ stopReason: "stop", model: modelId, content: [{ type: "text", text: "synthetic-answer" }], usage: { input: 11, output: 3, totalTokens: 14 } });
    });
  });

  it("re-admits a selected model against invalid keys, foreign grants and unknown prices", async () => {
    await fixture(async ({ start }) => {
      for (const [id, apiKey] of [["invalid", "clawrouter-live-vertex_stream-invalid"], ...["vertex_foreign", "vertex_unpriced", "vertex_unbound", "vertex_location"].map(id => [id, key(id)]), ["missing", ""]]) {
        const result = await (await start(id, { apiKey })).result();
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
      }
    });
  });

  it.each(["vertex_global", "vertex_europe", "vertex_asia"])("keeps original owner geography and credentials (%s)", async id => {
    await fixture(async ({ start }) => {
      const result = await (await start(id)).result();
      expect(result.errorMessage).toBeUndefined();
      expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "synthetic-answer" }], usage: { input: 11, output: 3, totalTokens: 14 } });
    });
  });

  it("uses actual thinking and prefill handling without losing tool history", async () => {
    await fixture(async ({ start }) => {
      const result = await (await start("vertex_thinking", { thinking: true })).result();
      expect(result.errorMessage).toBeUndefined(); expect(result.stopReason).toBe("stop");
      expect(result.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "synthetic reasoning" }));
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      expect(result.usage).toMatchObject({ input: 11, output: 3, totalTokens: 14 });
    });
  });

  it("parses fragmented native tool arguments through the actual SDK", async () => {
    await fixture(async ({ start }) => {
      const result = await (await start("vertex_tools")).result();
      expect(result.errorMessage).toBeUndefined(); expect(result.stopReason).toBe("toolUse");
      expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "lookup", arguments: { index: 2 } }));
    });
  });

  it("re-admits the original grant after catalog discovery and revocation", async () => {
    await fixture(async ({ discover, start }) => {
      expect((await discover("vertex_revoked")).models.some(model => model.id === modelId)).toBe(true);
      expect((await fetch(origin + "/fixture/revoke", { method: "POST" })).status).toBe(204);
      const result = await (await start("vertex_revoked")).result();
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-vertex-|must-not-fallback/);
    });
  });

  it("preserves a late SSE error without replay or successful terminal usage", async () => {
    await fixture(async ({ start }) => {
      const result = await (await start("vertex_error")).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("synthetic-upstream-error");
    });
  });

  it("cancels the actual SDK stream after partial output", async () => {
    await fixture(async ({ start }) => {
      const controller = new AbortController();
      const stream = await start("vertex_cancel", { signal: controller.signal });
      for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
      expect(controller.signal.aborted).toBe(true);
      expect(["aborted", "error"]).toContain((await stream.result()).stopReason);
    });
  });
});
