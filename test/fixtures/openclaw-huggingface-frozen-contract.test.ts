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

assert.equal(process.env.CLAWROUTER_HUGGINGFACE_CONTRACT, "frozen");
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["deepseek-ai/DeepSeek-R1","deepseek-ai/DeepSeek-V3.1","openai/gpt-oss-120b"];
const cases = [{"id":"stream_0","model":"deepseek-ai/DeepSeek-R1","max":128},{"id":"simple_0","model":"deepseek-ai/DeepSeek-R1","max":128},{"id":"stream_1","model":"deepseek-ai/DeepSeek-V3.1","max":128},{"id":"simple_1","model":"deepseek-ai/DeepSeek-V3.1","max":128},{"id":"stream_2","model":"openai/gpt-oss-120b","max":128},{"id":"simple_2","model":"openai/gpt-oss-120b","max":128},{"id":"suffix_fastest","model":"openai/gpt-oss-120b:fastest","max":128},{"id":"suffix_cheapest","model":"openai/gpt-oss-120b:cheapest","max":128},{"id":"suffix_preferred","model":"openai/gpt-oss-120b:preferred","max":128},{"id":"suffix_novita","model":"openai/gpt-oss-120b:novita","max":128},{"id":"unpriced_0","model":"deepseek-ai/DeepSeek-R1","max":128,"denied":true},{"id":"unpriced_1","model":"deepseek-ai/DeepSeek-V3.1","max":128,"denied":true},{"id":"unpriced_2","model":"openai/gpt-oss-120b","max":128,"denied":true},{"id":"invalid","model":"deepseek-ai/DeepSeek-R1","max":128,"denied":true},{"id":"foreign","model":"deepseek-ai/DeepSeek-R1","max":128,"denied":true},{"id":"depleted","model":"deepseek-ai/DeepSeek-R1","max":128,"denied":true},{"id":"model_denied","model":"deepseek-ai/DeepSeek-R1","max":128,"denied":true},{"id":"error","model":"deepseek-ai/DeepSeek-R1","max":128},{"id":"cancel","model":"openai/gpt-oss-120b","max":128}];
const key = (id: string) => "clawrouter-live-huggingface_" + id + "-fixture-secret";
const invocation = new AsyncLocalStorage<any>();
const originalGuard = guardedTransport.fetchWithProviderHttpGuard, originalFailure = transportStream.failTransportStream;
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createRequestBindings>, bodySucceeded: boolean;

async function runCase(body: () => unknown) {
  await preserveFailures(async () => { await body(); bodySucceeded = true; }, [
    () => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(),
  ]);
  if (bindings.bindings.some(row => row.id === "cancel")) console.log("HUGGINGFACE_CANCEL_RETIRED frozen");
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body)), {
  each: (rows: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(rows)(name, (...args) => runCase(() => body(...args))),
});

function registeredHuggingFaceCatalog(result: Awaited<ReturnType<typeof runProviderStaticCatalog>>) {
  assert.ok(result && "provider" in result && result.provider, "expected registered HuggingFace single-provider catalog");
  return result.provider;
}

async function start(id: string, options: { simple?: boolean; apiKey?: string; signal?: AbortSignal } = {}) {
  const selected = cases.find(row => row.id === id); assert.ok(selected);
  const modelId = selected.model, catalogId = modelId.split(":")[0];
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("huggingface");
  const result = await runProviderStaticCatalog({ provider });
  const catalog = registeredHuggingFaceCatalog(result), row = catalog.models.find(row => row.id === catalogId);
  expect(catalog.api).toBe("openai-completions");
  expect(row).toMatchObject({ id: catalogId, contextWindow: 131072, maxTokens: 8192, input: ["text"] });
  // These are static SDK defaults, not evidence for selected-host tariff or limits.
  const configured = { ...catalog, baseUrl: origin + "/v1/native/huggingface/v1", models: [{ ...row!, id: modelId }] };
  const config = { models: { providers: { huggingface: configured } } };
  const model = { ...row!, id: modelId, provider: "huggingface", api: "openai-completions", baseUrl: configured.baseUrl } as Model<"openai-completions">;
  expect(provider.normalizeResolvedModel?.({ model }) ?? model).toBe(model);
  const entry = options.simple ? streamSimple : stream;
  // Invoke only the registered hooks; no replacement provider implementation.
  expect(provider.wrapStreamFn?.({ provider: "huggingface", modelId, model, sourceApi: model.api, streamFn: entry })).toBeUndefined();
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: model.api, provider: "huggingface", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: "fixture huggingface_" + id, timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "huggingface-fast-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "huggingface", modelId, modelApi: model.api, model, runtimeHandle: { provider: "huggingface", plugin: provider } });
    const registry = createEmptyPluginRegistry(); registry.providers.push({ pluginId: "huggingface", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(registry, () => sanitizeSessionHistory({ provider: "huggingface", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: "huggingface-" + id,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "huggingface", modelApi: model.api, modelId })]), messages: history }));
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const apiKey = options.apiKey ?? key(id);
  const owner = bindings.expect(id, "chat", configured.baseUrl + "/chat/completions", "POST", apiKey, options.signal);
  owner.callerObservation = {}; lifetime.signal(owner.callerObservation, options.signal);
  return invocation.run(owner, () => entry(model, context, { apiKey, maxTokens: 128, signal: options.signal }));
}

describe("actual registered HuggingFace frozen custom-base Chat through Worker and SQLite", { concurrent: false }, () => {
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
  it.each(["fastest", "cheapest", "preferred", "novita"])("keeps selected suffix %s verbatim", async suffix => {
    expect((await (await start("suffix_" + suffix)).result()).stopReason).toBe("stop");
  });
  it.each(cases.filter(row => row.denied).map(row => row.id))("denies %s without upstream egress or ambient secrets", async id => {
    const result = await (await start(id, id === "invalid" ? { apiKey: "clawrouter-live-huggingface_stream_0-invalid" } : {})).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-|synthetic-huggingface/);
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
