import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { fetchWithRuntimeDispatcher } from "../../src/infra/net/runtime-fetch.js";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
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
const models = ["dola-seed-2-1-turbo-260628", "seed-2-0-code-preview-260328", "glm-5-2-260617", "deepseek-v4-pro-260425", "deepseek-v4-flash-260425"];
const closed = ["glm-4-7-251222"];
const key = (id: string) => `clawrouter-live-byte_${id}-fixture-secret`;
const nativeFetch = globalThis.fetch;
const originalCatalogGuard = ssrfRuntime.fetchWithSsrFGuard;
const originalChatGuard = guardedTransport.fetchWithProviderHttpGuard;
type Acquisition = {
  kind: "catalog" | "chat";
  returned: ReturnType<typeof originalCatalogGuard>;
  released: Promise<void>;
  releaseCalls: number;
  releases: Promise<void>[];
  body?: ReadableStream<Uint8Array> | null;
  readers: Array<{ pending: Promise<unknown>[]; unlocked: boolean }>;
};
const acquisitions: Acquisition[] = [];
const closeOperations: Promise<unknown>[] = [];
const dispatchers = new Set<object>();
const observationErrors: unknown[] = [];
let catalogCalls = 0, chatCalls = 0, expectedChatCalls = 0;

function observe(kind: Acquisition["kind"], returned: Acquisition["returned"]) {
  let released!: () => void;
  const row: Acquisition = { kind, returned, released: new Promise(resolve => { released = resolve; }), releaseCalls: 0, releases: [], readers: [] };
  acquisitions.push(row);
  void returned.then(result => {
    try {
      row.body = result.response.body;
      const release = result.release;
      vi.spyOn(result, "release").mockImplementation(function () {
        row.releaseCalls++;
        const pending = Reflect.apply(release, this, []);
        row.releases.push(pending);
        void pending.then(released, released);
        return pending;
      });
      if (!row.body) return;
      const getReader = row.body.getReader;
      vi.spyOn(row.body, "getReader").mockImplementation(function (...args) {
        const reader = Reflect.apply(getReader, this, args) as ReadableStreamDefaultReader<Uint8Array>;
        const observed = { pending: [] as Promise<unknown>[], unlocked: false }; row.readers.push(observed);
        for (const method of ["read", "cancel"] as const) {
          const original = reader[method];
          vi.spyOn(reader, method).mockImplementation(function (...operands: unknown[]) {
            const pending = Reflect.apply(original, this, operands); observed.pending.push(pending);
            void pending.then(() => {}, () => {});
            return pending;
          });
        }
        const unlock = reader.releaseLock;
        vi.spyOn(reader, "releaseLock").mockImplementation(function () {
          const value = Reflect.apply(unlock, this, []); observed.unlocked = true; return value;
        });
        return reader;
      });
    } catch (error) { observationErrors.push(error); released(); }
  }, () => { released(); });
  return returned; // Same original promise and response; no transport replacement.
}

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  acquisitions.length = 0; closeOperations.length = 0; dispatchers.clear(); observationErrors.length = 0;
  catalogCalls = 0; chatCalls = 0; expectedChatCalls = 0;
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(function (options) {
    expect(String(options.url)).toBe(`${origin}/v1/catalog`);
    catalogCalls++;
    return observe("catalog", Reflect.apply(originalCatalogGuard, this, [{ ...options,
      policy: ssrfRuntime.ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin),
      fetchImpl: function (input: Parameters<typeof fetchWithRuntimeDispatcher>[0], init?: Parameters<typeof fetchWithRuntimeDispatcher>[1]) {
        const dispatcher = init?.dispatcher;
        if (!dispatcher) throw new Error("catalog runtime dispatcher missing");
        if (!dispatchers.has(dispatcher)) {
          dispatchers.add(dispatcher);
          const close = dispatcher.close;
          vi.spyOn(dispatcher, "close").mockImplementation(function (...args) {
            const pending = Reflect.apply(close, this, args);
            // Undici close() calls close(callback), then healthy destroy(). Only
            // returned original promises are joins; callback calls are not releases.
            if (pending && typeof pending.then === "function") {
              closeOperations.push(pending); void pending.then(() => {}, () => {});
            }
            return pending;
          });
        }
        return Reflect.apply(fetchWithRuntimeDispatcher, this, [input, init]);
      },
    }]));
  });
  vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function (options) {
    expect(String(options.url)).toBe(`${origin}/v1/chat/completions`);
    chatCalls++;
    return observe("chat", Reflect.apply(originalChatGuard, this, [options]));
  });
});
afterEach(async () => {
  try {
    const returned = await Promise.allSettled(acquisitions.map(row => row.returned));
    const releases = await Promise.all(acquisitions.map(async row => {
      await row.released;
      const results = await Promise.allSettled(row.releases);
      await Promise.all(row.readers.map(reader => Promise.allSettled(reader.pending)));
      return results;
    }));
    const closed = await Promise.allSettled(closeOperations);
    // Assert only after the actual guard, reader, release and owned-dispatcher
    // joins. The shared Chat pool is never closed by this fixture.
    expect(returned.every(result => result.status === "fulfilled")).toBe(true);
    expect(releases.flat().every(result => result.status === "fulfilled")).toBe(true);
    expect(closed.every(result => result.status === "fulfilled")).toBe(true);
    expect(closeOperations).toHaveLength(dispatchers.size);
    expect([...dispatchers].every(dispatcher => Reflect.get(dispatcher, "closed") === true)).toBe(true);
    expect(catalogCalls).toBe(1);
    expect(chatCalls).toBe(expectedChatCalls);
    expect(dispatchers.size).toBe(catalogCalls);
    expect(acquisitions.filter(row => row.kind === "catalog")).toHaveLength(catalogCalls);
    expect(acquisitions.filter(row => row.kind === "chat")).toHaveLength(chatCalls);
    for (const row of acquisitions) {
      expect(row.releaseCalls).toBeGreaterThan(0);
      expect(row.body?.locked).toBe(false);
      expect(row.readers.every(reader => reader.unlocked)).toBe(true);
      if (row.kind === "chat") expect(row.readers.length).toBeGreaterThan(0);
    }
    expect(observationErrors).toEqual([]);
  } finally { vi.restoreAllMocks(); clearLiveCatalogCacheForTests(); }
});

