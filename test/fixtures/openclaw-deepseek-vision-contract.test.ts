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

assert.equal(process.env.CLAWROUTER_DEEPSEEK_CONTRACT, "vision");
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-flash", "deepseek-v4-flash-vision-exp"];
const cases = [{"id": "stream_0", "model": "deepseek-v4-pro", "max": 128}, {"id": "simple_0", "model": "deepseek-v4-pro", "max": 128}, {"id": "stream_1", "model": "deepseek-v4-flash", "max": 128}, {"id": "simple_1", "model": "deepseek-v4-flash", "max": 128}, {"id": "stream_2", "model": "deepseek-flash", "max": 128}, {"id": "simple_2", "model": "deepseek-flash", "max": 128}, {"id": "stream_3", "model": "deepseek-v4-flash-vision-exp", "max": 128}, {"id": "simple_3", "model": "deepseek-v4-flash-vision-exp", "max": 128}, {"id": "effort_off", "model": "deepseek-v4-flash", "max": 128, "effort": "off"}, {"id": "effort_low", "model": "deepseek-v4-flash", "max": 128, "effort": "low"}, {"id": "effort_high", "model": "deepseek-v4-flash", "max": 128, "effort": "high"}, {"id": "effort_max", "model": "deepseek-v4-flash", "max": 128, "effort": "max"}, {"id": "effort_xhigh", "model": "deepseek-v4-flash", "max": 128, "effort": "xhigh"}, {"id": "image_0", "model": "deepseek-v4-flash", "max": 128, "image": true}, {"id": "image_1", "model": "deepseek-flash", "max": 128, "image": true}, {"id": "image_2", "model": "deepseek-v4-flash-vision-exp", "max": 128, "image": true}, {"id": "unpriced", "model": "deepseek-unknown", "max": 128, "denied": true}, {"id": "invalid", "model": "deepseek-v4-pro", "max": 128, "denied": true}, {"id": "foreign", "model": "deepseek-v4-pro", "max": 128, "denied": true}, {"id": "depleted", "model": "deepseek-v4-pro", "max": 128, "denied": true}, {"id": "model_denied", "model": "deepseek-v4-pro", "max": 128, "denied": true}, {"id": "error", "model": "deepseek-v4-flash", "max": 128}, {"id": "cancel", "model": "deepseek-v4-flash", "max": 128}];
const key = (id: string) => "clawrouter-live-deepseek_" + id + "-fixture-secret";
const invocation = new AsyncLocalStorage<any>();
const originalGuard = guardedTransport.fetchWithProviderHttpGuard, originalFailure = transportStream.failTransportStream;
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createRequestBindings>, bodySucceeded: boolean;

async function runCase(body: () => unknown) {
  await preserveFailures(async () => { await body(); bodySucceeded = true; }, [
    () => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(),
  ]);
  if (bindings.bindings.some(row => row.id === "cancel")) console.log("DEEPSEEK_CANCEL_RETIRED vision");
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body)), {
  each: (rows: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(rows)(name, (...args) => runCase(() => body(...args))),
});

function registeredDeepSeekVisionCatalog(result: Awaited<ReturnType<typeof runProviderStaticCatalog>>) {
  assert.ok(result && "provider" in result && result.provider, "expected registered DeepSeekVision single-provider catalog");
  return result.provider;
}

