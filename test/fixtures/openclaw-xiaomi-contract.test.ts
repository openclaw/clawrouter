import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { createEmptyPluginRegistry, registerProviderPlugin, requireRegisteredProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { types as nodeTypes } from "node:util";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
import * as transportStream from "../../packages/ai/src/transports/transport-stream-shared.js";
import { APIError } from "openai";
import { makeInMemorySessionManager, makeModelSnapshotEntry } from "../../src/agents/embedded-agent-runner.sanitize-session-history.test-harness.js";
import { sanitizeSessionHistory } from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { convertToLlm } from "../../src/agents/sessions/messages.js";
import { resolveTranscriptPolicy } from "../../src/agents/transcript-policy.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../src/plugins/runtime/generation-state.js";
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
    const replayRegistry = createEmptyPluginRegistry();
    replayRegistry.providers.push({ pluginId: "xiaomi", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(replayRegistry, () => sanitizeSessionHistory({ provider: selected.provider, modelId, modelApi: selected.api, model: selected, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: `xiaomi-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: selected.provider, modelApi: selected.api, modelId })]), messages: history }));
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
  const phases = new Set(["setup", "register", "catalog", "history", "wrapper", "call", "result", "assert", "acquire", "read", "cancel", "closed", "unlock", "release", "join", "restore", "report", "helper", "sdk_cancel_receipt", "control", "qualification", "wire", "usage", "retire", "dispose", "remove", "overflow", "result_witness", "owner_witness", "operation_witness", "reader_witness", "release_witness"]);
  const own = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== "object" || isProxy(value)) return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  };
  const scalar = (v: unknown) => v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1_000_000;
  function record(source: string, caseId: string, phase: string, checkpoint: number, failed: boolean, error?: unknown, count: number | null = null) {
    return validate({ v: 1, source, caseId, phase, checkpoint, failed, kind: !failed ? "none" : error === undefined ? "undefined" : "unknown",
      actual: scalar(own(error, "actual")) ? own(error, "actual") : null, expected: scalar(own(error, "expected")) ? own(error, "expected") : null, count });
  }
  const factKeys: Record<string, { numbers: string; flags: string }> = {
    result_witness: { numbers: "stopReason acquisitions assertion", flags: "partial callerAborted bodyPassed" },
    owner_witness: { numbers: "acquisition invocation state callerAbort guardAbort partialSeq fetchAbort", flags: "resourceReturned admitted requestMatched callerLineageObserved callerObserved callerInitial callerReasonDefined guardObserved guardInitial guardReasonDefined sameSignal sameReason fetchObserved fetchInitial fetchReasonDefined fetchSameGuard fetchSameCaller" },
    operation_witness: { numbers: "acquisition reader operation operationKind state invoked settled unlockBefore", flags: "reasonPresent reasonDefined operandDefined signalAtInvoke signalAtReject sameInvokeReason sameRejectReason sameClosed sameRead sameOperand nonempty eof" },
    reader_witness: { numbers: "acquisition reader captured closedState closedSettled unlockCalls unlockReturns unlockInvoked unlockReturned operations settledOperations releaseCalls releaseSettled releaseInvoked releaseSettledSeq", flags: "closedReasonPresent closedReasonDefined bodyLocked joinAccepted allReleasesFulfilled" },
    release_witness: { numbers: "acquisition operation state invoked settled", flags: "resourceReturned reasonPresent reasonDefined" },
  };
  function validate(value: unknown): Record<string, any> | null {
    try {
      if (!value || typeof value !== "object" || isProxy(value)) return null;
      const keys = ["v", "source", "caseId", "phase", "checkpoint", "failed", "kind", "actual", "expected", "count"];
      const shape = factKeys[own(value, "phase") as string];
      if (shape) keys.push("facts");
      const control = [2, 3, 4].includes(own(value, "v") as number);
      if (control) keys.push("control");
      if ([3, 4].includes(own(value, "v") as number)) keys.push("postlude");
      if (own(value, "v") === 4) keys.push("reader");
      if (Reflect.ownKeys(value).length !== keys.length || keys.some(k => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k) ?? {}, "value"))) return null;
      const v = Object.fromEntries(keys.map(k => [k, own(value, k)]));
      if (!(v.v === 1 || control && v.source === "sdk" && v.phase === "control" && xiaomiNativeControls().some(row => row.id === v.caseId)) || !["sdk", "worker", "outer"].includes(v.source as string) || !cases.has(v.caseId as string) || !phases.has(v.phase as string)
        || !Number.isInteger(v.checkpoint) || (v.checkpoint as number) < 0 || (v.checkpoint as number) > 65535 || typeof v.failed !== "boolean"
        || !["none", "undefined", "unknown"].includes(v.kind as string) || !scalar(v.actual) || !scalar(v.expected)
        || !(v.count === null || Number.isInteger(v.count) && (v.count as number) >= 0 && (v.count as number) <= 1_000_000)) return null;
      if (control) {
        const c = v.control, names = ["state", "status", "witness", "qualification"];
        if (!c || typeof c !== "object" || isProxy(c) || Reflect.ownKeys(c).length !== names.length
          || names.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(c, key) ?? {}, "value"))) return null;
        const safe = Object.fromEntries(names.map(key => [key, own(c, key)]));
        const tuple = (value: any, size: number, field: (v: any, i: number) => boolean) => {
          if (!Array.isArray(value) || isProxy(value) || Reflect.ownKeys(value).length !== size + 1 || value.length !== size) return false;
          return Array.from({ length: size }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i)))
            .every((d, i) => d && Object.hasOwn(d, "value") && field(d.value, i));
        };
        const count = (n: any) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000;
        if (![0, 1, 2, 3].includes(safe.state) || !(safe.status === null || Number.isInteger(safe.status) && safe.status >= 100 && safe.status <= 599)
          || ([0, 3].includes(safe.state) ? safe.status !== null : safe.status === null)
          || (safe.state === 1 ? !tuple(safe.witness, 9, (v, i) => i >= 1 && i <= 4 ? count(v) && v <= 1000 : typeof v === "boolean") : safe.witness !== null)
          || !tuple(safe.qualification, 14, (v, i) => v === null || (i < 10 ? count(v) : typeof v === "boolean"))) return null;
        v.control = safe;
        if (v.v === 3 || v.v === 4) {
          // Pre-relay coverage only: first site/definedness, count, defined and
          // undefined site masks, saturation. Later relay/seal failures stay fatal.
          if (!tuple(v.postlude, 7, (n, i) => i === 2 ? n === null || typeof n === "boolean" : i === 6 ? typeof n === "boolean" : count(n))) return null;
          const [coverage, first, defined, total, definedSites, undefinedSites, saturated] = v.postlude;
          if (coverage !== 1 || first > 12 || definedSites > 4095 || undefinedSites > 4095
            || saturated && total !== 1_000_000 || v.failed !== (total > 0)
            || (total === 0 ? first !== 0 || defined !== null || definedSites !== 0 || undefinedSites !== 0 || saturated
              : first === 0 || defined === null || !((defined ? definedSites : undefinedSites) & (1 << (first - 1)))
                || total < definedSites.toString(2).replaceAll("0", "").length + undefinedSites.toString(2).replaceAll("0", "").length)) return null;
        }
        if (v.v === 4) {
          if (!["c_cancel", "c_provider_error"].includes(v.caseId) || !xiaomiReaderSnapshotValid(v.reader, tuple, count)) return null;
          if (!v.failed || !((v.postlude[4] | v.postlude[5]) & 64)) return null;
          if (v.reader[0] === 1 && !safe.qualification.slice(0, 4).every((n: unknown) => n === 1)) return null;
          if (new TextEncoder().encode(`::error title=Xiaomi typed contract::${JSON.stringify(v)}\n`).length > 768) return null;
        }
      }
      if (shape) {
        const facts = v.facts, numbers = shape.numbers.split(" "), flags = shape.flags.split(" "), names = [...numbers, ...flags];
        if (!facts || typeof facts !== "object" || isProxy(facts) || Reflect.ownKeys(facts).length !== names.length
          || names.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(facts, key) ?? {}, "value"))) return null;
        const safe = Object.fromEntries(names.map(key => [key, own(facts, key)]));
        if (numbers.some(key => safe[key] !== null && !(Number.isSafeInteger(safe[key]) && (safe[key] as number) >= 0 && (safe[key] as number) <= 1_000_000))
          || flags.some(key => safe[key] !== null && typeof safe[key] !== "boolean")) return null;
        v.facts = safe;
      }
      return new TextEncoder().encode(JSON.stringify(v)).length <= 768 ? v : null;
    } catch { return null; }
  }
  function witness(source: string, caseId: string, phase: string, facts: Record<string, unknown>) {
    const value = validate({ v: 1, source, caseId, phase, checkpoint: 0, failed: false, kind: "none", actual: null, expected: null, count: null, facts });
    if (!value) throw new Error("invalid Xiaomi witness");
    return value;
  }
  function store() {
    const rows: Record<string, any>[] = []; let suppressed = 0;
    return { add(value: unknown) {
      const row = validate(value); if (!row) throw new Error("invalid Xiaomi diagnostic");
      if (row.v !== 1 && rows.some(value => value.v !== 1 && value.caseId === row.caseId)) throw new Error("duplicate Xiaomi control observation");
      if (rows.length < 63) rows.push(row);
      else {
        // Keep the first control observation even after earlier failure notices fill the store.
        const index = row.v !== 1 ? rows.findLastIndex(value => value.v === 1 && value.phase !== "helper") : -1;
        if (index >= 0) rows[index] = row;
        suppressed++;
      }
    },
      values() { return [...rows, ...(suppressed ? [record("outer", "none", "overflow", 0, false, undefined, suppressed)!] : [])]; } };
  }
  function emit(values: unknown[], failed: boolean, write: (line: string) => unknown) {
    if (!failed) return;
    const rows = values.map(v => { const row = validate(v); if (!row) throw new Error("invalid Xiaomi diagnostic"); return row; });
    const unique = new Map<string, Record<string, any>>();
    for (const row of rows) unique.set([row.source, row.caseId, row.phase, row.checkpoint,
      row.facts?.acquisition, row.facts?.reader, row.facts?.operation].join("/"), row);
    const priority = (row: Record<string, any>) => row.phase === "helper" ? 0
      : row.v !== 1 && row.phase === "control" ? row.caseId === "c_cancel" ? 0.5 : [3, 4].includes(row.v) && row.caseId === "c_provider_error" ? 0.6 : 0.75
      : row.caseId === "c_cancel" && row.phase === "result_witness" ? 1
      : row.caseId === "c_cancel" && row.phase === "owner_witness" ? 2
      : row.caseId === "c_cancel" && ["operation_witness", "reader_witness"].includes(row.phase) ? 3
      : row.failed ? 4 : 5;
    const selected = [...unique.values()].sort((a, b) => priority(a) - priority(b));
    const count = selected.length; const out = selected.slice(0, 9);
    if (count > 9) out.push(record("outer", "none", "overflow", 0, false, undefined, count - 9)!);
    const text = out.map(row => `::error title=Xiaomi typed contract::${JSON.stringify(row).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`).join("");
    if (new TextEncoder().encode(text).length > 8192) throw new Error("Xiaomi annotation capacity");
    write(text);
  }
  // v2 control states: 0 unreached, 1 matching complete shape, 2 invalid shape,
  // 3 parse/capacity/status-read failure. None grants HTTP or retirement acceptance.
  // witness: joined, requests, inputs, calls, reserves, canceled, expired, sourceJoined, completed.
  function controlObservation(caseId: string, status: number | null, value: unknown, parsed: boolean) {
    const keys = ["caseId", "joined", "requests", "inputs", "calls", "reserves", "canceled", "expired", "sourceJoined", "completed"];
    const valid = parsed && value && typeof value === "object" && !isProxy(value) && Reflect.ownKeys(value).length === keys.length
      && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value")) && own(value, "caseId") === caseId
      && ["requests", "inputs", "calls", "reserves"].every(key => { const n = own(value, key); return Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 1000; })
      && ["joined", "canceled", "expired", "sourceJoined", "completed"].every(key => typeof own(value, key) === "boolean");
    return { state: !parsed ? 3 : valid ? 1 : 2, status,
      witness: valid ? keys.slice(1).map(key => own(value, key)) : null };
  }
  function controlRecord(base: Record<string, any>, observation: any, qualification: unknown[], postlude?: unknown[], reader?: unknown[]) {
    const value = validate({ ...base, v: reader ? 4 : postlude ? 3 : 2, control: { ...(observation ?? { state: 0, status: null, witness: null }), qualification }, ...(postlude ? { postlude } : {}), ...(reader ? { reader } : {}) });
    if (!value) throw new Error("invalid Xiaomi control observation");
    return value;
  }
  return { own, record, witness, validate, store, emit, controlObservation, controlRecord };
}
// v4 is the first failed reader-join evaluation, before relay/final seal. [0]
// means no unambiguous private control/acquisition/reader association. No reason
// properties, native getters, original calls or clocks are read by this snapshot.
// Slots: coverage, invocation/acquisition/reader/count, selection bits, disposition
// (false/true/threw = 1/2/3), evaluated/failed masks, first failure-list gate,
// read/cancel [total, fulfilled, rejected, sync throw, unobserved], closed state,
// unlock counts, fault/undefined counts, first original reason presence/identity,
// existing release/unlock ticks, two locked evaluations (unreached/returned/threw).
// Reason kind 4 is the retained fault collection, not an inferred native cause;
// definedness is absent/undefined/defined = 0/1/2, undefined equality is unknown.
// Gates 1..8: sync throw, rejected operation, absent original result, rejected
// closed, pending closed/unlock, absent reader/locked body, faults, invalidation.
// Missing originalClosed is an observation, never an added fatal predicate.
function xiaomiReaderFailureSnapshot(selection: any, readers: any[], faults: unknown[], trace: any) {
  const invocation = selection?.invocation, acquisition = selection?.acquisition;
  if (!invocation?.control || !["c_cancel", "c_provider_error"].includes(invocation.id)
    || !Array.isArray(invocation.acquisitions) || invocation.acquisitions.length !== 1 || invocation.acquisitions[0] !== acquisition || acquisition?.invocation !== invocation
    || !acquisition.bound || !acquisition.accepted || acquisition.state !== "fulfilled"
    || acquisition.observation?.readers !== readers || readers.length !== 1) return [0];
  const reader = readers[0], operations = reader.operations;
  const counts = (kind: string) => {
    const values = operations.filter((op: any) => op.kind === kind), out = [values.length, 0, 0, 0, 0];
    for (const op of values) out[op.state === "sync_throw" ? 3 : op.original?.result?.status === "fulfilled" ? 1 : op.original?.result?.status === "rejected" ? 2 : 4]++;
    return out;
  };
  const same = (present: boolean, reason: unknown) => xiaomiSameReason(trace.present, trace.reason, present, reason);
  const sameOperations = (kind: string) => {
    const results = operations.filter((op: any) => op.kind === kind && op.original?.result?.status === "rejected").map((op: any) => op.original.result);
    return !trace.present || trace.reason === undefined || !results.length || results.some((result: any) => !Object.hasOwn(result, "reason") || result.reason === undefined)
      ? null : results.every((result: any) => result.reason === trace.reason);
  };
  const closed = reader.originalClosed?.result, release = acquisition.releases.at(-1), op = trace.operand;
  return [1, invocation.ordinal, acquisition.ordinal, 1, readers.length,
    (selection.qualified === true ? 1 : 0) | (selection.control === true ? 2 : 0), trace.disposition,
    trace.evaluated, trace.failed, trace.first, counts("read"), counts("cancel"),
    [xiaomiState(reader.closedState), !closed ? 1 : closed.status === "fulfilled" ? 2 : closed.status === "rejected" ? 3 : 0,
      !reader.closedReasonPresent ? 0 : reader.closedReason === undefined ? 1 : 2],
    [reader.unlockCalls, reader.unlockReturns], [faults.length, faults.filter(reason => reason === undefined).length],
    [trace.kind, trace.operation, !trace.present ? 0 : trace.reason === undefined ? 1 : 2,
      sameOperations("read"), sameOperations("cancel"), same(closed?.status === "rejected" && Object.hasOwn(closed, "reason"), closed?.reason),
      same(op?.signalAbortedAtInvoke === true, op?.signalReasonAtInvoke), same(op?.signalAbortedAtReject === true, op?.signalReasonAtReject)],
    [release?.invoked ?? null, release?.settled ?? null, reader.unlockInvoked ?? null, reader.unlockReturned ?? null],
    [...trace.dispositionLocked, ...trace.bodyLocked]];
}
function xiaomiReaderSnapshotValid(value: any, tuple: (value: any, size: number, field: (v: any, i: number) => boolean) => boolean, count: (n: any) => boolean) {
  if (tuple(value, 1, n => n === 0)) return true;
  if (!tuple(value, 18, () => true) || value[0] !== 1) return false;
  const nullableCount = (n: any) => n === null || count(n), nullableFlag = (v: any) => v === null || typeof v === "boolean";
  if (![1, 2, 3].every(i => count(value[i]) && value[i] > 0) || value[3] !== 1 || value[4] !== 1
    || !count(value[5]) || value[5] > 3 || ![1, 2, 3].includes(value[6])
    || ![7, 8].every(i => count(value[i]) && value[i] <= 255) || value[8] === 0 || (value[8] & ~value[7]) !== 0
    || !Number.isSafeInteger(value[9]) || value[9] < 1 || value[9] > 8 || !(value[8] & (1 << (value[9] - 1)))) return false;
  for (const i of [10, 11]) if (!tuple(value[i], 5, count) || value[i][0] !== value[i].slice(1).reduce((a: number, b: number) => a + b, 0)) return false;
  if (!tuple(value[12], 3, (n, i) => i === 0 ? [0, 2, 3, 5].includes(n) : i === 1 ? [0, 1, 2, 3].includes(n) : [0, 1, 2].includes(n))
    || !tuple(value[13], 2, count) || !tuple(value[14], 2, count) || value[14][1] > value[14][0]
    || !tuple(value[15], 8, (n, i) => i === 0 ? Number.isInteger(n) && n >= 0 && n <= 4 : i === 1 ? nullableCount(n) : i === 2 ? [0, 1, 2].includes(n) : nullableFlag(n))
    || !tuple(value[16], 4, nullableCount)
    || !tuple(value[17], 4, (n, i) => i % 2 === 0 ? [0, 1, 2].includes(n) : nullableFlag(n))) return false;
  const reason = value[15];
  if ([1, 2].includes(reason[0]) ? !(count(reason[1]) && reason[1] > 0) : reason[1] !== null) return false;
  if (reason[0] === 0 && reason[2] !== 0 || reason[2] !== 2 && reason.slice(3).some((v: unknown) => v !== null)) return false;
  for (const i of [0, 2]) if (value[17][i] !== 1 && value[17][i + 1] !== null) return false;
  return true;
}

// Closed postlude sites: 1 ownership join, 2 release wait, 3 physical release or
// observer settle, 4 observer faults, 5 control witness, 6 acquisition/release,
// 7 reader join, 8 control qualification, 9 witness construction, 10 detach,
// 11 restoration, 12 reporting, 13 relay, 14 final seal. First means retention
// order, not native chronology. No reason properties read.
function xiaomiPostludeFailures(failures: unknown[]) {
  let first = 0, firstDefined: boolean | null = null, total = 0, definedSites = 0, undefinedSites = 0, saturated = false;
  return { add(site: number, ...errors: unknown[]) {
    for (const error of errors) {
      failures.push(error);
      if (!first) { first = site; firstDefined = error !== undefined; }
      if (total < 1_000_000) total++; else saturated = true;
      if (error === undefined) undefinedSites |= 1 << (site - 1); else definedSites |= 1 << (site - 1);
    }
  }, snapshot() { return [1, first, firstDefined, total, definedSites, undefinedSites, saturated]; } };
}
// Diagnostic-only: consume the original text once, retain safe facts before the
// original status/schema assertion, and never install them as an accepted witness.
function xiaomiConsumeControlWitness(caseId: string, text: string, readStatus: () => number,
  diagnostic: ReturnType<typeof xiaomiDiagnostic>, retain: (value: any) => void) {
  let value: any, status: number | null = null, parsed = false, primary: unknown, primaryPresent = false;
  let reporting: unknown, reportingPresent = false;
  try {
    if (text.length > 768) throw new Error("native control witness capacity");
    value = JSON.parse(text); status = readStatus(); parsed = true;
  } catch (error) { primary = error; primaryPresent = true; }
  try { retain(diagnostic.controlObservation(caseId, status, value, parsed)); }
  catch (error) { reporting = error; reportingPresent = true; }
  if (!primaryPresent) try {
    const keys = ["caseId", "joined", "requests", "inputs", "calls", "reserves", "canceled", "expired", "sourceJoined", "completed"];
    if (status !== 200 || !value || Object.keys(value).length !== keys.length || value.caseId !== caseId
      || !keys.every(key => Object.hasOwn(value, key)) || typeof value.joined !== "boolean"
      || ![value.requests, value.inputs, value.calls, value.reserves].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000)
      || ![value.canceled, value.expired, value.sourceJoined, value.completed].every(v => typeof v === "boolean")) throw new Error("native control witness invalid");
  } catch (error) { primary = error; primaryPresent = true; }
  if (primaryPresent && reportingPresent) throw new AggregateError([primary, reporting], "Xiaomi control witness and reporting failed");
  if (primaryPresent) throw primary;
  if (reportingPresent) throw reporting;
  return value;
}
// Counts summarize retained private records only; no signal/body reads or new
// qualification checks. UNKNOWN is null. The original classifiers remain sole authority.
// qualification: acquisitions, bound, admitted, fulfilled, releases, release fulfilled,
// rejected, sync_throw, pending, undefined failures; caller observed, initial,
// reason present, reason defined. No error values or native properties are read.
function xiaomiControlQualification(invocation: any) {
  const rows = invocation.acquisitions, releases = rows.flatMap((row: any) => row.releases);
  return [rows.length, rows.filter((row: any) => row.bound === true).length,
    rows.filter((row: any) => row.accepted === true).length, rows.filter((row: any) => row.state === "fulfilled").length,
    releases.length, ...["fulfilled", "rejected", "sync_throw", "invoke"].map(state => releases.filter((op: any) => op.state === state).length),
    releases.filter((op: any) => op.reasonPresent === true && op.reason === undefined).length,
    invocation.caller?.observed ?? null, invocation.caller?.initial ?? null, invocation.caller?.reasonPresent ?? null,
    invocation.caller?.reasonPresent === true ? invocation.caller.reason !== undefined : null];
}
function xiaomiNativeControls() {
  const base = xiaomiPlanCases()[0];
  return ["eof", "preabort", "cancel", "provider_error"].map(name => ({ ...base, id: `c_${name}`, source: "grant", simple: true,
    kind: name === "eof" ? "success" : name === "provider_error" ? "embedded" : name }));
}
// Invocation tokens establish ancestry. Signal/request equality is only an additional check.
function xiaomiInvocationOwnership(storage: any) {
  const tokens = new WeakSet<object>(), acquisitions = new WeakSet<object>(), responses = new WeakMap<object, any>(), bodies = new WeakMap<object, any>();
  const failures: unknown[] = [], transports: any[] = [], observers: Promise<unknown>[] = []; let active = true;
  const incomplete = () => { failures.push(new Error("incomplete Xiaomi invocation ownership")); };
  const context = () => { const value = storage.getStore(); return active && value && tokens.has(value.token) ? value : undefined; };
  const bound = (a: any) => {
    const t = a?.transport, token = a?.lineageContext?.token;
    return !!(active && acquisitions.has(a) && tokens.has(token) && token.invocation === a.invocation
      && t?.context === a.lineageContext && t.acquisition === a && t.state === "fulfilled" && t.unique === true
      && a.result?.response === t.response && a.result.response.body === t.body && responses.get(t.response) === t
      && (!t.body || bodies.get(t.body) === t));
  };
  return {
    failures, transports,
    currentInvocation() { return context()?.token.invocation; },
    invoke(invocation: any, fn: Function, receiver: unknown, args: any[]) {
      if (!active || invocation.token || args[2]?.signal !== invocation.caller.signal) {
        incomplete(); return Reflect.apply(fn, receiver, args);
      }
      const token = Object.freeze({ invocation, fn, receiver, args: Object.freeze([...args]) });
      tokens.add(token); invocation.token = token;
      return storage.run(Object.freeze({ token }), () => Reflect.apply(fn, receiver, args));
    },
    guard(fn: Function, receiver: unknown, args: any[], acquisition: any) {
      const outer = context();
      if (!outer || outer.acquisition || acquisitions.has(acquisition) || acquisition.invocation !== outer.token.invocation) {
        incomplete(); return Reflect.apply(fn, receiver, args);
      }
      acquisitions.add(acquisition); acquisition.guardFunction = fn; acquisition.guardReceiver = receiver; acquisition.guardArguments = args;
      acquisition.lineageContext = Object.freeze({ token: outer.token, acquisition });
      return storage.run(acquisition.lineageContext, () => Reflect.apply(fn, receiver, args));
    },
    fetch(fn: Function, receiver: unknown, args: any[], signal: AbortSignal | null | undefined, clock: () => number) {
      const captured = context(), acquisition = captured?.acquisition;
      const t: any = { context: captured, acquisition, fn, receiver, args, signal, signalTrace: xiaomiSignal(signal, clock), state: "invoke", invoked: clock(), unique: false };
      transports.push(t);
      if (!captured || !acquisitions.has(acquisition) || acquisition.lineageContext !== captured || acquisition.transport) incomplete();
      else acquisition.transport = t;
      let returned;
      try { returned = Reflect.apply(fn, receiver, args); t.pending = returned; }
      catch (reason) { t.state = "sync_throw"; t.reasonPresent = true; t.reason = reason; t.settled = clock(); throw reason; }
      const observed = returned.then((response: Response) => {
        t.state = "fulfilled"; t.settled = clock(); t.response = response; t.body = response.body;
        const priorResponse = responses.get(response), priorBody = t.body && bodies.get(t.body);
        if (priorResponse || priorBody) {
          if (priorResponse) priorResponse.unique = false;
          if (priorBody) priorBody.unique = false;
          incomplete(); return;
        }
        responses.set(response, t); if (t.body) bodies.set(t.body, t); t.unique = true;
      }, (reason: unknown) => { t.state = "rejected"; t.reasonPresent = true; t.reason = reason; t.settled = clock(); });
      observers.push(observed.catch((error: unknown) => { failures.push(error); }));
      return returned;
    },
    attach(acquisition: any, result: any) {
      acquisition.result = result;
      if (!bound(acquisition)) incomplete();
      return bound(acquisition);
    },
    bound,
    async join() {
      let done = 0;
      while (done < transports.length) {
        const batch = transports.slice(done); done += batch.length;
        await Promise.allSettled(batch.flatMap(t => t.pending ? [t.pending] : []));
      }
      await Promise.all(observers);
      return [...failures, ...transports.filter(t => t.state === "rejected" || t.state === "sync_throw").map(t => t.reason)];
    },
    restore() {
      if (!active) throw new Error("duplicate Xiaomi ownership restoration");
      active = false; const errors: unknown[] = [];
      for (const t of transports) try { t.signalTrace.detach(); } catch (error) { errors.push(error); }
      try { storage.disable(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Xiaomi ownership restoration failed");
    },
  };
}
function xiaomiInstallProperty(object: any, name: string, value: unknown) {
  const before = Object.getOwnPropertyDescriptor(object, name);
  const ours = { configurable: true, enumerable: before?.enumerable ?? false, writable: true, value };
  Object.defineProperty(object, name, ours); let restored = false;
  return () => {
    const current = Object.getOwnPropertyDescriptor(object, name);
    if (restored || !current || ["value", "get", "set", "writable", "enumerable", "configurable"].some(key => current[key as keyof PropertyDescriptor] !== ours[key as keyof typeof ours])) throw new Error("foreign Xiaomi observer descriptor");
    if (before) Object.defineProperty(object, name, before); else delete object[name];
    restored = true;
  };
}
// Only fixed numeric codes cross the fixture boundary; original reasons stay private.
function xiaomiStopReason(value: unknown, isProxy: (value: unknown) => boolean): number {
  if (!value || typeof value !== "object" || isProxy(value)) return 0;
  const reason = Object.getOwnPropertyDescriptor(value, "stopReason")?.value;
  return ["stop", "length", "toolUse", "error", "aborted"].indexOf(reason) + 1;
}
function xiaomiState(value: unknown): number {
  return ["invoke", "fulfilled", "rejected", "sync_throw", "pending"].indexOf(value as string) + 1;
}
function xiaomiSameReason(leftPresent: boolean, left: unknown, rightPresent: boolean, right: unknown): boolean | null {
  return leftPresent && rightPresent && left !== undefined && right !== undefined ? left === right : null;
}
function xiaomiReaderWitnesses(diagnostic: ReturnType<typeof xiaomiDiagnostic>, source: string, caseId: string,
  acquisition: number, observation: any, releases?: any[]) {
  const values: Record<string, any>[] = [];
  for (const [index, reader] of observation.readers.entries()) {
    const read = reader.operations.find((op: any) => op.kind === "read" && op.reasonPresent);
    const cancel = reader.operations.filter((op: any) => op.kind === "cancel").at(-1);
    for (const op of [read, cancel].filter(Boolean)) values.push(diagnostic.witness(source, caseId, "operation_witness", {
      acquisition, reader: index + 1, operation: op.ordinal, operationKind: op.kind === "read" ? 1 : 2,
      state: xiaomiState(op.state), invoked: op.invoked, settled: op.settled ?? null, unlockBefore: op.unlockCallsBefore,
      reasonPresent: op.reasonPresent, reasonDefined: op.reasonPresent && op.reason !== undefined, operandDefined: op.operandDefined,
      signalAtInvoke: op.signalAbortedAtInvoke, signalAtReject: op.signalAbortedAtReject ?? null,
      sameInvokeReason: xiaomiSameReason(op.reasonPresent, op.reason, op.signalAbortedAtInvoke === true, op.signalReasonAtInvoke),
      sameRejectReason: xiaomiSameReason(op.reasonPresent, op.reason, op.signalAbortedAtReject === true, op.signalReasonAtReject),
      sameClosed: xiaomiSameReason(op.reasonPresent, op.reason, reader.closedReasonPresent, reader.closedReason),
      sameRead: xiaomiSameReason(op.reasonPresent, op.reason, read?.reasonPresent === true, read?.reason),
      sameOperand: xiaomiSameReason(op.reasonPresent, op.reason, op.operandDefined, op.operands[0]),
      nonempty: op.nonempty ?? null, eof: op.eof ?? null,
    }));
    const last = releases?.at(-1);
    values.push(diagnostic.witness(source, caseId, "reader_witness", {
      acquisition, reader: index + 1, captured: reader.captured, closedState: xiaomiState(reader.closedState), closedSettled: reader.closedSettled ?? null,
      closedReasonPresent: reader.closedReasonPresent, closedReasonDefined: reader.closedReasonPresent && reader.closedReason !== undefined,
      unlockCalls: reader.unlockCalls, unlockReturns: reader.unlockReturns, unlockInvoked: reader.unlockInvoked ?? null, unlockReturned: reader.unlockReturned ?? null,
      operations: reader.operations.length, settledOperations: reader.operations.filter((op: any) => ["fulfilled", "rejected", "sync_throw"].includes(op.state)).length,
      bodyLocked: reader.body.locked, joinAccepted: observation.joinAccepted,
      releaseCalls: releases?.length ?? null, releaseSettled: releases?.filter(op => ["fulfilled", "rejected", "sync_throw"].includes(op.state)).length ?? null,
      releaseInvoked: last?.invoked ?? null, releaseSettledSeq: last?.settled ?? null,
      allReleasesFulfilled: releases ? releases.length > 0 && releases.every(op => op.state === "fulfilled") : null,
    }));
  }
  return values;
}
function xiaomiSignal(signal: AbortSignal | null | undefined, tick: () => number) {
  const value: any = { signal, observed: !!signal, initial: signal?.aborted ?? null, event: null, reasonPresent: false };
  if (signal?.aborted) { value.reasonPresent = true; value.reason = signal.reason; }
  const abort = () => { value.event = tick(); value.reasonPresent = true; value.reason = signal!.reason; };
  signal?.addEventListener("abort", abort, { once: true });
  return { ...value, detach() { signal?.removeEventListener("abort", abort); }, get event() { return value.event; },
    get reasonPresent() { return value.reasonPresent; }, get reason() { return value.reason; } };
}
function xiaomiSdkReaderDisposition(selection: any, reader: any, locked?: () => boolean) {
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
    || reader.unlockCalls !== 1 || reader.unlockReturns !== 1 || (locked ? locked() : reader.body.locked)
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
function xiaomiWorkerReaderDisposition(selection: any, reader: any, locked?: () => boolean) {
  const worker = selection?.worker, input = worker?.input, owner = input?.owner, source = worker?.source;
  if (!worker || !input || !owner || !["c_cancel", "n_cancel"].includes(input.row?.id)
    || worker.generation !== input.generation || owner.generation !== input.generation
    || owner.row !== input.row || owner.status !== 200 || input.state !== "fulfilled"
    || worker.requests.filter((value: any) => value.row === input.row).length !== 1 || !worker.requests.includes(owner)
    || worker.inputs.filter((value: any) => value.row === input.row).length !== 1 || !worker.inputs.includes(input)
    || input.observations.length !== 1 || input.observations[0].readers.length !== 1 || input.observations[0].readers[0] !== reader
    || input.response?.body !== reader.body || !input.returned || input.errors.length
    || !source || source.planId !== input.row.id || source.sourceJoined !== true || source.canceled !== true || source.cancelCalls !== 1
    || source.cancelReturned !== 1 || source.settled !== true || source.active !== 0 || source.expired !== false || source.completed !== false
    || worker.usage?.events?.length !== 1 || worker.budget?.ledger !== "durable_object" || worker.budget.limitMicros !== 100 || worker.budget.spentMicros !== 7) return false;
  const event = worker.usage.events[0];
  if (event.status !== "client_error" || event.credential_id !== `xiaomi_plan_${input.row.id}` || event.provider !== input.row.provider
    || event.model !== `${input.row.provider}/${input.row.model}` || event.actual_cost_micros !== 7 || event.cost_basis !== "policy_fixed"
    || [event.input_tokens, event.output_tokens, event.total_tokens, event.cached_input_tokens].some(value => value !== null)
    || reader.faults.length || reader.unlockCalls !== 1 || reader.unlockReturns !== 1 || (locked ? locked() : reader.body.locked)
    || reader.closedState !== "fulfilled" || reader.originalClosed?.pending !== reader.closed || reader.originalClosed.result?.status !== "fulfilled") return false;
  const rejected = reader.operations.filter((operation: any) => operation.state !== "fulfilled"), cancels = reader.operations.filter((operation: any) => operation.kind === "cancel");
  if (rejected.length !== 1 || cancels.length !== 1) return false;
  const read = rejected[0], cancel = cancels[0];
  return read.kind === "read" && read.state === "rejected" && read.reasonPresent && !read.late && !cancel.late
    && read.original?.pending === read.pending && read.original.result?.status === "rejected" && Object.is(read.original.result.reason, read.reason)
    && cancel.state === "fulfilled" && cancel.original?.pending === cancel.pending && cancel.original.result?.status === "fulfilled"
    && !read.unlockCallsBefore && !cancel.unlockCallsBefore && read.invoked < cancel.invoked && read.settled > cancel.invoked
    && read.settled < reader.unlockInvoked && cancel.settled < reader.unlockInvoked && reader.closedSettled < reader.unlockInvoked
    && reader.operations.some((operation: any) => operation.kind === "read" && operation.state === "fulfilled" && operation.nonempty && operation.settled < cancel.invoked);
}
function xiaomiSdkErrorWitness(current: () => any, isProxy: (value: unknown) => boolean, apiPrototype: object,
  aborted: Function, reason: Function, fault: (error: unknown) => void) {
  const inputs = new Map<any, unknown>(), errors = new Map<any, any>();
  const own = (value: any, key: string) => {
    if (!value || typeof value !== "object" || isProxy(value)) return undefined;
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && Object.hasOwn(field, "value") ? field : undefined;
  };
  const note = (body: () => void) => { try { body(); } catch (error) { fault(error); } };
  return {
    input(acquisition: any) { note(() => { const field = own(acquisition.guardInput, "signal"); if (field) inputs.set(acquisition, field.value); }); },
    failure(params: any) { note(() => {
      const invocation = current(); if (!invocation || !["c_provider_error", "n_embedded"].includes(invocation.id)) return;
      if (errors.has(invocation)) { errors.get(invocation).ambiguous = true; return; }
      const original = own(params, "error"), output = own(params, "output"), signal = own(params, "signal");
      if (!original || !output || !signal || signal.value !== invocation.caller.signal) return;
      const error = original.value, payload = own(error, "error")?.value;
      const controlled = !!error && typeof error === "object" && !isProxy(error) && Object.getPrototypeOf(error) === apiPrototype
        && !!own(error, "status") && own(error, "status")!.value === undefined
        && own(error, "message")?.value === "Synthetic rejection" && own(error, "code")?.value === "synthetic"
        && !!payload && typeof payload === "object" && !isProxy(payload) && Object.getPrototypeOf(payload) === Object.prototype
        && Reflect.ownKeys(payload).sort().join() === "code,message"
        && own(payload, "message")?.value === "Synthetic rejection" && own(payload, "code")?.value === "synthetic";
      const observed = { error, output: output.value, controlled, matched: false, ambiguous: false, samples: new Map<any, any>() };
      errors.set(invocation, observed);
      for (const acquisition of invocation.acquisitions) if (inputs.has(acquisition)) {
        const held = inputs.get(acquisition), field = own(acquisition.guardInput, "signal");
        if (!field || field.value !== held || !held || typeof held !== "object" || isProxy(held)) continue;
        note(() => { const state = Reflect.apply(aborted, held, []);
          if (typeof state !== "boolean") throw new Error("invalid native Xiaomi signal state");
          observed.samples.set(acquisition, { aborted: state, reason: state ? Reflect.apply(reason, held, []) : undefined }); });
      }
    }); },
    result(invocation: any, result: any) { note(() => { const observed = errors.get(invocation);
      if (observed?.output === result) { if (observed.matched) observed.ambiguous = true; observed.matched = true; } }); },
    qualifies(invocation: any, acquisition: any, reader: any) {
      const observed = errors.get(invocation), sample = observed?.samples.get(acquisition);
      const read = reader.operations.filter((operation: any) => operation.kind === "read" && operation.state === "rejected");
      const cancel = reader.operations.filter((operation: any) => operation.kind === "cancel");
      return !!observed && observed.controlled && observed.matched && !observed.ambiguous && sample?.aborted === true
        && !!sample.reason && typeof sample.reason === "object" && observed.error !== sample.reason
        && inputs.get(acquisition) !== invocation.caller.signal && own(observed.output, "stopReason")?.value === "error"
        && own(observed.output, "errorMessage")?.value === "Synthetic rejection"
        && read.length === 1 && cancel.length === 1 && cancel[0].state === "rejected" && !cancel[0].unlockCallsBefore
        && reader.closedState === "rejected" && reader.closedReasonPresent && reader.closedReason === sample.reason
        && reader.originalClosed?.pending === reader.closed && reader.originalClosed.result?.status === "rejected"
        && reader.originalClosed.result.reason === sample.reason
        && [...read, ...cancel].every((operation: any) => operation.reasonPresent && operation.reason === sample.reason
          && operation.original?.pending === operation.pending && operation.original.result?.status === "rejected"
          && operation.original.result.reason === sample.reason && !operation.late)
        && (!cancel[0].operandDefined || cancel[0].operands[0] === sample.reason)
        && reader.operations.every((operation: any) => operation.state === "fulfilled" || read.includes(operation) || cancel.includes(operation));
    },
  };
}
function xiaomiSdkProviderErrorDisposition(selection: any, reader: any, locked?: () => boolean) {
  const acquisition = selection?.acquisition, invocation = acquisition?.invocation;
  return !!invocation && (selection.qualified === true || selection.control === true && invocation.control === true)
    && ["c_provider_error", "n_embedded"].includes(invocation.id) && invocation.bodyPassed && invocation.resultErrorEmpty
    && invocation.caller.observed && invocation.caller.initial === false && invocation.caller.signal.aborted === false
    && acquisition.bound && acquisition.accepted && acquisition.state === "fulfilled" && invocation.acquisitions.length === 1 && invocation.acquisitions[0] === acquisition
    && acquisition.observation?.readers.length === 1 && acquisition.observation.readers[0] === reader && reader.signal === acquisition.guard.signal
    && acquisition.releases.length === 1 && acquisition.releases[0].state === "fulfilled"
    && reader.unlockCalls === 1 && reader.unlockReturns === 1 && !(locked ? locked() : reader.body.locked) && !reader.faults.length
    && invocation.sdkErrors?.qualifies(invocation, acquisition, reader) === true;
}
// Closed display of one retained original reason and, at most, its own-data cause.
// protoMatch is immediate identity only, not an authentic class or origin claim.
function xiaomiReaderReasonProjector(isProxy: (value: unknown) => boolean, isNativeError: (value: unknown) => boolean) {
  const getPrototypeOf = Object.getPrototypeOf, descriptor = Object.getOwnPropertyDescriptor;
  const hasOwn = Object.hasOwn, define = Object.defineProperty, Failure = Error;
  const prototypes = [Error.prototype, TypeError.prototype, SyntaxError.prototype, ReferenceError.prototype,
    RangeError.prototype, URIError.prototype, EvalError.prototype, AggregateError.prototype];
  const labels = ["Error", "TypeError", "SyntaxError", "ReferenceError", "RangeError", "URIError", "EvalError", "AggregateError"];
  const inspect = (value: unknown, present: boolean) => {
    const kind = !present ? "missing" : value === null ? "null" : typeof value;
    const out = { kind, protoMatch: "unknown", code: "unobserved" };
    if (!present || value === null || !["object", "function"].includes(typeof value)) return out;
    if (isProxy(value)) return { ...out, kind: "proxy" };
    if (!isNativeError(value)) return { ...out, kind: "foreign" };
    out.kind = "native";
    const prototype = getPrototypeOf(value); // Never inspect or traverse this result.
    for (let i = 0; i < prototypes.length; i++) if (prototype === prototypes[i]) { out.protoMatch = labels[i]; break; }
    const field = descriptor(value, "code");
    out.code = !field ? "absent" : !hasOwn(field, "value") ? "accessor"
      : field.value === undefined ? "undefined" : typeof field.value !== "string" ? "wrongtype" : "unknown";
    if (field && hasOwn(field, "value") && typeof field.value === "string") switch (field.value) {
      case "ABORT_ERR": case "UND_ERR_ABORTED": case "UND_ERR_HEADERS_TIMEOUT":
      case "ETIMEDOUT": case "ECONNRESET": case "ECONNREFUSED": case "EPIPE":
      case "ERR_INVALID_STATE": case "UND_ERR_SOCKET": case "UND_ERR_BODY_TIMEOUT": case "UND_ERR_CONNECT_TIMEOUT":
        out.code = field.value;
    }
    return out;
  };
  return (wrapper: AggregateError, reason: unknown, present: boolean, kind: number,
    atInvoke: boolean | null, atReject: boolean | null) => {
    const root = inspect(reason, present);
    let cause = "unobserved";
    if (root.kind === "native") {
      const field = descriptor(reason, "cause");
      if (!field) cause = "absent";
      else if (!hasOwn(field, "value")) cause = "accessor";
      else if (field.value === undefined) cause = "undefined";
      else if (field.value === reason) cause = "self";
      else {
        const child = inspect(field.value, true);
        cause = `${child.kind}/${child.protoMatch}/${child.code}`;
      }
    }
    const source = kind === 1 ? "read" : kind === 2 ? "cancel" : kind === 3 ? "closed" : kind === 4 ? "observer" : "unknown";
    const flag = (value: boolean | null) => value === true ? "t" : value === false ? "f" : "u";
    const text = `readerReason=v1;source=${source};kind=${root.kind};protoMatch=${root.protoMatch};code=${root.code};cause=${cause};abortEq=${flag(atInvoke)}${flag(atReject)};origin=unknown`;
    if (text.length > 192 || !/^[A-Za-z0-9_=/;]+$/.test(text)) throw new Failure("invalid Xiaomi reader reason display");
    define(wrapper, "message", { value: `Xiaomi original reader outcomes [${text}]`, writable: true, configurable: true });
    return text;
  };
}
// Default (including the injected Worker) is strict. Only an explicitly bound SDK
// selection can classify a terminal disposition after the original physical joins.
function xiaomiObserveBody(body: ReadableStream<Uint8Array>, signal: AbortSignal | null | undefined,
  install: (object: any, name: string, replacement: any) => void, report: (phase: string, ordinal: number, failed: boolean, error?: unknown) => void,
  clock?: () => number, projectOriginalReason?: (wrapper: AggregateError, reason: unknown, present: boolean, kind: number, atInvoke: boolean | null, atReject: boolean | null) => unknown) {
  let sequence = 0; const tick = clock ?? (() => ++sequence), readers: any[] = [], faults: unknown[] = [];
  const originals: any[] = [], originalByPromise = new Map<any, any>(), observers: Promise<unknown>[] = [];
  let originalCursor = 0, observerCursor = 0, revision = 0, acceptedRevision = -1;
  let acceptedOnce = false, failed = false, sealed = false, joinAccepted: boolean | null = null;
  let physical: Promise<void> | undefined, joining: Promise<void> | undefined, completedJoin: Promise<void> | undefined;
  let completedRevision = -1, currentFailure: AggregateError | undefined;
  let selectionSet = false, selected: any, firstFailure: AggregateError | undefined;
  let firstFailedJoin: { value?: unknown[]; error?: unknown; errorPresent: boolean } | undefined;
  const fault = (error: unknown) => { faults.push(error); failed = true; joinAccepted = false; revision++; };
  const safe = (fn: () => void) => { try { fn(); } catch (error) { fault(error); } };
  const changed = (receiver: unknown, expected: unknown) => {
    revision++; joinAccepted = failed ? false : null;
    if (sealed) fault(new Error("original reader operation after ownership seal"));
    if (receiver !== expected) fault(new Error("foreign original reader receiver"));
  };
  // Retain the existing settlement derivative and its nonthrowing error guard.
  // Joining subscribes to each original once; it never returns a replacement P.
  const observe = (pending: any, fulfilled: (value: any) => void, rejected: (reason: unknown) => void) => {
    let original = originalByPromise.get(pending);
    if (!original) { original = { pending, result: undefined }; originalByPromise.set(pending, original); originals.push(original); }
    safe(() => {
      const observed = pending.then(fulfilled, rejected); observers.push(observed);
      observers.push(observed.then(undefined, fault));
    });
    return original;
  };
  const getReader = body.getReader;
  install(body, "getReader", function(this: ReadableStream<Uint8Array>, ...args: any[]) {
    changed(this, body);
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try { reader = Reflect.apply(getReader, this, args); } catch (error) { fault(error); throw error; }
    if (this !== body) return reader;
    if (readers.some(row => row.reader === reader)) { fault(new Error("duplicate original reader identity")); return reader; }
    const row: any = { reader, body, signal, captured: 0, closedState: "pending", closedReasonPresent: false,
      operations: [], unlockCalls: 0, unlockReturns: 0, faults };
    readers.push(row);
    safe(() => {
      row.closed = reader.closed; row.captured = tick();
      row.originalClosed = observe(row.closed, () => { row.closedState = "fulfilled"; row.closedSettled = tick(); }, (reason: unknown) => {
        row.closedState = "rejected"; row.closedReasonPresent = true; row.closedReason = reason; row.closedSettled = tick();
      });
    });
    for (const kind of ["read", "cancel"] as const) {
      const original = reader[kind];
      install(reader, kind, function(this: ReadableStreamDefaultReader<Uint8Array>, ...operands: unknown[]) {
        const late = acceptedOnce; changed(this, reader);
        const op: any = { kind, state: "invoke", ordinal: row.operations.length + 1, invoked: tick(), unlockCallsBefore: row.unlockCalls,
          reasonPresent: false, operands, operandDefined: operands.length > 0 && operands[0] !== undefined, late,
          signalAbortedAtInvoke: signal?.aborted ?? null, signalReasonAtInvoke: signal?.reason }; row.operations.push(op);
        let pending;
        try { pending = Reflect.apply(original, this, operands); op.pending = pending; }
        catch (reason) { failed = true; joinAccepted = false; op.state = "sync_throw"; op.reasonPresent = true; op.reason = reason;
          safe(() => { op.settled = tick(); }); safe(() => report(kind, op.ordinal, true, reason)); throw reason; }
        op.original = observe(pending, (value: any) => {
          op.state = "fulfilled"; op.settled = tick(); op.nonempty = kind === "read" && !value.done && value.value?.byteLength > 0; op.eof = kind === "read" && value.done === true;
        }, (reason: unknown) => {
          op.state = "rejected"; op.reasonPresent = true; op.reason = reason;
          if (late) { failed = true; joinAccepted = false; }
          op.settled = tick(); op.signalAbortedAtReject = signal?.aborted ?? null; op.signalReasonAtReject = signal?.reason;
          safe(() => report(kind, op.ordinal, true, reason));
        });
        return pending;
      });
    }
    const unlock = reader.releaseLock;
    install(reader, "releaseLock", function(this: ReadableStreamDefaultReader<Uint8Array>, ...args: unknown[]) {
      changed(this, reader); row.unlockCalls++; row.unlockInvoked = tick();
      try { const value = Reflect.apply(unlock, this, args); row.unlockReturns++; row.unlockReturned = tick(); return value; }
      catch (error) { fault(error); throw error; }
    });
    return reader;
  });
  const settle = () => {
    if (physical) return physical;
    return physical = (async () => {
      try {
        do {
          const batch = originals.slice(originalCursor), tails = observers.slice(observerCursor);
          originalCursor += batch.length; observerCursor += tails.length;
          const results = await Promise.allSettled([...batch.map(value => value.pending), ...tails]);
          batch.forEach((value, index) => { value.result = results[index]; });
        } while (originalCursor < originals.length || observerCursor < observers.length);
      } finally { physical = undefined; }
    })();
  };
  const join = (selection?: any) => {
    if (!selectionSet) { selectionSet = true; selected = selection; }
    else if (selection !== undefined && selection !== selected) fault(new Error("changed original reader disposition owner"));
    if (joining) return joining;
    if (completedJoin && completedRevision === revision) return completedJoin;
    return joining = (async () => {
      try {
        while (true) {
          await settle(); const failures: unknown[] = [];
          // These bits describe existing evaluations, not a second acceptance pass.
          const trace: any = { evaluated: 0, failed: 0, first: 0, kind: 0, operation: null, present: false,
            reason: undefined, operand: undefined, disposition: 0, dispositionLocked: [0, null], bodyLocked: [0, null] };
          const retain = (bit: number, reason: unknown, kind = 0, op?: any, present = kind !== 0) => {
            trace.failed |= bit;
            if (!trace.first) { trace.first = Math.log2(bit) + 1; trace.kind = kind; trace.operation = op?.ordinal ?? null;
              trace.reason = reason; trace.present = present; trace.operand = op; }
          };
          const locked = (owner: any, target: any[]) => {
            target[0] = 2; // A throw retains the original reason through the existing safe() boundary.
            const value = owner.locked; target[0] = 1; target[1] = typeof value === "boolean" ? value : null; return value;
          };
          for (const row of readers) {
            let eligible = false;
            safe(() => { trace.disposition = 3;
              eligible = selected?.worker ? xiaomiWorkerReaderDisposition(selected, row, () => locked(row.body, trace.dispositionLocked))
                : ["c_provider_error", "n_embedded"].includes(selected?.acquisition?.invocation?.id)
                ? xiaomiSdkProviderErrorDisposition(selected, row, () => locked(row.body, trace.dispositionLocked))
                : xiaomiSdkReaderDisposition(selected, row, () => locked(row.body, trace.dispositionLocked));
              trace.disposition = eligible ? 2 : 1; });
            for (const op of row.operations) {
              trace.evaluated |= 1;
              if (op.state === "sync_throw") { retain(1, op.reason, op.kind === "read" ? 1 : 2, op, op.reasonPresent === true); failures.push(op.reason); }
              else {
                trace.evaluated |= 2;
                if (op.original?.result?.status === "rejected" && (!eligible || op.late)) {
                  retain(2, op.original.result.reason, op.kind === "read" ? 1 : 2, op, Object.hasOwn(op.original.result, "reason")); failures.push(op.original.result.reason);
                } else {
                  trace.evaluated |= 4;
                  if (!op.original?.result) { retain(4, undefined); failures.push(new Error("original reader operation not joined")); }
                }
              }
            }
            trace.evaluated |= 8;
            if (row.originalClosed?.result?.status === "rejected" && !eligible) {
              retain(8, row.originalClosed.result.reason, 3, undefined, Object.hasOwn(row.originalClosed.result, "reason")); failures.push(row.originalClosed.result.reason);
            }
            trace.evaluated |= 16;
            if (row.closedState === "pending" || !row.unlockCalls || row.unlockCalls !== row.unlockReturns) { retain(16, undefined); failures.push(new Error("original reader did not retire")); }
          }
          safe(() => { trace.evaluated |= 32; if (!readers.length || locked(body, trace.bodyLocked)) { retain(32, undefined); failures.push(new Error("original body not consumed and unlocked")); } });
          if (originalCursor < originals.length || observerCursor < observers.length) continue;
          trace.evaluated |= 64; if (faults.length) retain(64, faults[0], 4);
          failures.push(...faults);
          trace.evaluated |= 128;
          if (failed && !failures.length) { retain(128, undefined); failures.push(firstFailure ?? new Error("original reader acceptance invalidated")); }
          if (failures.length) {
            failed = true; joinAccepted = false;
            const error = new AggregateError(failures, "Xiaomi original reader outcomes"); firstFailure ??= error; currentFailure = error;
            if (!firstFailedJoin) {
              try {
                const value = xiaomiReaderFailureSnapshot(selected, readers, faults, trace);
                if (value[0] === 1 && projectOriginalReason)
                  projectOriginalReason(error, trace.reason, trace.present, trace.kind, value[15][6], value[15][7]);
                firstFailedJoin = { value, errorPresent: false };
              }
              catch (reportError) { firstFailedJoin = { error: reportError, errorPresent: true }; }
            }
            throw error;
          }
          acceptedOnce = true; acceptedRevision = revision; joinAccepted = true; return;
        }
      } finally { completedJoin = joining; completedRevision = revision; joining = undefined; }
    })();
  };
  return { readers, settle, join, failureSnapshot: () => firstFailedJoin, get joinAccepted() { return failed ? false : acceptedRevision === revision ? joinAccepted : null; },
    get revision() { return revision; }, get sealed() { return sealed; }, seal() {
      if (physical || joining || completedRevision !== revision || originalCursor !== originals.length || observerCursor !== observers.length) {
        const error = new Error("original reader seal before stable joins"); fault(error); throw error;
      }
      sealed = true;
      if (failed || joinAccepted !== true) throw currentFailure ?? new Error("original reader acceptance invalidated");
    },
  };
}
// Final postludes keep every body open until cross-body owned tails are stable.
async function xiaomiSealReaderObservations(observations: any[]) {
  const failures: unknown[] = [], seen = new Set<unknown>();
  const retain = (error: unknown) => { if (!seen.has(error)) { seen.add(error); failures.push(error); } };
  let versions: number[];
  do {
    versions = observations.map(value => value.revision);
    const outcomes = await Promise.allSettled(observations.map(value => value.join()));
    for (const value of outcomes) if (value.status === "rejected") retain(value.reason);
  } while (observations.some((value, index) => value.revision !== versions[index]));
  for (const value of observations) try { value.seal(); } catch (error) { retain(error); }
  if (failures.length) throw new AggregateError(failures, "Xiaomi final reader joins failed");
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
  if (invocation.id === "c_provider_error" && row.observation?.readers.some((reader: any) => reader.closedState === "rejected"
    || reader.operations.some((operation: any) => operation.state === "rejected"))) return witness.completed === true
    && xiaomiSdkProviderErrorDisposition({ acquisition: row, control: true }, row.observation?.readers[0]);
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

const planReaderReasonProject = xiaomiReaderReasonProjector(nodeTypes.isProxy, nodeTypes.isNativeError);
const planRows = xiaomiPlanCases(), planDiagnostic = xiaomiDiagnostic(nodeTypes.isProxy), controlFetch = globalThis.fetch;
const originalPlanGuard = guardedTransport.fetchWithProviderHttpGuard, qualifiedControls = new Set<string>();
const originalSdkFailure = transportStream.failTransportStream;
const planUndici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici"), originalPlanFetch = planUndici.fetch;
let planOwnership = xiaomiInvocationOwnership(new AsyncLocalStorage()), restorePlanRuntime: (() => void) | undefined;
let planContext: { id: string; phase: string; checkpoint: number } | undefined;
let planRecords = planDiagnostic.store(), planAcquisitions: any[] = [], planObserverFaults: unknown[] = [], planInvocations: any[] = [];
let planBodyPassed = false, planPartial = false, planCaller: AbortSignal | undefined, planSequence = 0;
let planSdkErrors: ReturnType<typeof xiaomiSdkErrorWitness>;
const planTick = () => ++planSequence;
function planMark(phase: string, checkpoint = 0) { if (planContext) { planContext.phase = phase; planContext.checkpoint = checkpoint; } }
function planRemember(context: { id: string; phase: string; checkpoint: number }, error?: unknown, failed = true) {
  planRecords.add(planDiagnostic.record("sdk", context.id, context.phase, context.checkpoint, failed, error));
}
function qualifiedNativeControls() { return xiaomiNativeControls().every(row => qualifiedControls.has(row.id)); }
beforeEach(() => {
  planContext = undefined; planRecords = planDiagnostic.store(); planAcquisitions = []; planObserverFaults = []; planInvocations = [];
  planBodyPassed = false; planPartial = false; planCaller = undefined; planSequence = 0;
  planOwnership = xiaomiInvocationOwnership(new AsyncLocalStorage());
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  const reason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")?.get;
  if (!aborted || !reason) throw new Error("native Xiaomi signal witness unavailable");
  planSdkErrors = xiaomiSdkErrorWitness(() => planOwnership.currentInvocation(), nodeTypes.isProxy, APIError.prototype, aborted, reason,
    error => { planObserverFaults.push(error); });
  vi.spyOn(transportStream, "failTransportStream").mockImplementation(function(this: unknown, ...args: Parameters<typeof originalSdkFailure>) {
    planSdkErrors.failure(args[0]); return Reflect.apply(originalSdkFailure, this, args);
  });
  restorePlanRuntime = xiaomiInstallProperty(globalThis, "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...planUndici,
    fetch: function(this: unknown, ...args: Parameters<typeof originalPlanFetch>) {
      if (!planContext) return Reflect.apply(originalPlanFetch, this, args);
      const [input, init] = args;
      const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
      return planOwnership.fetch(originalPlanFetch, this, args, signal, planTick);
    },
  });
  vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function(options) {
    if (!planContext) return Reflect.apply(originalPlanGuard, this, [options]);
    const headers = new Headers(options.init?.headers);
    const invocation = planOwnership.currentInvocation();
    const requestMatched = !!invocation && !invocation.complete && options.url === invocation.url
      && options.init?.method?.toUpperCase() === "POST" && headers.get("authorization") === invocation.authorization
      && !!options.capture && options.capture.meta?.provider === "xiaomi-token-plan" && options.capture.meta?.model === invocation.model;
    const context = { ...planContext, phase: "acquire", checkpoint: planAcquisitions.length + 1 };
    // This is the observable guard INPUT; the private composed transport signal is not observed.
    const guard = xiaomiSignal(options.signal ?? options.init?.signal, planTick);
    let released!: () => void;
    const row: any = { invocation, requestMatched, bound: false, guard, guardInput: options, state: "invoke", invoked: planTick(), reasonPresent: false,
      releases: [], ordinal: planAcquisitions.length + 1, released: new Promise<void>(resolve => { released = resolve; }), context };
    planAcquisitions.push(row); invocation?.acquisitions.push(row);
    planSdkErrors.input(row);
    let returned;
    try { returned = planOwnership.guard(originalPlanGuard, this, [options], row); row.returned = returned; }
    catch (error) { row.state = "sync_throw"; row.reasonPresent = true; row.reason = error; row.settled = planTick(); released(); throw error; }
    void returned.then(result => {
      row.state = "fulfilled"; row.settled = planTick(); row.result = result;
      row.accepted = result.finalUrl === options.url && result.response.status === 200 && /^text\/event-stream\b/i.test(result.response.headers.get("content-type") ?? "");
      try {
        const lineage = planOwnership.attach(row, result); row.bound = lineage && row.requestMatched;
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
          (phase, checkpoint, failed, error) => planRemember({ ...context, phase, checkpoint }, error, failed), planTick, planReaderReasonProject);
      } catch (error) { planObserverFaults.push(error); released(); }
    }, error => { row.state = "rejected"; row.settled = planTick(); row.reasonPresent = true; row.reason = error; released(); });
    return returned;
  });
});
async function planWitness(invocation: any) {
  const response = await controlFetch(origin + `/fixture/plan/${invocation.id}/witness`);
  const text = await response.text();
  return xiaomiConsumeControlWitness(invocation.id, text, () => response.status, planDiagnostic,
    value => { invocation.controlObservation = value; });
}
afterEach(async () => {
  if (!planContext) {
    const failures: unknown[] = [];
    for (const restore of [restorePlanRuntime, () => planOwnership.restore(), () => vi.restoreAllMocks()]) try { restore?.(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Xiaomi observer restoration failed");
    return;
  }
  const failures: unknown[] = [], context = { ...planContext }, postlude = xiaomiPostludeFailures(failures);
  let site = 6;
  for (const invocation of planInvocations) invocation.bodyPassed = planBodyPassed;
  try {
    await Promise.allSettled(planAcquisitions.flatMap(row => row.returned ? [row.returned] : []));
    site = 1;
    postlude.add(1, ...await planOwnership.join());
    site = 2;
    await Promise.all(planAcquisitions.map(row => row.released));
    site = 3; const physical = await Promise.allSettled(planAcquisitions.flatMap(row => [
      ...row.releases.flatMap((operation: any) => operation.pending ? [operation.pending] : []), ...(row.observation ? [row.observation.settle()] : [])]));
    postlude.add(3, ...physical.flatMap(value => value.status === "rejected" ? [value.reason] : []));
    postlude.add(4, ...planObserverFaults);
    for (const invocation of planInvocations) if (invocation.control || invocation.id === "n_preabort") {
      site = 5; try { invocation.witness = await planWitness(invocation); } catch (error) { postlude.add(5, error); }
    }
    for (const row of planAcquisitions) {
      site = 6; const invocation = row.invocation;
      const selection = { acquisition: row, invocation, qualified: qualifiedNativeControls(), control: invocation?.control && invocation.witness?.joined === true };
      if (row.state === "sync_throw" || row.state === "rejected" && !xiaomiSdkPreabortDisposition(selection, row)) postlude.add(6, row.reason);
      if (row.state === "fulfilled") {
        if (!row.bound || !row.releases.length) postlude.add(6, new Error("missing bound original request release"));
        for (const release of row.releases) if (release.state !== "fulfilled" && release.state !== "rejected") postlude.add(6, release.reason);
        site = 7; if (row.observation) try { await row.observation.join(selection); } catch (error) {
          postlude.add(7, error);
          if (["c_cancel", "c_provider_error"].includes(invocation?.id) && row.observation.failureSnapshot) try {
            const snapshot = row.observation.failureSnapshot();
            if (snapshot?.errorPresent) postlude.add(9, snapshot.error);
            else if (!Object.hasOwn(invocation, "readerSnapshot")) invocation.readerSnapshot = snapshot?.value ?? [0];
          } catch (reportError) { postlude.add(9, reportError); }
        }
      }
    }
    for (const invocation of planInvocations) {
      site = 8; if (invocation.control && !xiaomiNativeControlQualified(invocation)) postlude.add(8, new Error("native control did not qualify"));
      // No acquisition is not itself a passing cancellation receipt.
      if (invocation.id === "n_preabort" && !xiaomiSdkPreabortDisposition({ invocation, qualified: qualifiedNativeControls() })) postlude.add(8, new Error("original public pre-abort result did not qualify"));
    }
  } catch (error) { postlude.add(site, error); }
  // Snapshot existing originals only. These records never grant a disposition.
  for (const invocation of planInvocations) if (["c_cancel", "n_cancel"].includes(invocation.id)) try {
    planRecords.add(planDiagnostic.witness("sdk", invocation.id, "result_witness", {
      stopReason: invocation.stopReasonCode ?? 0, acquisitions: invocation.acquisitions.length,
      assertion: context.phase === "assert" ? context.checkpoint : null, partial: invocation.textDelta ?? false,
      callerAborted: invocation.caller.signal?.aborted ?? null, bodyPassed: invocation.bodyPassed,
    }));
  } catch (error) { postlude.add(9, error); }
  for (const row of planAcquisitions) if (["c_cancel", "n_cancel"].includes(row.context.id)) try {
    const invocation = row.invocation;
    planRecords.add(planDiagnostic.witness("sdk", row.context.id, "owner_witness", {
      acquisition: row.ordinal, invocation: invocation?.ordinal ?? null, state: xiaomiState(row.state), resourceReturned: row.state === "fulfilled", admitted: row.accepted ?? null, requestMatched: row.requestMatched,
      callerLineageObserved: planOwnership.bound(row), callerObserved: invocation?.caller.observed ?? null, callerInitial: invocation?.caller.initial ?? null,
      callerAbort: invocation?.caller.event ?? null, callerReasonDefined: invocation ? invocation.caller.reasonPresent && invocation.caller.reason !== undefined : null,
      guardObserved: row.guard.observed, guardInitial: row.guard.initial, guardAbort: row.guard.event,
      guardReasonDefined: row.guard.reasonPresent && row.guard.reason !== undefined, partialSeq: invocation?.partial ?? null,
      sameSignal: invocation?.caller.observed && row.guard.observed ? invocation.caller.signal === row.guard.signal : null,
      sameReason: xiaomiSameReason(invocation?.caller.reasonPresent === true, invocation?.caller.reason, row.guard.reasonPresent, row.guard.reason),
      fetchAbort: row.transport?.signalTrace.event ?? null, fetchObserved: row.transport?.signalTrace.observed ?? null,
      fetchInitial: row.transport?.signalTrace.initial ?? null,
      fetchReasonDefined: row.transport ? row.transport.signalTrace.reasonPresent && row.transport.signalTrace.reason !== undefined : null,
      fetchSameGuard: row.transport?.signalTrace.observed && row.guard.observed ? row.transport.signal === row.guard.signal : null,
      fetchSameCaller: row.transport?.signalTrace.observed && invocation?.caller.observed ? row.transport.signal === invocation.caller.signal : null,
    }));
    if (row.observation) for (const value of xiaomiReaderWitnesses(planDiagnostic, "sdk", row.context.id, row.ordinal, row.observation, row.releases)) planRecords.add(value);
    for (const [index, op] of row.releases.entries()) planRecords.add(planDiagnostic.witness("sdk", row.context.id, "release_witness", {
      acquisition: row.ordinal, operation: index + 1, state: xiaomiState(op.state), invoked: op.invoked, settled: op.settled ?? null,
      resourceReturned: row.state === "fulfilled", reasonPresent: op.reasonPresent, reasonDefined: op.reasonPresent && op.reason !== undefined,
    }));
  } catch (error) { postlude.add(9, error); }
  // Detach our passive listeners only after the original operations have joined.
  for (const row of planAcquisitions) try { row.guard.detach(); } catch (error) { postlude.add(10, error); }
  for (const invocation of planInvocations) try { invocation.caller.detach(); } catch (error) { postlude.add(10, error); }
  for (const restore of [restorePlanRuntime, () => planOwnership.restore(), () => vi.restoreAllMocks()]) try { restore?.(); } catch (error) { postlude.add(11, error); }
  for (const error of [...failures]) try { planRemember({ ...context, phase: "join" }, error); } catch (reportError) { postlude.add(12, reportError); }
  if (!failures.length && context.id === "n_cancel" && planBodyPassed && planPartial && planCaller?.aborted) {
    try { planRecords.add(planDiagnostic.record("sdk", context.id, "sdk_cancel_receipt", 1, false, undefined, planAcquisitions.length)); }
    catch (error) { postlude.add(12, error); }
  }
  if (context.id.startsWith("c_")) try {
    const base = planDiagnostic.record("sdk", context.id, "control", 1, failures.length > 0, undefined, planAcquisitions.length)!;
    const invocation = planInvocations.find(value => value.id === context.id);
    planRecords.add(invocation ? planDiagnostic.controlRecord(base, invocation.controlObservation, xiaomiControlQualification(invocation), postlude.snapshot(), invocation.readerSnapshot) : base);
  } catch (error) { postlude.add(12, error); }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
  try {
    for (const record of planRecords.values()) {
      const response = await controlFetch(origin + "/fixture/diagnostic", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(record) });
      await response.arrayBuffer(); if (response.status !== 204) throw new Error("diagnostic relay rejected");
    }
  } catch (error) { postlude.add(13, error); }
  finally { clearTimeout(timer); }
  try { await xiaomiSealReaderObservations(planAcquisitions.flatMap(row => row.observation ? [row.observation] : [])); } catch (error) { postlude.add(14, error); }
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
    const replayRegistry = createEmptyPluginRegistry();
    replayRegistry.providers.push({ pluginId: "xiaomi", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(replayRegistry, () => sanitizeSessionHistory({ provider: selected.provider, modelId: row.model, modelApi: selected.api, model: selected, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: row.id,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: selected.provider, modelApi: selected.api, modelId: row.model })]), messages: history }));
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
  invocation.sdkErrors = planSdkErrors;
  planMark("call");
  const value = planOwnership.invoke(invocation, streamFn, undefined, [selected, context, { apiKey, maxTokens: 128, reasoning: "high", signal }]);
  if (onPartial) for await (const event of value) if (event.type === "text_delta") {
    invocation.textDelta = (invocation.textDelta ?? false) || event.delta.length > 0;
    if (event.delta.length > 0 && invocation.acquisitions.length === 1) {
      const readers = invocation.acquisitions[0].observation?.readers;
      if (readers?.length === 1 && readers[0].operations.some((op: any) => op.kind === "read" && op.state === "fulfilled" && op.nonempty)) {
        invocation.partialReader = readers[0]; invocation.partial ??= planTick();
      }
    }
    onPartial();
  }
  const pending = value.result(); planMark("result");
  try { const result = await pending; planSdkErrors.result(invocation, result); invocation.stopReasonCode = xiaomiStopReason(result, nodeTypes.isProxy); invocation.resultAborted = result.stopReason === "aborted" && signal?.aborted === true;
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
        planMark("assert", 1); expect(result.stopReason).toBe(row.kind === "success" ? "stop" : row.kind === "cancel" ? "aborted" : "error");
        if (row.kind === "preabort") { expect(result.content).toEqual([]); expect(result.errorMessage).toBe(caller.signal.reason.message); }
        if (row.kind === "cancel") { planMark("assert", 2); expect(partial).toBe(true); planMark("assert", 3); expect(caller.signal.aborted).toBe(true); }
        if (row.kind === "embedded") { expect(caller.signal.aborted).toBe(false); expect(result.errorMessage).toBe("Synthetic rejection"); }
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
          expect(result.stopReason).toBe(row.kind === "cancel" ? "aborted" : "error"); planMark("assert", 2); expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
          if (row.kind === "embedded") { expect(controller.signal.aborted).toBe(false); expect(result.errorMessage).toBe("Synthetic rejection"); }
          if (row.kind === "cancel") { planMark("assert", 3); expect(partial).toBe(true); planMark("assert", 4); expect(controller.signal.aborted).toBe(true); }
        }
      }
      planBodyPassed = true;
    } catch (error) { xiaomiRethrow(error, () => planRemember({ ...planContext! }, error)); }
  });
});
