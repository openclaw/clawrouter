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
async function run(id: string, invalid = false) {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("stepfun");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const modelId = id.endsWith("35") ? "step-3.5-flash" : "step-3.7-flash";
  const row = catalog.models.find(row => row.id === modelId); expect(row).toBeDefined();
  const route = id.startsWith("cn") ? "stepfun-cn" : "stepfun";
  // Explicit standard-region proxy selection; this does not certify the native
  // profile wizard, automatic region detection or Step Plan entitlement.
  const model = { ...row, api: catalog.api, provider: "stepfun", baseUrl: `${origin}/v1/native/${route}` } as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Synthetic tool request", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }], api: model.api, provider: "stepfun", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "text", text: `stepfun_${id}` }, ...(id === "image" ? [{ type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", mimeType: "image/png" }] : [])], timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "stepfun-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "stepfun", modelId, modelApi: model.api, model, runtimeHandle: { provider: "stepfun", plugin: provider } });
    return sanitizeSessionHistory({ provider: "stepfun", modelId, modelApi: model.api, model, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: `stepfun-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "stepfun", modelApi: model.api, modelId })]), messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  return streamSimple(model, context, { apiKey: invalid ? "clawrouter-live-stepfun_global37-invalid" : `clawrouter-live-stepfun_${id}-fixture-secret`, maxTokens: 128, reasoning: id === "low" ? "low" : id === "max" ? "max" : "high" }).result();
}
describe("actual registered StepFun standard Chat through Worker", () => {
  it.each(["global37", "global35", "cn37", "cn35", "low", "max", "image"])("preserves exact region/model and native serializer for %s", async id => {
    const result = await run(id); expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage.totalTokens).toBe(320);
  });
  it("rejects invalid caller, foreign product and unknown-dollar cost with zero upstream calls", async () => {
    for (const [id, invalid] of [["global37", true], ["foreign", false], ["unpriced", false]] as const) {
      const result = await run(id, invalid); expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
    }
  });
});
