import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
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
const cards = { preview: "hy3-preview", hy3: "hy3", hy4: "hy4-preview", off: "hy3", low: "hy3" };
async function run(id: string, invalid = false, signal?: AbortSignal) {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("tencent-tokenhub");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const modelId = cards[id as keyof typeof cards] ?? "hy3";
  const row = catalog.models.find(row => row.id === modelId); expect(row).toBeDefined();
  const model = { ...row, api: catalog.api, provider: "tencent-tokenhub", baseUrl: origin + "/v1/native/tencent-tokenhub" } as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Synthetic tool request", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }], api: model.api, provider: model.provider, model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: `synthetic tencent_${id}`, timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "tencent-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: model.provider, modelId, modelApi: model.api, model, runtimeHandle: { provider: model.provider, plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(false);
    return sanitizeSessionHistory({ provider: model.provider, modelId, modelApi: model.api, model, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: `tencent-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: model.provider, modelApi: model.api, modelId })]), messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const wrapped = provider.wrapStreamFn?.({ provider: model.provider, modelId, model, streamFn: streamSimple });
  expect(wrapped).toBeDefined();
  return wrapped!(model, context, { apiKey: invalid ? "clawrouter-live-tencent_hy3-invalid" : `clawrouter-live-tencent_${id}-fixture-secret`, maxTokens: 128, reasoning: id === "off" ? "off" : id === "low" ? "low" : "high", signal }).result();
}
describe("actual registered Tencent TokenHub standard client through Worker", () => {
  it.each(Object.keys(cards))("preserves selected card and native wrapper for %s", async id => {
    const result = await run(id); expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage).toMatchObject({ input: 44, cacheRead: 256, output: 20, totalTokens: 320 });
  });
  it("denies invalid caller, TokenPlan-only scope, unknown-dollar pricing and pre-aborted calls without fallback", async () => {
    for (const [id, invalid] of [["hy3", true], ["foreign", false], ["unpriced", false]] as const) {
      const result = await run(id, invalid); expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
    }
    const controller = new AbortController();
    controller.abort(new DOMException("Synthetic caller cancellation", "AbortError"));
    const canceled = await run("aborted", false, controller.signal);
    // The actual host rejects before provider dispatch and retains this exact cause.
    expect(canceled.stopReason).toBe("error");
    expect(canceled.errorMessage).toBe(controller.signal.reason.message);
    expect(canceled.content).toEqual([]);
  });
});
