import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
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

assert.equal(process.env.CLAWROUTER_MYTHOS_CONTRACT, "mythos5");
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const modelId = "claude-mythos-5";
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const key = (id: string) => "clawrouter-live-mythos_" + id + "-fixture-secret";
const invocation = new AsyncLocalStorage<any>();
const originalGuard = guardedTransport.fetchWithProviderHttpGuard;
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createRequestBindings>, bodySucceeded: boolean;
let cancelController: AbortController | undefined;
let retainedAssistant: any;

async function runCase(body: () => unknown) {
  await preserveFailures(async () => { await body(); bodySucceeded = true; }, [
    () => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(),
  ]);
  if (bindings.bindings.some(row => row.id === "cancel")) console.log("MYTHOS_CANCEL_RETIRED mythos5");
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body)), {
  each: (rows: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(rows)(name, (...args) => runCase(() => body(...args))),
});

function registeredMythosCatalog(result: Awaited<ReturnType<typeof runProviderStaticCatalog>>) {
  assert.ok(result && "providers" in result && result.providers.anthropic, "expected registered Anthropic catalog");
  return result.providers.anthropic;
}

async function start(id: string, options: { simple?: boolean; apiKey?: string; signal?: AbortSignal; effort?: string; modifiers?: Record<string, string>; replay?: boolean; foreignReplay?: boolean; image?: boolean } = {}) {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("anthropic");
  const catalog = registeredMythosCatalog(await runProviderStaticCatalog({ provider }));
  const row = catalog.models.find(row => row.id === modelId);
  expect(catalog.api).toBe("anthropic-messages");
  expect(row).toMatchObject({ id: modelId, contextWindow: 1000000, maxTokens: 128000, input: ["text", "image"], reasoning: true });
  const configured = { ...catalog, baseUrl: origin + "/v1/native/anthropic", models: [row!] };
  const config = { models: { providers: { anthropic: configured } } };
  const initial = { ...row!, provider: "anthropic", api: "anthropic-messages", baseUrl: configured.baseUrl } as Model<"anthropic-messages">;
  const model = (provider.normalizeResolvedModel?.({ provider: "anthropic", modelId, model: initial, config }) ?? initial) as Model<"anthropic-messages">;
  expect(model).toMatchObject({ id: modelId, provider: "anthropic", baseUrl: configured.baseUrl, maxTokens: 128000 });
  const publicStream = options.simple ? streamSimple : stream;
  const entry = provider.wrapStreamFn?.({ provider: "anthropic", modelId, model, sourceApi: model.api, streamFn: publicStream });
  expect(entry).toBeDefined();
  const user: AgentMessage = { role: "user", content: options.image ? [{ type: "text", text: "Synthetic image" }, { type: "image", data: image, mimeType: "image/png" }] : "Synthetic instructions", timestamp: 1 };
  const history: AgentMessage[] = [user];
  if (options.replay) {
    assert.ok(retainedAssistant);
    const assistant = options.foreignReplay ? { ...retainedAssistant, model: "claude-sonnet-4-6" } : retainedAssistant;
    history.push(assistant, { role: "toolResult", toolCallId: "tool_fixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 });
  }
  history.push({ role: "user", content: "fixture mythos_" + id, timestamp: 4 });
  const messages = await withOpenClawTestState({ label: "mythos-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "anthropic", modelId, modelApi: model.api, model, runtimeHandle: { provider: "anthropic", plugin: provider } });
    const registry = createEmptyPluginRegistry(); registry.providers.push({ pluginId: "anthropic", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(registry, () => sanitizeSessionHistory({ provider: "anthropic", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: "mythos-" + id,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "anthropic", modelApi: model.api, modelId: options.foreignReplay ? "claude-sonnet-4-6" : modelId })]), messages: history }));
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: { index: { type: "integer" } } } }] };
  const apiKey = options.apiKey ?? key(id);
  const owner = bindings.expect(id, "chat", configured.baseUrl + "/v1/messages", "POST", apiKey, options.signal);
  owner.callerObservation = {}; lifetime.signal(owner.callerObservation, options.signal);
  return invocation.run(owner, () => entry!(model, context, { apiKey, maxTokens: 128, signal: options.signal,
    ...(options.effort ? { reasoning: options.effort as any } : {}),
    ...(options.modifiers ? { onPayload(payload: unknown) { Object.assign(payload as object, options.modifiers); } } : {}),
  }));
}

