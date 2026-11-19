import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { APIError } from "openai";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
import * as transportStream from "../../packages/ai/src/transports/transport-stream-shared.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../src/plugins/runtime/generation-state.js";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { createEmptyPluginRegistry, registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it as nativeIt, vi } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { runProviderStaticCatalog } from "../../src/plugins/provider-discovery.js";
import plugin from "./index.js";

/* OWNED_LIFETIME_IMPLEMENTATION */

const phase = process.env.CLAWROUTER_MINIMAX_PHASE;
assert.ok(phase === "m3" || phase === "flash");
const flash = phase === "flash";
const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const modelId = flash ? "MiniMax-M3.1-Flash" : "MiniMax-M3";
const key = (id: string) => `clawrouter-live-minimax_${id}-fixture-secret`;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

const invocation = new AsyncLocalStorage<any>();
const originalGuard = guardedTransport.fetchWithProviderHttpGuard, originalFailure = transportStream.failTransportStream;
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createRequestBindings>, bodySucceeded: boolean;

async function runCase(body: () => unknown) {
  await preserveFailures(async () => { await body(); bodySucceeded = true; }, [
    () => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(),
  ]);
  if (bindings.bindings.some(row => row.id === "cancel")) console.log("MINIMAX_CANCEL_RETIRED " + phase);
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body)), {
  each: (rows: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(rows)(name, (...args) => runCase(() => body(...args))),
});

async function start(id: string, options: { simple?: boolean; image?: boolean; apiKey?: string; signal?: AbortSignal; reasoning?: typeof efforts[number]; rawCompat?: boolean } = {}) {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("minimax");
  const result = await runProviderStaticCatalog({ provider });
  if (!result || !("providers" in result) || !result.providers?.minimax) {
    throw new Error("expected the registered MiniMax static catalog map");
  }
  expect(Object.keys(result.providers)).toEqual(["minimax"]);
  const catalog = result.providers.minimax;
  expect(catalog.api).toBe("anthropic-messages");
  const row = catalog.models.find(row => row.id === modelId);
  expect(row).toMatchObject({ id: modelId, contextWindow: 1_000_000, input: ["text", "image"], reasoning: true });
  // This frozen provider supports explicit Chat configuration. Its default
  // Anthropic API, OAuth portal, live discovery and video are separate contracts.
  // The configured Chat model explicitly declares its supported effort domain.
  // The unmodified Anthropic catalog does not declare Chat xhigh/max.
  const chatRow = flash && !options.rawCompat ? { ...row!, compat: { ...row!.compat, supportsReasoningEffort: true, supportedReasoningEfforts: [...efforts] } } : row!;
  const configured = { ...catalog, api: "openai-completions" as const, baseUrl: origin + "/v1/native/minimax/v1", models: [chatRow] };
  const config = { models: { providers: { minimax: configured } } };
  const model = { ...chatRow, provider: "minimax", api: configured.api, baseUrl: configured.baseUrl } as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: model.api, provider: "minimax", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "text", text: `fixture minimax_${id}` }, ...(options.image ? [{ type: "image" as const, data: png, mimeType: "image/png" }] : [])], timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "minimax-m3-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "minimax", modelId, modelApi: model.api, model, runtimeHandle: { provider: "minimax", plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(true);
    const registry = createEmptyPluginRegistry(); registry.providers.push({ pluginId: "minimax", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(registry, () => sanitizeSessionHistory({ provider: "minimax", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: `minimax-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "minimax", modelApi: model.api, modelId })]),
      messages: history }));
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const wrap = options.simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({ provider: "minimax", modelId, model, sourceApi: model.api, streamFn: streamSimple });
  expect(wrapped).toBeDefined();
  const apiKey = options.apiKey ?? key(id);
  const owner = bindings.expect(id, "chat", configured.baseUrl + "/chat/completions", "POST", apiKey, options.signal);
  owner.callerObservation = {}; lifetime.signal(owner.callerObservation, options.signal);
  return invocation.run(owner, () => wrapped!(model, context, { apiKey, maxTokens: flash && options.image ? 16 : 128, signal: options.signal, reasoning: options.reasoning }));
}

describe(phase + " actual registered MiniMax explicit Chat client through Worker and SQLite", { concurrent: false }, () => {
  beforeEach(async () => {
    bodySucceeded = false; bindings = createRequestBindings();
    lifetime = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => bodySucceeded, current: () => invocation.getStore(), apiPrototype: APIError.prototype, isProxy: types.isProxy });
    try {
      vi.spyOn(transportStream, "failTransportStream").mockImplementation(function (...args: Parameters<typeof originalFailure>) {
        lifetime.providerError(args[0]); return Reflect.apply(originalFailure, this, args);
      });
      vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function (...args) {
        const options = args[0], owner = bindings.claim(options.url, options.init, "chat");
        lifetime.signal(owner, options.signal ?? options.init?.signal); return lifetime.guard(originalGuard, this, args, owner);
      });
    } catch (error) { await preserveFailures(() => { throw error; }, [() => lifetime.join(), () => lifetime.restore(), () => vi.restoreAllMocks()]); }
  });

  it.each([false, true])("uses the actual stream hook and replay policy (simple=%s)", async simple => {
    const result = await (await start(simple ? "simple" : "stream", { simple })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it("serializes real inline PNG bytes through the registered image-capable card", async () => {
    const result = await (await start("image", { image: true })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it("uses terminal observed usage without treating client tariff hints as a reservation", async () => {
    const result = await (await start("observed")).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.usage).toMatchObject(flash ? { input: 7, cacheRead: 4, output: 3, totalTokens: 14 } : { input: 4, output: 3, totalTokens: 7 });
  });
  it.each(flash ? ["invalid", "foreign", "budget", "model_denied"] : ["invalid", "foreign", "unpriced", "provider_budget", "model_denied"])("denies %s before upstream egress or ambient-key fallback", async id => {
    const result = await (await start(id, id === "invalid" ? { apiKey: "clawrouter-live-minimax_stream-invalid" } : {})).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
  });
  if (flash) {
    it.each(efforts)("preserves explicitly configured Chat effort %s", async reasoning => {
      expect((await (await start("effort_" + reasoning, { reasoning })).result()).stopReason).toBe("stop");
    });
    it.each(["xhigh", "max"] as const)("records the unmodified catalog Chat effort limitation for %s", async reasoning => {
      expect((await (await start("raw_" + reasoning, { reasoning, rawCompat: true })).result()).stopReason).toBe("stop");
    });
  }
  it("retains a fragmented embedded upstream error without replay", async () => {
    const result = await (await start("error")).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("synthetic-upstream-error"); lifetime.providerResult(result);
  });
  it("cancels after actual partial delivery without claiming a free request", async () => {
    const controller = new AbortController(), stream = await start("cancel", { signal: controller.signal });
    for await (const event of stream) if (event.type === "text_delta") { lifetime.partial(bindings.bindings.find(row => row.id === "cancel")); controller.abort(); break; }
    const result = await stream.result();
    expect(controller.signal.aborted).toBe(true);
    expect(result.stopReason).toBe("aborted");
  });
});
