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

assert.equal(process.env.CLAWROUTER_FIREWORKS_CONTRACT, "fast");
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const modelId = "accounts/fireworks/routers/glm-5p3-fast";
const key = (id: string) => "clawrouter-live-fireworks_" + id + "-fixture-secret";
const invocation = new AsyncLocalStorage<any>();
const originalGuard = guardedTransport.fetchWithProviderHttpGuard, originalFailure = transportStream.failTransportStream;
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createRequestBindings>, bodySucceeded: boolean;

async function runCase(body: () => unknown) {
  await preserveFailures(async () => { await body(); bodySucceeded = true; }, [
    () => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(),
  ]);
  if (bindings.bindings.some(row => row.id === "cancel")) console.log("FIREWORKS_CANCEL_RETIRED fast");
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body)), {
  each: (rows: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(rows)(name, (...args) => runCase(() => body(...args))),
});

async function start(id: string, options: { simple?: boolean; apiKey?: string; signal?: AbortSignal; tier?: string } = {}) {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("fireworks");
  const result = await runProviderStaticCatalog({ provider });
  if (!result || !("providers" in result) || !result.providers?.fireworks) throw new Error("missing registered Fireworks catalog");
  expect(Object.keys(result.providers)).toEqual(["fireworks"]);
  const catalog = result.providers.fireworks, row = catalog.models.find(row => row.id === modelId);
  expect(catalog.api).toBe("openai-completions");
  expect(row).toMatchObject({ id: modelId, contextWindow: 256000, maxTokens: 256000, input: ["text"], reasoning: true });
  const configured = { ...catalog, baseUrl: origin + "/v1/native/fireworks/v1", models: [row!] };
  const config = { models: { providers: { fireworks: configured } } };
  const model = { ...row!, provider: "fireworks", api: "openai-completions", baseUrl: configured.baseUrl } as Model<"openai-completions">;
  expect(provider.normalizeResolvedModel?.({ model })).toBe(model);
  const entry = options.simple ? streamSimple : stream;
  // The real hook is native-origin-only. Do not force its header-cache repair
  // onto a custom Worker URL or claim that route executed the skipped wrapper.
  expect(provider.wrapStreamFn?.({ provider: "fireworks", modelId, model, sourceApi: model.api, streamFn: entry })).toBeUndefined();
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: model.api, provider: "fireworks", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: "fixture fireworks_" + id, timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "fireworks-fast-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "fireworks", modelId, modelApi: model.api, model, runtimeHandle: { provider: "fireworks", plugin: provider } });
    const registry = createEmptyPluginRegistry(); registry.providers.push({ pluginId: "fireworks", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(registry, () => sanitizeSessionHistory({ provider: "fireworks", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: "fireworks-" + id,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "fireworks", modelApi: model.api, modelId })]), messages: history }));
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const apiKey = options.apiKey ?? key(id);
  const owner = bindings.expect(id, "chat", configured.baseUrl + "/chat/completions", "POST", apiKey, options.signal);
  owner.callerObservation = {}; lifetime.signal(owner.callerObservation, options.signal);
  return invocation.run(owner, () => entry(model, context, { apiKey, maxTokens: 128, signal: options.signal,
    // A supported caller payload hook supplies the explicit tier. It is not an
    // invented SDK serviceTier option or the provider's skipped native wrapper.
    ...(options.tier === undefined ? {} : { onPayload(payload: unknown) { (payload as Record<string, unknown>).service_tier = options.tier; } }),
  }));
}

describe("actual registered Fireworks Fast custom-base Chat through Worker and SQLite", { concurrent: false }, () => {
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
  it.each([false, true])("uses the actual public stream and captured replay provider (simple=%s)", async simple => {
    const result = await (await start(simple ? "simple" : "stream", { simple })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage).toMatchObject({ input: 500, cacheRead: 500, output: 100, totalTokens: 1100 });
  });
  it.each(["default", "auto", "flex"])("preserves explicit tier %s on the final native wire", async tier => {
    expect((await (await start(tier, { tier })).result()).stopReason).toBe("stop");
  });
  it.each(["missing_tier", "missing_cache"])("keeps %s evidence honest", async id => {
    expect((await (await start(id)).result()).stopReason).toBe("stop");
  });
  it.each(["invalid", "foreign", "budget", "model_denied", "priority", "fast", "future"])("denies %s without upstream egress or secret fallback", async id => {
    const result = await (await start(id, { ...(id === "invalid" ? { apiKey: "clawrouter-live-fireworks_stream-invalid" } : {}),
      ...(["priority", "fast", "future"].includes(id) ? { tier: id } : {}) })).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|synthetic-fireworks/);
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
