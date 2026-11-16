import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
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
      const control = own(value, "v") === 2;
      if (control) keys.push("control");
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
      if (row.v === 2 && rows.some(value => value.v === 2 && value.caseId === row.caseId)) throw new Error("duplicate Xiaomi control observation");
      if (rows.length < 63) rows.push(row);
      else {
        // Keep the first control observation even after earlier failure notices fill the store.
        const index = row.v === 2 ? rows.findLastIndex(value => value.v !== 2 && value.phase !== "helper") : -1;
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
      : row.v === 2 && row.phase === "control" ? row.caseId === "c_cancel" ? 0.5 : 0.75
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
  function controlRecord(base: Record<string, any>, observation: any, qualification: unknown[]) {
    const value = validate({ ...base, v: 2, control: { ...(observation ?? { state: 0, status: null, witness: null }), qualification } });
    if (!value) throw new Error("invalid Xiaomi control observation");
    return value;
  }
  return { own, record, witness, validate, store, emit, controlObservation, controlRecord };
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
  const originals: any[] = [], originalByPromise = new Map<any, any>(), observers: Promise<unknown>[] = [];
  let originalCursor = 0, observerCursor = 0, revision = 0, acceptedRevision = -1;
  let acceptedOnce = false, failed = false, sealed = false, joinAccepted: boolean | null = null;
  let physical: Promise<void> | undefined, joining: Promise<void> | undefined, completedJoin: Promise<void> | undefined;
  let completedRevision = -1, currentFailure: AggregateError | undefined;
  let selectionSet = false, selected: any, firstFailure: AggregateError | undefined;
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
          for (const row of readers) {
            let eligible = false; safe(() => { eligible = xiaomiSdkReaderDisposition(selected, row); });
            for (const op of row.operations) {
              if (op.state === "sync_throw") failures.push(op.reason);
              else if (op.original?.result?.status === "rejected" && (!eligible || op.late)) failures.push(op.original.result.reason);
              else if (!op.original?.result) failures.push(new Error("original reader operation not joined"));
            }
            if (row.originalClosed?.result?.status === "rejected" && !eligible) failures.push(row.originalClosed.result.reason);
            if (row.closedState === "pending" || !row.unlockCalls || row.unlockCalls !== row.unlockReturns) failures.push(new Error("original reader did not retire"));
          }
          safe(() => { if (!readers.length || body.locked) failures.push(new Error("original body not consumed and unlocked")); });
          if (originalCursor < originals.length || observerCursor < observers.length) continue;
          failures.push(...faults);
          if (failed && !failures.length) failures.push(firstFailure ?? new Error("original reader acceptance invalidated"));
          if (failures.length) {
            failed = true; joinAccepted = false;
            const error = new AggregateError(failures, "Xiaomi original reader outcomes"); firstFailure ??= error; currentFailure = error; throw error;
          }
          acceptedOnce = true; acceptedRevision = revision; joinAccepted = true; return;
        }
      } finally { completedJoin = joining; completedRevision = revision; joining = undefined; }
    })();
  };
  return { readers, settle, join, get joinAccepted() { return failed ? false : acceptedRevision === revision ? joinAccepted : null; },
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
const planUndici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici"), originalPlanFetch = planUndici.fetch;
let planOwnership = xiaomiInvocationOwnership(new AsyncLocalStorage()), restorePlanRuntime: (() => void) | undefined;
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
  planOwnership = xiaomiInvocationOwnership(new AsyncLocalStorage());
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
    const row: any = { invocation, requestMatched, bound: false, guard, state: "invoke", invoked: planTick(), reasonPresent: false,
      releases: [], ordinal: planAcquisitions.length + 1, released: new Promise<void>(resolve => { released = resolve; }), context };
    planAcquisitions.push(row); invocation?.acquisitions.push(row);
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
          (phase, checkpoint, failed, error) => planRemember({ ...context, phase, checkpoint }, error, failed), planTick);
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
  const failures: unknown[] = [], context = { ...planContext };
  for (const invocation of planInvocations) invocation.bodyPassed = planBodyPassed;
  try {
    await Promise.allSettled(planAcquisitions.flatMap(row => row.returned ? [row.returned] : []));
    failures.push(...await planOwnership.join());
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
  // Snapshot existing originals only. These records never grant a disposition.
  for (const invocation of planInvocations) if (["c_cancel", "n_cancel"].includes(invocation.id)) try {
    planRecords.add(planDiagnostic.witness("sdk", invocation.id, "result_witness", {
      stopReason: invocation.stopReasonCode ?? 0, acquisitions: invocation.acquisitions.length,
      assertion: context.phase === "assert" ? context.checkpoint : null, partial: invocation.textDelta ?? false,
      callerAborted: invocation.caller.signal?.aborted ?? null, bodyPassed: invocation.bodyPassed,
    }));
  } catch (error) { failures.push(error); }
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
  } catch (error) { failures.push(error); }
  // Detach our passive listeners only after the original operations have joined.
  for (const row of planAcquisitions) try { row.guard.detach(); } catch (error) { failures.push(error); }
  for (const invocation of planInvocations) try { invocation.caller.detach(); } catch (error) { failures.push(error); }
  for (const restore of [restorePlanRuntime, () => planOwnership.restore(), () => vi.restoreAllMocks()]) try { restore?.(); } catch (error) { failures.push(error); }
  for (const error of [...failures]) try { planRemember({ ...context, phase: "join" }, error); } catch (reportError) { failures.push(reportError); }
  if (!failures.length && context.id === "n_cancel" && planBodyPassed && planPartial && planCaller?.aborted) {
    try { planRecords.add(planDiagnostic.record("sdk", context.id, "sdk_cancel_receipt", 1, false, undefined, planAcquisitions.length)); }
    catch (error) { failures.push(error); }
  }
  if (context.id.startsWith("c_")) try {
    const base = planDiagnostic.record("sdk", context.id, "control", 1, failures.length > 0, undefined, planAcquisitions.length)!;
    const invocation = planInvocations.find(value => value.id === context.id);
    planRecords.add(invocation ? planDiagnostic.controlRecord(base, invocation.controlObservation, xiaomiControlQualification(invocation)) : base);
  } catch (error) { failures.push(error); }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
  try {
    for (const record of planRecords.values()) {
      const response = await controlFetch(origin + "/fixture/diagnostic", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(record) });
      await response.arrayBuffer(); if (response.status !== 204) throw new Error("diagnostic relay rejected");
    }
  } catch (error) { failures.push(error); }
  finally { clearTimeout(timer); }
  try { await xiaomiSealReaderObservations(planAcquisitions.flatMap(row => row.observation ? [row.observation] : [])); } catch (error) { failures.push(error); }
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
  try { const result = await pending; invocation.stopReasonCode = xiaomiStopReason(result, nodeTypes.isProxy); invocation.resultAborted = result.stopReason === "aborted" && signal?.aborted === true;
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
          expect(result.stopReason).toBe(row.kind === "cancel" ? "aborted" : "error"); planMark("assert", 2); expect(result.errorMessage).not.toMatch(/fixture-secret|fixture-upstream|must-not-fallback/);
          if (row.kind === "cancel") { planMark("assert", 3); expect(partial).toBe(true); planMark("assert", 4); expect(controller.signal.aborted).toBe(true); }
        }
      }
      planBodyPassed = true;
    } catch (error) { xiaomiRethrow(error, () => planRemember({ ...planContext! }, error)); }
  });
});
