import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import * as catalogTransport from "../../src/infra/net/fetch-guard.js";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { selectEmbeddedAgentStream } from "../../src/agents/embedded-agent-runner/stream-resolution.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../src/plugins/runtime/generation-state.js";
import { createEmptyPluginRegistry, registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import "openclaw/plugin-sdk/llm";
import type { Model, Context } from "openclaw/plugin-sdk/llm";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { beforeEach, describe, expect, it as nativeIt, vi } from "vitest";
import plugin from "./index.js";

/* OWNED_LIFETIME_IMPLEMENTATION */

// BEGIN CLOUDFLARE BINDINGS
function createCloudflareBindings() {
  const bindings: any[] = [];
  return {
    bindings,
    expect(id: string, kind: string, url: string, method: string, credential: string, caller?: AbortSignal, header = "authorization", prefix = "Bearer ") {
      if (bindings.some(row => row.id === id && row.kind === kind)) throw new Error("duplicate Cloudflare expectation");
      const row: any = { id, kind, url, method, credential, caller, header, prefix, claimed: false }; bindings.push(row); return row;
    },
    claim(input: Request | URL | string, init: RequestInit | undefined, kind: string) {
      const request = input instanceof Request ? input : undefined;
      const url = new URL(request?.url ?? String(input)).href, method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers !== undefined ? init.headers : request?.headers);
      const matches = bindings.filter(row => row.kind === kind && row.url === url && row.method === method && headers.get(row.header) === row.prefix + row.credential);
      if (matches.length !== 1 || matches[0].claimed) throw new Error("foreign, duplicate or ambiguous Cloudflare request");
      matches[0].claimed = true; return matches[0];
    },
    verify() { if (bindings.some(row => !row.claimed)) throw new Error("missing original Cloudflare request"); },
  };
}
// END CLOUDFLARE BINDINGS

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const modelId = "cloudflare-ai-gateway/claude-sonnet-4-6";
const key = (id: string) => `clawrouter-live-cf_${id}-fixture-secret`;
const nativePath = "/v1/native/cloudflare-ai-gateway/anthropic/v1/messages";
const invocation = new AsyncLocalStorage<any>();
const originalCatalog = catalogTransport.fetchWithSsrFGuard, originalGuard = guardedTransport.fetchWithProviderHttpGuard;
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createCloudflareBindings>, bodySucceeded: boolean;
let cancelController: AbortController | undefined;
assert.equal(process.env.CLAWROUTER_CF_CONTRACT, "cloudflare-messages");

