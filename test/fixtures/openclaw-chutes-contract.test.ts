import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { buildStaticChutesProvider } from "./provider-catalog.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["deepseek-ai/DeepSeek-V3.2-TEE", "moonshotai/Kimi-K2.6-TEE", "zai-org/GLM-5.2-TEE", "Qwen/Qwen3.6-27B-TEE", "Qwen/Qwen3.5-397B-A17B-TEE"];
const key = (id: string) => `clawrouter-live-chutes_${id}-fixture-secret`;
function selected(modelId: string) {
  // This is the actual native plugin's finite model/compatibility builder with
  // an explicitly configured proxy base, not a substitute catalog parser.
  const config = buildStaticChutesProvider(), row = config.models.find(row => row.id === modelId);
  expect(row).toBeDefined(); expect(row!.compat?.supportsUsageInStreaming).toBe(false);
  return { ...row, id: modelId, provider: "chutes", api: config.api, baseUrl: origin + "/v1/native/chutes" } as Model<"openai-completions">;
}
function context(id: string, modelId: string): Context {
  return { systemPrompt: "Synthetic instructions", messages: [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "call_fixture", name: "lookup", arguments: {} }], api: "openai-completions", provider: "chutes", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "call_fixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: `fixture chutes_${id}`, timestamp: 4 },
  ], tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] } as Context;
}
function start(id: string, modelId = models[0], options: { apiKey?: string; signal?: AbortSignal } = {}) {
  return streamSimple(selected(modelId), context(id, modelId), { apiKey: options.apiKey ?? key(id), maxTokens: 128, signal: options.signal });
}

describe("actual native Chutes compatibility through the Worker", () => {
  it.each(models.map((model, i) => [model, `card${i}`]))("streams exact frozen %s with the native usage-request compatibility", async (model, id) => {
    const result = await start(id, model).result();
    expect(result.stopReason).toBe("stop"); expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it("uses observed counters when the native stream actually supplies them", async () => {
    const result = await start("observed").result();
    expect(result.stopReason).toBe("stop"); expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  it("does not substitute credentials for invalid keys, foreign policy or unknown-dollar admission", async () => {
    for (const [id, apiKey] of [["invalid", "clawrouter-live-chutes_card0-invalid"], ["foreign", key("foreign")], ["unpriced", key("unpriced")]]) {
      const result = await start(id, models[0], { apiKey }).result();
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
    }
  });
  it("retains an embedded error after partial output without replay", async () => {
    const result = await start("error").result(); expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("synthetic-upstream-error");
  });
  it("cancels the actual native SDK stream after partial delivery", async () => {
    const controller = new AbortController(), stream = start("cancel", models[0], { signal: controller.signal });
    for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
    const result = await stream.result(); expect(controller.signal.aborted).toBe(true); expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
