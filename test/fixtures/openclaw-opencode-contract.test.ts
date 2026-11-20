import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { APIError } from "openai";
import * as catalogTransport from "../../src/infra/net/fetch-guard.js";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
import * as transportStream from "../../packages/ai/src/transports/transport-stream-shared.js";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
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
import plugin from "./index.js";

/* OWNED_LIFETIME_IMPLEMENTATION */

const contract = JSON.parse(process.env.CLAWROUTER_OPENCODE_CONTRACT!);
assert.ok(["opencode", "opencode-go"].includes(contract.provider));
assert.ok(["chat", "responses", "messages"].includes(contract.protocol));
assert.equal(contract.phase, contract.provider + ":" + contract.protocol);
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const key = (id: string) => "clawrouter-live-opencode_" + (["replay", "session_conversation"].includes(id) ? "first" : id) + "-fixture-secret";
const invocation = new AsyncLocalStorage<any>();
const originalGuard = guardedTransport.fetchWithProviderHttpGuard;
const originalCatalogGuard = catalogTransport.fetchWithSsrFGuard;
const originalFailure = transportStream.failTransportStream;
let cancelController: AbortController | undefined;
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createOpenCodeBindings>, bodySucceeded: boolean;

// BEGIN OPENCODE CLAIM
function claimOwned(url: any, init: any, kind: string) {
  try { const owner = bindings.claim(url, init, kind); if (owner !== invocation.getStore()) throw new Error("foreign OpenCode invocation"); return owner; }
  catch (error) { lifetime.errors.push(error); throw error; }
}
// END OPENCODE CLAIM

// BEGIN OPENCODE QUARANTINED PROGRESS
function observeQuarantinedProgress(owner: any, value: any) {
  if (contract.provider !== "opencode" || contract.protocol !== "messages" || owner.id !== "cancel" || owner.kind !== "chat" || owner.partialDelivery || value?.done !== false || !(value.value?.byteLength > 0)) return;
  assert.equal(owner.claimed, true); assert.equal(owner.caller, cancelController?.signal);
  const matches = bindings.bindings.filter(row => row.id === "cancel" && row.kind === "chat");
  assert.equal(matches.length, 1); assert.equal(matches[0], owner);
  lifetime.partial(owner); cancelController!.abort();
}
// END OPENCODE QUARANTINED PROGRESS

async function runCase(body: () => unknown) {
  await preserveFailures(async () => { await body(); bodySucceeded = true; }, [
    () => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(),
  ]);
  // A transport return alone is never a receipt of acquisition or release.
  const summary = lifetime.summary();
  expect(summary.releases).toBe(bindings.bindings.length);
  expect(lifetime.guards).toHaveLength(bindings.bindings.length);
  if (bindings.bindings.some(row => row.id === "cancel")) console.log("OPENCODE_CANCEL_RETIRED " + contract.phase);
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body)), {
  each: (rows: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(rows)(name, (...args) => runCase(() => body(...args))),
});

async function select(id: string) {
  clearLiveCatalogCacheForTests();
  const row = contract.cases.find((row: any) => row.id === id); assert.ok(row);
  const provider = await registerSingleProviderPlugin(plugin); expect(provider.id).toBe("clawrouter");
  const config = { models: { providers: { clawrouter: { baseUrl: origin + "/v1", auth: "api-key" as const, apiKey: key(id), models: [] } } } };
  const owner = bindings.expect(id, "catalog", origin + "/v1/catalog", "GET", key(id));
  const catalog = await invocation.run(owner, () => withOpenClawTestState({ label: "opencode-catalog" }, state => provider.catalog!.run({ config, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir,
    resolveProviderAuth: () => ({ apiKey: key(id), discoveryApiKey: key(id), mode: "api_key", source: "config" }) } as any)));
  const modelId = contract.provider + "/" + row.model;
  const actual = catalog && "provider" in catalog ? catalog.provider?.models.find((entry: any) => entry.id === modelId) : undefined;
  if (!actual) throw new Error("catalog offer unavailable");
  const raw = { ...actual, provider: "clawrouter" } as Model<any>;
  const model = provider.normalizeResolvedModel?.({ provider: "clawrouter", modelId, model: raw } as any) ?? raw;
  expect(model).toMatchObject({ id: modelId, provider: "clawrouter", api: contract.api });
  const suffix = contract.protocol === "chat" ? "/chat/completions" : contract.protocol === "responses" ? "/responses" : "/v1/messages";
  expect(model.baseUrl + suffix).toBe(origin + (row.unified ? contract.unifiedPath : contract.nativePath));
  return { provider, model, modelId, config, row };
}

