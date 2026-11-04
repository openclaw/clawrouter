import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { runProviderStaticCatalog } from "../../src/plugins/provider-discovery.js";
import plugin from "./index.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["grok-4.6", "grok-4.5", "grok-build-0.1", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning"];
const key = (id: string) => `clawrouter-live-xai_${id}-fixture-secret`;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

async function start(id: string, options: { modelIndex?: number; image?: boolean; reasoning?: "low" | "xhigh"; apiKey?: string; signal?: AbortSignal } = {}) {
  // The frozen runtime preserves xhigh from Grok 4.6; Grok 4.5 maps it to high.
  const modelId = models[options.modelIndex ?? 0];
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("xai");
  const result = await runProviderStaticCatalog({ provider });
  if (!result || !("provider" in result) || !result.provider) throw new Error("expected the actual xAI static provider catalog");
  const catalog = result.provider;
  expect(catalog.api).toBe("openai-responses");
  const row = catalog.models.find(row => row.id === modelId);
  expect(row?.id).toBe(modelId);
  // The proxy is explicitly configured for Chat. Default Responses and native
  // hosted search have separate transport, admission and billing contracts.
  const configured = { ...catalog, api: "openai-completions" as const, baseUrl: origin + "/v1/native/xai/v1", models: [row!] };
  const config = { models: { providers: { xai: configured } } };
  const rawModel = { ...row, provider: "xai", api: configured.api, baseUrl: configured.baseUrl } as Model<"openai-completions">;
  const model = provider.normalizeResolvedModel?.({ provider: "xai", modelId, model: rawModel }) as Model<"openai-completions"> | undefined;
  if (!model) throw new Error("expected the actual registered xAI model normalizer");
  expect(model).toMatchObject({ id: modelId, provider: "xai", api: configured.api, baseUrl: configured.baseUrl });
  if (options.reasoning === "xhigh") expect(model.thinkingLevelMap?.xhigh).toBe("xhigh");
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "x_search", arguments: {} }],
      api: model.api, provider: "xai", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "x_search", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "text", text: `fixture xai_${id}` }, ...(options.image ? [{ type: "image" as const, data: png, mimeType: "image/png" }] : [])], timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "xai-frozen-chat-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "xai", modelId, modelApi: model.api, model, runtimeHandle: { provider: "xai", plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(true);
    return sanitizeSessionHistory({ provider: "xai", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: `xai-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "xai", modelApi: model.api, modelId })]),
      messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "x_search", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const wrapped = provider.wrapStreamFn?.({ provider: "xai", modelId, model, sourceApi: model.api, streamFn: streamSimple });
  expect(wrapped).toBeDefined();
  return wrapped!(model, context, { apiKey: options.apiKey ?? key(id), maxTokens: 128, signal: options.signal, ...(options.reasoning ? { reasoning: options.reasoning } : {}) });
}

describe("actual registered frozen xAI Chat explicit Chat client through Worker and SQLite", () => {
  it.each(models.map((model, modelIndex) => ({ model, modelIndex })))("preserves $model through the actual registered Chat hook", async ({ modelIndex }) => {
    const result = await (await start(`model${modelIndex}`, { modelIndex })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage).toMatchObject({ input: 11, output: 3, totalTokens: 14 });
  });
  it("serializes real inline PNG bytes through the registered image-capable card", async () => {
    const result = await (await start("image", { image: true })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it.each(["low", "xhigh"] as const)("preserves qualified %s reasoning without enabling hosted tools", async reasoning => {
    const result = await (await start(reasoning, { reasoning })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it.each(["invalid", "foreign", "unpriced", "provider_budget", "model_denied"])("denies %s before upstream egress or ambient-key fallback", async id => {
    const result = await (await start(id, id === "invalid" ? { apiKey: "clawrouter-live-xai_model0-invalid" } : {})).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
  });
  it("retains a fragmented embedded upstream error without replay", async () => {
    const result = await (await start("error")).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("synthetic-upstream-error");
  });
  it("cancels after actual partial delivery without claiming a free request", async () => {
    const controller = new AbortController(), stream = await start("cancel", { signal: controller.signal });
    for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
    const result = await stream.result();
    expect(controller.signal.aborted).toBe(true);
    expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
