import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildLiveModelProviderConfig, clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["deepseek-ai/DeepSeek-V4-Pro", "zai-org/GLM-5.2-FP8", "zai-org/GLM-5.1-FP8", "deepseek-ai/DeepSeek-V3.2", "google/gemini-3.5-flash-lite", "anthropic/claude-sonnet-5", "anthropic/claude-sonnet-4.6", "openai/gpt-5.6-sol"];
const key = (id: string) => `clawrouter-live-gmi_${id}-fixture-secret`;

afterEach(() => clearLiveCatalogCacheForTests());

async function start(id: string, modelId = models[0], options: { apiKey?: string; signal?: AbortSignal; simpleCompletion?: boolean; tools?: boolean; discovered?: Model<"openai-completions"> } = {}) {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const row = catalog.models.find(row => row.id === modelId);
  expect(row).toBeDefined();
  const configured = { ...catalog, baseUrl: origin + "/v1/native/gmi", models: [row!] };
  const config = { models: { providers: { gmi: configured } } };
  const augmented = await provider.augmentModelCatalog?.({ config });
  expect(augmented).toEqual([expect.objectContaining({ id: modelId, provider: "gmi" })]);
  const model = options.discovered ?? { ...row, provider: "gmi", api: catalog.api, baseUrl: configured.baseUrl } as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: "openai-completions", provider: "gmi", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: `fixture gmi_${id}`, timestamp: 4 },
  ];
  // Execute the registered provider's actual replay policy and host sanitizer.
  // The proxy URL is explicit configuration; no live-discovery route is invented.
  const messages = await withOpenClawTestState({ label: "gmi-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "gmi", modelId, modelApi: model.api, model, runtimeHandle: { provider: "gmi", plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(false);
    return sanitizeSessionHistory({ provider: "gmi", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: `gmi-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "gmi", modelApi: model.api, modelId })]),
      messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: options.tools === false ? undefined : [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  console.info(JSON.stringify({ kind: "gmi-replay-boundary", fixture: id, model: modelId,
    hostThinking: messages.some(message => message.role === "assistant" && Array.isArray(message.content) && message.content.some(block => block.type === "thinking" && block.thinking === "synthetic-prior-thinking")),
    llmThinking: context.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "thinking" && block.thinking === "synthetic-prior-thinking")),
    requiresThinkingAsText: model.compat?.requiresThinkingAsText ?? null,
  }));
  const wrap = options.simpleCompletion ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({ provider: "gmi", modelId, model, streamFn: streamSimple });
  expect(wrapped).toHaveProperty("preservesGenericCompatibility", true);
  return wrapped!(model, context, { apiKey: options.apiKey ?? key(id), maxTokens: 128, reasoning: "high", signal: options.signal });
}

async function discovered(id: string) {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  return buildLiveModelProviderConfig({ providerId: "gmi", endpoint: origin + "/v1/native/gmi/models",
    apiKey: key(id), discoveryMode: "strict", models: catalog.models,
    providerConfig: { ...catalog, baseUrl: origin + "/v1/native/gmi" },
    policy: { allowPrivateNetwork: true }, requireHttps: false });
}

describe("actual GMI configured catalog and replay through Worker and SQLite", () => {
  it.each(models.map((model, i) => [model, `card${i}`]))("streams exact frozen %s through the registered replay policy", async (model, id) => {
    const result = await (await start(id, model)).result();
    expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it("runs the actual simple-completion OpenAI tool-reasoning wrapper", async () => {
    const result = await (await start("simple", models[7], { simpleCompletion: true })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it("keeps explicit reasoning when no tools are declared", async () => {
    const result = await (await start("notools", models[7], { tools: false })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it.each(["catalog_org", "catalog_plain"])("selects a permitted model through actual strict keyed discovery (%s)", async id => {
    const catalog = await discovered(id);
    expect(catalog.models.map(row => row.id)).toEqual([models[0]]);
    const model = { ...catalog.models[0], provider: "gmi", api: catalog.api, baseUrl: catalog.baseUrl } as Model<"openai-completions">;
    const result = await (await start(id, model.id, { discovered: model })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it("keeps strict empty and foreign catalogs closed", async () => {
    expect((await discovered("empty")).models).toEqual([]);
    await expect(discovered("foreign")).rejects.toThrow();
  });
  it("uses observed counters when actually supplied", async () => {
    const result = await (await start("observed")).result();
    expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  it("denies invalid credentials, foreign policy and unknown-dollar admission without key fallback", async () => {
    for (const [id, apiKey] of [["invalid", "clawrouter-live-gmi_card0-invalid"], ["foreign", key("foreign")], ["unpriced", key("unpriced")]]) {
      const result = await (await start(id, models[0], { apiKey })).result();
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
    }
  });
  it("retains embedded errors without replay", async () => {
    const result = await (await start("error")).result(); expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("synthetic-upstream-error");
  });
  it("cancels the actual native SDK stream after partial delivery", async () => {
    const controller = new AbortController(), stream = await start("cancel", models[0], { signal: controller.signal });
    for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
    const result = await stream.result(); expect(controller.signal.aborted).toBe(true); expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