// BEGIN OPENCODE SIGNED MESSAGES OPTIONS
function signedMessagesReplayOptions(row: { id: string; model: string; hook: string }) {
  if (contract.protocol !== "messages" || row.hook !== "stream" || !["first", "replay"].includes(row.id)) return {};
  // Raw Anthropic streaming does not consume reasoningEffort. The signed-replay
  // cases explicitly enable the selected model's own adaptive or manual mode.
  if (contract.provider === "opencode" && row.model === "claude-opus-5") return { thinkingEnabled: true, effort: "high" };
  if (contract.provider === "opencode-go" && row.model === "qwen3.8-max") return { thinkingEnabled: true, thinkingBudgetTokens: 1024, maxTokens: 2048 };
  return {};
}
// END OPENCODE SIGNED MESSAGES OPTIONS

async function start(id: string, history?: AgentMessage[], signal?: AbortSignal) {
  const { provider, model, modelId, config, row } = await select(id);
  const replayOptions = signedMessagesReplayOptions(row);
  if (row.model === "qwen3.8-max" && replayOptions.thinkingEnabled) expect(model.reasoning, "actual selected Qwen catalog must admit enabled thinking").toBe(true);
  const sessionId = id === "session_conversation" ? "raw-private-session-other" : "raw-private-session";
  const input: AgentMessage[] = history ?? [{ role: "user", content: [{ type: "text", text: "synthetic OpenCode " + id }], timestamp: 1 }];
  if (id === "prefill") input.push({ role: "assistant", content: [{ type: "text", text: "Synthetic prefill" }], api: model.api, provider: "clawrouter", model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } as any);
  const messages = await withOpenClawTestState({ label: "opencode-replay" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "clawrouter", modelId, modelApi: model.api, model, runtimeHandle: { provider: "clawrouter", plugin: provider } });
    const registry = createEmptyPluginRegistry(); registry.providers.push({ pluginId: "clawrouter", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(registry, async () => {
      await Promise.resolve();
      return sanitizeSessionHistory({ provider: "clawrouter", modelId, modelApi: model.api, model, policy, config, env: {}, workspaceDir: state.workspaceDir, sessionId,
        sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "clawrouter", modelApi: model.api, modelId })]), messages: input });
    });
  });
  const context: Context = { systemPrompt: "Synthetic instructions opencode_case=" + id + ";", messages: convertToLlm(messages),
    ...(row.hook === "simple" ? {} : { tools: [{ name: id.startsWith("dynamic") ? "web_search" : "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: id.startsWith("dynamic") ? { labels: { type: "object", patternProperties: { "^.*$": { type: "string" } } } } : {} } }] }) };
  const thinkingLevel = row.model.startsWith("deepseek-") ? "low" : row.model.startsWith("kimi-") ? "off" : "high";
  const wrap = row.hook === "simple" ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  expect(typeof wrap).toBe("function");
  const wrapped = wrap!({ provider: "clawrouter", modelId, model, sourceApi: model.api, thinkingLevel, streamFn: row.hook === "simple" ? streamSimple : stream } as any);
  expect(wrapped).toBeDefined();
  const owner = bindings.expect(id, "chat", origin + (row.unified ? contract.unifiedPath : contract.nativePath), "POST", key(id), signal);
  owner.callerObservation = {}; lifetime.signal(owner.callerObservation, signal);
  return invocation.run(owner, () => wrapped!(model, context, { apiKey: key(id), maxTokens: 128, signal, sessionId, maxRetries: 0,
    ...(row.hook === "simple" ? { reasoning: thinkingLevel } : { reasoningEffort: thinkingLevel === "off" ? undefined : thinkingLevel }),
    ...replayOptions,
  } as any));
}

describe(contract.phase + " registered catalog and stream ownership", { concurrent: false }, () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests(); bodySucceeded = false; cancelController = undefined; bindings = createOpenCodeBindings();
    lifetime = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => bodySucceeded, current: () => invocation.getStore(), apiPrototype: APIError.prototype, isProxy: types.isProxy,
      readProgress: observeQuarantinedProgress,
    });
    vi.spyOn(catalogTransport, "fetchWithSsrFGuard").mockImplementation(function (...args) {
      const options = args[0]; if (options.url !== origin + "/v1/catalog") return Reflect.apply(originalCatalogGuard, this, args);
      const owner = claimOwned(options.url, options.init, "catalog"); lifetime.signal(owner, options.signal ?? options.init?.signal); return lifetime.guard(originalCatalogGuard, this, args, owner);
    });
    vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function (...args) {
      const options = args[0], owner = claimOwned(options.url, options.init, "chat"); lifetime.signal(owner, options.signal ?? options.init?.signal); return lifetime.guard(originalGuard, this, args, owner);
    });
    vi.spyOn(transportStream, "failTransportStream").mockImplementation(function (...args: Parameters<typeof originalFailure>) { lifetime.providerError(args[0]); return Reflect.apply(originalFailure, this, args); });
  });
  it.each(contract.cases.filter((row: any) => row.id.startsWith("card") || row.id.startsWith("unified_") || row.id === "prefill"))("executes $id with the actual selected $model and hook", async row => {
    const result = await (await start(row.id)).result(); expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "synthetic-answer" }));
  });
  it("replays the actual signed/tool assistant through its captured registry", async () => {
    const first = await (await start("first")).result(); expect(first.stopReason, first.errorMessage).toBe("toolUse");
    const call = first.content.find(part => part.type === "toolCall"); assert.ok(call?.type === "toolCall"); expect(call.name).toBe("lookup"); expect(call.arguments).toEqual({});
    if (contract.protocol !== "chat") expect(first.content.some(part => part.type === "thinking" && part.thinkingSignature)).toBe(true);
    const history: AgentMessage[] = [{ role: "user", content: "synthetic first turn", timestamp: 1 }, first,
      { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: first.timestamp + 1 },
      { role: "user", content: "synthetic follow-up", timestamp: first.timestamp + 2 }];
    const second = await (await start("replay", history)).result(); expect(second.stopReason, second.errorMessage).toBe("stop");
    for (const id of ["session_conversation", "session_credential"]) {
      const result = await (await start(id)).result(); expect(result.stopReason, result.errorMessage).toBe("stop");
    }
    console.log("OPENCODE_REPLAY_RETIRED " + contract.phase);
  });
  if (contract.provider === "opencode" && contract.protocol === "responses") it("restores actual Console dynamic tools and replays their arguments", async () => {
    const first = await (await start("dynamic")).result(); expect(first.stopReason, first.errorMessage).toBe("toolUse");
    const call = first.content.find(part => part.type === "toolCall"); assert.ok(call?.type === "toolCall");
    expect(call.name).toBe("web_search"); expect(call.arguments).toEqual({ labels: { topic: "synthetic" } });
    const history: AgentMessage[] = [{ role: "user", content: "synthetic dynamic tool", timestamp: 1 }, first, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "synthetic result" }], isError: false, timestamp: first.timestamp + 1 }];
    expect((await (await start("dynamic_replay", history)).result()).stopReason).toBe("stop");
  });
  it.each(contract.cases.filter((row: any) => row.denied))("rejects $id without a synthetic offer or ambient key", async row => {
    await expect(start(row.id)).rejects.toThrow(row.id === "invalid" ? "clawrouter model discovery failed: HTTP 401" : "catalog offer unavailable");
    expect(bindings.bindings.filter(row => row.kind === "chat")).toHaveLength(0);
  });
  it("preserves provider error and original cleanup", async () => {
    const result = await (await start("error")).result(); expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("synthetic-upstream-error"); lifetime.providerResult(result);
  });
  const quarantined = contract.provider === "opencode" && contract.protocol === "messages";
  it(quarantined ? "aborts after original transport bytes while Claude 5 output stays quarantined" : "retires real post-content caller cancellation", async () => {
    const controller = new AbortController(); cancelController = controller;
    const output = await start("cancel", undefined, controller.signal), events: string[] = [];
    for await (const event of output) {
      events.push(event.type);
      if (!quarantined && event.type === "text_delta") {
        const matches = bindings.bindings.filter(row => row.id === "cancel" && row.kind === "chat" && row.method === "POST"); expect(matches).toHaveLength(1);
        lifetime.partial(matches[0]); controller.abort(); break;
      }
    }
    const result = await output.result(); expect(controller.signal.aborted).toBe(true); expect(result.stopReason).toBe("aborted");
    if (quarantined) { expect(result.content).toEqual([]); expect(events).not.toContain("text_delta"); expect(events).not.toContain("thinking_delta"); expect(events).not.toContain("toolcall_end"); }
  });
});
