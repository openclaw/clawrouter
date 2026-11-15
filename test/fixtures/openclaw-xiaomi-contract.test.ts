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

registerNativeLifetimeControls();

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
  const cases = new Set(["none", "payg", ...xiaomiPlanCases().map(row => row.id), ...xiaomiNativeControls().map(row => row.id)]);
  const phases = new Set(["setup", "register", "catalog", "history", "wrapper", "call", "result", "assert", "acquire", "read", "cancel", "closed", "unlock", "release", "join", "restore", "report", "helper", "sdk_cancel_receipt", "control", "qualification", "wire", "usage", "retire", "dispose", "remove", "overflow"]);
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
function xiaomiNativeControls() {
  const base = xiaomiPlanCases()[0];
  return ["eof", "preabort", "cancel", "provider_error"].map(name => ({ ...base, id: `c_${name}`, source: "grant", simple: true,
    kind: name === "eof" ? "success" : name === "provider_error" ? "embedded" : name }));
}
function xiaomiSignal(signal: AbortSignal | null | undefined, tick: () => number) {
  const value: any = { signal, observed: !!signal, initial: signal?.aborted ?? null, event: null, reasonPresent: false };
  if (signal?.aborted) { value.reasonPresent = true; value.reason = signal.reason; }
  const abort = () => { value.event = tick(); value.reasonPresent = true; value.reason = signal!.reason; };
  signal?.addEventListener("abort", abort, { once: true });
  return { ...value, detach() { signal?.removeEventListener("abort", abort); }, get event() { return value.event; },
    get reasonPresent() { return value.reasonPresent; }, get reason() { return value.reason; } };
}
function xiaomiSdkReaderDisposition(selection: any, reader: any) {
  const acquisition = selection?.acquisition, invocation = acquisition?.invocation;
  if (!invocation || !(selection.qualified === true || selection.control === true && invocation.control === true)
    || !["n_cancel", "c_cancel"].includes(invocation.id) || !invocation.bodyPassed || !invocation.resultAborted
    || !acquisition.bound || !acquisition.accepted || acquisition.state !== "fulfilled"
    || invocation.acquisitions.length !== 1 || acquisition.observation?.readers.length !== 1
    || acquisition.observation.readers[0] !== reader || reader.signal !== acquisition.guard.signal || invocation.partialReader !== reader
    || !invocation.partial || !invocation.caller.observed || invocation.caller.initial !== false
    || !acquisition.guard.observed || acquisition.guard.initial !== false || !invocation.caller.event || !acquisition.guard.event
    || !invocation.caller.reasonPresent || invocation.caller.reason === undefined
    || !acquisition.guard.reasonPresent || acquisition.guard.reason === undefined
    || invocation.partial >= invocation.caller.event || invocation.caller.event > acquisition.guard.event
    || !reader.operations.some((op: any) => op.kind === "read" && op.state === "fulfilled" && op.nonempty && op.settled < invocation.partial)
    || !acquisition.releases.length || acquisition.releases.some((op: any) => op.state !== "fulfilled" || op.invoked <= acquisition.guard.event)
    || reader.unlockCalls !== 1 || reader.unlockReturns !== 1 || reader.body.locked
    || reader.closedState === "pending" || reader.faults.length) return false;
  const cancel = reader.operations.filter((op: any) => op.kind === "cancel");
  if (cancel.length !== 1 || cancel[0].unlockCallsBefore !== 0 || cancel[0].invoked < acquisition.guard.event
    || cancel[0].signalAbortedAtInvoke !== true || cancel[0].signalReasonAtInvoke !== acquisition.guard.reason
    || !["fulfilled", "rejected"].includes(cancel[0].state)) return false;
  const rejectedReads = reader.operations.filter((op: any) => op.kind === "read" && op.state === "rejected");
  if (reader.operations.some((op: any) => !["fulfilled", "rejected"].includes(op.state))
    || rejectedReads.some((op: any) => !op.reasonPresent || op.reason === undefined || op.settled <= acquisition.guard.event || op.signalAbortedAtReject !== true || op.signalReasonAtReject !== acquisition.guard.reason)
    || reader.closedState === "rejected" && reader.closedSettled <= acquisition.guard.event) return false;
  // A fulfilled cancellation is truthful; no EOF is manufactured. Any stored error
  // requires all three original same-reader witnesses, captured before unlock.
  if (!rejectedReads.length) return reader.closedState === "fulfilled" && cancel[0].state === "fulfilled";
  const reason = rejectedReads[0].reason;
  return reason === invocation.caller.reason && reason === acquisition.guard.reason
    && rejectedReads.every((op: any) => op.reason === reason)
    && reader.closedState === "rejected" && reader.closedReasonPresent && reader.closedReason === reason
    && cancel[0].state === "rejected" && cancel[0].reasonPresent && cancel[0].reason === reason
    && cancel[0].signalAbortedAtReject === true && cancel[0].signalReasonAtReject === reason
    && (!cancel[0].operandDefined || cancel[0].operands[0] === reason);
}
// Default (including the injected Worker) is strict. Only an explicitly bound SDK
// selection can classify a terminal disposition after the original physical joins.
function xiaomiObserveBody(body: ReadableStream<Uint8Array>, signal: AbortSignal | null | undefined,
  install: (object: any, name: string, replacement: any) => void, report: (phase: string, ordinal: number, failed: boolean, error?: unknown) => void,
  clock?: () => number) {
  let sequence = 0; const tick = clock ?? (() => ++sequence), readers: any[] = [], faults: unknown[] = [];
  const safe = (fn: () => void) => { try { fn(); } catch (error) { faults.push(error); } };
  const getReader = body.getReader;
  install(body, "getReader", function(this: ReadableStream<Uint8Array>, ...args: any[]) {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try { reader = Reflect.apply(getReader, this, args); } catch (error) { faults.push(error); throw error; }
    const row: any = { reader, body, signal, closed: reader.closed, captured: tick(), closedState: "pending", closedReasonPresent: false,
      operations: [], unlockCalls: 0, unlockReturns: 0, faults };
    readers.push(row);
    void row.closed.then(() => { row.closedState = "fulfilled"; row.closedSettled = tick(); }, (reason: unknown) => {
      row.closedState = "rejected"; row.closedSettled = tick(); row.closedReasonPresent = true; row.closedReason = reason;
    });
    for (const kind of ["read", "cancel"] as const) {
      const original = reader[kind];
      install(reader, kind, function(this: ReadableStreamDefaultReader<Uint8Array>, ...operands: unknown[]) {
        const op: any = { kind, state: "invoke", ordinal: row.operations.length + 1, invoked: tick(), unlockCallsBefore: row.unlockCalls,
          reasonPresent: false, operands, operandDefined: operands.length > 0 && operands[0] !== undefined,
          signalAbortedAtInvoke: signal?.aborted ?? null, signalReasonAtInvoke: signal?.reason }; row.operations.push(op);
        try {
          const pending = Reflect.apply(original, this, operands); op.pending = pending;
          void pending.then((value: any) => { op.state = "fulfilled"; op.settled = tick(); op.nonempty = kind === "read" && !value.done && value.value?.byteLength > 0; op.eof = kind === "read" && value.done === true; }, (reason: unknown) => {
            op.state = "rejected"; op.settled = tick(); op.reasonPresent = true; op.reason = reason;
            op.signalAbortedAtReject = signal?.aborted ?? null; op.signalReasonAtReject = signal?.reason;
            safe(() => report(kind, op.ordinal, true, reason));
          });
          return pending;
        } catch (reason) { op.state = "sync_throw"; op.settled = tick(); op.reasonPresent = true; op.reason = reason; safe(() => report(kind, op.ordinal, true, reason)); throw reason; }
      });
    }
    const unlock = reader.releaseLock;
    install(reader, "releaseLock", function(this: ReadableStreamDefaultReader<Uint8Array>, ...args: unknown[]) {
      row.unlockCalls++; row.unlockInvoked = tick();
      try { const value = Reflect.apply(unlock, this, args); row.unlockReturns++; row.unlockReturned = tick(); return value; }
      catch (error) { faults.push(error); throw error; }
    });
    return reader;
  });
  let physical: Promise<void> | undefined, joining: Promise<void> | undefined;
  const settle = () => physical ??= (async () => {
    for (const row of readers) { let done = 0; while (done < row.operations.length) {
      const batch = row.operations.slice(done); done += batch.length; await Promise.allSettled(batch.flatMap((op: any) => op.pending ? [op.pending] : []));
    } }
  })();
  return { readers, settle, join(selection?: any) {
    return joining ??= (async () => {
      await settle(); const failures: unknown[] = [];
      for (const row of readers) {
        const eligible = xiaomiSdkReaderDisposition(selection, row);
        for (const op of row.operations) if (op.state === "sync_throw" || op.state === "rejected" && !eligible) failures.push(op.reason);
        if (row.closedState === "rejected" && !eligible) failures.push(row.closedReason);
        if (row.closedState === "pending" || !row.unlockCalls || row.unlockCalls !== row.unlockReturns) failures.push(new Error("original reader did not retire"));
      }
      failures.push(...faults);
      if (!readers.length || body.locked) failures.push(new Error("original body not consumed and unlocked"));
      if (failures.length) throw new AggregateError(failures, "Xiaomi original reader outcomes");
    })();
  } };
}
function xiaomiPublicAbortResult(result: unknown, reason: unknown, isProxy: (value: unknown) => boolean) {
  try {
    if (!result || typeof result !== "object" || isProxy(result) || !reason || typeof reason !== "object" || isProxy(reason)) return false;
    const own = (value: object, key: string) => Object.getOwnPropertyDescriptor(value, key)?.value;
    const content = own(result, "content"), message = own(reason, "message");
    return own(result, "stopReason") === "error" && Array.isArray(content) && !isProxy(content) && content.length === 0
      && typeof message === "string" && own(result, "errorMessage") === message;
  } catch { return false; }
}
function xiaomiSdkPreabortDisposition(selection: any, acquisition?: any) {
  const invocation = selection?.invocation;
  return !!invocation && (selection.qualified === true || selection.control === true && invocation.control === true)
    && ["n_preabort", "c_preabort"].includes(invocation.id) && invocation.bodyPassed && invocation.resultErrorEmpty && invocation.publicAbortMatched === true
    && invocation.caller.observed && invocation.caller.initial === true && invocation.caller.reasonPresent && invocation.caller.reason !== undefined
    && invocation.witness?.joined === true && invocation.witness.requests === 0 && invocation.witness.inputs === 0
    && invocation.witness.calls === 0 && invocation.witness.reserves === 0
    && (!acquisition || acquisition.invocation === invocation && acquisition.bound && acquisition.state === "rejected"
      && acquisition.reasonPresent && acquisition.reason !== undefined && acquisition.reason === invocation.caller.reason
      && acquisition.guard.initial === true && acquisition.guard.reasonPresent && acquisition.guard.reason === acquisition.reason);
}
function xiaomiNativeControlQualified(invocation: any) {
  if (!xiaomiNativeControls().some(row => row.id === invocation?.id) || !invocation.control || !invocation.bodyPassed) return false;
  const witness = invocation.witness;
  if (!witness?.joined || witness.expired !== false || witness.sourceJoined !== true) return false;
  if (invocation.id === "c_preabort") return xiaomiSdkPreabortDisposition({ invocation, control: true })
    && invocation.acquisitions.every((row: any) => row.state === "rejected" && xiaomiSdkPreabortDisposition({ invocation, control: true }, row));
  if (witness.requests !== 1 || witness.inputs !== 1 || witness.calls !== 1 || witness.reserves !== 1 || invocation.acquisitions.length !== 1) return false;
  const row = invocation.acquisitions[0];
  if (!row.bound || !row.accepted || row.state !== "fulfilled" || !row.releases.length || row.releases.some((op: any) => op.state !== "fulfilled")) return false;
  if (invocation.id === "c_cancel") return witness.canceled === true && xiaomiSdkReaderDisposition({ acquisition: row, control: true }, row.observation?.readers[0]);
  return (invocation.id !== "c_eof" || witness.completed === true) && invocation.caller.signal?.aborted === false && row.observation?.readers.length === 1
    && row.observation.readers.every((reader: any) => reader.closedState === "fulfilled" && reader.unlockCalls === 1
      && reader.unlockReturns === 1 && !reader.body.locked && !reader.faults.length
      && reader.operations.every((op: any) => op.state === "fulfilled"));
}
function xiaomiRethrow(primary: unknown, report: () => void): never {
  try { report(); } catch (secondary) { throw new AggregateError([primary, secondary], "original and reporting failures"); }
  throw primary;
}
// END Xiaomi proof functions.