async function selected(id: string, modelId = models[0]) {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("clawrouter");
  const config = await buildClawRouterProviderConfig({ apiKey: key(id), baseUrl: origin });
  const row = config.models.find(row => row.id === `byteplus/${modelId}`);
  expect(row).toBeDefined();
  const raw = { ...row, provider: "clawrouter" } as Model<"openai-completions">;
  const model = (provider.normalizeResolvedModel?.({ model: raw }) ?? raw) as typeof raw;
  expect(model.api).toBe("openai-completions"); expect(model.baseUrl).toBe(`${origin}/v1`);
  expect(model.id).toBe(`byteplus/${modelId}`);
  expect(model.compat?.unsupportedToolSchemaKeywords).toBeUndefined();
  return { provider, model };
}
function context(id: string): Context {
  return { systemPrompt: "Synthetic instructions", messages: [{ role: "user", content: `synthetic byte_${id}`, timestamp: 1 }] };
}
async function start(selection: Awaited<ReturnType<typeof selected>>, id: string, simple = false, ctx = context(id), signal?: AbortSignal, apiKey = key(id)) {
  const { provider, model } = selection;
  // The embedded host selects its managed transport before provider wrapping.
  // Simple completion keeps its separate registered source stream and defaults.
  const host = simple ? undefined : selectEmbeddedAgentStream({
    llmRuntime: defaultLlmRuntime, currentStreamFn: streamSimple,
    model, sessionId: `byteplus-${id}`, resolvedApiKey: apiKey, signal,
  });
  if (host) expect(host.strategy).toBe("boundary-aware:openai-completions");
  const hook = simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const fn = hook?.({ provider: "clawrouter", modelId: model.id, model, streamFn: host?.streamFn ?? streamSimple });
  expect(fn).toBeDefined();
  if (!signal?.aborted) expectedChatCalls++;
  return (host ? host.wrapApiKey(fn!) : fn!)(model, ctx, { apiKey, maxTokens: 128, signal });
}

describe("actual registered ClawRouter BytePlus PAYG catalog and Chat", () => {
  for (const [i, model] of models.entries()) for (const simple of [false, true]) {
    const id = `m${i}_${simple ? "simple" : "stream"}`;
    it(`${model} selects the credential-scoped router catalog simple=${simple}`, async () => {
      const selection = await selected(id, model);
      expect(selection.model.reasoning).toBe(i >= 2);
      const result = await (await start(selection, id, simple)).result();
      expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      // No advertised effort profile is invented. The managed host exposes
      // reasoning on its three heuristic rows; the simple default suppresses it.
      if (!simple && i >= 2) expect(result.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "synthetic-reasoning" }));
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
    const messages = await withOpenClawTestState({ label: "byteplus-router" }, async state => {
      const { provider, model } = selection;
      const policy = resolveTranscriptPolicy({ provider: "clawrouter", modelId: model.id, modelApi: model.api, model, runtimeHandle: { provider: "clawrouter", plugin: provider } });
      expect(policy.dropReasoningFromHistory).toBe(false);
      expect(policy.sanitizeToolCallIds).toBe(true); expect(policy.toolCallIdMode).toBe("strict");
      expect(policy.duplicateToolCallIdStyle).toBeUndefined();
      return sanitizeSessionHistory({ provider: "clawrouter", modelId: model.id, modelApi: model.api, model, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: "byteplus-roundtrip",
        sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "clawrouter", modelApi: model.api, modelId: model.id })]), messages: history });
    });
    expect(messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }] }));
    expect(messages.some(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === "callfixture" && part.name === "lookup"))).toBe(true);
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
  it("does not advertise the closed PAYG identity despite a permitting policy", async () => {
    for (const [i, model] of closed.entries()) {
      const config = await buildClawRouterProviderConfig({ apiKey: key(`closed${i}`), baseUrl: origin });
      expect(config.models.some(row => row.id === `byteplus/${model}`)).toBe(false);
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
