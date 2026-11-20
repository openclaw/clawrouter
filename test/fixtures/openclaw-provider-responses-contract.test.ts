import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { APIError } from "openai";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
import * as transportStream from "../../packages/ai/src/transports/transport-stream-shared.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../src/plugins/runtime/generation-state.js";
import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
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

const phase = process.env.CLAWROUTER_RESPONSES_PHASE;
assert.ok(phase === "xai" || phase === "openrouter");
const xai = phase === "xai", modelId = xai ? "grok-4.7" : "openai/gpt-6.1-terra";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const key = (id: string) => `clawrouter-live-responses_${id}-fixture-secret`;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const invocation = new AsyncLocalStorage<any>();
const originalGuard = guardedTransport.fetchWithProviderHttpGuard, originalFailure = transportStream.failTransportStream;
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createRequestBindings>, bodySucceeded: boolean;

async function runCase(body: () => unknown) {
  await preserveFailures(async () => { await body(); bodySucceeded = true; }, [
    () => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(),
  ]);
  if (bindings.bindings.some(row => row.id === "cancel")) console.log("RESPONSES_CANCEL_RETIRED " + phase);
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body)), {
  each: (rows: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(rows)(name, (...args) => runCase(() => body(...args))),
});

async function select(chat = false) {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe(phase);
  let row: any;
  if (xai) {
    const result = await runProviderStaticCatalog({ provider });
    if (!result || !("provider" in result) || !result.provider) throw new Error("missing registered xAI catalog");
    expect(result.provider.api).toBe("openai-responses");
    row = result.provider.models.find(row => row.id === modelId);
    expect(row?.id).toBe(modelId);
  } else {
    // An explicit operator-configured model; zero client hints are NOT a tariff.
    // Worker policy-fixed transport and hard-budget unpriced denial are separate.
    row = { id: modelId, name: "GPT-6.1 Terra", reasoning: true, input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }
  const api = chat ? "openai-completions" : "openai-responses";
  const configured = { api, baseUrl: origin + "/v1/native/" + phase + "/v1", models: [row] };
  const raw = { ...row, provider: phase, api, baseUrl: configured.baseUrl } as Model<"openai-responses">;
  const model = provider.normalizeResolvedModel?.({ provider: phase, modelId, model: raw }) ?? raw;
  expect(model).toMatchObject({ id: modelId, provider: phase, api, baseUrl: configured.baseUrl });
  return { provider, model, config: { models: { providers: { [phase]: configured } } } };
}

async function start(id: string, options: { selected?: Awaited<ReturnType<typeof select>>; history?: AgentMessage[]; signal?: AbortSignal } = {}) {
  const selected = options.selected ?? await select(id === "chat"), { provider, model, config } = selected;
  const history: AgentMessage[] = options.history ?? [{ role: "user", content: [{ type: "text", text: "fixture responses_" + id },
    ...(id === "image" ? [{ type: "image" as const, data: png, mimeType: "image/png" }] : [])], timestamp: 1 }];
  const messages = await withOpenClawTestState({ label: "responses-" + phase }, async state => {
    const policy = resolveTranscriptPolicy({ provider: phase, modelId, modelApi: model.api, model, runtimeHandle: { provider: phase, plugin: provider } });
    const registry = createEmptyPluginRegistry(); registry.providers.push({ pluginId: phase, provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(registry, async () => {
      await Promise.resolve();
      return sanitizeSessionHistory({ provider: phase, modelId, modelApi: model.api, model, policy, config, env: {}, workspaceDir: state.workspaceDir,
        sessionId: `responses-${phase}-${id}`, sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: phase, modelApi: model.api, modelId })]), messages: history });
    });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  // Public stream keeps serviceTier/reasoningEffort as native Responses options.
  const wrapped = provider.wrapStreamFn?.({ provider: phase, modelId, model, sourceApi: model.api, streamFn: id === "chat" ? streamSimple : stream });
  expect(wrapped).toBeDefined();
  const apiKey = id === "invalid" ? "clawrouter-live-responses_stream-invalid" : key(id);
  const owner = bindings.expect(id, "chat", model.baseUrl + (id === "chat" ? "/chat/completions" : "/responses"), "POST", apiKey, options.signal);
  owner.callerObservation = {}; lifetime.signal(owner.callerObservation, options.signal);
  return invocation.run(owner, () => wrapped!(model, context, {
    apiKey, maxTokens: 128, signal: options.signal,
    ...(id === "no_effort" || id === "chat" ? {} : { reasoningEffort: id === "low" ? "low" : "high" }),
    ...(id === "priority" || id === "priority_long" ? { serviceTier: "priority" } : {}),
    ...(id === "stored" || id === "hosted" ? { onPayload(payload: any) {
      if (id === "stored") payload.previous_response_id = "resp_unknown_stored";
      else payload.tools = [{ type: "web_search" }];
    } } : {}),
  } as any));
}

describe(phase + " registered Responses through Worker and SQLite", { concurrent: false }, () => {
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
  it("replays the actual first Responses assistant and matching tool result through the captured provider", async () => {
    const selected = await select();
    const first = await (await start("stream", { selected })).result();
    expect(first.stopReason, first.errorMessage).toBe("toolUse");
    const thinking = first.content.find(part => part.type === "thinking"), tool = first.content.find(part => part.type === "toolCall");
    expect(thinking?.type).toBe("thinking"); expect(tool?.type).toBe("toolCall");
    if (thinking?.type !== "thinking" || tool?.type !== "toolCall") throw new Error("actual replay items missing");
    expect(thinking.thinkingSignature).toContain("synthetic-encrypted-reasoning");
    expect(tool.name).toBe("lookup"); expect(tool.arguments).toEqual({});
    const history: AgentMessage[] = [{ role: "user", content: "fixture responses_stream", timestamp: 1 }, first,
      { role: "toolResult", toolCallId: tool.id, toolName: tool.name, content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: first.timestamp + 1 },
      { role: "user", content: "fixture responses_replay", timestamp: first.timestamp + 2 }];
    const second = await (await start("replay", { selected, history })).result();
    expect(second.stopReason, second.errorMessage).toBe("stop");
    expect(second.content).toContainEqual(expect.objectContaining({ type: "text", text: "synthetic-answer" }));
    console.log("RESPONSES_REPLAY_RETIRED " + phase);
  });
  it.each(["no_effort", "image", "low", ...(xai ? ["priority", "long", "priority_long", "unknown_bill"] : ["chat"])])("uses actual selected provider for %s", async id => {
    const result = await (await start(id)).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "synthetic-answer" }));
  });
  it.each(["invalid", "foreign", "budget", "model_denied", ...(xai ? ["stored", "hosted"] : ["unpriced"])])("denies %s without ambient fallback or unqualified dispatch", async id => {
    const result = await (await start(id)).result(); expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|synthetic-responses/);
  });
  it("preserves the controlled provider error and original retirement", async () => {
    const result = await (await start("error")).result();
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe("synthetic-upstream-error"); lifetime.providerResult(result);
  });
  it("retires an actual partial Responses stream after caller cancellation", async () => {
    const controller = new AbortController(), output = await start("cancel", { signal: controller.signal });
    for await (const event of output) if (event.type === "text_delta") { lifetime.partial(bindings.bindings.find(row => row.id === "cancel")); controller.abort(); break; }
    expect(controller.signal.aborted).toBe(true); expect((await output.result()).stopReason).toBe("aborted");
  });
});
