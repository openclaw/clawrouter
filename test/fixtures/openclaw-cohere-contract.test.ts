import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { buildClawRouterProviderConfig, normalizeClawRouterResolvedModel } from "./provider-catalog.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const modelId = "cohere/command-a-plus-05-2026";
const nativeFetch = globalThis.fetch;
const key = (id: string) => `clawrouter-live-${id}-fixture-secret`;

beforeEach(() => {
  clearLiveCatalogCacheForTests();
  // Only the isolated loopback fixture is trusted here. This does not certify
  // production private-network policy; all catalog/parser/SDK code stays real.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe(origin);
    return nativeFetch(request);
  });
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async ({ url, init }) => {
    expect(String(url)).toBe(`${origin}/v1/catalog`);
    return { response: await fetch(url, init), finalUrl: String(url), release: async () => undefined };
  });
});
afterEach(() => { vi.restoreAllMocks(); clearLiveCatalogCacheForTests(); });

async function selected(id = "cohere_stream") {
  const config = await buildClawRouterProviderConfig({ baseUrl: `${origin}/v1`, apiKey: key(id) });
  const row = config.models.find(row => row.id === modelId)!;
  expect(row).toBeDefined();
  const normalized = normalizeClawRouterResolvedModel({ ...row, provider: "clawrouter" } as ProviderRuntimeModel)!;
  const model = { ...row, ...normalized, provider: "clawrouter" } as Model<"openai-completions">;
  expect(model.api).toBe("openai-completions");
  expect(model.baseUrl).toBe(`${origin}/v1/native/cohere/compatibility/v1`);
  return model;
}
function context(id: string): Context {
  return {
    systemPrompt: "Synthetic instructions",
    messages: [
      { role: "user", content: "Run the synthetic tool", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_fixture", name: "lookup", arguments: {} }], api: "openai-completions", provider: "clawrouter", model: modelId,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "call_fixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
      { role: "user", content: `fixture ${id}`, timestamp: 4 },
    ],
    tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }],
  } as Context;
}
async function start(id: string, hook: "wrapStreamFn" | "wrapSimpleCompletionStreamFn" = "wrapStreamFn", options: { apiKey?: string; signal?: AbortSignal } = {}) {
  const model = await selected();
  const provider = await registerSingleProviderPlugin(plugin);
  const streamFn = provider[hook]?.({ provider: "clawrouter", modelId, model, streamFn: streamSimple });
  expect(streamFn).toBeDefined();
  return streamFn!(model, context(id), { apiKey: options.apiKey ?? key(id), maxTokens: 128, signal: options.signal });
}

describe("actual Cohere compatibility client through workerd", () => {
  it.each([["cohere_stream", "wrapStreamFn"], ["cohere_simple", "wrapSimpleCompletionStreamFn"]] as const)("streams %s through %s with actual tool replay and token usage", async (id, hook) => {
    const result = await (await start(id, hook)).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });

  it("re-admits a cached model against invalid keys, foreign grants and unknown-price hard budgets", async () => {
    for (const [id, apiKey] of [["invalid", "clawrouter-live-cohere_stream-invalid"], ["cohere_foreign", key("cohere_foreign")], ["cohere_unpriced", key("cohere_unpriced")]]) {
      const result = await (await start(id, "wrapStreamFn", { apiKey })).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
    }
  });

  it("retains a late upstream error after partial delivery without replay or fabricated success", async () => {
    const result = await (await start("cohere_error")).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("synthetic-upstream-error");
  });

  it("cancels the actual SDK stream after partial delivery without claiming a free request", async () => {
    const controller = new AbortController();
    const stream = await start("cohere_cancel", "wrapStreamFn", { signal: controller.signal });
    for await (const event of stream) {
      if (event.type === "text_delta") { controller.abort(); break; }
    }
    const result = await stream.result();
    expect(controller.signal.aborted).toBe(true);
    expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
