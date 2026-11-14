import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["abliterated-model-large-flash", "abliterated-model-large-v2", "abliterated-model", "abliterated-model-large"];
const efforts = [["off", "low", "high", "max"], ["off", "low", "high", "max"], ["off", "minimal", "low", "medium", "high", "xhigh", "max"], ["off", "high", "max"]] as const;
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const key = (id: string) => `clawrouter-live-abliteration_${id}-fixture-secret`;

// Observe the shipped guard and its original products. Do not stub global fetch:
// that changes the pinned client's SSRF/runtime-dispatcher selection.
const originalGuard = guardedTransport.fetchWithProviderHttpGuard;
const acquisitions: Array<{
  returned: ReturnType<typeof originalGuard>;
  released: Promise<void>;
  releaseCalls: number;
  releasePending: Promise<void>[];
  body?: ReadableStream<Uint8Array> | null;
  readers: Array<{ reader: ReadableStreamDefaultReader<Uint8Array>; pending: Promise<unknown>[]; unlocked: boolean }>;
}> = [];
const observationErrors: unknown[] = [];
let started = 0;

beforeEach(() => {
  acquisitions.length = 0; observationErrors.length = 0; started = 0;
  vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function (options) {
    const returned = Reflect.apply(originalGuard, this, [options]);
    let released!: () => void;
    const row: (typeof acquisitions)[number] = { returned, released: new Promise(resolve => { released = resolve; }), releaseCalls: 0, releasePending: [], readers: [] };
    acquisitions.push(row);
    // Register before returning the same promise, so instrumentation precedes the
    // consumer's continuation without replacing its response or transport.
    void returned.then(result => {
      try {
        row.body = result.response.body;
        const release = result.release;
        vi.spyOn(result, "release").mockImplementation(function () {
          row.releaseCalls++;
          const pending = Reflect.apply(release, this, []);
          row.releasePending.push(pending);
          void pending.then(released, released);
          return pending;
        });
        if (row.body) {
          const getReader = row.body.getReader;
          vi.spyOn(row.body, "getReader").mockImplementation(function (...args) {
            const reader = Reflect.apply(getReader, this, args) as ReadableStreamDefaultReader<Uint8Array>;
            const observed = { reader, pending: [] as Promise<unknown>[], unlocked: false };
            row.readers.push(observed);
            for (const name of ["read", "cancel"] as const) {
              const original = reader[name];
              vi.spyOn(reader, name).mockImplementation(function (...operands: unknown[]) {
                const pending = Reflect.apply(original, this, operands);
                observed.pending.push(pending);
                // Preserve rejection for the real caller while keeping the retained
                // original promise observed until the later allSettled join.
                void pending.then(() => {}, () => {});
                return pending;
              });
            }
            const unlock = reader.releaseLock;
            vi.spyOn(reader, "releaseLock").mockImplementation(function () {
              const result = Reflect.apply(unlock, this, []);
              observed.unlocked = true;
              return result;
            });
            return reader;
          });
        }
      } catch (error) { observationErrors.push(error); }
    }, () => { released(); });
    return returned;
  });
});

afterEach(async () => {
  try {
    await Promise.allSettled(acquisitions.map(row => row.returned));
    const releases = await Promise.all(acquisitions.map(async row => {
      await row.released;
      const results = await Promise.allSettled(row.releasePending);
      await Promise.all(row.readers.map(async observed => {
        await Promise.allSettled(observed.pending);
      }));
      return results;
    }));
    // Assertions follow every original join, so one failed observation cannot
    // skip retirement of a later acquisition in the four-denial case.
    expect(releases.flat().every(result => result.status === "fulfilled")).toBe(true);
    for (const row of acquisitions) {
      expect(row.releaseCalls).toBeGreaterThan(0);
      expect(row.readers.length).toBeGreaterThan(0);
      expect(row.readers.every(observed => observed.unlocked)).toBe(true);
      expect(row.body?.locked).toBe(false);
    }
    expect(observationErrors).toEqual([]);
    expect(acquisitions).toHaveLength(started);
  } finally { vi.restoreAllMocks(); }
});

