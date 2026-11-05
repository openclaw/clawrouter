import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import { selectEmbeddedAgentStream } from "../../src/agents/embedded-agent-runner/stream-resolution.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import plugin from "./index.js";
import { buildClawRouterProviderConfig } from "./provider-catalog.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["doubao-seed-2-1-pro-260915", "doubao-seed-evolving", "doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628", "glm-5-2-260617", "deepseek-v4-pro-260425", "deepseek-v4-flash-260425"];
const closed = ["kimi-k2-5-260127", "glm-4-7-251222", "deepseek-v3-2-251201"];
const key = (id: string) => `clawrouter-live-volc_${id}-fixture-secret`;
const nativeFetch = globalThis.fetch;
beforeEach(() => {
  clearLiveCatalogCacheForTests();
  // Trust only this isolated catalog socket; retain the real HTTP response and parser.
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async ({ url, init }) => {
    expect(String(url)).toBe(`${origin}/v1/catalog`);
    return { response: await nativeFetch(url, init), finalUrl: String(url), release: async () => undefined };
  });
});
afterEach(() => { vi.restoreAllMocks(); clearLiveCatalogCacheForTests(); });

async function selected(id: string, modelId = models[0]) {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("clawrouter");
  const config = await buildClawRouterProviderConfig({ apiKey: key(id), baseUrl: origin });
  const row = config.models.find(row => row.id === `volcengine/${modelId}`);
  expect(row).toBeDefined();
  const raw = { ...row, provider: "clawrouter" } as Model<"openai-completions">;
  const model = (provider.normalizeResolvedModel?.({ model: raw }) ?? raw) as typeof raw;
  expect(model.api).toBe("openai-completions"); expect(model.baseUrl).toBe(`${origin}/v1`);
  expect(model.id).toBe(`volcengine/${modelId}`);
  expect(model.compat?.unsupportedToolSchemaKeywords).toBeUndefined();
  return { provider, model };
}
function context(id: string): Context {
  return { systemPrompt: "Synthetic instructions", messages: [{ role: "user", content: `synthetic volc_${id}`, timestamp: 1 }] };
}
async function start(selection: Awaited<ReturnType<typeof selected>>, id: string, simple = false, ctx = context(id), signal?: AbortSignal, apiKey = key(id)) {
  const { provider, model } = selection;
  // The embedded host selects its managed transport before provider wrapping.
  // Simple completion keeps its separate registered source stream and defaults.
  const host = simple ? undefined : selectEmbeddedAgentStream({
    llmRuntime: defaultLlmRuntime, currentStreamFn: streamSimple,
    model, sessionId: `volcengine-${id}`, resolvedApiKey: apiKey, signal,
  });
  if (host) expect(host.strategy).toBe("boundary-aware:openai-completions");
  const hook = simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const fn = hook?.({ provider: "clawrouter", modelId: model.id, model, streamFn: host?.streamFn ?? streamSimple });
  expect(fn).toBeDefined();
  return (host ? host.wrapApiKey(fn!) : fn!)(model, ctx, { apiKey, maxTokens: 128, signal });
}