function claim(url: any, init: any, kind: string) {
  try { const owner = bindings.claim(url, init, kind); assert.equal(owner, invocation.getStore()); return owner; }
  catch (error) { lifetime.errors.push(error); throw error; }
}
async function runCase(body: () => unknown) {
  await preserveFailures(async () => { await body(); bodySucceeded = true; }, [
    () => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(),
    () => vi.unstubAllEnvs(), () => clearLiveCatalogCacheForTests(),
  ]);
  assert.equal(lifetime.guards.length, bindings.bindings.length);
  assert.equal(lifetime.summary().releases, bindings.bindings.length);
  if (bindings.bindings.some(row => row.id === "cancel")) console.log("CLOUDFLARE_CANCEL_RETIRED cloudflare-messages");
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body)), {
  each: (rows: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(rows)(name, (...args) => runCase(() => body(...args))),
});
async function control(action: string) {
  const response = await fetch(process.env.CLAWROUTER_CF_CONTROL_ORIGIN + "/fixture/" + action);
  expect(response.status).toBe(200); return response.json();
}
async function selected(id: string, denied = false) {
  clearLiveCatalogCacheForTests();
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("clawrouter");
  const registry = createEmptyPluginRegistry(); registry.providers.push({ pluginId: "clawrouter", provider, source: "test" });
  const providerConfig = { baseUrl: origin + "/v1", api: "anthropic-messages" as const, auth: "api-key" as const, apiKey: key(id),
    models: [{ id: modelId, name: "Synthetic Cloudflare selection", api: "anthropic-messages" as const, reasoning: true,
      input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 100 }] };
  const config = { models: { providers: { clawrouter: providerConfig } } };
  const owner = bindings.expect(id + "_catalog", "catalog", origin + "/v1/catalog", "GET", key(id));
  return withOpenClawTestState({ label: "cloudflare-messages-catalog" }, async state => {
    const catalog = await invocation.run(owner, () => provider.catalog!.run({ config, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir,
      resolveProviderAuth: () => ({ apiKey: key(id), discoveryApiKey: key(id), mode: "api_key", source: "config" }) } as any));
    const rows = catalog && "provider" in catalog ? catalog.provider?.models : undefined;
    const prepare = () => provider.prepareDynamicModel!({ provider: "clawrouter", modelId, config, providerConfig,
      agentDir: state.agentDir(), workspaceDir: state.workspaceDir } as any);
    if (denied) {
      expect(rows?.some(row => row.id === modelId)).toBe(false);
      await expect(prepare()).rejects.toThrow("ClawRouter catalog does not offer the selected model");
      return undefined;
    }
    expect(rows?.find(row => row.id === modelId)).toMatchObject({ api: "anthropic-messages", baseUrl: origin + "/v1/native/cloudflare-ai-gateway/anthropic" });
    const prepared = await prepare(); assert(prepared);
    const model = (provider.normalizeResolvedModel?.({ provider: "clawrouter", modelId, model: prepared } as any) ?? prepared) as Model<any>;
    expect(model).toMatchObject({ id: modelId, provider: "clawrouter", api: "anthropic-messages", baseUrl: origin + "/v1/native/cloudflare-ai-gateway/anthropic" });
    return { provider, registry, model, config };
  });
}
async function start(id: string, options: { selected?: NonNullable<Awaited<ReturnType<typeof selected>>>; apiKey?: string; signal?: AbortSignal; assistant?: any; simple?: boolean } = {}) {
  const current = options.selected ?? await selected(id); assert(current);
  const { provider, registry, model, config } = current;
  const history: AgentMessage[] = [{ role: "user", content: "Synthetic Cloudflare request", timestamp: 1 }];
  if (options.assistant) history.push(options.assistant, { role: "toolResult", toolCallId: "tool_fixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 });
  history.push({ role: "user", content: "fixture cf_" + id, timestamp: 4 });
  const messages = await withOpenClawTestState({ label: "cloudflare-messages-replay" }, state => withPluginRuntimeGenerationRegistryScope(registry, () => sanitizeSessionHistory({
    provider: "clawrouter", modelId, modelApi: model.api, model, config, env: {}, workspaceDir: state.workspaceDir, sessionId: "cf-" + id,
    policy: resolveTranscriptPolicy({ provider: "clawrouter", modelId, modelApi: model.api, model, runtimeHandle: { provider: "clawrouter", plugin: provider } }),
    sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "clawrouter", modelApi: model.api, modelId })]), messages: history,
  })));
  const context: Context = { messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: { index: { type: "integer" } } } }] };
  const apiKey = options.apiKey ?? key(id), owner = bindings.expect(id, "chat", origin + nativePath, "POST", apiKey, options.signal, "x-api-key", "");
  owner.callerObservation = {}; lifetime.signal(owner.callerObservation, options.signal);
  return invocation.run(owner, () => withPluginRuntimeGenerationRegistryScope(registry, () => {
    const transport = selectEmbeddedAgentStream({ llmRuntime: defaultLlmRuntime, currentStreamFn: undefined,
      model, sessionId: "cf-" + id, resolvedApiKey: apiKey });
    expect(transport.strategy).toBe("boundary-aware:anthropic-messages");
    const hook = options.simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
    const wrapped = hook?.({ provider: "clawrouter", modelId, model, sourceApi: model.api, streamFn: transport.streamFn }); assert(wrapped);
    return transport.wrapApiKey(wrapped)(model, context, { apiKey, maxTokens: 100, signal: options.signal, maxRetries: 0 });
  }));
}

