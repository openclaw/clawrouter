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
const modelId = "MiniMax-M3";
const key = (id: string) => `clawrouter-live-minimax_${id}-fixture-secret`;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

async function start(id: string, options: { simple?: boolean; image?: boolean; apiKey?: string; signal?: AbortSignal } = {}) {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("minimax");
  const result = await runProviderStaticCatalog({ provider });
  if (!result || !("providers" in result) || !result.providers?.minimax) {
    throw new Error("expected the registered MiniMax static catalog map");
  }
  expect(Object.keys(result.providers)).toEqual(["minimax"]);
  const catalog = result.providers.minimax;
  expect(catalog.api).toBe("anthropic-messages");
  const row = catalog.models.find(row => row.id === modelId);
  expect(row).toMatchObject({ id: modelId, contextWindow: 1_000_000, input: ["text", "image"], reasoning: true });
  // This frozen provider supports explicit Chat configuration. Its default
  // Anthropic API, OAuth portal, live discovery and video are separate contracts.
  const configured = { ...catalog, api: "openai-completions" as const, baseUrl: origin + "/v1/native/minimax/v1", models: [row!] };
  const config = { models: { providers: { minimax: configured } } };
  const model = { ...row, provider: "minimax", api: configured.api, baseUrl: configured.baseUrl } as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: model.api, provider: "minimax", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "text", text: `fixture minimax_${id}` }, ...(options.image ? [{ type: "image" as const, data: png, mimeType: "image/png" }] : [])], timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "minimax-m3-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "minimax", modelId, modelApi: model.api, model, runtimeHandle: { provider: "minimax", plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(true);
    return sanitizeSessionHistory({ provider: "minimax", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: `minimax-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "minimax", modelApi: model.api, modelId })]),
      messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const wrap = options.simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({ provider: "minimax", modelId, model, sourceApi: model.api, streamFn: streamSimple });
  expect(wrapped).toBeDefined();
  return wrapped!(model, context, { apiKey: options.apiKey ?? key(id), maxTokens: 128, signal: options.signal });
}

describe("actual registered MiniMax M3 explicit Chat client through Worker and SQLite", () => {
  it.each([false, true])("uses the actual stream hook and replay policy (simple=%s)", async simple => {
    const result = await (await start(simple ? "simple" : "stream", { simple })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it("serializes real inline PNG bytes through the registered image-capable card", async () => {
    const result = await (await start("image", { image: true })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it("uses terminal observed usage without treating client tariff hints as a reservation", async () => {
    const result = await (await start("observed")).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  it.each(["invalid", "foreign", "unpriced", "provider_budget", "model_denied"])("denies %s before upstream egress or ambient-key fallback", async id => {
    const result = await (await start(id, id === "invalid" ? { apiKey: "clawrouter-live-minimax_stream-invalid" } : {})).result();
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