async function start(id: string, modelId = models[0], options: { apiKey?: string; signal?: AbortSignal; simpleCompletion?: boolean; tools?: boolean; reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; image?: boolean } = {}) {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const row = catalog.models.find(row => row.id === modelId);
  expect(row).toBeDefined();
  expect(catalog.models.map(row => row.id)).toEqual(models);
  expect(row!.reasoning, modelId).toBe(true);
  const configured = { ...catalog, baseUrl: origin + "/v1/native/abliteration", models: [row!] };
  const config = { models: { providers: { abliteration: configured } } };
  const augmented = await provider.augmentModelCatalog?.({ config });
  expect(augmented).toEqual([expect.objectContaining({ id: modelId, provider: "abliteration" })]);
  const model = { ...row, provider: "abliteration", api: catalog.api, baseUrl: configured.baseUrl } as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Run the synthetic tool", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }],
      api: "openai-completions", provider: "abliteration", model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: options.image ? [{ type: "text", text: `fixture abliteration_${id}` }, { type: "image", data: image, mimeType: "image/png" }] : `fixture abliteration_${id}`, timestamp: 4 },
  ];
  // Execute the registered provider's actual replay policy and host sanitizer.
  // The proxy URL is explicit configuration; no live-discovery route is invented.
  const messages = await withOpenClawTestState({ label: "abliteration-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: "abliteration", modelId, modelApi: model.api, model, runtimeHandle: { provider: "abliteration", plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(false);
    return sanitizeSessionHistory({ provider: "abliteration", modelId, modelApi: model.api, model, policy, config, env: {},
      workspaceDir: state.workspaceDir, sessionId: `abliteration-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: "abliteration", modelApi: model.api, modelId })]),
      messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages),
    tools: options.tools === false ? undefined : [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const wrap = options.simpleCompletion ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({ provider: "abliteration", modelId, model, streamFn: streamSimple });
  expect(wrapped).toHaveProperty("preservesGenericCompatibility", true);
  started++;
  return wrapped!(model, context, { apiKey: options.apiKey ?? key(id), maxTokens: 128, reasoning: options.reasoning ?? "high", sessionId: "synthetic-cache-affinity", cacheRetention: "long", signal: options.signal });
}

describe("actual Abliteration static catalog and replay through Worker and SQLite", () => {
  it.each(efforts.flatMap((levels, modelIndex) => levels.map(reasoning => ({ modelIndex, reasoning }))))("streams frozen card $modelIndex with logical effort $reasoning", async ({ modelIndex, reasoning }) => {
    const result = await (await start(`m${modelIndex}_${reasoning}`, models[modelIndex], { reasoning })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  it("runs the actual simple-completion tool/reasoning hook", async () => {
    const result = await (await start("simple", models[0], { simpleCompletion: true })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it("retains prior tool history as text when no tools are declared", async () => {
    const result = await (await start("notools", models[0], { tools: false })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it.each([0, 2])("preserves actual image input on frozen card %i", async index => {
    const result = await (await start(`image${index}`, models[index], { image: true })).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  it("uses observed counters when supplied", async () => {
    const result = await (await start("observed")).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  it("keeps cached input and reasoning as subsets of native usage", async () => {
    const result = await (await start("cached")).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.usage).toMatchObject({ input: 60, output: 20, cacheRead: 40, totalTokens: 120 });
  });
  it("denies invalid, foreign, revoked and unknown-dollar calls without ambient-key fallback", async () => {
    for (const [id, apiKey] of [["invalid", "clawrouter-live-abliteration_m0_high-invalid"], ["foreign", key("foreign")], ["revoked", key("revoked")], ["unpriced", key("unpriced")]]) {
      const result = await (await start(id, models[0], { apiKey })).result();
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
    }
  });
  it("retains embedded errors without replay", async () => {
    const result = await (await start("error")).result();
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("synthetic-upstream-error");
  });
  it("cancels the actual native SDK stream after partial delivery", async () => {
    const controller = new AbortController(), stream = await start("cancel", models[0], { signal: controller.signal });
    for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
    const result = await stream.result(); expect(controller.signal.aborted).toBe(true); expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
