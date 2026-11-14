import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerProviderPlugin, requireRegisteredProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
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
const models = ["mimo-v2.6-pro", "mimo-v2.6-flash"];
async function run(id: string, modelId = models[0], simple = true, reasoning: "off" | "high" | "max" = "high", invalid = false, signal?: AbortSignal) {
  const { providers } = await registerProviderPlugin({ plugin, id: "xiaomi", name: "Xiaomi Provider" });
  const provider = requireRegisteredProvider(providers, "xiaomi");
  expect(requireRegisteredProvider(providers, "xiaomi-token-plan").id).toBe("xiaomi-token-plan");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const row = catalog.models.find(row => row.id === modelId); expect(row).toBeDefined();
  const model = { ...row, api: catalog.api, provider: provider.id, baseUrl: origin + "/v1/native/xiaomi" } as Model<"openai-completions">;
  const normalized = provider.normalizeResolvedModel?.({ model });
  const selected = (normalized ?? model) as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Synthetic tool request", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }], api: selected.api, provider: selected.provider, model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: `synthetic xiaomi_${id}`, timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "xiaomi-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: selected.provider, modelId, modelApi: selected.api, model: selected, runtimeHandle: { provider: selected.provider, plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(false);
    return sanitizeSessionHistory({ provider: selected.provider, modelId, modelApi: selected.api, model: selected, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: `xiaomi-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: selected.provider, modelApi: selected.api, modelId })]), messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const wrapped = provider.wrapStreamFn?.({ provider: selected.provider, modelId, model: selected, streamFn: simple ? streamSimple : stream, thinkingLevel: reasoning });
  expect(wrapped).toBeDefined();
  return wrapped!(selected, context, { apiKey: invalid ? "clawrouter-live-xiaomi_pro-invalid" : `clawrouter-live-xiaomi_${id}-fixture-secret`, maxTokens: 128, reasoning, signal }).result();
}

describe("actual registered Xiaomi PAYG client through Worker", () => {
  for (const [index, model] of models.entries()) for (const simple of [false, true]) {
    const id = `${index ? "flash" : "pro"}_${simple ? "simple" : "stream"}`;
    it(`${model} preserves registered replay and native stream simple=${simple}`, async () => {
      const result = await run(id, model, simple);
      expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      expect(result.usage).toMatchObject({ input: 44, cacheRead: 256, output: 20, totalTokens: 320 });
    });
  }
  for (const reasoning of ["off", "max"] as const) it(`applies the actual ${reasoning} thinking wrapper without changing the selected card`, async () => {
    const result = await run(reasoning, models[0], true, reasoning);
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage.totalTokens).toBe(320);
  });
  it("keeps successful missing usage separate from measured tokens", async () => {
    const result = await run("no_usage");
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage.totalTokens).toBe(0);
  });
  for (const id of ["http_error", "embedded_error"]) it(`returns ${id} without a credential or product fallback`, async () => {
    const result = await run(id); expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
  });
  it("denies invalid caller, TokenPlan policy, missing grant, retired cards and unknown dollars before egress", async () => {
    for (const [id, model, invalid] of [
      ["pro", models[0], true], ["foreign", models[0], false], ["missing", models[0], false], ["unpriced", models[0], false],
      ["retired_pro", "mimo-v2.5-pro", false], ["retired", "mimo-v2.5", false],
    ] as const) {
      const result = await run(id, model, true, "high", invalid); expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
    }
  });
  it("preserves caller pre-abort without upstream dispatch", async () => {
    const controller = new AbortController(); controller.abort(new DOMException("Synthetic caller cancellation", "AbortError"));
    const result = await run("aborted", models[0], true, "high", false, controller.signal);
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe(controller.signal.reason.message); expect(result.content).toEqual([]);
  });
});
