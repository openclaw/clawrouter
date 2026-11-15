import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { registerProviderPlugin, requireRegisteredProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { types as nodeTypes } from "node:util";
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
const models = ["mimo-v2.6-pro", "mimo-v2.6-flash"];
async function run(id: string, modelId = models[0], simple = true, reasoning: "off" | "high" | "max" = "high", invalid = false, signal?: AbortSignal) {
  const { providers } = await registerProviderPlugin({ plugin, id: "xiaomi", name: "Xiaomi Provider" });
  const provider = requireRegisteredProvider(providers, "xiaomi");
  expect(requireRegisteredProvider(providers, "xiaomi-token-plan").id).toBe("xiaomi-token-plan");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const row = catalog.models.find(row => row.id === modelId); expect(row).toBeDefined();
  const model = { ...row, api: catalog.api, provider: provider.id, baseUrl: origin + "/v1/native/xiaomi" } as Model<"openai-completions">;
  const normalized = provider.normalizeResolvedModel?.({ model });
  const selected = (normalized ?? model) as Model<"openai-completions">;
  const history: AgentMessage[] = [
    { role: "user", content: "Synthetic tool request", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-prior-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "callfixture", name: "lookup", arguments: {} }], api: selected.api, provider: selected.provider, model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "callfixture", toolName: "lookup", content: [{ type: "text", text: "synthetic-tool-result" }], isError: false, timestamp: 3 },
    { role: "user", content: `synthetic xiaomi_${id}`, timestamp: 4 },
  ];
  const messages = await withOpenClawTestState({ label: "xiaomi-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: selected.provider, modelId, modelApi: selected.api, model: selected, runtimeHandle: { provider: selected.provider, plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(false);
    return sanitizeSessionHistory({ provider: selected.provider, modelId, modelApi: selected.api, model: selected, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: `xiaomi-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: selected.provider, modelApi: selected.api, modelId })]), messages: history });
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const wrapped = provider.wrapStreamFn?.({ provider: selected.provider, modelId, model: selected, streamFn: simple ? streamSimple : stream, thinkingLevel: reasoning });
  expect(wrapped).toBeDefined();
  return wrapped!(selected, context, { apiKey: invalid ? "clawrouter-live-xiaomi_pro-invalid" : `clawrouter-live-xiaomi_${id}-fixture-secret`, maxTokens: 128, reasoning, signal }).result();
}

describe("actual registered Xiaomi PAYG client through Worker", () => {
  for (const [index, model] of models.entries()) for (const simple of [false, true]) {
    const id = `${index ? "flash" : "pro"}_${simple ? "simple" : "stream"}`;
    it(`${model} preserves registered replay and native stream simple=${simple}`, async () => {
      const result = await run(id, model, simple);
      expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
      expect(result.usage).toMatchObject({ input: 44, cacheRead: 256, output: 20, totalTokens: 320 });
    });
  }
  for (const reasoning of ["off", "max"] as const) it(`applies the actual ${reasoning} thinking wrapper without changing the selected card`, async () => {
    const result = await run(reasoning, models[0], true, reasoning);
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage.totalTokens).toBe(320);
  });
  it("keeps successful missing usage separate from measured tokens", async () => {
    const result = await run("no_usage");
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    expect(result.usage.totalTokens).toBe(0);
  });
  for (const id of ["http_error", "embedded_error"]) it(`returns ${id} without a credential or product fallback`, async () => {
    const result = await run(id); expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
  });
  it("denies invalid caller, TokenPlan policy, missing grant, retired cards and unknown dollars before egress", async () => {
    for (const [id, model, invalid] of [
      ["pro", models[0], true], ["foreign", models[0], false], ["missing", models[0], false], ["unpriced", models[0], false],
      ["retired_pro", "mimo-v2.5-pro", false], ["retired", "mimo-v2.5", false],
    ] as const) {
      const result = await run(id, model, true, "high", invalid); expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
    }
  });
  it("preserves caller pre-abort without upstream dispatch", async () => {
    const controller = new AbortController(); controller.abort(new DOMException("Synthetic caller cancellation", "AbortError"));
    const result = await run("aborted", models[0], true, "high", false, controller.signal);
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe(controller.signal.reason.message); expect(result.content).toEqual([]);
  });
});

// BEGIN Xiaomi proof functions. The outer executes this exact source locally and in workerd.
function xiaomiPlanCases() {
  const regions = [
    { provider: "xiaomi-token-plan", binding: "XIAOMI_TOKEN_PLAN_API_KEY", base: "https://token-plan-sgp.xiaomimimo.com/v1" },
    { provider: "xiaomi-token-plan-cn", binding: "XIAOMI_TOKEN_PLAN_CN_API_KEY", base: "https://token-plan-cn.xiaomimimo.com/v1" },
    { provider: "xiaomi-token-plan-ams", binding: "XIAOMI_TOKEN_PLAN_AMS_API_KEY", base: "https://token-plan-ams.xiaomimimo.com/v1" },
  ];
  const rows: Array<{ id: string; provider: string; binding: string; base: string; model: string; source: string; prefix: string; simple: boolean; kind: string }> = [];
  for (const region of regions) for (const model of ["mimo-v2.6-pro", "mimo-v2.6-flash"])
    for (const source of ["env", "grant"]) for (const prefix of ["tp", "ttp"]) for (const simple of [false, true])
      rows.push({ ...region, id: `p${rows.length}`, model, source, prefix, simple, kind: "success" });
  for (const kind of ["invalid_proxy", "foreign_policy", "foreign_model", "retired_pro", "retired", "missing", "invalid_grant", "capacity", "http", "embedded", "no_usage", "preabort", "cancel", "rotation", "failover"])
    rows.push({ ...regions[0], id: `n_${kind}`, model: kind === "retired_pro" ? "mimo-v2.5-pro" : kind === "retired" ? "mimo-v2.5" : "mimo-v2.6-pro", source: "grant", prefix: "tp", simple: true, kind });
  return rows;
}
function xiaomiDiagnostic(isProxy: (value: unknown) => boolean = () => false) {
  const cases = new Set(["none", "payg", ...xiaomiPlanCases().map(row => row.id)]);
  const phases = new Set(["setup", "register", "catalog", "history", "wrapper", "call", "result", "assert", "acquire", "read", "cancel", "closed", "unlock", "release", "join", "restore", "report", "helper", "sdk_cancel_receipt", "wire", "usage", "retire", "dispose", "remove", "overflow"]);
  const own = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== "object" || isProxy(value)) return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  };
  const scalar = (v: unknown) => v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1_000_000;
  function record(source: string, caseId: string, phase: string, checkpoint: number, failed: boolean, error?: unknown, count: number | null = null) {
    return validate({ v: 1, source, caseId, phase, checkpoint, failed, kind: !failed ? "none" : error === undefined ? "undefined" : "unknown",
      actual: scalar(own(error, "actual")) ? own(error, "actual") : null, expected: scalar(own(error, "expected")) ? own(error, "expected") : null, count });
  }
  function validate(value: unknown): Record<string, any> | null {
    try {
      if (!value || typeof value !== "object" || isProxy(value)) return null;
      const keys = ["v", "source", "caseId", "phase", "checkpoint", "failed", "kind", "actual", "expected", "count"];
      if (Reflect.ownKeys(value).length !== keys.length || keys.some(k => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k) ?? {}, "value"))) return null;
      const v = Object.fromEntries(keys.map(k => [k, own(value, k)]));
      if (v.v !== 1 || !["sdk", "worker", "outer"].includes(v.source as string) || !cases.has(v.caseId as string) || !phases.has(v.phase as string)
        || !Number.isInteger(v.checkpoint) || (v.checkpoint as number) < 0 || (v.checkpoint as number) > 65535 || typeof v.failed !== "boolean"
        || !["none", "undefined", "unknown"].includes(v.kind as string) || !scalar(v.actual) || !scalar(v.expected)
        || !(v.count === null || Number.isInteger(v.count) && (v.count as number) >= 0 && (v.count as number) <= 1_000_000)) return null;
      return new TextEncoder().encode(JSON.stringify(v)).length <= 768 ? v : null;
    } catch { return null; }
  }
  function store() {
    const rows: Record<string, any>[] = []; let suppressed = 0;
    return { add(value: unknown) { const row = validate(value); if (!row) throw new Error("invalid Xiaomi diagnostic"); if (rows.length < 63) rows.push(row); else suppressed++; },
      values() { return [...rows, ...(suppressed ? [record("outer", "none", "overflow", 0, false, undefined, suppressed)!] : [])]; } };
  }
  function emit(values: unknown[], failed: boolean, write: (line: string) => unknown) {
    if (!failed) return;
    const rows = values.map(v => { const row = validate(v); if (!row) throw new Error("invalid Xiaomi diagnostic"); return row; });
    const unique = new Map<string, Record<string, any>>();
    for (const row of rows) unique.set([row.source, row.caseId, row.phase, row.checkpoint].join("/"), row);
    const selected = [...unique.values()].sort((a, b) => Number(b.phase === "helper") - Number(a.phase === "helper") || Number(b.failed) - Number(a.failed));
    const count = selected.length; const out = selected.slice(0, 9);
    if (count > 9) out.push(record("outer", "none", "overflow", 0, false, undefined, count - 9)!);
    const text = out.map(row => `::error title=Xiaomi typed contract::${JSON.stringify(row).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`).join("");
    if (new TextEncoder().encode(text).length > 8192) throw new Error("Xiaomi annotation capacity");
    write(text);
  }
  return { own, record, validate, store, emit };
}
// Observe actual instances; no replacement fetch, read, cancellation or pool close.
function xiaomiObserveBody(body: ReadableStream<Uint8Array>, signal: AbortSignal | null | undefined,
  install: (object: any, name: string, replacement: any) => void, report: (phase: string, ordinal: number, failed: boolean, error?: unknown) => void) {
  const readers: any[] = [], faults: unknown[] = [];
  const safe = (fn: () => void) => { try { fn(); } catch (error) { faults.push(error); } };
  const getReader = body.getReader;
  install(body, "getReader", function(this: ReadableStream<Uint8Array>, ...args: any[]) {
    const reader = Reflect.apply(getReader, this, args) as ReadableStreamDefaultReader<Uint8Array>;
    const row: any = { reader, closed: reader.closed, closedState: "pending", operations: [], unlockCalls: 0, unlockReturns: 0 };
    readers.push(row);
    void row.closed.then(() => { row.closedState = "fulfilled"; }, (reason: unknown) => { row.closedState = "rejected"; row.closedReason = reason; });
    for (const kind of ["read", "cancel"] as const) {
      const original = reader[kind];
      install(reader, kind, function(this: ReadableStreamDefaultReader<Uint8Array>, ...operands: unknown[]) {
        const op: any = { kind, state: "invoke", ordinal: row.operations.length + 1, expected: false }; row.operations.push(op);
        try {
          const pending = Reflect.apply(original, this, operands); op.pending = pending;
          void pending.then(() => { op.state = "fulfilled"; }, (reason: unknown) => {
            op.state = "rejected"; op.reason = reason;
            // Exact guard-input read reason at rejection only. Cancellation is always strict.
            op.expected = kind === "read" && reason !== undefined && signal?.aborted === true && signal.reason === reason;
            safe(() => report(kind, op.ordinal, true, reason));
          });
          return pending;
        } catch (reason) { op.state = "sync_throw"; op.reason = reason; safe(() => report(kind, op.ordinal, true, reason)); throw reason; }
      });
    }
    const unlock = reader.releaseLock;
    install(reader, "releaseLock", function(this: ReadableStreamDefaultReader<Uint8Array>, ...args: unknown[]) {
      row.unlockCalls++;
      try { const value = Reflect.apply(unlock, this, args); row.unlockReturns++; return value; }
      catch (error) { faults.push(error); throw error; }
    });
    return reader;
  });
  let joining: Promise<void> | undefined;
  return { readers, join() {
    // One original join generation, reused by success and failure cleanup.
    return joining ??= (async () => {
      const failures: unknown[] = [];
      for (const row of readers) {
        await Promise.allSettled(row.operations.flatMap((op: any) => op.pending ? [op.pending] : []));
        for (const op of row.operations) if (op.state === "sync_throw" || op.state === "rejected" && !op.expected) failures.push(op.reason);
        if (row.closedState === "rejected" && !row.operations.some((op: any) => op.kind === "read" && op.expected && op.reason === row.closedReason)) failures.push(row.closedReason);
        if (row.closedState === "pending" || !row.unlockCalls || row.unlockCalls !== row.unlockReturns) failures.push(new Error("original reader did not retire"));
      }
      failures.push(...faults);
      if (!readers.length || body.locked) failures.push(new Error("original body not consumed and unlocked"));
      if (failures.length) throw new AggregateError(failures, "Xiaomi original reader outcomes");
    })();
  } };
}
function xiaomiRethrow(primary: unknown, report: () => void): never {
  try { report(); } catch (secondary) { throw new AggregateError([primary, secondary], "original and reporting failures"); }
  throw primary;
}
// END Xiaomi proof functions.

const planRows = xiaomiPlanCases(), planDiagnostic = xiaomiDiagnostic(nodeTypes.isProxy), controlFetch = globalThis.fetch;
const originalPlanGuard = guardedTransport.fetchWithProviderHttpGuard;
let planContext: { id: string; phase: string; checkpoint: number } | undefined;
let planRecords = planDiagnostic.store(), planAcquisitions: any[] = [], planObserverFaults: unknown[] = [];
let planBodyPassed = false, planPartial = false, planCaller: AbortSignal | undefined;
function planMark(phase: string, checkpoint = 0) { if (planContext) { planContext.phase = phase; planContext.checkpoint = checkpoint; } }
function planRemember(context: { id: string; phase: string; checkpoint: number }, error?: unknown, failed = true) {
  planRecords.add(planDiagnostic.record("sdk", context.id, context.phase, context.checkpoint, failed, error));
}
beforeEach(() => {
  planContext = undefined; planRecords = planDiagnostic.store(); planAcquisitions = []; planObserverFaults = []; planBodyPassed = false; planPartial = false; planCaller = undefined;
  vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function(options) {
    const context = planContext && { ...planContext, phase: "acquire", checkpoint: planAcquisitions.length + 1 };
    const returned = Reflect.apply(originalPlanGuard, this, [options]);
    if (!context) return returned; // Preserve the original eleven PAYG bodies and execution.
    let released!: () => void;
    const row: any = { returned, releases: [], released: new Promise<void>(resolve => { released = resolve; }), observations: [], context };
    planAcquisitions.push(row);
    void returned.then(result => {
      try {
        const release = result.release;
        vi.spyOn(result, "release").mockImplementation(function(...args) {
          try { const pending = Reflect.apply(release, this, args); row.releases.push(pending); void pending.then(released, released); return pending; }
          catch (error) { planObserverFaults.push(error); released(); throw error; }
        });
        if (result.response.body) row.observations.push(xiaomiObserveBody(result.response.body, options.signal ?? options.init?.signal,
          (object, name, replacement) => { vi.spyOn(object, name).mockImplementation(replacement); },
          (phase, checkpoint, failed, error) => planRemember({ ...context, phase, checkpoint }, error, failed)));
      } catch (error) { planObserverFaults.push(error); released(); }
    }, () => { released(); });
    return returned;
  });
});
afterEach(async () => {
  if (!planContext) { vi.restoreAllMocks(); return; }
  const failures: unknown[] = [], context = { ...planContext };
  try {
    const acquired = await Promise.allSettled(planAcquisitions.map(row => row.returned));
    await Promise.all(planAcquisitions.map(row => row.released));
    const joined = await Promise.allSettled(planAcquisitions.flatMap(row => [...row.releases, ...row.observations.map((value: any) => value.join())]));
    failures.push(...acquired.concat(joined).flatMap(value => value.status === "rejected" ? [value.reason] : []), ...planObserverFaults);
    for (let i = 0; i < acquired.length; i++) if (acquired[i].status === "fulfilled" && !planAcquisitions[i].releases.length) failures.push(new Error("missing original request release"));
  } catch (error) { failures.push(error); }
  try { vi.restoreAllMocks(); } catch (error) { failures.push(error); }
  for (const error of [...failures]) try { planRemember({ ...context, phase: "join" }, error); } catch (reportError) { failures.push(reportError); }
  if (!failures.length && context.id === "n_cancel" && planBodyPassed && planPartial && planCaller?.aborted) {
    try { planRecords.add(planDiagnostic.record("sdk", context.id, "sdk_cancel_receipt", 1, false, undefined, planAcquisitions.length)); }
    catch (error) { failures.push(error); }
  }
  // Reporting starts only after original joins and restoration; it cannot replace a primary failure.
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
  try {
    for (const record of planRecords.values()) {
      const response = await controlFetch(origin + "/fixture/diagnostic", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(record) });
      await response.arrayBuffer(); if (response.status !== 204) throw new Error("diagnostic relay rejected");
    }
  } catch (error) { failures.push(error); }
  finally { clearTimeout(timer); }
  if (failures.length) throw new AggregateError(failures, "Xiaomi SDK original cleanup failed");
});
async function planControl(id: string, action: string) {
  const response = await controlFetch(origin + `/fixture/plan/${id}/${action}`, { method: "POST" });
  await response.arrayBuffer(); expect(response.status).toBe(204);
}
async function runPlan(row: (typeof planRows)[number], signal?: AbortSignal, onPartial?: () => void) {
  planMark("register");
  const registered = await registerProviderPlugin({ plugin, id: "xiaomi", name: "Xiaomi Provider" });
  const provider = requireRegisteredProvider(registered.providers, "xiaomi-token-plan");
  planMark("catalog");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const found = catalog.models.find(value => value.id === row.model); expect(found).toBeDefined();
  const model = { ...found, api: catalog.api, provider: provider.id, baseUrl: origin + `/v1/native/${row.provider}` } as Model<"openai-completions">;
  const selected = (provider.normalizeResolvedModel?.({ model }) ?? model) as Model<"openai-completions">;
  planMark("history");
  const history: AgentMessage[] = [
    { role: "assistant", content: [{ type: "thinking", thinking: "synthetic-plan-thinking", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "planlookup", name: "lookup", arguments: {} }], api: selected.api, provider: selected.provider, model: row.model,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 },
    { role: "toolResult", toolCallId: "planlookup", toolName: "lookup", content: [{ type: "text", text: "synthetic-plan-result" }], isError: false, timestamp: 2 },
    { role: "user", content: "Synthetic plan request", timestamp: 3 },
  ];
  const messages = await withOpenClawTestState({ label: "xiaomi-plan-worker" }, async state => {
    const policy = resolveTranscriptPolicy({ provider: selected.provider, modelId: row.model, modelApi: selected.api, model: selected, runtimeHandle: { provider: selected.provider, plugin: provider } });
    expect(policy.dropReasoningFromHistory).toBe(false);
    return sanitizeSessionHistory({ provider: selected.provider, modelId: row.model, modelApi: selected.api, model: selected, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: row.id,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: selected.provider, modelApi: selected.api, modelId: row.model })]), messages: history });
  });
  const context: Context = { messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  planMark("wrapper");
  const wrapped = provider.wrapStreamFn?.({ provider: provider.id, modelId: row.model, model: selected, streamFn: row.simple ? streamSimple : stream, thinkingLevel: "high" });
  expect(wrapped).toBeDefined(); planMark("call");
  const value = wrapped!(selected, context, { apiKey: `clawrouter-live-xiaomi_plan_${row.id}-${row.kind === "invalid_proxy" ? "invalid" : "fixture-secret"}`, maxTokens: 128, reasoning: "high", signal });
  if (onPartial) for await (const event of value) if (event.type === "text_delta") onPartial();
  const pending = value.result(); planMark("result"); return await pending;
}
describe("configured registered Xiaomi Token Plan native client through Worker", () => {
  for (const row of planRows) it(`plan ${row.id} ${row.kind}`, async () => {
    planContext = { id: row.id, phase: "setup", checkpoint: 0 };
    try {
      if (row.kind === "rotation") {
        for (const [action, expected] of [["valid", "stop"], ["invalid", "error"], ["rotated", "stop"], ["revoked", "error"]]) {
          await planControl(row.id, action); const result = await runPlan(row); planMark("assert", 1); expect(result.stopReason).toBe(expected);
        }
      } else {
        const controller = new AbortController(); planCaller = controller.signal; let partial = false;
        if (row.kind === "preabort") controller.abort(new Error("Synthetic pre-abort"));
        const result = await runPlan(row, controller.signal, row.kind === "cancel" ? () => { partial = true; planPartial = true; controller.abort(new Error("Synthetic caller abort")); } : undefined);
        planMark("assert", 1);
        if (["success", "no_usage"].includes(row.kind)) {
          expect(result.stopReason, result.errorMessage).toBe("stop"); planMark("assert", 2); expect(result.content).toContainEqual({ type: "text", text: "synthetic-plan-answer" });
          planMark("assert", 3); expect(result.usage.totalTokens).toBe(row.kind === "no_usage" ? 0 : 320);
          if (row.kind === "success") expect(result.usage).toMatchObject({ input: 44, cacheRead: 256, output: 20 });
        } else {
          expect(result.stopReason).toBe("error"); planMark("assert", 2); expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
          if (row.kind === "cancel") { planMark("assert", 3); expect(partial).toBe(true); expect(controller.signal.aborted).toBe(true); }
        }
      }
      planBodyPassed = true;
    } catch (error) { xiaomiRethrow(error, () => planRemember({ ...planContext! }, error)); }
  });
});
