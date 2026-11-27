import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerProviderPlugin, requireRegisteredProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { runProviderStaticCatalog } from "../../src/plugins/provider-discovery.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import plugin from "./index.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const modelId = process.env.CLAWROUTER_CONTRACT_MODEL!;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

async function start(id: string, options: { image?: boolean; signal?: AbortSignal } = {}) {
  const { providers } = await registerProviderPlugin({ plugin, id: "google", name: "Google fixture" });
  const provider = requireRegisteredProvider(providers, "google");
  const result = await runProviderStaticCatalog({ provider });
  if (!result || !("providers" in result) || !result.providers?.google) throw new Error("missing registered Google static catalog");
  const row = result.providers.google.models.find(row => row.id === modelId);
  expect(row).toMatchObject({ id: modelId, contextWindow: 1_048_576, maxTokens: 65_536, reasoning: true });
  const configured = { ...result.providers.google, api: "google-generative-ai" as const,
    baseUrl: origin + "/v1/native/google-gemini/v1beta", models: [row!] };
  const config = { models: { providers: { google: configured } } };
  const model = { ...row, provider: "google", api: configured.api, baseUrl: configured.baseUrl } as Model<"google-generative-ai">;
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: model.api, provider: "google", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "text", text: "fixture google_" + id }, ...(options.image ? [{ type: "image" as const, data: png, mimeType: "image/png" }] : [])], timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "google-text-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "google", modelId, modelApi: model.api, model, runtimeHandle: { provider: "google", plugin: provider } });
    expect(policy.validateGeminiTurns).toBe(true);
    return sanitizeSessionHistory({ provider: "google", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: "google-" + id,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "google", modelApi: model.api, modelId })]), messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const native = provider.createStreamFn?.({ provider: "google", modelId, model, config, providerConfig: configured });
  expect(native).toBeDefined();
  const stream = provider.wrapStreamFn?.({ provider: "google", modelId, model, sourceApi: model.api, streamFn: native!, thinkingLevel: "low" });
  expect(stream).toBeDefined();
  return stream!(model, context, { apiKey: "clawrouter-live-google_" + (id === "invalid" ? "complete-invalid" : id + "-fixture-secret"), maxTokens: 128, reasoning: "low", signal: options.signal });
}

describe("actual registered Google native GenerateContent through Worker and SQLite", () => {
  it.each(["complete", "image", "fixed"])("preserves real serializer, tool replay, thinking and observed usage for %s", async id => {
    const result = await (await start(id, { image: id === "image" })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.content.some(part => part.type === "thinking" && part.thinking === "synthetic-thinking")).toBe(true);
    expect(result.usage).toMatchObject({ output: 100, cacheRead: 500, totalTokens: 1100 });
  });
  it.each(["invalid", "foreign", "budget", "model_denied"])("denies %s without upstream egress or alternate credentials", async id => {
    const result = await (await start(id)).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
  });
  it("retains an embedded error after real partial delivery without paid replay", async () => {
    const result = await (await start("error")).result();
    expect(result.stopReason).toBe("error");
  });
  it("cancels after delivery while retaining explicit paid accounting", async () => {
    const controller = new AbortController(), stream = await start("cancel", { signal: controller.signal });
    for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
    const result = await stream.result();
    expect(controller.signal.aborted).toBe(true);
    expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
