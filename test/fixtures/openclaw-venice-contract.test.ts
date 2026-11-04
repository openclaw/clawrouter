import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import { createHtmlEntityToolCallArgumentDecodingWrapper } from "../../src/agents/embedded-agent-runner/tool-call-argument-decoding.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { resolveToolCallArgumentsEncoding } from "../../src/plugins/provider-model-compat.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { buildStaticVeniceProvider } from "./provider-catalog.js";
import plugin from "./index.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["zai-org-glm-5-2", "zai-org-glm-4.7", "venice-uncensored-1-2", "google-gemma-4-31b-it", "kimi-k2-6", "deepseek-v3.2", "qwen3-235b-a22b-thinking-2507", "qwen3-coder-480b-a35b-instruct-turbo", "qwen3-vl-235b-a22b", "grok-4-5", "qwen-3-7-max", "qwen-3-7-plus", "claude-fable-5", "claude-opus-5", "claude-sonnet-4-6", "openai-gpt-56-sol", "zai-org-glm-4.6", "google-gemma-3-27b-it", "kimi-k2-5"];
const key = (id: string) => `clawrouter-live-venice_${id}-fixture-secret`;

async function start(id: string, modelId = models[0], options: { apiKey?: string; signal?: AbortSignal } = {}) {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = buildStaticVeniceProvider();
  const row = catalog.models.find(row => row.id === modelId);
  expect(row).toBeDefined();
  const configured = { ...catalog, baseUrl: origin + "/v1/native/venice", models: [row!] };
  const config = { models: { providers: { venice: configured } } };
  const original = { ...row, provider: "venice", api: catalog.api, baseUrl: configured.baseUrl } as Model<"openai-completions">;
  const model = provider.normalizeResolvedModel?.({ modelId, model: original }) ?? original;
  expect(model.compat?.supportsUsageInStreaming).toBe(false);
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: "openai-completions", provider: "venice", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: `fixture venice_${id}`, timestamp: 4 },
  ];
  // Execute the actual host replay-policy resolver and sanitizer for this provider.
  // The proxy URL is explicit configuration; no live-discovery route is invented.
  const messages = await withOpenClawTestState({ label: "venice-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "venice", modelId, modelApi: model.api, model, runtimeHandle: { provider: "venice", plugin: provider } });
    return sanitizeSessionHistory({ provider: "venice", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: `venice-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "venice", modelApi: model.api, modelId })]),
      messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: { value: { type: "string", minLength: 1 } } } }] };
  const wrapped = provider.wrapStreamFn?.({ provider: "venice", modelId, model, streamFn: streamSimple });
  expect(wrapped).toBeDefined();
  const hostStream = resolveToolCallArgumentsEncoding(model) === "html-entities"
    ? createHtmlEntityToolCallArgumentDecodingWrapper(wrapped!) : wrapped!;
  return hostStream(model, context, { apiKey: options.apiKey ?? key(id), maxTokens: 128, signal: options.signal });
}

describe("actual Venice configured catalog and registered stream through Worker and SQLite", () => {
  it.each(models.map((model, i) => [model, `card${i}`]))("streams exact frozen %s through the actual replay and stream hooks", async (model, id) => {
    const result = await (await start(id, model)).result();
    expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it("uses observed counters when actually supplied", async () => {
    const result = await (await start("observed")).result();
    expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  it("denies invalid credentials, foreign policy and unknown-dollar admission without key fallback", async () => {
    for (const [id, apiKey] of [["invalid", "clawrouter-live-venice_card0-invalid"], ["foreign", key("foreign")], ["unpriced", key("unpriced")]]) {
      const result = await (await start(id, models[0], { apiKey })).result();
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
    }
  });
  it("fails closed after an observed prefix without replay", async () => {
    const controller = new AbortController(), stream = await start("error", models[0], { signal: controller.signal });
    let delivered = "", released = false;
    try {
      for await (const event of stream) {
        if (event.type !== "text_delta") continue;
        delivered += event.delta;
        if (!released && delivered === "synthetic-answer") {
          expect((await fetch(origin + "/fixture/release-error", { method: "POST" })).status).toBe(204);
          released = true;
        }
      }
      const result = await stream.result();
      expect(released).toBe(true); expect(delivered).toBe("synthetic-answer");
      expect(result.stopReason).toBe("error");
      expect(JSON.stringify(result)).not.toContain("synthetic-upstream-error");
    } finally { controller.abort(); }
  });
  it.each(["foreign_model", "missing_model"])("withholds %s before native output", async id => {
    const result = await (await start(id)).result(); expect(result.stopReason).toBe("error");
    expect(JSON.stringify(result.content)).not.toContain("synthetic-answer");
  });
  it("executes actual Grok tool-schema and HTML-entity argument compatibility", async () => {
    const result = await (await start("groktool", "grok-4-5")).result();
    expect(result.stopReason, result.errorMessage).toBe("toolUse");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "lookup", arguments: { value: "A & B" } }));
    expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  it("cancels the actual native SDK stream after partial delivery", async () => {
    const controller = new AbortController(), stream = await start("cancel", models[0], { signal: controller.signal });
    for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
    const result = await stream.result(); expect(controller.signal.aborted).toBe(true); expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