async function start(id: string, options: { simple?: boolean; apiKey?: string; signal?: AbortSignal } = {}) {
  const selected = cases.find(row => row.id === id); assert.ok(selected);
  const modelId = selected.model, catalogId = modelId === "deepseek-unknown" ? models[0] : modelId;
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("deepseek");
  const result = await runProviderStaticCatalog({ provider });
  const catalog = registeredDeepSeekVisionCatalog(result), row = catalog.models.find(row => row.id === catalogId);
  expect(catalog.api).toBe("openai-completions");
  expect(row).toMatchObject({ id: catalogId, contextWindow: 1000000, maxTokens: 384000, input: [models[2], models[3]].includes(catalogId) ? ["text", "image"] : ["text"] });
  // Static SDK limits/costs differ from the dated Router upper bounds.
  // V4 Flash image capability is an explicit supported model configuration, not the pinned catalog default.
  const configured = { ...catalog, baseUrl: origin + "/v1/native/deepseek", models: [{ ...row!, id: modelId, input: selected.image ? ["text", "image"] : row!.input }] };
  const config = { models: { providers: { deepseek: configured } } };
  const model = { ...configured.models[0], id: modelId, provider: "deepseek", api: "openai-completions", baseUrl: configured.baseUrl } as Model<"openai-completions">;
  expect(provider.normalizeResolvedModel?.({ model }) ?? model).toBe(model);
  const entry = options.simple ? streamSimple : stream;
  // Invoke only the registered hooks; no replacement provider implementation.
  const wrapped = provider.wrapStreamFn?.({ provider: "deepseek", modelId, model, sourceApi: model.api, streamFn: entry, thinkingLevel: selected.effort });
  assert.equal(typeof wrapped, "function");
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic reasoning replay", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: model.api, provider: "deepseek", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: selected.image ? [{ type: "text", text: "fixture deepseek_" + id }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] : "fixture deepseek_" + id, timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "deepseek-fast-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "deepseek", modelId, modelApi: model.api, model, runtimeHandle: { provider: "deepseek", plugin: provider } });
    const registry = createEmptyPluginRegistry(); registry.providers.push({ pluginId: "deepseek", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(registry, () => sanitizeSessionHistory({ provider: "deepseek", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: "deepseek-" + id,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "deepseek", modelApi: model.api, modelId })]), messages: history }));
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const apiKey = options.apiKey ?? key(id);
  const owner = bindings.expect(id, "chat", configured.baseUrl + "/chat/completions", "POST", apiKey, options.signal);
  owner.callerObservation = {}; lifetime.signal(owner.callerObservation, options.signal);
  return invocation.run(owner, () => wrapped!(model, context, { apiKey, maxTokens: 128, signal: options.signal, ...(selected.effort === "off" ? { temperature: 0.2 } : {}) }));
}

describe("actual registered DeepSeek vision custom-base Chat through Worker and SQLite", { concurrent: false }, () => {
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
  it.each(models.flatMap((model, i) => [{ id: "stream_" + i, model, simple: false }, { id: "simple_" + i, model, simple: true }]))("selects registered identity $model (simple=$simple)", async ({ id, simple }) => {
    const result = await (await start(id, { simple })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage).toMatchObject({ input: 500, cacheRead: 500, output: 100, totalTokens: 1100 });
  });
  it.each(cases.filter(row => row.effort || row.image).map(row => row.id))("preserves configured image/thinking wire for %s", async id => {
    expect((await (await start(id)).result()).stopReason).toBe("stop");
  });
  it.each(cases.filter(row => row.denied).map(row => row.id))("denies %s without upstream egress or ambient secrets", async id => {
    const result = await (await start(id, id === "invalid" ? { apiKey: "clawrouter-live-deepseek_stream_0-invalid" } : {})).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-|synthetic-deepseek/);
  });
  it("retains the controlled embedded API error and all original retirement outcomes", async () => {
    const result = await (await start("error")).result();
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe("synthetic-upstream-error"); lifetime.providerResult(result);
  });
  it("cancels only after actual partial delivery and retires original resources", async () => {
    const controller = new AbortController(), output = await start("cancel", { signal: controller.signal });
    for await (const event of output) if (event.type === "text_delta") { lifetime.partial(bindings.bindings.find(row => row.id === "cancel")); controller.abort(); break; }
    const result = await output.result(); expect(controller.signal.aborted).toBe(true); expect(result.stopReason).toBe("aborted");
  });
});
