import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5-turbo", "glm-5v-turbo", "glm-5.1"];
async function run(id: string, modelId = models[0], simple = true, reasoning: "off" | "low" | "high" = "high", invalid = false, signal?: AbortSignal) {
  const provider = await registerSingleProviderPlugin(plugin); expect(provider.id).toBe("zai");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const row = catalog.models.find(row => row.id === modelId); expect(row).toBeDefined();
  const model = { ...row, api: catalog.api, provider: provider.id, baseUrl: origin + "/v1/native/zai" } as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Synthetic tool request", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }], api: model.api, provider: model.provider, model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: `synthetic zai_${id}`, timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "zai-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: model.provider, modelId, modelApi: model.api, model, runtimeHandle: { provider: model.provider, plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(false);
    return sanitizeSessionHistory({ provider: model.provider, modelId, modelApi: model.api, model, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: `zai-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: model.provider, modelApi: model.api, modelId })]), messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const thinkingLevel = id.startsWith("default") ? undefined : reasoning;
  const extraParams = provider.prepareExtraParams?.({ provider: model.provider, modelId,
    extraParams: id === "preserve" ? { preserveThinking: true } : id === "tool_off" ? { tool_stream: false } : {} } as never);
  expect(extraParams?.tool_stream).toBe(id === "tool_off" ? false : true);
  const wrap = simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({ provider: model.provider, modelId, model, streamFn: simple ? streamSimple : stream, thinkingLevel, extraParams });
  expect(wrapped).toBeDefined();
  return wrapped!(model, context, { apiKey: invalid ? "clawrouter-live-zai_m0_simple-invalid" : `clawrouter-live-zai_${id}-fixture-secret`, maxTokens: 128,
    ...(thinkingLevel === undefined ? {} : { reasoning: thinkingLevel }), signal }).result();
}

describe("actual registered Z.AI global standard client through Worker", () => {
  for (const [index, model] of models.entries()) for (const simple of [false, true]) {
    const id = `m${index}_${simple ? "simple" : "stream"}`;
    it(`${model} preserves selected identity and registered replay simple=${simple}`, async () => {
      const result = await run(id, model, simple); expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      expect(result.usage).toMatchObject({ input: 44, cacheRead: 256, output: 20, totalTokens: 320 });
    });
  }
  for (const [id, model, reasoning] of [
    ["default53", "glm-5.3", "high"], ["default52", "glm-5.2", "high"], ["legacy_off", "glm-5.1", "off"],
    ["preserve", "glm-5.1", "low"], ["tool_off", "glm-5.3", "high"],
  ] as const) it(`applies the registered ${id} policy without rewriting the standard model`, async () => {
    const result = await run(id, model, true, reasoning); expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" }); expect(result.usage.totalTokens).toBe(320);
  });
  it("does not fabricate native usage for a complete stream without usage", async () => {
    const result = await run("no_usage"); expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" }); expect(result.usage.totalTokens).toBe(0);
  });
  for (const id of ["http_error", "embedded_error"]) it(`returns ${id} without another region or product attempt`, async () => {
    const result = await run(id); expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
  });
  it("denies invalid caller, CN policy, missing grant, model mismatch and unknown-dollar price before egress", async () => {
    for (const [id, invalid] of [["m0_simple", true], ["foreign", false], ["missing", false], ["foreign_model", false], ["unpriced", false]] as const) {
      const result = await run(id, models[0], true, "high", invalid); expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
    }
  });
  it("preserves caller pre-abort without dispatch or fallback", async () => {
    const controller = new AbortController(); controller.abort(new DOMException("Synthetic caller cancellation", "AbortError"));
    const result = await run("aborted", models[0], true, "high", false, controller.signal);
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe(controller.signal.reason.message); expect(result.content).toEqual([]);
  });
});
