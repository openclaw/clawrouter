import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerProviderPlugin, requireRegisteredProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { buildQwenProvider } from "./api.js";
import plugin from "./index.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["qwen3.5-plus", "qwen3.6-flash", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max", "qwen3.8-flash", "MiniMax-M2.5", "glm-5", "kimi-k2.5"];
const blocked = ["qwen3-max-2026-01-23", "qwen3-coder-next", "qwen3-coder-plus", "glm-4.7"];
async function run(id: string, modelId = models[0], simple = true, reasoning: "off" | "low" | "medium" | "high" = "high", invalid = false, signal?: AbortSignal) {
  const { providers } = await registerProviderPlugin({ plugin, id: "qwen", name: "Qwen Provider" });
  const provider = requireRegisteredProvider(providers, "qwen"); expect(provider.id).toBe("qwen");
  // The actual explicit-base selector chooses the standard roster. The plugin's
  // default static catalog is Coding Plan and is not a global-standard oracle.
  const catalog = buildQwenProvider({ baseUrl: origin + "/v1/native/qwen" });
  const row = catalog.models.find(row => row.id === modelId); expect(row).toBeDefined();
  expect(provider.normalizeConfig?.({ providerConfig: catalog } as never)).toBeUndefined();
  const model = { ...row, api: catalog.api, provider: provider.id, baseUrl: catalog.baseUrl } as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Synthetic tool request", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }], api: model.api, provider: model.provider, model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: `synthetic qwen_${id}`, timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "qwen-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: model.provider, modelId, modelApi: model.api, model, runtimeHandle: { provider: model.provider, plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(["qwen3.5-plus", "glm-5", ...blocked].includes(modelId));
    return sanitizeSessionHistory({ provider: model.provider, modelId, modelApi: model.api, model, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: `qwen-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: model.provider, modelApi: model.api, modelId })]), messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const wrap = simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({ provider: model.provider, modelId, model, streamFn: simple ? streamSimple : stream, thinkingLevel: reasoning });
  expect(wrapped).toBeDefined();
  return wrapped!(model, context, { apiKey: invalid ? "clawrouter-live-qwen_m0_simple-invalid" : `clawrouter-live-qwen_${id}-fixture-secret`, maxTokens: 128, reasoning, signal }).result();
}

describe("actual registered Qwen global standard client through Worker", () => {
  for (const [index, model] of models.entries()) for (const simple of [false, true]) {
    const id = `m${index}_${simple ? "simple" : "stream"}`;
    it(`${model} preserves selected identity and registered replay simple=${simple}`, async () => {
      const result = await run(id, model, simple); expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      expect(result.usage).toMatchObject({ input: 44, cacheRead: 256, output: 20, totalTokens: 320 });
    });
  }
  for (const [id, model, reasoning] of [
    ["effort_low", "qwen3.8-max", "low"], ["effort_medium", "qwen3.8-flash", "medium"], ["effort_off", "qwen3.8-max", "off"],
  ] as const) it(`applies registered ${id} without borrowing Token Plan semantics`, async () => {
    const result = await run(id, model, true, reasoning); expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" }); expect(result.usage.totalTokens).toBe(320);
  });
  it("does not fabricate native usage for a complete stream without usage", async () => {
    const result = await run("no_usage", "qwen3.7-plus"); expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" }); expect(result.usage.totalTokens).toBe(0);
  });
  for (const id of ["http_error", "embedded_error"]) it(`returns ${id} without another region or product attempt`, async () => {
    const result = await run(id, "qwen3.7-plus"); expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
  });
  it("denies invalid caller, CN policy, missing grant, model mismatch and unknown-dollar price before egress", async () => {
    for (const [id, invalid] of [["m0_simple", true], ["foreign", false], ["missing", false], ["foreign_model", false], ["unpriced", false]] as const) {
      const result = await run(id, models[0], true, "high", invalid); expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
    }
  });
  for (const [index, model] of blocked.entries()) it(`keeps unqualified global ${model} closed despite a permitting policy`, async () => {
    const result = await run(`closed${index}`, model); expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("model_capability_unsupported"); expect(result.content).toEqual([]);
  });
  it("preserves caller pre-abort without dispatch or fallback", async () => {
    const controller = new AbortController(); controller.abort(new DOMException("Synthetic caller cancellation", "AbortError"));
    const result = await run("aborted", models[0], true, "high", false, controller.signal);
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe(controller.signal.reason.message); expect(result.content).toEqual([]);
  });
});
