import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerProviderPlugin, requireRegisteredProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import { ssrfPolicyFromHttpBaseUrlAllowedOrigin } from "openclaw/plugin-sdk/ssrf-runtime";
import * as transport from "../../src/agents/provider-transport-dispatcher-pool.js";
import { expect, it, vi } from "vitest";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { buildQwenProvider } from "./api.js";
import plugin from "./index.js";

const sourceHead = "d8bb939408aa4d2be7df0161748edb52ebf3b1fb";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
type Row = { id: string; provider: string; model: string; simple: boolean; mode: string };
type Operation = { kind: string; pending: Promise<unknown>; state: string; reason?: unknown };

// BEGIN shared fixture functions. The outer executes these exact functions after
// native TypeScript stripping, including their original-operation tests.
function qwenRegionCases(): Row[] {
  const cn = ["qwen3.5-plus", "qwen3.6-flash", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max", "qwen3.8-flash", "MiniMax-M2.5", "glm-5", "kimi-k2.5"];
  const coding = ["qwen3.7-plus", "qwen3.6-plus", "kimi-k2.5", "glm-5", "MiniMax-M2.5", "qwen3.5-plus"];
  return ["qwen-cn", "qwen-coding-global", "qwen-coding-cn"].flatMap((provider, region) => {
    const rows = (region === 0 ? cn : coding).flatMap((model, index) => [false, true].map(simple => ({
      id: `qr${region}_m${index}_${simple ? "simple" : "stream"}`, provider, model, simple, mode: "eof",
    })));
    for (const mode of ["preabort", "partial", "provider_error"]) for (const simple of [false, true]) {
      rows.push({ id: `qr${region}_${mode}_${simple ? "simple" : "stream"}`, provider, model: "qwen3.7-plus", simple, mode });
    }
    for (const mode of ["no_usage", "missing", "empty", "missing_grant", "foreign", "revoked", "rotation", "unpriced", "invalid_caller", "bad_model", ...(region ? ["invalid", "raw_c0", "raw_del", "whitespace"] : [])]) {
      rows.push({ id: `qr${region}_${mode}`, provider, model: mode === "bad_model" ? "qwen3-coder-plus" : "qwen3.7-plus", simple: true, mode });
    }
    if (region === 0) for (const mode of ["effort_off", "effort_low", "effort_medium"]) {
      rows.push({ id: `qr${region}_${mode}`, provider, model: "qwen3.8-max", simple: true, mode });
    }
    return rows;
  });
}

function createQwenLedger() {
  const operations: Operation[] = [], synchronous: unknown[] = [], restorers: Array<() => void> = [];
  const readers: Array<{ body: ReadableStream<Uint8Array>; unlocks: number; returns: number }> = [];
  function observe<T>(kind: string, pending: Promise<T>): Promise<T> {
    const operation: Operation = { kind, pending, state: "pending" }; operations.push(operation);
    void pending.then(() => { operation.state = "fulfilled"; }, reason => { operation.state = "rejected"; operation.reason = reason; });
    return pending;
  }
  function invoke<T>(kind: string, original: (...args: any[]) => Promise<T>, receiver: unknown, args: unknown[]): Promise<T> {
    try { return observe(kind, Reflect.apply(original, receiver, args)); }
    catch (error) { synchronous.push(error); throw error; }
  }
  function replace(target: any, name: string, next: any) {
    const original = target[name]; target[name] = next;
    restorers.push(() => { target[name] = original; }); return original;
  }
  function body(source: ReadableStream<Uint8Array> | null) {
    if (!source) return;
    const originalCancel = source.cancel;
    replace(source, "cancel", function (this: ReadableStream<Uint8Array>, ...args: unknown[]) {
      return invoke("body_cancel", originalCancel, this, args);
    });
    const getReader = source.getReader;
    replace(source, "getReader", function (this: ReadableStream<Uint8Array>, ...args: unknown[]) {
      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try { reader = Reflect.apply(getReader, this, args); } catch (error) { synchronous.push(error); throw error; }
      const row = { body: source, unlocks: 0, returns: 0 }; readers.push(row);
      observe("closed", reader.closed);
      for (const kind of ["read", "cancel"] as const) {
        const original = reader[kind];
        replace(reader, kind, function (this: ReadableStreamDefaultReader<Uint8Array>, ...operands: unknown[]) {
          return invoke(kind, original, this, operands);
        });
      }
      const release = reader.releaseLock;
      replace(reader, "releaseLock", function (this: ReadableStreamDefaultReader<Uint8Array>, ...operands: unknown[]) {
        row.unlocks++;
        try { const result = Reflect.apply(release, this, operands); row.returns++; return result; }
        catch (error) { synchronous.push(error); throw error; }
      });
      return reader;
    });
  }
  async function drain() {
    let at = 0;
    // Actual acquisitions/attachment reactions, closed and release lifetimes
    // remain in this list. New work registered while joining is included.
    while (at < operations.length) {
      const batch = operations.slice(at); at = operations.length;
      await Promise.allSettled(batch.map(operation => operation.pending));
    }
    const failures = [...synchronous, ...operations.filter(operation => operation.state !== "fulfilled").map(operation => operation.reason)];
    for (const row of readers) if (row.unlocks !== 1 || row.returns !== 1 || row.body.locked) failures.push(new Error("original reader remains owned"));
    if (failures.length) throw new AggregateError(failures, "original Qwen operations failed");
  }
  function restore() {
    const failures: unknown[] = [];
    for (const restore of restorers.reverse()) try { restore(); } catch (error) { failures.push(error); }
    restorers.length = 0;
    if (failures.length) throw new AggregateError(failures, "Qwen observer restoration failed");
  }
  return { observe, invoke, replace, body, drain, restore, operations, readers };
}
// END shared fixture functions.

const originalGuard = transport.fetchWithProviderHttpGuard;
for (const row of qwenRegionCases()) it(`${row.id}: registered Qwen ${row.mode}`, async () => {
  const ledger = createQwenLedger(), failures: unknown[] = [];
  let acquisitions = 0, releases = 0, partial = false;
  const controller = new AbortController();
  const key = `clawrouter-live-${row.id}-${row.mode === "invalid_caller" ? "invalid" : "fixture-secret"}`;
  const baseUrl = `${origin}/v1/native/${row.provider}`;
  vi.spyOn(transport, "fetchWithProviderHttpGuard").mockImplementation(function (options) {
    expect(String(options.url)).toBe(`${baseUrl}/chat/completions`); acquisitions++;
    const pending = ledger.invoke("acquisition", originalGuard, this, [{ ...options, policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(origin) }]);
    ledger.observe("acquisition_observer", pending.then(result => {
      ledger.body(result.response.body);
      const release = result.release;
      ledger.replace(result, "release", function (this: typeof result, ...args: unknown[]) {
        releases++; return ledger.invoke("release", release, this, args);
      });
    }));
    return pending;
  });
  try {
    expect(process.env.CLAWROUTER_SDK_SOURCE_HEAD).toBe(sourceHead);
    const { providers } = await registerProviderPlugin({ plugin, id: "qwen", name: "Qwen Provider" });
    const provider = requireRegisteredProvider(providers, "qwen");
    const catalog = buildQwenProvider({ baseUrl });
    // Loopback is not a coding hostname: eligibility belongs to the real Worker.
    expect(provider.normalizeConfig?.({ providerConfig: catalog } as never)).toBeUndefined();
    const selected = catalog.models.find(model => model.id === row.model); expect(selected).toBeDefined();
    const model = { ...selected!, provider: provider.id, api: catalog.api, baseUrl } as Model<"openai-completions">;
    const history: AgentMessage[] = [
      { role: "user", content: "Synthetic tool request", timestamp: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }], api: model.api, provider: model.provider, model: row.model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
      { role: "user", content: `synthetic ${row.id}`, timestamp: 4 },
    ];
    const messages = await withOpenClawTestState({ label: "qwen-regions" }, async state => {
      const policy = resolveTranscriptPolicy({ provider: model.provider, modelId: row.model, modelApi: model.api, model, runtimeHandle: { provider: model.provider, plugin: provider } });
      return sanitizeSessionHistory({ provider: model.provider, modelId: row.model, modelApi: model.api, model, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: row.id,
        sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: model.provider, modelApi: model.api, modelId: row.model })]), messages: history });
    });
    const context: Context = { messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
    const reasoning = row.mode === "effort_off" ? "off" : row.mode === "effort_low" ? "low" : row.mode === "effort_medium" ? "medium" : "high";
    const wrap = row.simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
    const wrapped = wrap?.({ provider: model.provider, modelId: row.model, model, streamFn: row.simple ? streamSimple : stream, thinkingLevel: reasoning });
    expect(wrapped).toBeDefined();
    if (row.mode === "preabort") controller.abort(new Error("synthetic caller cancellation"));
    const output = wrapped!(model, context, { apiKey: key, maxTokens: 128, reasoning, signal: controller.signal });
    for await (const event of output) if (row.mode === "partial" && event.type === "text_delta" && event.delta.length && !partial) {
      partial = true; controller.abort(new Error("synthetic caller cancellation"));
    }
    const result = await output.result();
    const success = ["eof", "rotation", "no_usage", "effort_off", "effort_low", "effort_medium"].includes(row.mode);
    expect(result.stopReason).toBe(success ? "stop" : "error");
    if (success) {
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      expect(result.usage.totalTokens).toBe(row.mode === "no_usage" ? 0 : 320);
    }
    if (row.mode === "partial") { expect(partial).toBe(true); expect(controller.signal.aborted).toBe(true); }
    if (row.mode === "preabort") expect(result.content).toEqual([]);
  } catch (error) { failures.push(error); }
  try {
    await ledger.drain();
    // This asserts attachment to the actual runtime graph. Zero observations
    // cannot qualify a successful stream, and no SDK abort disposition exists.
    expect(acquisitions).toBe(row.mode === "preabort" ? 0 : 1);
    expect(releases).toBe(acquisitions);
    if (acquisitions) expect(ledger.readers.length).toBeGreaterThan(0);
  } catch (error) { failures.push(error); }
  try { ledger.restore(); } catch (error) { failures.push(error); }
  try { vi.restoreAllMocks(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Qwen case and original retirement failed");
}, 60_000);
