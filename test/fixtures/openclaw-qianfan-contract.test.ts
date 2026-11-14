import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildLiveModelProviderConfig, clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["deepseek-v4-pro", "ernie-5.1", "ernie-5.0", "deepseek-v3.2", "ernie-5.0-thinking-preview"];
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const key = (id: string) => `clawrouter-live-qianfan_${id}-fixture-secret`;

afterEach(() => clearLiveCatalogCacheForTests());

async function start(id: string, modelId = models[0], options: { apiKey?: string; signal?: AbortSignal; reasoning?: "high" | "max"; image?: boolean; discovered?: Model<"openai-completions"> } = {}) {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const row = catalog.models.find(row => row.id === modelId);
  expect(row).toBeDefined();
  const configured = { ...catalog, baseUrl: origin + "/v1/native/qianfan", models: [row!] };
  const config = { models: { providers: { qianfan: configured } } };
  expect(row!.reasoning).toBe(![models[1], models[3]].includes(modelId));
  const model = options.discovered ?? { ...row, provider: "qianfan", api: catalog.api, baseUrl: configured.baseUrl } as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: "openai-completions", provider: "qianfan", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: options.image ? [{ type: "text", text: `fixture qianfan_${id}` }, { type: "image", data: image, mimeType: "image/png" }] : `fixture qianfan_${id}`, timestamp: 4 },
  ];
  // Execute the registered provider's actual replay policy and host sanitizer.
  // The proxy URL is explicit configuration; no live-discovery route is invented.
  const messages = await withOpenClawTestState({ label: "qianfan-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "qianfan", modelId, modelApi: model.api, model, runtimeHandle: { provider: "qianfan", plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe([models[1], models[3]].includes(modelId));
    return sanitizeSessionHistory({ provider: "qianfan", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: `qianfan-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "qianfan", modelApi: model.api, modelId })]),
      messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  return streamSimple(model, context, { apiKey: options.apiKey ?? key(id), maxTokens: 128, reasoning: options.reasoning, signal: options.signal });
}

async function discovered(id: string) {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  return buildLiveModelProviderConfig({ providerId: "qianfan", endpoint: origin + "/v1/native/qianfan/models",
    apiKey: key(id), discoveryMode: "strict", models: catalog.models,
    providerConfig: { ...catalog, baseUrl: origin + "/v1/native/qianfan" },
    policy: { allowPrivateNetwork: true }, requireHttps: false });
}

describe("actual Qianfan configured catalog and replay through Worker and SQLite", () => {
  it.each(models.map((model, i) => [model, `card${i}`]))("streams frozen %s through the registered replay policy", async (model, id) => {
    const result = await (await start(id, model)).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it.each(["high", "max"] as const)("serializes explicit V4 effort %s", async reasoning => {
    const result = await (await start(reasoning, models[0], { reasoning })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it.each([2, 4])("preserves actual image input on frozen card %i", async index => {
    const result = await (await start(`image${index}`, models[index], { image: true })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it("selects the public identity from strict keyed discovery before native dispatch", async () => {
    const catalog = await discovered("catalog");
    expect(catalog.models.map(row => row.id)).toEqual([models[0]]);
    const model = { ...catalog.models[0], provider: "qianfan", api: catalog.api, baseUrl: catalog.baseUrl } as Model<"openai-completions">;
    const result = await (await start("catalog", model.id, { discovered: model })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it("keeps strict empty and denied catalogs closed without static fallback", async () => {
    expect((await discovered("empty")).models).toEqual([]);
    await expect(discovered("foreign")).rejects.toThrow();
  });
  it("uses observed counters when actually supplied", async () => {
    const result = await (await start("observed")).result();
    expect(result.stopReason, result.errorMessage).toBe("stop"); expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  it("denies invalid credentials, foreign policy and unknown-dollar admission without key fallback", async () => {
    for (const [id, apiKey] of [["invalid", "clawrouter-live-qianfan_high-invalid"], ["foreign", key("foreign")], ["unpriced", key("unpriced")]]) {
      const result = await (await start(id, models[0], { apiKey })).result();
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
    }
  });
  it("retains embedded errors without replay", async () => {
    const result = await (await start("error")).result(); expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("synthetic-upstream-error");
  });
  it("cancels the actual native SDK stream after partial delivery", async () => {
    const controller = new AbortController(), stream = await start("cancel", models[0], { signal: controller.signal });
    for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
    const result = await stream.result(); expect(controller.signal.aborted).toBe(true); expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
