import { types as nodeTypes } from "node:util";
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


// BEGIN typed diagnostic protocol. The outer fixture executes and embeds this
// exact source; the Worker supplies no exception inspector.
type DiagnosticValue = number | boolean | null;
type DiagnosticContext = { source: string; test: string; scenario: string; operation: string; ordinal: number };
type DiagnosticReason = { kind: string; depth: number; actual: DiagnosticValue; expected: DiagnosticValue };
type DiagnosticRecord = DiagnosticContext & { v: number; reasons: DiagnosticReason[] };
function diagnosticProtocol(isProxy?: (value: unknown) => boolean) {
  const scenarios = ["m0_off", "m0_low", "m0_high", "m0_max", "m1_off", "m1_low", "m1_high", "m1_max", "m2_off", "m2_minimal", "m2_low", "m2_medium", "m2_high", "m2_xhigh", "m2_max", "m3_off", "m3_high", "m3_max", "simple", "notools", "image0", "image2", "observed", "cached", "invalid", "foreign", "revoked", "unpriced", "error", "cancel"];
  const operations = ["setup", "register", "catalog", "select", "augment", "history", "wrapper", "stream", "result", "assert", "abort", "guard", "acquire", "reader", "read", "cancel", "release", "unlock", "acquisition_join", "release_join", "reader_join", "retirement_assert", "restore", "report", "fixture_start", "provision", "catalog_assert", "sdk_process", "worker_retire", "upstream_assert", "cancel_assert", "usage_wait", "usage_assert", "denial_assert", "dispose", "scratch_cleanup", "capacity"];
  const kinds = ["unknown", "undefined", "null", "primitive", "proxy", "error", "assertion", "abort", "aggregate", "suppressed"];
  const own = (value: object, key: PropertyKey): unknown => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d && Object.hasOwn(d, "value") ? d.value : undefined;
  };
  const object = (value: unknown): value is object => value !== null && typeof value === "object" && !isProxy?.(value);
  const scalar = (value: unknown): value is DiagnosticValue => value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000);
  function identity(test: string, scenario: string) {
    if (test === "T00") return scenario === "none";
    const index = scenarios.indexOf(scenario);
    return index >= 0 && test === `T${String(index < 24 ? index + 1 : index < 28 ? 25 : index - 2).padStart(2, "0")}`;
  }
  function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
    if (!object(value)) return false;
    const actual = Reflect.ownKeys(value);
    return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
  }
  function validate(value: unknown): DiagnosticRecord | null {
    try {
      if (!fields(value, ["v", "source", "test", "scenario", "operation", "ordinal", "reasons"])) return null;
      const v = own(value, "v"), source = own(value, "source"), test = own(value, "test"), scenario = own(value, "scenario"), operation = own(value, "operation"), ordinal = own(value, "ordinal"), raw = own(value, "reasons");
      if (v !== 1 || typeof source !== "string" || !["sdk", "worker", "outer"].includes(source) || typeof test !== "string" || typeof scenario !== "string" || !identity(test, scenario) || typeof operation !== "string" || !operations.includes(operation) || typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 1_000_000 || !object(raw) || !Array.isArray(raw)) return null;
      const length = own(raw, "length");
      if (typeof length !== "number" || length < 1 || length > 4 || Reflect.ownKeys(raw).length !== length + 1) return null;
      const reasons: DiagnosticReason[] = [];
      for (let i = 0; i < length; i++) {
        const r = own(raw, String(i));
        if (!fields(r, ["kind", "depth", "actual", "expected"])) return null;
        const kind = own(r, "kind"), depth = own(r, "depth"), actual = own(r, "actual"), expected = own(r, "expected");
        if (typeof kind !== "string" || !kinds.includes(kind) || typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > 2 || !scalar(actual) || !scalar(expected)) return null;
        reasons.push({ kind, depth, actual, expected });
      }
      const result = { v: 1, source, test, scenario, operation, ordinal, reasons };
      return new TextEncoder().encode(JSON.stringify(result)).byteLength <= 2048 ? result : null;
    } catch { return null; }
  }
  function classify(reason: unknown): DiagnosticReason[] {
    const result: DiagnosticReason[] = [], seen = new Set<object>();
    function visit(value: unknown, depth: number) {
      if (result.length === 4) return;
      const row: DiagnosticReason = { kind: "unknown", depth, actual: null, expected: null }; result.push(row);
      // No Worker reflection on thrown values. Node rejects Proxy before even
      // requesting descriptors, including proxies in a prototype/aggregate chain.
      if (!isProxy) return;
      if (value === undefined) { row.kind = "undefined"; return; }
      if (value === null) { row.kind = "null"; return; }
      if (typeof value !== "object" && typeof value !== "function") { row.kind = "primitive"; return; }
      if (isProxy(value)) { row.kind = "proxy"; return; }
      if (seen.has(value)) return;
      seen.add(value);
      try {
        let current: object | null = value, name: unknown;
        for (let i = 0; current && i < 3; i++) {
          if (isProxy(current)) break;
          name = own(current, "name");
          if (typeof name === "string") break;
          current = Object.getPrototypeOf(current);
        }
        row.kind = name === "AssertionError" ? "assertion" : name === "AbortError" ? "abort" : name === "AggregateError" ? "aggregate" : name === "Error" || name === "TypeError" ? "error" : "unknown";
        if (row.kind === "assertion") {
          const actual = own(value, "actual"), expected = own(value, "expected");
          row.actual = scalar(actual) ? actual : null; row.expected = scalar(expected) ? expected : null;
        }
        if (row.kind === "aggregate" && depth < 2) {
          const errors = own(value, "errors");
          if (object(errors) && Array.isArray(errors)) {
            const length = own(errors, "length");
            if (typeof length === "number") for (let i = 0; i < Math.min(length, 4) && result.length < 4; i++) {
              const d = Object.getOwnPropertyDescriptor(errors, String(i));
              if (d && Object.hasOwn(d, "value")) visit(d.value, depth + 1);
            }
          }
        }
      } catch { /* Diagnostic classification cannot replace the original throw. */ }
    }
    visit(reason, 0); return result;
  }
  function record(context: DiagnosticContext, reason: unknown): DiagnosticRecord {
    return { v: 1, ...context, reasons: classify(reason) };
  }
  function store() {
    const records: DiagnosticRecord[] = []; let suppressed = 0;
    return {
      add(value: unknown) {
        const valid = validate(value); if (!valid) return false;
        if (records.length < 63) records.push(valid); else suppressed = Math.min(suppressed + 1, 1_000_000);
        return true;
      },
      values() {
        return suppressed ? [...records, { v: 1, source: "outer", test: "T00", scenario: "none", operation: "capacity", ordinal: suppressed, reasons: [{ kind: "suppressed", depth: 0, actual: null, expected: null }] }] : [...records];
      },
    };
  }
  async function read(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<string> {
    if (!body) return "";
    const reader = body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const value = await reader.read(); if (value.done) break;
        length += value.value.byteLength;
        if (length > maximum) { await reader.cancel(); throw new Error("diagnostic capacity"); }
        chunks.push(value.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  function relay() {
    const records = store();
    const route = async (request: Request): Promise<Response | null> => {
      const path = new URL(request.url).pathname;
      if (path === "/fixture/diagnostic" && request.method === "POST") {
        try {
          return new Response(null, { status: records.add(JSON.parse(await read(request.body, 2048))) ? 204 : 400 });
        } catch { return new Response(null, { status: 400 }); }
      }
      if (path === "/fixture/diagnostics" && request.method === "GET") return Response.json(records.values());
      return null;
    };
    return Object.assign(route, { add: records.add });
  }
  async function flush(records: DiagnosticRecord[], target: string, send: typeof fetch) {
    if (!records.length) return;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
    try {
      for (const value of records) {
        const valid = validate(value); if (!valid) throw new Error("invalid diagnostic");
        const response = await send(target + "/fixture/diagnostic", { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(valid) });
        await read(response.body, 2048);
        if (response.status !== 204) throw new Error("diagnostic rejected");
      }
    } finally { clearTimeout(timer); }
  }
  return { scenarios, operations, own, identity, validate, record, classify, store, read, relay, flush };
}
// END typed diagnostic protocol.

const diagnostic = diagnosticProtocol(nodeTypes.isProxy);
const diagnosticFetch = globalThis.fetch;
let current: DiagnosticContext = { source: "sdk", test: "T00", scenario: "none", operation: "setup", ordinal: 0 };
let failureRecords = diagnostic.store();
const testNames = new Map<string, string>();
function mark(operation: string) { current = { ...current, operation }; }
function remember(context: DiagnosticContext, error: unknown) {
  // This observer never throws into an original operation or promise continuation.
  try { failureRecords.add(diagnostic.record(context, error)); } catch { /* original outcome remains authoritative */ }
}
function caseBody<T extends unknown[]>(testId: string, body: (...args: T) => Promise<void>) {
  return async (...args: T) => {
    try { await body(...args); }
    catch (error) {
      try { const bodyFailure = diagnostic.record({ ...current, test: testId }, error); remember(bodyFailure, error); } catch { /* preserve even throw undefined */ }
      throw error;
    }
  };
}
function caseTest(testId: string, title: string, body: () => Promise<void>) {
  testNames.set(title, testId); it(title, caseBody(testId, body));
}
function resultOf<T>(stream: { result(): Promise<T> }): Promise<T> {
  mark("result"); const context = { ...current };
  const pending = stream.result();
  void pending.then(() => { if (current.scenario === context.scenario) mark("assert"); }, error => remember(context, error));
  return pending;
}

// Observe the shipped guard and its original products. Do not stub global fetch:
// that changes the pinned client's SSRF/runtime-dispatcher selection.
const originalGuard = guardedTransport.fetchWithProviderHttpGuard;
const acquisitions: Array<{
  context: DiagnosticContext;
  returned: ReturnType<typeof originalGuard>;
  released: Promise<void>;
  releaseCalls: number;
  releasePending: Promise<void>[];
  body?: ReadableStream<Uint8Array> | null;
  readers: Array<{ reader: ReadableStreamDefaultReader<Uint8Array>; pending: ReaderOperation[]; unlocked: boolean }>;
}> = [];
const observationErrors: unknown[] = [];
let started = 0;

// Pure observation/join functions are also exercised by the outer fixture tests.
type ReaderOperation = { kind: "read" | "cancel"; pending: Promise<unknown>; expectedAbort: boolean };
function observeReaderOperation<T extends Promise<unknown>>(operations: ReaderOperation[], kind: ReaderOperation["kind"], pending: T, signals: Array<AbortSignal | null | undefined>): T {
  const operation = { kind, pending, expectedAbort: false }; operations.push(operation);
  void pending.then(() => {}, reason => {
    // Match the original request's exact reason at rejection, never an error name
    // or a signal that only becomes aborted later. Cancellation failures always fail.
    operation.expectedAbort = kind === "read" && reason !== undefined && signals.some(signal => signal?.aborted && signal.reason === reason);
  });
  return pending;
}
async function joinReaderOperations(operations: ReaderOperation[]) {
  const results = await Promise.allSettled(operations.map(operation => operation.pending));
  const failures = results.flatMap((result, index) => result.status === "rejected" && !operations[index].expectedAbort ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "original reader operations failed");
}


beforeEach(({ task }) => {
  const test = testNames.get(task.name);
  const scenario = test ? diagnostic.scenarios.find(value => diagnostic.identity(test, value))! : "none";
  current = { source: "sdk", test: test ?? "T00", scenario, operation: "setup", ordinal: 0 };
  failureRecords = diagnostic.store();
  acquisitions.length = 0; observationErrors.length = 0; started = 0;
  try {
  if (!test) throw new Error("unmapped diagnostic test");
  vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function (options) {
    const context = { ...current, operation: "guard", ordinal: acquisitions.length + 1 };
    let returned: ReturnType<typeof originalGuard>;
    try { returned = Reflect.apply(originalGuard, this, [options]); } catch (error) { remember(context, error); throw error; }
    const signals = [options.signal, options.init?.signal];
    let released!: () => void;
    const row: (typeof acquisitions)[number] = { context, returned, released: new Promise(resolve => { released = resolve; }), releaseCalls: 0, releasePending: [], readers: [] };
    acquisitions.push(row);
    // Register before returning the same promise, so instrumentation precedes the
    // consumer's continuation without replacing its response or transport.
    void returned.then(result => {
      try {
        row.body = result.response.body;
        const release = result.release;
        vi.spyOn(result, "release").mockImplementation(function () {
          row.releaseCalls++;
          let pending: Promise<void>;
          try { pending = Reflect.apply(release, this, []); } catch (error) { remember({ ...context, operation: "release" }, error); throw error; }
          row.releasePending.push(pending);
          void pending.then(released, error => { remember({ ...context, operation: "release" }, error); released(); });
          return pending;
        });
        if (row.body) {
          const getReader = row.body.getReader;
          vi.spyOn(row.body, "getReader").mockImplementation(function (...args) {
            let reader: ReadableStreamDefaultReader<Uint8Array>;
            try { reader = Reflect.apply(getReader, this, args); } catch (error) { remember({ ...context, operation: "reader" }, error); throw error; }
            const observed = { reader, pending: [] as ReaderOperation[], unlocked: false };
            row.readers.push(observed);
            for (const name of ["read", "cancel"] as const) {
              const original = reader[name];
              vi.spyOn(reader, name).mockImplementation(function (...operands: unknown[]) {
                const operation = { ...context, operation: name };
                let pending: ReturnType<typeof original>;
                try { pending = Reflect.apply(original, this, operands); } catch (error) { remember(operation, error); throw error; }
                const result = observeReaderOperation(observed.pending, name, pending, signals);
                const observedOperation = observed.pending.at(-1)!;
                void pending.then(() => {}, error => { if (!observedOperation.expectedAbort) remember(operation, error); });
                return result;
              });
            }
            const unlock = reader.releaseLock;
            vi.spyOn(reader, "releaseLock").mockImplementation(function () {
              let result: void;
              try { result = Reflect.apply(unlock, this, []); } catch (error) { remember({ ...context, operation: "unlock" }, error); throw error; }
              observed.unlocked = true;
              return result;
            });
            return reader;
          });
        }
      } catch (error) { remember({ ...context, operation: "acquire" }, error); observationErrors.push(error); released(); }
    }, error => { remember({ ...context, operation: "acquire" }, error); released(); });
    return returned;
  });
  } catch (error) { remember({ ...current }, error); throw error; }
});

afterEach(async () => {
  const cleanupFailures: unknown[] = [];
  try {
    mark("acquisition_join");
    const returned = await Promise.allSettled(acquisitions.map(row => row.returned));
    const releases = await Promise.all(acquisitions.map(async row => {
      mark("release_join");
      await row.released;
      const results = await Promise.allSettled(row.releasePending);
      mark("reader_join");
      const readers = await Promise.allSettled(row.readers.map(observed => joinReaderOperations(observed.pending)));
      return [...results, ...readers];
    }));
    // Assertions follow every original join, so one failed observation cannot
    // skip retirement of a later acquisition in the four-denial case.
    const failures = [...returned, ...releases.flat()].flatMap(result => result.status === "rejected" ? [result.reason] : []);
    failures.push(...observationErrors);
    // Vitest retains the test-body failure separately from this afterEach failure.
    if (failures.length) throw new AggregateError(failures, "Abliteration client retirement failed");
    mark("retirement_assert");
    for (const row of acquisitions) {
      expect(row.releaseCalls).toBeGreaterThan(0);
      expect(row.readers.length).toBeGreaterThan(0);
      expect(row.readers.every(observed => observed.unlocked)).toBe(true);
      expect(row.body?.locked).toBe(false);
    }
    expect(observationErrors).toEqual([]);
    expect(acquisitions).toHaveLength(started);
  } catch (error) { remember({ ...current }, error); cleanupFailures.push(error); }
  finally {
    try { vi.restoreAllMocks(); } catch (error) { remember({ ...current, operation: "restore" }, error); cleanupFailures.push(error); }
    // Physical joins and mock restoration precede any reporting I/O. Vitest
    // retains the original body failure independently, including throw undefined.
    try { await diagnostic.flush(failureRecords.values(), origin, diagnosticFetch); }
    catch (error) { cleanupFailures.push(error); }
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "retirement or diagnostic reporting failed");
});

async function start(id: string, modelId = models[0], options: { apiKey?: string; signal?: AbortSignal; simpleCompletion?: boolean; tools?: boolean; reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; image?: boolean } = {}) {
  if (!diagnostic.identity(current.test, id)) throw new Error("unmapped diagnostic scenario");
  current = { ...current, scenario: id };
  mark("register");
  const provider = await registerSingleProviderPlugin(plugin);
  mark("catalog");
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  mark("select");
  const row = catalog.models.find(row => row.id === modelId);
  expect(row).toBeDefined();
  expect(catalog.models.map(row => row.id)).toEqual(models);
  expect(row!.reasoning, modelId).toBe(true);
  const configured = { ...catalog, baseUrl: origin + "/v1/native/abliteration", models: [row!] };
  const config = { models: { providers: { abliteration: configured } } };
  mark("augment");
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
  mark("history");
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
  mark("wrapper");
  expect(provider.wrapStreamFn).toBeUndefined();
  expect(provider.wrapSimpleCompletionStreamFn).toBeUndefined();
  const wrap = options.simpleCompletion ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const selectedStream = wrap?.({ provider: "abliteration", modelId, model, streamFn: streamSimple }) ?? streamSimple;
  expect(selectedStream).toBe(streamSimple);
  mark("stream");
  started++;
  return selectedStream(model, context, { apiKey: options.apiKey ?? key(id), maxTokens: 128, reasoning: options.reasoning ?? "high", sessionId: "synthetic-cache-affinity", cacheRetention: "long", signal: options.signal });
}

describe("actual Abliteration static catalog and replay through Worker and SQLite", () => {
  let effortId = 0;
  for (const [modelIndex, levels] of efforts.entries()) for (const reasoning of levels) caseTest(`T${String(++effortId).padStart(2, "0")}`, `streams frozen card ${modelIndex} with logical effort ${reasoning}`, async () => {
    const result = await resultOf(await start(`m${modelIndex}_${reasoning}`, models[modelIndex], { reasoning }));
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
  });
  caseTest("T19", "runs the actual simple-completion tool/reasoning path", async () => {
    const result = await resultOf(await start("simple", models[0], { simpleCompletion: true }));
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  caseTest("T20", "retains prior tool history as text when no tools are declared", async () => {
    const result = await resultOf(await start("notools", models[0], { tools: false }));
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  for (const index of [0, 2]) caseTest(index === 0 ? "T21" : "T22", `preserves actual image input on frozen card ${index}`, async () => {
    const result = await resultOf(await start(`image${index}`, models[index], { image: true }));
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });
  caseTest("T23", "uses observed counters when supplied", async () => {
    const result = await resultOf(await start("observed"));
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.usage).toMatchObject({ input: 4, output: 3, totalTokens: 7 });
  });
  caseTest("T24", "keeps cached input and reasoning as subsets of native usage", async () => {
    const result = await resultOf(await start("cached"));
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.usage).toMatchObject({ input: 60, output: 20, cacheRead: 40, totalTokens: 120 });
  });
  caseTest("T25", "denies invalid, foreign, revoked and unknown-dollar calls without ambient-key fallback", async () => {
    for (const [id, apiKey] of [["invalid", "clawrouter-live-abliteration_m0_high-invalid"], ["foreign", key("foreign")], ["revoked", key("revoked")], ["unpriced", key("unpriced")]]) {
      const result = await resultOf(await start(id, models[0], { apiKey }));
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).not.toMatch(/fixture-secret|must-not-fallback|fixture-upstream/);
    }
  });
  caseTest("T26", "retains embedded errors without replay", async () => {
    const result = await resultOf(await start("error"));
    expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("synthetic-upstream-error");
  });
  caseTest("T27", "cancels the actual native SDK stream after partial delivery", async () => {
    const controller = new AbortController(), stream = await start("cancel", models[0], { signal: controller.signal });
    mark("abort");
    for await (const event of stream) if (event.type === "text_delta") { controller.abort(); break; }
    const result = await resultOf(stream); expect(controller.signal.aborted).toBe(true); expect(["aborted", "error"]).toContain(result.stopReason);
  });
});