const planRows = xiaomiPlanCases(), planDiagnostic = xiaomiDiagnostic(nodeTypes.isProxy), controlFetch = globalThis.fetch;
const originalPlanGuard = guardedTransport.fetchWithProviderHttpGuard, qualifiedControls = new Set<string>();
let planContext: { id: string; phase: string; checkpoint: number } | undefined;
let planRecords = planDiagnostic.store(), planAcquisitions: any[] = [], planObserverFaults: unknown[] = [], planInvocations: any[] = [];
let planBodyPassed = false, planPartial = false, planCaller: AbortSignal | undefined, planSequence = 0;
const planTick = () => ++planSequence;
function planMark(phase: string, checkpoint = 0) { if (planContext) { planContext.phase = phase; planContext.checkpoint = checkpoint; } }
function planRemember(context: { id: string; phase: string; checkpoint: number }, error?: unknown, failed = true) {
  planRecords.add(planDiagnostic.record("sdk", context.id, context.phase, context.checkpoint, failed, error));
}
function qualifiedNativeControls() { return xiaomiNativeControls().every(row => qualifiedControls.has(row.id)); }
beforeEach(() => {
  planContext = undefined; planRecords = planDiagnostic.store(); planAcquisitions = []; planObserverFaults = []; planInvocations = [];
  planBodyPassed = false; planPartial = false; planCaller = undefined; planSequence = 0;
  vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function(options) {
    if (!planContext) return Reflect.apply(originalPlanGuard, this, [options]);
    const headers = new Headers(options.init?.headers);
    const matches = planInvocations.filter(invocation => !invocation.complete && options.url === invocation.url
      && options.init?.method?.toUpperCase() === "POST" && headers.get("authorization") === invocation.authorization
      && options.capture && options.capture.meta?.provider === "xiaomi-token-plan" && options.capture.meta?.model === invocation.model);
    const invocation = matches.length === 1 ? matches[0] : undefined;
    const context = { ...planContext, phase: "acquire", checkpoint: planAcquisitions.length + 1 };
    // This is the observable guard INPUT; the private composed transport signal is not observed.
    const guard = xiaomiSignal(options.signal ?? options.init?.signal, planTick);
    let released!: () => void;
    const row: any = { invocation, bound: !!invocation, guard, state: "invoke", invoked: planTick(), reasonPresent: false,
      releases: [], released: new Promise<void>(resolve => { released = resolve; }), context };
    planAcquisitions.push(row); invocation?.acquisitions.push(row);
    let returned;
    try { returned = Reflect.apply(originalPlanGuard, this, [options]); row.returned = returned; }
    catch (error) { row.state = "sync_throw"; row.reasonPresent = true; row.reason = error; row.settled = planTick(); released(); throw error; }
    void returned.then(result => {
      row.state = "fulfilled"; row.settled = planTick(); row.result = result;
      row.accepted = result.finalUrl === options.url && result.response.status === 200 && /^text\/event-stream\b/i.test(result.response.headers.get("content-type") ?? "");
      try {
        const release = result.release;
        vi.spyOn(result, "release").mockImplementation(function(...args) {
          const operation: any = { state: "invoke", invoked: planTick(), reasonPresent: false }; row.releases.push(operation);
          try {
            const pending = Reflect.apply(release, this, args); operation.pending = pending;
            void pending.then(() => { operation.state = "fulfilled"; operation.settled = planTick(); released(); }, error => {
              operation.state = "rejected"; operation.reasonPresent = true; operation.reason = error; operation.settled = planTick(); released();
            });
            return pending;
          } catch (error) { operation.state = "sync_throw"; operation.reasonPresent = true; operation.reason = error; operation.settled = planTick(); released(); throw error; }
        });
        if (result.response.body) row.observation = xiaomiObserveBody(result.response.body, options.signal ?? options.init?.signal,
          (object, name, replacement) => { vi.spyOn(object, name).mockImplementation(replacement); },
          (phase, checkpoint, failed, error) => planRemember({ ...context, phase, checkpoint }, error, failed), planTick);
      } catch (error) { planObserverFaults.push(error); released(); }
    }, error => { row.state = "rejected"; row.settled = planTick(); row.reasonPresent = true; row.reason = error; released(); });
    return returned;
  });
});
async function planWitness(invocation: any) {
  const response = await controlFetch(origin + `/fixture/plan/${invocation.id}/witness`);
  const text = await response.text(); if (text.length > 768) throw new Error("native control witness capacity");
  const value = JSON.parse(text), keys = ["caseId", "joined", "requests", "inputs", "calls", "reserves", "canceled", "expired", "sourceJoined", "completed"];
  if (response.status !== 200 || !value || Object.keys(value).length !== keys.length || value.caseId !== invocation.id
    || !keys.every(key => Object.hasOwn(value, key)) || typeof value.joined !== "boolean"
    || ![value.requests, value.inputs, value.calls, value.reserves].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000)
    || ![value.canceled, value.expired, value.sourceJoined, value.completed].every(v => typeof v === "boolean")) throw new Error("native control witness invalid");
  return value;
}
afterEach(async () => {
  if (!planContext) { vi.restoreAllMocks(); return; }
  const failures: unknown[] = [], context = { ...planContext };
  for (const invocation of planInvocations) invocation.bodyPassed = planBodyPassed;
  try {
    await Promise.allSettled(planAcquisitions.flatMap(row => row.returned ? [row.returned] : []));
    await Promise.all(planAcquisitions.map(row => row.released));
    const physical = await Promise.allSettled(planAcquisitions.flatMap(row => [
      ...row.releases.flatMap((operation: any) => operation.pending ? [operation.pending] : []), ...(row.observation ? [row.observation.settle()] : [])]));
    failures.push(...physical.flatMap(value => value.status === "rejected" ? [value.reason] : []), ...planObserverFaults);
    for (const invocation of planInvocations) if (invocation.control || invocation.id === "n_preabort") {
      try { invocation.witness = await planWitness(invocation); } catch (error) { failures.push(error); }
    }
    for (const row of planAcquisitions) {
      const invocation = row.invocation;
      const selection = { acquisition: row, invocation, qualified: qualifiedNativeControls(), control: invocation?.control && invocation.witness?.joined === true };
      if (row.state === "sync_throw" || row.state === "rejected" && !xiaomiSdkPreabortDisposition(selection, row)) failures.push(row.reason);
      if (row.state === "fulfilled") {
        if (!row.bound || !row.releases.length) failures.push(new Error("missing bound original request release"));
        for (const release of row.releases) if (release.state !== "fulfilled" && release.state !== "rejected") failures.push(release.reason);
        if (row.observation) try { await row.observation.join(selection); } catch (error) { failures.push(error); }
      }
    }
    for (const invocation of planInvocations) {
      if (invocation.control && !xiaomiNativeControlQualified(invocation)) failures.push(new Error("native control did not qualify"));
      // No acquisition is not itself a passing cancellation receipt.
      if (invocation.id === "n_preabort" && !xiaomiSdkPreabortDisposition({ invocation, qualified: qualifiedNativeControls() })) failures.push(new Error("original public pre-abort result did not qualify"));
    }
  } catch (error) { failures.push(error); }
  // Detach our passive listeners only after the original operations have joined.
  for (const row of planAcquisitions) try { row.guard.detach(); } catch (error) { failures.push(error); }
  for (const invocation of planInvocations) try { invocation.caller.detach(); } catch (error) { failures.push(error); }
  try { vi.restoreAllMocks(); } catch (error) { failures.push(error); }
  for (const error of [...failures]) try { planRemember({ ...context, phase: "join" }, error); } catch (reportError) { failures.push(reportError); }
  if (!failures.length && context.id === "n_cancel" && planBodyPassed && planPartial && planCaller?.aborted) {
    try { planRecords.add(planDiagnostic.record("sdk", context.id, "sdk_cancel_receipt", 1, false, undefined, planAcquisitions.length)); }
    catch (error) { failures.push(error); }
  }
  if (context.id.startsWith("c_")) try { planRecords.add(planDiagnostic.record("sdk", context.id, "control", 1, failures.length > 0, undefined, planAcquisitions.length)); } catch (error) { failures.push(error); }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
  try {
    for (const record of planRecords.values()) {
      const response = await controlFetch(origin + "/fixture/diagnostic", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(record) });
      await response.arrayBuffer(); if (response.status !== 204) throw new Error("diagnostic relay rejected");
    }
  } catch (error) { failures.push(error); }
  finally { clearTimeout(timer); }
  if (!failures.length && planBodyPassed && context.id.startsWith("c_")) qualifiedControls.add(context.id);
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
  return invokePlanStream(row, selected, context, wrapped!, signal, onPartial);
}
async function invokePlanStream(row: (typeof planRows)[number], selected: Model<"openai-completions">, context: Context,
  streamFn: typeof streamSimple, signal?: AbortSignal, onPartial?: () => void) {
  const apiKey = `clawrouter-live-xiaomi_plan_${row.id}-${row.kind === "invalid_proxy" ? "invalid" : "fixture-secret"}`;
  const invocation: any = { id: row.id, model: row.model, control: row.id.startsWith("c_"), ordinal: planInvocations.length + 1, role: "inference",
    url: origin + `/v1/native/${row.provider}/chat/completions`, authorization: `Bearer ${apiKey}`, caller: xiaomiSignal(signal, planTick), acquisitions: [], complete: false };
  planInvocations.push(invocation);
  planMark("call");
  const value = streamFn(selected, context, { apiKey, maxTokens: 128, reasoning: "high", signal });
  if (onPartial) for await (const event of value) if (event.type === "text_delta") {
    if (event.delta.length > 0 && invocation.acquisitions.length === 1) {
      const readers = invocation.acquisitions[0].observation?.readers;
      if (readers?.length === 1 && readers[0].operations.some((op: any) => op.kind === "read" && op.state === "fulfilled" && op.nonempty)) {
        invocation.partialReader = readers[0]; invocation.partial ??= planTick();
      }
    }
    onPartial();
  }
  const pending = value.result(); planMark("result");
  try { const result = await pending; invocation.resultAborted = result.stopReason === "error" && signal?.aborted === true;
    invocation.resultErrorEmpty = result.stopReason === "error" && result.content.length === 0;
    invocation.publicAbortMatched = xiaomiPublicAbortResult(result, invocation.caller.reason, nodeTypes.isProxy); return result;
  } finally { invocation.complete = true; }
}
async function runNativeControl(row: (typeof planRows)[number], signal: AbortSignal, onPartial?: () => void) {
  const { providers } = await registerProviderPlugin({ plugin, id: "xiaomi", name: "Xiaomi Provider" });
  const provider = requireRegisteredProvider(providers, "xiaomi-token-plan");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const found = catalog.models.find(value => value.id === row.model); expect(found).toBeDefined();
  const model = { ...found, api: catalog.api, provider: provider.id, baseUrl: origin + `/v1/native/${row.provider}` } as Model<"openai-completions">;
  return invokePlanStream(row, model, { messages: [{ role: "user", content: "Synthetic lifetime control", timestamp: 1 }] }, streamSimple, signal, onPartial);
}
function registerNativeLifetimeControls() {
  describe("native SDK lifetime qualification controls (not product parity)", () => {
    for (const row of xiaomiNativeControls()) it(`original native control ${row.id}`, async () => {
      planContext = { id: row.id, phase: "control", checkpoint: 1 };
      const caller = new AbortController(); let partial = false;
      if (row.kind === "preabort") caller.abort(new Error("Synthetic native pre-abort"));
      try {
        const result = await runNativeControl(row, caller.signal, row.kind === "cancel" ? () => { partial = true; caller.abort(new Error("Synthetic native caller abort")); } : undefined);
        planMark("assert", 1); expect(result.stopReason).toBe(row.kind === "success" ? "stop" : "error");
        if (row.kind === "preabort") { expect(result.content).toEqual([]); expect(result.errorMessage).toBe(caller.signal.reason.message); }
        if (row.kind === "cancel") { expect(partial).toBe(true); expect(caller.signal.aborted).toBe(true); }
        if (row.kind === "embedded") expect(caller.signal.aborted).toBe(false);
        if (row.kind === "success") expect(result.content).toContainEqual({ type: "text", text: "synthetic-plan-answer" });
        planBodyPassed = true;
      } catch (error) { xiaomiRethrow(error, () => planRemember({ ...planContext! }, error)); }
    });
  });
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
