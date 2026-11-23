import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { createEmptyPluginRegistry, registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it as nativeIt, vi } from "vitest";
import { APIError } from "openai";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
import * as transportStream from "../../packages/ai/src/transports/transport-stream-shared.js";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../src/plugins/runtime/generation-state.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";

// The outer fixture inserts the existing exact owned-operation implementation
// here, then copies that one complete source into the pinned SDK checkout.
/* OWNED_LIFETIME_IMPLEMENTATION */

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["codestral-latest", "devstral-medium-latest", "mistral-large-latest", "mistral-medium-2508", "mistral-small-latest"];
const key = (id: string) => `clawrouter-live-mistral_${id}-fixture-secret`;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const invocation = new AsyncLocalStorage<any>();
const originalGuard = guardedTransport.fetchWithProviderHttpGuard, originalFailure = transportStream.failTransportStream;
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createRequestBindings>, bodySucceeded: boolean;

async function runCase(body: () => unknown) {
  await preserveFailures(async () => { await body(); bodySucceeded = true; }, [
    () => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(),
  ]);
  if (bindings.bindings.some(row => row.id === "cancel")) console.log("MISTRAL_CANCEL_RETIRED");
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body)), {
  each: (rows: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(rows)(name, (...args) => runCase(() => body(...args))),
});

async function start(id: string, index = 0, options: { signal?: AbortSignal; image?: boolean; reasoning?: "minimal" | "high"; tier?: string; invalid?: boolean } = {}) {
  const provider = await registerSingleProviderPlugin(plugin), modelId = models[index];
  expect(provider.id).toBe("mistral");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const row = catalog.models.find(row => row.id === modelId); expect(row).toBeDefined();
  const configured = { ...catalog, baseUrl: origin + "/v1/native/mistral/v1", models: [row!] };
  const config = { models: { providers: { mistral: configured } } };
  const raw = { ...row, provider: "mistral", api: "openai-completions", baseUrl: configured.baseUrl } as Model<"openai-completions">;
  const model = provider.normalizeResolvedModel!({ provider: "mistral", modelId, model: raw }) as Model<"openai-completions">;
  expect(model).toMatchObject({ id: modelId, provider: "mistral", api: "openai-completions", baseUrl: configured.baseUrl });
  const history: any[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "long_tool-id_with_symbols", name: "lookup", arguments: {} }],
      api: model.api, provider: "mistral", model: modelId, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "long_tool-id_with_symbols", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "text", text: `fixture mistral_${id}` }, ...(options.image ? [{ type: "image", data: png, mimeType: "image/png" }] : [])], timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "mistral-frozen-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "mistral", modelId, modelApi: model.api, model, runtimeHandle: { provider: "mistral", plugin: provider } });
    const registry = createEmptyPluginRegistry(); registry.providers.push({ pluginId: "mistral", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(registry, () => sanitizeSessionHistory({ provider: "mistral", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: `mistral-${id}`, sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "mistral", modelApi: model.api, modelId })]), messages: history }));
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const apiKey = options.invalid ? "clawrouter-live-mistral_card0-invalid" : key(id);
  const owner = bindings.expect(id, "chat", configured.baseUrl + "/chat/completions", "POST", apiKey, options.signal);
  owner.callerObservation = {}; lifetime.signal(owner.callerObservation, options.signal);
  return invocation.run(owner, () => streamSimple(model, context, { apiKey, maxTokens: 128, signal: options.signal, reasoning: options.reasoning,
    ...(options.tier ? { onPayload(payload: any) { payload.service_tier = options.tier; return payload; } } : {}) }));
}

describe("registered frozen Mistral Chat through Worker and SQLite", { concurrent: false }, () => {
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
  it.each(models.map((model, index) => [model, index]))("preserves exact %s identity and registered replay", async (_model, index) => {
    const result = await (await start(`card${index}`, index)).result();
    expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage).toMatchObject({ input: 7, cacheRead: 4, output: 3, totalTokens: 14 });
  });
  it.each([2, 3, 4])("preserves image input only on qualified image card %i", async index => {
    expect((await (await start(`image${index}`, index, { image: true })).result()).stopReason).toBe("stop");
  });
  it.each(["minimal", "high"] as const)("preserves Small %s and typed reasoning chunks", async reasoning => {
    const result = await (await start(reasoning, 4, { reasoning })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "synthetic-reasoning" }));
  });
  it.each([0, 4].flatMap(index => ["standard", "standard_only", "priority", "auto"].map(tier => [index, tier])))("bills card %i through supported %s payload selection", async (index, tier) => {
    expect((await (await start(`tier${index}_${tier}`, index, { tier })).result()).stopReason).toBe("stop");
  });
  it.each([1, 2, 3])("rejects unpriced card %i with zero egress", async index => {
    expect((await (await start(`unpriced${index}`, index)).result()).stopReason).toBe("error");
  });
  it.each(["invalid", "foreign", "unknown_tier"])("rejects %s without ambient credential fallback", async id => {
    expect((await (await start(id, 0, { invalid: id === "invalid", tier: id === "unknown_tier" ? "future" : undefined })).result()).stopReason).toBe("error");
  });
  it("retains the exact controlled embedded provider error and cleanup", async () => {
    const result = await (await start("error")).result(); expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe("synthetic-upstream-error"); lifetime.providerResult(result);
  });
  it("cancels after actual SDK partial delivery and joins originals", async () => {
    const caller = new AbortController(), stream = await start("cancel", 0, { signal: caller.signal });
    for await (const event of stream) if (event.type === "text_delta") { lifetime.partial(bindings.bindings.find(row => row.id === "cancel")); caller.abort(); break; }
    const result = await stream.result(); assert.equal(caller.signal.aborted, true); expect(result.stopReason).toBe("aborted");
  });
});