describe("actual registered ClawRouter Volcengine PAYG catalog and Chat", () => {
  for (const [i, model] of models.entries()) for (const simple of [false, true]) {
    const id = `m${i}_${simple ? "simple" : "stream"}`;
    it(`${model} selects the credential-scoped router catalog simple=${simple}`, async () => {
      const selection = await selected(id, model);
      expect(selection.model.reasoning).toBe(i >= 4);
      const result = await (await start(selection, id, simple)).result();
      expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      // No advertised effort profile is invented. The managed host exposes
      // reasoning on its three heuristic rows; the simple default suppresses it.
      if (!simple && i >= 4) expect(result.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "synthetic-reasoning" }));
      else expect(result.content.some(part => part.type === "thinking")).toBe(false);
      expect(result.usage).toMatchObject({ input: 60, cacheRead: 40, output: 20, totalTokens: 120 });
    });
  }
  it("replays an actual streamed tool turn through the registered host without borrowing native compatibility", async () => {
    const id = "roundtrip", selection = await selected(id, "deepseek-v4-pro-260425");
    const firstContext = context(id);
    firstContext.tools = [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }];
    const first = await (await start(selection, id, false, firstContext)).result();
    expect(first.stopReason, first.errorMessage).toBe("toolUse");
    expect(first.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "synthetic-reasoning" }));
    const tool = first.content.find(part => part.type === "toolCall"); expect(tool?.type).toBe("toolCall");
    if (tool?.type !== "toolCall") throw new Error("missing actual tool call");
    expect(tool.name).toBe("lookup"); expect(tool.arguments).toEqual({ value: "fixture" });
    const history: AgentMessage[] = [...firstContext.messages, first,
      { role: "toolResult", toolCallId: tool.id, toolName: tool.name, content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
      { role: "user", content: "synthetic second turn", timestamp: 4 },
    ];
    const messages = await withOpenClawTestState({ label: "volcengine-router" }, async state => {
      const { provider, model } = selection;
      const policy = resolveTranscriptPolicy({ provider: "clawrouter", modelId: model.id, modelApi: model.api, model, runtimeHandle: { provider: "clawrouter", plugin: provider } });
      expect(policy.dropReasoningFromHistory).toBe(false);
      return sanitizeSessionHistory({ provider: "clawrouter", modelId: model.id, modelApi: model.api, model, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: "volcengine-roundtrip",
        sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "clawrouter", modelApi: model.api, modelId: model.id })]), messages: history });
    });
    const second = await (await start(selection, id, false, { ...firstContext, messages: convertToLlm(messages) })).result();
    expect(second.stopReason, second.errorMessage).toBe("stop"); expect(second.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it("keeps complete missing usage separate from measured tokens", async () => {
    const result = await (await start(await selected("no_usage"), "no_usage")).result();
    expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.usage.totalTokens).toBe(0);
  });
  for (const id of ["http_error", "embedded_error"]) it(`returns ${id} without region, plan or credential retry`, async () => {
    const result = await (await start(await selected(id), id)).result();
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
  });
  it("re-admits an already selected route under invalid, foreign, missing and unknown-price caller grants", async () => {
    const selection = await selected("m0_stream");
    const invalid = await (await start(selection, "m0_stream", false, context("invalid"), undefined, key("m0_stream").replace("fixture-secret", "invalid"))).result();
    expect(invalid.stopReason).toBe("error"); expect(invalid.content).toEqual([]);
    for (const id of ["foreign", "missing", "unpriced"]) {
      const result = await (await start(selection, id)).result();
      expect(result.stopReason).toBe("error"); expect(result.content).toEqual([]);
      expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
    }
  });
  it("re-admits the original selected grant after revocation", async () => {
    const selection = await selected("revoked");
    expect((await nativeFetch(origin + "/fixture/revoke", { method: "POST" })).status).toBe(204);
    const result = await (await start(selection, "revoked")).result(); expect(result.stopReason).toBe("error"); expect(result.content).toEqual([]);
  });
  it("does not advertise the three closed PAYG identities despite a permitting policy", async () => {
    for (const [i, model] of closed.entries()) {
      const config = await buildClawRouterProviderConfig({ apiKey: key(`closed${i}`), baseUrl: origin });
      expect(config.models.some(row => row.id === `volcengine/${model}`)).toBe(false);
    }
  });
  it("propagates a post-header SDK cancellation without another attempt", async () => {
    const controller = new AbortController(), response = await start(await selected("cancel"), "cancel", false, context("cancel"), controller.signal);
    let received = false;
    for await (const event of response) if (event.type === "text_delta") { received = true; controller.abort(); break; }
    const result = await response.result(); expect(received).toBe(true); expect(controller.signal.aborted).toBe(true);
    expect(["aborted", "error"]).toContain(result.stopReason);
  });
  it("preserves pre-abort before an inference request", async () => {
    const selection = await selected("aborted"), controller = new AbortController();
    controller.abort(new DOMException("Synthetic caller cancellation", "AbortError"));
    await expect(start(selection, "aborted", false, context("aborted"), controller.signal)).rejects.toBe(controller.signal.reason);
  });
});
