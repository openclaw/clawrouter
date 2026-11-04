import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildLiveModelProviderConfig, clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./index.js";
import { buildLongCatProvider } from "./provider-catalog.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const modelId = "LongCat-2.0";
const key = (id: string) => `clawrouter-live-longcat_${id}-fixture-secret`;
afterEach(() => clearLiveCatalogCacheForTests());

function selected() {
  const config = buildLongCatProvider(), row = config.models.find(row => row.id === modelId);
  expect(row).toBeDefined();
  expect(row!.compat).toMatchObject({ supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    supportsUsageInStreaming: false, supportsStrictMode: false, maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true });
  return { ...row, provider: "longcat", api: config.api, baseUrl: origin + "/v1/native/longcat" } as Model<"openai-completions">;
}
async function discovered(id: string) {
  const config = buildLongCatProvider();
  return buildLiveModelProviderConfig({ providerId: "longcat", endpoint: origin + "/v1/native/longcat/models",
    apiKey: key(id), discoveryMode: "strict", models: config.models, providerConfig: { ...config, baseUrl: origin + "/v1/native/longcat" },
    policy: { allowPrivateNetwork: true }, requireHttps: false });
}
function context(id: string): Context {
  return { systemPrompt: "Synthetic instructions", messages: [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "call_fixture", name: "lookup", arguments: {} }],
      api: "openai-completions", provider: "longcat", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "call_fixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: `fixture longcat_${id}`, timestamp: 4 },
  ], tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] } as Context;
}
async function start(id: string, options: { apiKey?: string; signal?: AbortSignal; thinkingLevel?: "high" | "off"; model?: Model<"openai-completions"> } = {}) {
  const model = options.model ?? selected(), provider = await registerSingleProviderPlugin(plugin);
  const wrapped = provider.wrapStreamFn?.({ provider: "longcat", modelId, model, streamFn: streamSimple, thinkingLevel: options.thinkingLevel });
  expect(wrapped).toBeDefined();
  return wrapped!(model, context(id), { apiKey: options.apiKey ?? key(id), maxTokens: 128, reasoning: "high", signal: options.signal });
}

describe("actual LongCat native client through Worker and SQLite", () => {
  it("selects the frozen identity through actual strict keyed discovery before streaming", async () => {
    const config = await discovered("catalog");
    expect(config.models.map(row => row.id)).toEqual([modelId]);
    const model = { ...config.models[0], provider: "longcat", api: config.api, baseUrl: config.baseUrl } as Model<"openai-completions">;
    const result = await (await start("catalog", { model })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it("keeps strict empty and denied catalogs closed without static or anonymous fallback", async () => {
    expect((await discovered("empty")).models).toEqual([]);
    await expect(discovered("foreign")).rejects.toThrow();
  });
  it.each([undefined, "high", "off"] as const)("runs the registered thinking wrapper for %s", async thinkingLevel => {
    const result = await (await start(thinkingLevel ?? "default", { thinkingLevel })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it("uses token counters only when actually supplied", async () => {
    const result = await (await start("observed")).result();
    expect(result.stopReason).toBe("stop"); expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  it("does not substitute credentials for invalid keys, foreign grants or unknown-dollar admission", async () => {
    for (const [id, apiKey] of [["invalid", "clawrouter-live-longcat_default-invalid"], ["foreign", key("foreign")], ["unpriced", key("unpriced")]]) {
      const result = await (await start(id, { apiKey })).result();
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
    }
  });
  it("retains an embedded error after partial output without replay", async () => {
    const result = await (await start("error")).result(); expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("synthetic-upstream-error");
  });
  it("cancels the actual native SDK stream after partial delivery", async () => {
    const controller = new AbortController(), stream = await start("cancel", { signal: controller.signal });
    for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
    const result = await stream.result(); expect(controller.signal.aborted).toBe(true); expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
