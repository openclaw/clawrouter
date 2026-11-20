import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { APIError } from "openai";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
import * as transportStream from "../../packages/ai/src/transports/transport-stream-shared.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../src/plugins/runtime/generation-state.js";
import { type Context } from "openclaw/plugin-sdk/llm";
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

assert.equal(process.env.CLAWROUTER_RADIUS_CONTRACT, "configured");
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const cases = [{"id": "stream", "model": "tenant/model", "max": 128}, {"id": "tools", "model": "tenant/model", "max": 128}, {"id": "off", "model": "tenant/model", "max": 128, "effort": "off"}, {"id": "high", "model": "tenant/model", "max": 128, "effort": "high"}, {"id": "unpriced", "model": "tenant/model", "max": 128, "denied": true}, {"id": "invalid", "model": "tenant/model", "max": 128, "denied": true}, {"id": "foreign", "model": "tenant/model", "max": 128, "denied": true}, {"id": "depleted", "model": "tenant/model", "max": 128, "denied": true}, {"id": "model_denied", "model": "tenant/model", "max": 128, "denied": true}, {"id": "error", "model": "tenant/model", "max": 128}, {"id": "cancel", "model": "tenant/model", "max": 128}];
const key = (id: string) => "clawrouter-live-radius_" + id + "-fixture-secret";
const invocation = new AsyncLocalStorage<any>();
const originalGuard = guardedTransport.fetchWithProviderHttpGuard, originalFailure = transportStream.failTransportStream;
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createRequestBindings>, bodySucceeded: boolean;

async function runCase(body: () => unknown) {
  await preserveFailures(async () => { await body(); bodySucceeded = true; }, [
    () => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(),
  ]);
  if (bindings.bindings.some(row => row.id === "cancel")) console.log("RADIUS_CANCEL_RETIRED configured");
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body)), {
  each: (rows: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(rows)(name, (...args) => runCase(() => body(...args))),
});

async function start(id: string, options: { apiKey?: string; signal?: AbortSignal } = {}) {
  const selected = cases.find(row => row.id === id); assert.ok(selected);
  const modelId = selected.model, provider = await registerSingleProviderPlugin(plugin); expect(provider.id).toBe("radius");
  // Explicit configured Pi route. Native catalog/OAuth discovery still selects the upstream origin.
  const row = { id: modelId, name: "Synthetic configured Radius", reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const configured = { api: "pi-messages", baseUrl: origin + "/v1/native/radius", models: [row] };
  const config = { models: { providers: { radius: configured } } };
  const model = { ...row, provider: "radius", api: "pi-messages", baseUrl: configured.baseUrl } as any;
  assert.equal(typeof provider.createStreamFn, "function");
  const entry = provider.createStreamFn!({ provider: "radius", modelId, model, config } as any); assert.equal(typeof entry, "function");
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic reasoning replay", thinkingSignature: "synthetic-replay-signature" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: model.api, provider: "radius", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: "fixture radius_" + id, timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "radius-fast-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "radius", modelId, modelApi: model.api, model, runtimeHandle: { provider: "radius", plugin: provider } });
    const registry = createEmptyPluginRegistry(); registry.providers.push({ pluginId: "radius", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(registry, () => sanitizeSessionHistory({ provider: "radius", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: "radius-" + id,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "radius", modelApi: model.api, modelId })]), messages: history }));
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const apiKey = options.apiKey ?? key(id);
  const owner = bindings.expect(id, "chat", configured.baseUrl + "/messages", "POST", apiKey, options.signal);
  owner.callerObservation = {}; lifetime.signal(owner.callerObservation, options.signal);
  return invocation.run(owner, () => entry!(model, context, { apiKey, maxTokens: 128, signal: options.signal, reasoning: selected.effort }));
}

describe("actual registered Radius custom-base Chat through Worker and SQLite", { concurrent: false }, () => {
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
  it.each(["stream", "tools", "off", "high"])("runs registered configured Pi stream %s", async id => {
    const result = await (await start(id)).result(); expect(result.stopReason, result.errorMessage).toBe("toolUse");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer", textSignature: "synthetic-text-signature" });
    expect(result.content).toContainEqual({ type: "thinking", thinking: "synthetic-reasoning", thinkingSignature: "synthetic-thinking-signature", redacted: undefined });
    expect(result.content).toContainEqual({ type: "toolCall", id: "response-tool", name: "lookup", arguments: { query: "fixture" }, thoughtSignature: "synthetic-tool-signature" });
    expect(result.usage).toMatchObject({ input: 50, output: 12, cacheRead: 10, cacheWrite: 4, totalTokens: 76 });
  });
  it.each(cases.filter(row => row.denied).map(row => row.id))("denies %s without upstream egress or ambient secrets", async id => {
    const result = await (await start(id, id === "invalid" ? { apiKey: "clawrouter-live-radius_stream-invalid" } : {})).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-|synthetic-radius/);
  });
  it("retains the controlled embedded API error and all original retirement outcomes", async () => {
    const result = await (await start("error")).result();
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe("synthetic-radius-error");
  });
  it("cancels only after actual partial delivery and retires original resources", async () => {
    const controller = new AbortController(), output = await start("cancel", { signal: controller.signal });
    for await (const event of output) if (event.type === "text_delta") { lifetime.partial(bindings.bindings.find(row => row.id === "cancel")); controller.abort(); break; }
    const result = await output.result(); expect(controller.signal.aborted).toBe(true); expect(result.stopReason).toBe("aborted");
  });
});
