import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectEmbeddedAgentStream } from "../../src/agents/embedded-agent-runner/stream-resolution.js";
import plugin from "./index.js";
import { buildClawRouterProviderConfig } from "./provider-catalog.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const modelId = "volcengine/doubao-seed-2-1-pro-260915";
const key = (id: string) => `clawrouter-live-owned_http_${id}-fixture-secret`;
const nativeFetch = globalThis.fetch;

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  // Only catalog SSRF admission is adapted to the isolated fixture socket.
  // The catalog parser, registered plugin and unified HTTP transport are real.
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async ({ url, init }) => {
    expect(String(url)).toBe(`${origin}/v1/catalog`);
    return { response: await nativeFetch(url, init), finalUrl: String(url), release: async () => undefined };
  });
});
afterEach(() => { vi.restoreAllMocks(); clearLiveCatalogCacheForTests(); });

async function configured(id: string, selectedModel = modelId) {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("clawrouter");
  const config = await buildClawRouterProviderConfig({ apiKey: key(id), baseUrl: origin });
  const row = config.models.find(row => row.id === selectedModel);
  expect(row).toBeDefined();
  const original = { ...row, provider: "clawrouter" } as Model<"openai-completions">;
  const model = (provider.normalizeResolvedModel?.({ model: original }) ?? original) as typeof original;
  expect(model).toMatchObject({ id: selectedModel, api: "openai-completions", baseUrl: `${origin}/v1` });
  expect(model.baseUrl).not.toContain("/native/");
  return { provider, model };
}

function start(selected: Awaited<ReturnType<typeof configured>>, id: string,
  options: { apiKey?: string; signal?: AbortSignal; tools?: boolean; flatEscaped?: boolean } = {}) {
  const { provider, model } = selected;
  const apiKey = options.apiKey ?? key(id);
  const host = selectEmbeddedAgentStream({ llmRuntime: defaultLlmRuntime, currentStreamFn: streamSimple,
    model, sessionId: `owned-http-${id}`, resolvedApiKey: apiKey, signal: options.signal });
  expect(host.strategy).toBe("boundary-aware:openai-completions");
  const wrapped = provider.wrapStreamFn?.({ provider: "clawrouter", modelId: model.id, model, streamFn: host.streamFn });
  expect(wrapped).toBeDefined();
  const context: Context = { systemPrompt: "Synthetic instructions",
    messages: [{ role: "user", content: options.flatEscaped ? "fixture-owned-flat-escaped" : `fixture owned_http_${id}`, timestamp: 1 }],
    ...(options.tools ? { tools: [{ name: "lookup", description: "Synthetic lookup",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] } : {}) };
  return host.wrapApiKey(wrapped!)(model, context, { apiKey, maxTokens: 128, signal: options.signal });
}

describe("actual registered OpenClaw unified Chat through the private owned HTTP entry", () => {
  it("streams Venice through the actual configured UNIFIED boundary on cold and covered requests", async () => {
    const selected = await configured("venice", "venice/zai-org-glm-5-2");
    for (let invocation = 0; invocation < 2; invocation++) {
      const result = await start(selected, "venice").result();
      expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
    }
  });
  it("consumes a near-limit escaped Venice frame through the real unified client", async () => {
    const result = await start(await configured("venice", "venice/zai-org-glm-5-2"), "venice", { flatEscaped: true }).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  it("delivers cold and covered-hit requests through the same configured unified route", async () => {
    const selected = await configured("chat");
    for (let invocation = 0; invocation < 2; invocation++) {
      const result = await start(selected, "chat").result();
      expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
    }
  });
  it("preserves streamed tool arguments and actual usage", async () => {
    const result = await start(await configured("tool"), "tool", { tools: true }).result();
    expect(result.stopReason, result.errorMessage).toBe("toolUse");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "lookup", arguments: { value: "fixture" } }));
    expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  it("does not replace a wrong selected proxy secret with ambient credentials", async () => {
    const result = await start(await configured("chat"), "chat", { apiKey: "clawrouter-live-owned_http_chat-invalid" }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
  });
  it("preserves the upstream rejection without replay", async () => {
    const result = await start(await configured("error"), "error").result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
  });
  it("aborts after an actual delivered prefix", async () => {
    const controller = new AbortController();
    const stream = start(await configured("abort"), "abort", { signal: controller.signal });
    let received = false, hasPrimary = false, primary: unknown;
    try {
      for await (const event of stream) if (event.type === "text_delta") { received = true; controller.abort(); break; }
    } catch (error) { hasPrimary = true; primary = error; }
    const failures: unknown[] = [];
    try { controller.abort(); } catch (error) { failures.push(error); }
    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try { result = await stream.result(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "owned HTTP client retirement");
    if (hasPrimary) throw primary;
    expect(received).toBe(true);
    expect(["aborted", "error"]).toContain(result!.stopReason);
  });
});