describe("registered Mythos Messages through Worker and SQLite", { concurrent: false }, () => {
  beforeEach(() => {
    bodySucceeded = false; cancelController = undefined; bindings = createRequestBindings();
    lifetime = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => bodySucceeded, current: () => invocation.getStore(),
      readProgress(owner: any, value: any) {
        if (owner.id === "cancel" && !owner.partialDelivery && value?.done === false && value.value?.byteLength > 0) {
          assert.equal(owner.claimed, true); assert.equal(owner.caller, cancelController?.signal);
          lifetime.partial(owner); cancelController!.abort();
        }
      },
    });
    vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function (...args) {
      const options = args[0], owner = bindings.claim(options.url, options.init, "chat");
      lifetime.signal(owner, options.signal ?? options.init?.signal); return lifetime.guard(originalGuard, this, args, owner);
    });
  });
  it.each([false, true])("uses registered public Messages (simple=%s)", async simple => {
    const result = await (await start(simple ? "simple" : "stream", { simple })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage).toMatchObject({ input: 400, cacheRead: 100, cacheWrite: 500, output: 10, totalTokens: 1010 });
  });
  it.each(["low", "medium", "high", "xhigh", "max", "minimal"])("uses actual adaptive thinking effort %s", async effort => {
    expect((await (await start(effort, { simple: true, effort })).result()).stopReason).toBe("stop");
  });
  it.each(["global", "us", "missing_geo"])("keeps actual geography %s and cache evidence", async id => {
    expect((await (await start(id, { modifiers: id === "missing_geo" ? {} : { inference_geo: id } })).result()).stopReason).toBe("stop");
  });
  it("uses declared image input through the original transport", async () => {
    expect((await (await start("image", { image: true })).result()).stopReason).toBe("stop");
  });
  it("retains actual same-model signed thinking and drops incompatible cross-model thinking", async () => {
    retainedAssistant = await (await start("seed")).result();
    expect(retainedAssistant.stopReason).toBe("toolUse");
    expect(retainedAssistant.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "synthetic reasoning", thinkingSignature: "synthetic-signature" }));
    expect(retainedAssistant.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "tool_fixture", name: "lookup", arguments: { index: 2 } }));
    expect((await (await start("replay", { replay: true })).result()).stopReason).toBe("stop");
    expect((await (await start("cross", { replay: true, foreignReplay: true })).result()).stopReason).toBe("stop");
  });
  it.each(["invalid", "foreign", "budget", "model_denied", "fast", "priority", "bad_geo"])("denies %s without egress", async id => {
    const result = await (await start(id, { ...(id === "invalid" ? { apiKey: "clawrouter-live-mythos_stream-invalid" } : {}),
      modifiers: id === "fast" ? { speed: "fast" } : id === "priority" ? { service_tier: "priority" } : id === "bad_geo" ? { inference_geo: "future" } : {} })).result();
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|synthetic-mythos|must-not-fallback/);
  });
  it("re-admits credentials after real grant revocation", async () => {
    const response = await fetch(origin + "/fixture/revoke", { method: "POST" }); expect(response.status).toBe(204);
    expect((await (await start("revoked")).result()).stopReason).toBe("error");
  });
  it.each(["error", "refusal"])("keeps buffered output quarantined on %s", async id => {
    const output = await start(id), events: string[] = [];
    for await (const event of output) events.push(event.type);
    const result = await output.result(); expect(result.stopReason).toBe("error"); expect(result.content).toEqual([]);
    expect(events).not.toContain("text_delta"); expect(events).not.toContain("thinking_delta"); expect(events).not.toContain("toolcall_end");
    if (id === "error") expect(result.errorMessage).toContain("synthetic-upstream-error");
  });
  it("aborts from bound original transport progress without bypassing public quarantine", async () => {
    cancelController = new AbortController(); const output = await start("cancel", { signal: cancelController.signal }), events: string[] = [];
    for await (const event of output) events.push(event.type);
    const result = await output.result(); expect(cancelController.signal.aborted).toBe(true); expect(result.stopReason).toBe("aborted");
    expect(bindings.bindings.find(row => row.id === "cancel").partialDelivery).toBe(true);
    expect(result.content).toEqual([]); expect(events).not.toContain("text_delta");
  });
});