describe("registered Cloudflare Messages through Worker and SQLite", { concurrent: false }, () => {
  beforeEach(() => {
    bodySucceeded = false; cancelController = undefined; bindings = createCloudflareBindings();
    vi.stubEnv("ANTHROPIC_API_KEY", "must-not-fallback-anthropic"); vi.stubEnv("CLOUDFLARE_API_TOKEN", "must-not-fallback-cloudflare"); vi.stubEnv("CLAWROUTER_API_KEY", "");
    lifetime = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => bodySucceeded, current: () => invocation.getStore(),
      readProgress(owner: any, value: any) {
        if (owner.id === "cancel" && !owner.partialDelivery && value?.done === false && value.value?.byteLength > 0) {
          assert.equal(owner.claimed, true); assert.equal(owner.caller, cancelController?.signal); lifetime.partial(owner); cancelController!.abort();
        }
      },
    });
    vi.spyOn(catalogTransport, "fetchWithSsrFGuard").mockImplementation(function (this: unknown, ...args) {
      const input = args[0]; if (input.url !== origin + "/v1/catalog") return Reflect.apply(originalCatalog, this, args);
      const owner = claim(input.url, input.init, "catalog"); lifetime.signal(owner, input.signal ?? input.init?.signal); return lifetime.guard(originalCatalog, this, args, owner);
    });
    vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function (this: unknown, ...args) {
      const input = args[0], owner = claim(input.url, input.init, "chat"); lifetime.signal(owner, input.signal ?? input.init?.signal); return lifetime.guard(originalGuard, this, args, owner);
    });
  });
  it.each([false, true])("selects the registered native transport (simple=%s)", async simple => {
    const result = await (await start(simple ? "simple" : "stream", { simple })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage).toMatchObject({ input: 11, output: 3, totalTokens: 14 });
  });
  it("joins true HTTP EOF before publishing the final result", async () => {
    const stream = await start("eof"), result = stream.result(); let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    let state;
    for (let i = 0; i < 150; i++) { state = await control("state"); if (state.wireSent) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(state).toMatchObject({ wireSent: true, eof: false, expired: false }); expect(settled).toBe(false);
    expect((await control("release")).released).toBe(true);
    expect((await result).stopReason).toBe("stop"); expect((await control("state")).eof).toBe(true);
  });
  it("replays original signed thinking and its tool result through the captured registry", async () => {
    const assistant = await (await start("seed")).result();
    expect(assistant.stopReason).toBe("toolUse");
    expect(assistant.content).toContainEqual(expect.objectContaining({ type: "thinking", thinkingSignature: "synthetic-signature" }));
    expect(assistant.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "tool_fixture", name: "lookup", arguments: { index: 2 } }));
    expect((await (await start("replay", { assistant })).result()).stopReason).toBe("stop");
  });
  it.each(["offers_empty", "offers_invalid", "model_missing", "catalog_unpriced", "catalog_foreign"])("fails closed for catalog %s and configured-model preparation", async id => { await selected(id, true); });
  it("re-admits invalid credentials, model/provider policy, missing grant, budget and unknown price", async () => {
    const good = await selected("selection"); assert(good);
    for (const id of ["invalid", "foreign", "model_denied", "grant_missing", "grant_revoked", "grant_foreign", "budget", "unpriced"]) {
      const result = await (await start(id, { selected: good, ...(id === "invalid" ? { apiKey: "clawrouter-live-cf_stream-invalid" } : {}) })).result();
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|synthetic-gateway|must-not-fallback/);
    }
  });
  it("retains provider error and releases the original response without replay", async () => {
    const result = await (await start("error")).result(); expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("synthetic-upstream-error"); expect(result.content).toEqual([]);
  });
  it("cancels only from actual original transport progress and joins all owned work", async () => {
    cancelController = new AbortController(); const output = await start("cancel", { signal: cancelController.signal });
    const result = await output.result(); expect(result.stopReason).toBe("aborted"); expect(result.content).toEqual([]);
    expect(bindings.bindings.find(row => row.id === "cancel").partialDelivery).toBe(true);
  });
});
