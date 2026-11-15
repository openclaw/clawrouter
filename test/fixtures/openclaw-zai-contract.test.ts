import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin, registerProviderPlugin, requireRegisteredProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { describe, expect, it as productIt, vi } from "vitest";
import * as transport from "../../src/agents/provider-transport-dispatcher-pool.js";
import * as guard from "../../src/infra/net/fetch-guard.js";
import routerPlugin from "../clawrouter/index.js";
import { types as nodeTypes } from "node:util";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5-turbo", "glm-5v-turbo", "glm-5.1"];

// BEGIN ZAI CONTRACT SUPPORT
// The outer fixture extracts these same functions for its focused regressions.
function regionalCases() {
  const regions = [
    { provider: "zai-cn", binding: "ZAI_CN_API_KEY", base: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5-turbo", "glm-5v-turbo"] },
    { provider: "zai-coding-global", binding: "ZAI_CODING_GLOBAL_API_KEY", base: "https://api.z.ai/api/coding/paas/v4", models: ["glm-5.3", "glm-5.3-flash"] },
    { provider: "zai-coding-cn", binding: "ZAI_CODING_CN_API_KEY", base: "https://open.bigmodel.cn/api/coding/paas/v4", models: ["glm-5.3", "glm-5.3-flash"] },
  ];
  return regions.flatMap((region, r) => region.models.flatMap((model, m) => [
    ...[false, true].flatMap(simple => ["environment", "grant"].map(credential => ({ ...region, model, id: `r${r}m${m}_${simple ? "simple" : "stream"}_${credential}`, simple, credential, route: "native", outcome: "success" }))),
    { ...region, model, id: `r${r}m${m}_catalog`, simple: false, credential: "grant", route: "catalog", outcome: "success" },
  ]));
}
function regionalNegativeCases() {
  return [0, 1, 2].flatMap(region => {
    const base = regionalCases().find(row => row.id === `r${region}m0_stream_grant`)!;
    return ["foreign", "missing", "disabled", "unpriced", "closed", "revoked", "http401", "http403", "http429", "embedded", "no_usage", "preabort", "cancel", "rotation"].map(outcome => ({ ...base, id: `r${region}_${outcome}`, outcome,
      model: outcome === "closed" ? region === 0 ? "glm-5.1" : "glm-5.2" : base.model }));
  });
}

function allFailures(primary: () => any, cleanups: Array<() => any>) {
  return (async () => {
    const failures: unknown[] = []; let value;
    try { value = await primary(); } catch (error) { failures.push(error); }
    for (const cleanup of cleanups) try { await cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "ZAI contract failure");
    return value;
  })();
}

function originalLifetime() {
  const operations: any[] = [], readers: any[] = [], acquisitions: any[] = [], restores: Array<() => void> = [];
  const bodies = new WeakMap(), acquired = new WeakSet(), failures: unknown[] = []; let sequence = 0;
  function record(kind: string, original: any, owner: any) {
    const entry = { kind, original, owner, state: "pending", reason: undefined as unknown, invoked: ++sequence, settled: 0 };
    operations.push(entry);
    Promise.resolve(original).then(() => { entry.state = "fulfilled"; entry.settled = ++sequence; }, error => { entry.state = "rejected"; entry.reason = error; entry.settled = ++sequence; });
    return original;
  }
  function invoke(kind: string, fn: (...args: any[]) => any, receiver: any, args: any[], owner: any) {
    try { return record(kind, Reflect.apply(fn, receiver, args), owner); }
    catch (error) { failures.push(error); throw error; }
  }
  function patch(target: any, key: string, replacement: any) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
    restores.push(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key]; });
  }
  function observeResponse(response: Response, owner: any) {
    const body = response.body;
    if (!body || bodies.has(body)) return;
    bodies.set(body, owner);
    const getReader = body.getReader, cancel = body.cancel;
    patch(body, "cancel", function (...args: any[]) { return invoke("cancel", cancel, this, args, owner); });
    patch(body, "getReader", function (...args: any[]) {
      const reader = Reflect.apply(getReader, this, args), entry = { reader, body, owner, eof: false, unlocks: 0, unlocked: 0 };
      readers.push(entry); record("closed", reader.closed, owner);
      const read = reader.read, cancelReader = reader.cancel, unlock = reader.releaseLock;
      patch(reader, "read", function (...operands: any[]) {
        const pending = invoke("read", read, this, operands, owner);
        pending.then((value: any) => { if (value.done) entry.eof = true; }, () => {}); return pending;
      });
      patch(reader, "cancel", function (...operands: any[]) { return invoke("cancel", cancelReader, this, operands, owner); });
      patch(reader, "releaseLock", function (...operands: any[]) {
        entry.unlocks++; try { const result = Reflect.apply(unlock, this, operands); entry.unlocked++; return result; }
        catch (error) { failures.push(error); throw error; }
      });
      return reader;
    });
  }
  function acquire(fn: (...args: any[]) => any, receiver: any, args: any[], owner: any) {
    let pending;
    try { pending = Reflect.apply(fn, receiver, args); } catch (error) { failures.push(error); throw error; }
    if (acquired.has(pending)) return pending;
    acquired.add(pending); record("acquire", pending, owner);
    const entry = { owner, released: 0, releaseFulfilled: 0 };
    acquisitions.push(entry);
    pending.then((result: any) => {
      try {
        observeResponse(result.response, owner);
        const release = result.release;
        patch(result, "release", function (...operands: any[]) {
          entry.released++;
          const original = invoke("release", release, this, operands, owner);
          Promise.resolve(original).then(() => { entry.releaseFulfilled++; }, () => {});
          return original;
        });
      } catch (error) { failures.push(error); }
    }, () => {});
    return pending;
  }
  async function join() {
    let seen = -1;
    while (seen !== operations.length) { seen = operations.length; await Promise.allSettled(operations.map(op => op.original)); }
    const errors = [...failures, ...operations.filter(op => op.state === "rejected").map(op => op.reason)];
    if (operations.some(op => op.state === "pending") || readers.some(row => row.unlocks !== row.unlocked || !row.unlocked || row.body.locked)
      || acquisitions.some(row => row.released !== row.releaseFulfilled || row.released === 0)) errors.push(new Error("Original lifetime is not retired"));
    if (errors.length) throw new AggregateError(errors, "Original lifetime failed");
  }
  function restore() { const errors: unknown[] = []; for (const undo of restores.splice(0).reverse()) try { undo(); } catch (error) { errors.push(error); } if (errors.length) throw new AggregateError(errors, "Observer restore failed"); }
  return { record, acquire, observeResponse, join, restore, operations, readers, acquisitions,
    summary: () => ({ operations: operations.length, pending: operations.filter(op => op.state === "pending").length, rejected: operations.filter(op => op.state === "rejected").length, readers: readers.length, releases: acquisitions.reduce((n, row) => n + row.releaseFulfilled, 0) }) };
}

function diagnosticProtocol(isProxy: (value: any) => boolean) {
  const phases = ["setup", "body", "catalog", "join", "restore", "worker", "helper", "receipt", "upstream", "sqlite", "dispose", "remove"];
  const prefix = "ZAI_CONTRACT_V1 ";
  function validate(value: any) {
    try {
      if (!value || typeof value !== "object" || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.values(descriptors).some(d => !("value" in d))) return null;
      const get = (key: string) => descriptors[key]?.value;
      if (Object.keys(descriptors).some(key => !["v", "layer", "caseId", "phase", "category", "pending", "rejected", "operations"].includes(key))) return null;
      if (get("v") !== 1 || !["sdk", "outer"].includes(get("layer")) || !phases.includes(get("phase"))
        || !["failure", "undefined", "null", "cleanup", "unknown"].includes(get("category"))) return null;
      const allowed = ["original", "regional", "control", ...Array.from({ length: 6 }, (_, i) => [`m${i}_stream`, `m${i}_simple`]).flat(),
        "default53", "default52", "legacy_off", "preserve", "tool_off", "no_usage", "http_error", "embedded_error", "foreign", "missing", "unpriced", "foreign_model", "aborted",
        ...[...regionalCases(), ...regionalNegativeCases()].map(row => row.id)];
      if (!allowed.includes(get("caseId"))) return null;
      const result: any = { v: 1, layer: get("layer"), caseId: get("caseId"), phase: get("phase"), category: get("category") };
      for (const key of ["pending", "rejected", "operations"]) if (descriptors[key]) {
        if (!Number.isSafeInteger(get(key)) || get(key) < 0 || get(key) > 4096) return null;
        result[key] = get(key);
      }
      return result;
    } catch { return null; }
  }
  function parse(text: unknown) {
    if (typeof text !== "string" || text.length > 2 * 1024 * 1024) return [];
    return text.split("\n").filter(line => line.startsWith(prefix) && line.length <= 768).flatMap(line => {
      try { const record = validate(JSON.parse(line.slice(prefix.length))); return record ? [record] : []; } catch { return []; }
    });
  }
  function emitter(write: (line: string) => unknown) {
    let bytes = 0, overflow = false; const seen = new Set();
    return (value: any) => {
      const record = validate(value); if (!record) return false;
      // Reserve three SDK and six outer slots. A noisy child cannot hide either Worker owner.
      const slot = record.layer === "sdk" ? (record.phase === "join" ? "sdk-join" : record.phase === "restore" ? "sdk-cleanup" : "sdk-body")
        : ["worker", "helper", "receipt", "upstream", "sqlite"].includes(record.phase) ? record.phase : "outer-cleanup";
      if (seen.has(slot)) { if (overflow) return false; overflow = true; value = { v: 1, layer: "outer", caseId: "control", phase: "receipt", category: "unknown" }; }
      else { seen.add(slot); value = record; }
      const command = "::error title=ZAI contract diagnostic::" + JSON.stringify(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A") + "\n";
      if (new TextEncoder().encode(command).length > 768 || bytes + command.length > 8192) return false;
      bytes += command.length; try { write(command); } catch { return false; } return true;
    };
  }
  return { validate, parse, emitter, prefix };
}
// END ZAI CONTRACT SUPPORT

const originalInferenceGuard = transport.fetchWithProviderHttpGuard;
const originalCatalogGuard = guard.fetchWithSsrFGuard;
let lifetime: ReturnType<typeof originalLifetime>;
let activeCase = "original";
const expectedRequests = new Map<string, { caseId: string; role: string; path: string; optional: boolean }>();
function bind(id: string, role: string, path: string, apiKey: string, optional = false) { expectedRequests.set(`${apiKey}:${path}`, { caseId: id, role, path, optional }); }
function observeGuard(original: any, receiver: any, args: any[]) {
  const options = args[0], url = new URL(options.url), headers = new Headers(options.init?.headers);
  const expected = expectedRequests.get(`${headers.get("authorization")?.replace(/^Bearer /, "")}:${url.pathname}`);
  if (!expected || url.origin !== origin) throw new Error("Unexpected original SDK acquisition");
  return lifetime.acquire(original, receiver, args, expected);
}
function sdkFailure(phase: string, error: unknown) {
  try {
    const protocol = diagnosticProtocol(nodeTypes.isProxy), summary = lifetime?.summary();
    const record = protocol.validate({ v: 1, layer: "sdk", caseId: activeCase, phase, category: error === undefined ? "undefined" : error === null ? "null" : "failure", ...(summary ? { pending: summary.pending, rejected: summary.rejected, operations: summary.operations } : {}) });
    if (record) process.stdout.write(protocol.prefix + JSON.stringify(record) + "\n");
  } catch { /* Reporting never replaces an original failure. */ }
}
function it(title: string, body: () => unknown) {
  productIt(title, async () => {
    lifetime = originalLifetime(); expectedRequests.clear(); activeCase = "original";
    const stage = async (phase: string, run: () => any) => { try { return await run(); } catch (error) { sdkFailure(phase, error); throw error; } };
    await allFailures(async () => {
      await stage("setup", () => {
        clearLiveCatalogCacheForTests();
        vi.spyOn(transport, "fetchWithProviderHttpGuard").mockImplementation(function (...args) { return observeGuard(originalInferenceGuard, this, args); });
        vi.spyOn(guard, "fetchWithSsrFGuard").mockImplementation(function (...args) { return observeGuard(originalCatalogGuard, this, args); });
      });
      return stage("body", body);
    }, [() => stage("join", async () => {
      await lifetime.join();
      for (const request of expectedRequests.values()) if (!request.optional) expect(lifetime.acquisitions.some(row => row.owner === request)).toBe(true);
    }), () => stage("restore", () => lifetime.restore()),
      () => stage("restore", () => vi.restoreAllMocks()), () => stage("restore", () => clearLiveCatalogCacheForTests())]);
  });
}

async function run(id: string, modelId = models[0], simple = true, reasoning: "off" | "low" | "high" = "high", invalid = false, signal?: AbortSignal) {
  activeCase = id;
  bind(id, "chat", "/v1/native/zai/chat/completions", invalid ? "clawrouter-live-zai_m0_simple-invalid" : `clawrouter-live-zai_${id}-fixture-secret`, signal?.aborted === true);
  const provider = await registerSingleProviderPlugin(plugin); expect(provider.id).toBe("zai");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const row = catalog.models.find(row => row.id === modelId); expect(row).toBeDefined();
  const model = { ...row, api: catalog.api, provider: provider.id, baseUrl: origin + "/v1/native/zai" } as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Synthetic tool request", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }], api: model.api, provider: model.provider, model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: `synthetic zai_${id}`, timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "zai-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: model.provider, modelId, modelApi: model.api, model, runtimeHandle: { provider: model.provider, plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(false);
    return sanitizeSessionHistory({ provider: model.provider, modelId, modelApi: model.api, model, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: `zai-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: model.provider, modelApi: model.api, modelId })]), messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const thinkingLevel = id.startsWith("default") ? undefined : reasoning;
  const extraParams = provider.prepareExtraParams?.({ provider: model.provider, modelId,
    extraParams: id === "preserve" ? { preserveThinking: true } : id === "tool_off" ? { tool_stream: false } : {} } as never);
  expect(extraParams?.tool_stream).toBe(id === "tool_off" ? false : true);
  const wrap = simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({ provider: model.provider, modelId, model, streamFn: simple ? streamSimple : stream, thinkingLevel, extraParams });
  expect(wrapped).toBeDefined();
  return wrapped!(model, context, { apiKey: invalid ? "clawrouter-live-zai_m0_simple-invalid" : `clawrouter-live-zai_${id}-fixture-secret`, maxTokens: 128,
    ...(thinkingLevel === undefined ? {} : { reasoning: thinkingLevel }), signal }).result();
}

describe("actual registered Z.AI global standard client through Worker", () => {
  for (const [index, model] of models.entries()) for (const simple of [false, true]) {
    const id = `m${index}_${simple ? "simple" : "stream"}`;
    it(`${model} preserves selected identity and registered replay simple=${simple}`, async () => {
      const result = await run(id, model, simple); expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      expect(result.usage).toMatchObject({ input: 44, cacheRead: 256, output: 20, totalTokens: 320 });
    });
  }
  for (const [id, model, reasoning] of [
    ["default53", "glm-5.3", "high"], ["default52", "glm-5.2", "high"], ["legacy_off", "glm-5.1", "off"],
    ["preserve", "glm-5.1", "low"], ["tool_off", "glm-5.3", "high"],
  ] as const) it(`applies the registered ${id} policy without rewriting the standard model`, async () => {
    const result = await run(id, model, true, reasoning); expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" }); expect(result.usage.totalTokens).toBe(320);
  });
  it("does not fabricate native usage for a complete stream without usage", async () => {
    const result = await run("no_usage"); expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" }); expect(result.usage.totalTokens).toBe(0);
  });
  for (const id of ["http_error", "embedded_error"]) it(`returns ${id} without another region or product attempt`, async () => {
    const result = await run(id); expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
  });
  it("denies invalid caller, CN policy, missing grant, model mismatch and unknown-dollar price before egress", async () => {
    for (const [id, invalid] of [["m0_simple", true], ["foreign", false], ["missing", false], ["foreign_model", false], ["unpriced", false]] as const) {
      const result = await run(id, models[0], true, "high", invalid); expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
    }
  });
  it("preserves caller pre-abort without dispatch or fallback", async () => {
    const controller = new AbortController(); controller.abort(new DOMException("Synthetic caller cancellation", "AbortError"));
    const result = await run("aborted", models[0], true, "high", false, controller.signal);
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe(controller.signal.reason.message); expect(result.content).toEqual([]);
  });
});

async function regional(row: ReturnType<typeof regionalCases>[number], signal?: AbortSignal) {
  activeCase = row.id;
  const apiKey = `clawrouter-live-zai_${row.id}-fixture-secret`;
  let provider: any, model: Model<"openai-completions">;
  if (row.route === "native") {
    provider = await registerSingleProviderPlugin(plugin);
    expect(provider.id).toBe("zai");
    const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
    const selected = catalog.models.find(item => item.id === row.model);
    expect(selected).toBeDefined();
    model = { ...selected, api: catalog.api, provider: provider.id, baseUrl: origin + "/v1/native/" + row.provider } as Model<"openai-completions">;
  } else {
    const registered = await registerProviderPlugin({ plugin: routerPlugin, id: "clawrouter", name: "ClawRouter" });
    provider = requireRegisteredProvider(registered.providers, "clawrouter");
    bind(row.id, "catalog", "/v1/catalog", apiKey);
    const catalog = await withOpenClawTestState({ label: "zai-regional-discovery" }, async state => provider.catalog.run({
      config: { models: { providers: { clawrouter: { baseUrl: origin + "/v1", apiKey } } } }, env: {},
      agentDir: state.agentDir(), workspaceDir: state.workspaceDir,
      resolveProviderAuth: () => ({ apiKey, discoveryApiKey: apiKey, mode: "api_key", source: "profile" }),
    }));
    const selected = catalog.provider.models.find((item: any) => item.id === `${row.provider}/${row.model}`);
    expect(selected).toBeDefined(); expect(selected.api).toBe("openai-completions");
    const discovered = { ...selected, provider: "clawrouter" };
    model = (provider.normalizeResolvedModel?.({ model: discovered }) ?? discovered) as Model<"openai-completions">;
    expect(model.api).toBe("openai-completions"); expect(model.baseUrl).toBe(origin + "/v1");
    expect(model.id).toBe(`${row.provider}/${row.model}`);
  }
  const path = row.route === "native" ? `/v1/native/${row.provider}/chat/completions` : "/v1/chat/completions";
  bind(row.id, "chat", path, apiKey, signal?.aborted === true);
  const context: Context = { messages: [{ role: "user", content: `synthetic zai_${row.id}`, timestamp: 1 }] };
  const extraParams = row.route === "native" ? provider.prepareExtraParams?.({ provider: "zai", modelId: row.model, extraParams: {} }) : undefined;
  const wrapper = row.simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  expect(wrapper).toBeTypeOf("function");
  const wrapped = wrapper({ provider: model.provider, modelId: model.id, model, streamFn: row.simple ? streamSimple : stream, thinkingLevel: "high", extraParams });
  expect(wrapped).toBeTypeOf("function");
  return wrapped(model, context, { apiKey, maxTokens: 128, reasoning: "high", signal });
}

describe("registered regional Z.AI and discovered ClawRouter clients", () => {
  for (const row of regionalCases()) it(`${row.id} preserves the selected regional credential and identity`, async () => {
    const result = await (await regional(row)).result();
    expect(result.stopReason).toBe("stop"); expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage).toMatchObject({ input: 44, cacheRead: 256, output: 20, totalTokens: 320 });
  });
  for (const row of regionalNegativeCases()) it(`${row.id} preserves admission, outcome and original cancellation`, async () => {
    if (row.outcome === "preabort") {
      const controller = new AbortController(); controller.abort(new DOMException("Synthetic regional cancellation", "AbortError"));
      const result = await (await regional(row, controller.signal)).result(); expect(result.stopReason).toBe("error"); expect(result.content).toEqual([]); return;
    }
    if (row.outcome === "cancel") {
      const controller = new AbortController(), original = await regional(row, controller.signal); let partial = false;
      for await (const event of original) if (event.type === "text_delta") { partial = true; controller.abort(new DOMException("Synthetic regional cancellation", "AbortError")); break; }
      expect(partial).toBe(true); const result = await original.result(); expect(result.stopReason).toBe("aborted"); return;
    }
    if (row.outcome === "rotation") {
      expect((await (await regional(row)).result()).stopReason).toBe("stop");
      const response = await fetch(origin + "/fixture/rotate", { method: "POST", body: row.id }); await response.arrayBuffer(); expect(response.status).toBe(204);
      expect((await (await regional(row)).result()).stopReason).toBe("stop"); return;
    }
    const result = await (await regional(row)).result();
    expect(result.stopReason).toBe(row.outcome === "no_usage" ? "stop" : "error");
    if (row.outcome === "no_usage") { expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" }); expect(result.usage.totalTokens).toBe(0); }
  });
});
