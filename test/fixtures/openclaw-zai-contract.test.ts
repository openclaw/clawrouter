import { stream, streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { createEmptyPluginRegistry, registerSingleProviderPlugin, registerProviderPlugin, requireRegisteredProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
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
import { withPluginRuntimeGenerationRegistryScope } from "../../src/plugins/runtime/generation-state.js";
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

function nativeControlCases() {
  return ["success", "preabort", "cancel", "embedded"].map(outcome => ({
    provider: "zai", binding: "ZAI_API_KEY", base: "https://api.z.ai/api/paas/v4", models: ["glm-5.3"], model: "glm-5.3",
    id: `control_${outcome}`, simple: false, credential: "grant", route: "native", outcome,
  }));
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

function originalLifetime(options: { sdkQualified?: (kind: string) => boolean } = {}) {
  const operations: any[] = [], readers: any[] = [], acquisitions: any[] = [], restores: Array<() => void> = [];
  const bodies = new WeakMap(), acquired = new WeakMap(), failures: unknown[] = []; let sequence = 0;
  const tick = () => ++sequence;
  const snapshot = (signal: AbortSignal | undefined) => ({ aborted: signal?.aborted === true, reason: signal?.reason });
  function signalState(signal: AbortSignal | undefined) {
    const state = { signal, initial: snapshot(signal), event: 0, reason: undefined as unknown };
    if (signal) {
      const abort = () => { state.event = tick(); state.reason = signal.reason; };
      signal.addEventListener("abort", abort, { once: true });
      restores.push(() => signal.removeEventListener("abort", abort));
    }
    return state;
  }
  function bind(owner: any, callerSignal?: AbortSignal) {
    owner.caller = signalState(callerSignal); owner.delta = 0; owner.terminal = undefined;
    owner.ordinal = acquisitions.filter(row => row.owner === owner).length;
    return owner;
  }
  function record(kind: string, original: any, owner: any, reader?: any, acquisition?: any, invocation?: any) {
    const entry = { kind, original, owner, reader, acquisition, state: "pending", rejected: false, reason: undefined as unknown,
      invoked: invocation?.at ?? tick(), settled: 0, receiver: invocation?.receiver, operands: invocation?.args, guardInvoke: invocation?.signal ?? snapshot(acquisition?.input.signal), guardReject: undefined as any };
    operations.push(entry);
    // Worker-only owner binding: keep additional original reader observations
    // in the originating request's I/O context. SDK owners have no waitUntil.
    if (owner?.waitUntil && ["read", "closed", "cancel"].includes(kind)) {
      try { owner.waitUntil(original); } catch (error) { failures.push(error); }
    }
    Promise.resolve(original).then(value => {
      entry.state = "fulfilled"; entry.settled = tick();
      if (kind === "read" && reader) {
        if (value.done) reader.eof = true;
        else if (value.value instanceof Uint8Array && value.value.byteLength > 0) reader.nonempty ||= entry.settled;
      }
    }, error => {
      entry.state = "rejected"; entry.rejected = true; entry.reason = error; entry.settled = tick();
      entry.guardReject = snapshot(acquisition?.input.signal);
    });
    return original;
  }
  function invoke(kind: string, fn: (...args: any[]) => any, receiver: any, args: any[], owner: any, reader?: any, acquisition?: any) {
    const invocation = { at: tick(), signal: snapshot(acquisition?.input.signal), receiver, args };
    try { return record(kind, Reflect.apply(fn, receiver, args), owner, reader, acquisition, invocation); }
    catch (error) { failures.push(error); throw error; }
  }
  function patch(target: any, key: PropertyKey, replacement: any) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
    restores.push(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key]; });
  }
  function observeResponse(response: Response, owner: any, acquisition?: any) {
    const body = response.body;
    if (!body) return;
    if (bodies.has(body)) { if (bodies.get(body) !== owner) failures.push(new Error("Ambiguous original body owner")); return; }
    bodies.set(body, owner);
    const getReader = body.getReader, cancel = body.cancel;
    patch(body, "cancel", function (...args: any[]) { return invoke("cancel", cancel, this, args, owner, undefined, acquisition); });
    patch(body, "getReader", function (...args: any[]) {
      let reader; try { reader = Reflect.apply(getReader, this, args); } catch (error) { failures.push(error); throw error; }
      const entry = { reader, body, owner, acquisition, eof: false, nonempty: 0, unlocks: 0, unlocked: 0, unlockInvoke: 0, unlockReturn: 0 };
      readers.push(entry); record("closed", reader.closed, owner, entry, acquisition);
      const read = reader.read, cancelReader = reader.cancel, unlock = reader.releaseLock;
      patch(reader, "read", function (...operands: any[]) { return invoke("read", read, this, operands, owner, entry, acquisition); });
      patch(reader, "cancel", function (...operands: any[]) { return invoke("cancel", cancelReader, this, operands, owner, entry, acquisition); });
      patch(reader, "releaseLock", function (...operands: any[]) {
        entry.unlocks++; entry.unlockInvoke ||= tick();
        try { const result = Reflect.apply(unlock, this, operands); entry.unlocked++; entry.unlockReturn = tick(); return result; }
        catch (error) { failures.push(error); throw error; }
      });
      return reader;
    });
  }
  function acquire(fn: (...args: any[]) => any, receiver: any, args: any[], owner: any) {
    // Observe the public guard input before forwarding; this is not its private combined signal.
    const params = args[0], input = signalState(params?.signal ?? params?.init?.signal);
    const entry = { owner, input, ordinal: acquisitions.length, returned: false, released: 0, releaseFulfilled: 0, releaseEntry: 0, releaseReturn: 0, releaseSettlement: 0 };
    acquisitions.push(entry);
    const invocation = { at: tick(), signal: snapshot(input.signal), receiver, args };
    let pending;
    try { pending = Reflect.apply(fn, receiver, args); } catch (error) { failures.push(error); throw error; }
    if (acquired.has(pending)) { failures.push(new Error("Duplicate original acquisition")); return pending; }
    acquired.set(pending, entry); record("acquire", pending, owner, undefined, entry, invocation);
    pending.then((result: any) => {
      try {
        entry.returned = true; observeResponse(result.response, owner, entry);
        const release = result.release;
        patch(result, "release", function (...operands: any[]) {
          entry.released++; entry.releaseEntry ||= tick();
          const original = invoke("release", release, this, operands, owner, undefined, entry);
          entry.releaseReturn = tick();
          Promise.resolve(original).then(() => { entry.releaseFulfilled++; entry.releaseSettlement = tick(); }, () => {});
          return original;
        });
      } catch (error) { failures.push(error); }
    }, () => {});
    return pending;
  }
  function observeStream(stream: any, owner: any) {
    const iterator = stream[Symbol.asyncIterator], result = stream.result;
    patch(stream, Symbol.asyncIterator, function (...args: any[]) {
      const originalIterator = Reflect.apply(iterator, this, args), next = originalIterator.next;
      patch(originalIterator, "next", function (...operands: any[]) {
        const original = Reflect.apply(next, this, operands);
        original.then((value: any) => { if (!value.done && value.value?.type === "text_delta" && typeof value.value.delta === "string" && value.value.delta.length) owner.delta ||= tick(); }, () => {});
        return original;
      });
      return originalIterator;
    });
    patch(stream, "result", function (...args: any[]) {
      const original = Reflect.apply(result, this, args);
      original.then((value: any) => { owner.terminal = { stopReason: value.stopReason, empty: Array.isArray(value.content) && value.content.length === 0, errorMatchesCaller: owner.caller?.signal?.aborted === true && typeof owner.caller.signal.reason?.message === "string" && value.errorMessage === owner.caller.signal.reason.message, at: tick() }; }, () => {});
      return original;
    });
    return stream;
  }
  async function settle() {
    let seen = -1;
    while (seen !== operations.length) { seen = operations.length; await Promise.allSettled(operations.map(op => op.original)); }
  }
  function structuralErrors() {
    const errors = [...failures];
    if (operations.some(op => op.state === "pending") || readers.some(row => row.unlocks !== row.unlocked || !row.unlocked || row.body.locked)
      || acquisitions.some(row => row.returned && (row.released !== row.releaseFulfilled || row.released === 0))) errors.push(new Error("Original lifetime is not retired"));
    return errors;
  }
  function cancellationWitness(reader: any) {
    const { owner, acquisition } = reader;
    if (!options.sdkQualified || !owner?.verified || owner.role !== "chat" || owner.outcome !== "cancel" || owner.expired
      || !reader || !acquisition || reader.owner !== owner || reader.acquisition !== acquisition || acquisition.owner !== owner
      || !acquisition.returned || !owner.caller || owner.caller.initial.aborted || acquisition.input.initial.aborted
      || !reader.nonempty || !owner.delta || reader.nonempty > owner.delta || owner.delta >= owner.caller.event
      || owner.caller.event > acquisition.input.event || !acquisition.input.event || acquisition.input.event >= acquisition.releaseEntry
      || owner.terminal?.stopReason !== "aborted"
      || operations.some(op => op.owner === owner && op.rejected && op.settled < owner.caller.event)
      || readers.filter(row => row.owner === owner && row.nonempty).length !== 1) return false;
    return true;
  }
  function cancellationCandidate(operation: any) {
    const { reader, acquisition } = operation;
    if (!reader || !cancellationWitness(reader)) return false;
    if (!operation.rejected || operation.reason === undefined || operation.reason === null
      || !["read", "closed", "cancel"].includes(operation.kind)) return false;
    const reason = operation.reason;
    const same = (op: any) => op.reader === reader && op.acquisition === acquisition && op.rejected && op.reason === reason
      && op.guardReject?.aborted === true && op.guardReject.reason === reason;
    if (!same(operation) || !operations.some(op => op.kind === "read" && same(op)) || !operations.some(op => op.kind === "closed" && same(op))) return false;
    // Callback order after unlock does not establish the stream's internal error time.
    return operation.kind !== "cancel" || operation.invoked < reader.unlockInvoke
      && operation.guardInvoke.aborted && operation.guardInvoke.reason === reason;
  }
  async function join() {
    await settle();
    const errors = structuralErrors();
    for (const op of operations) if (op.rejected && !(options.sdkQualified?.(op.kind) === true && cancellationCandidate(op))) errors.push(op.reason);
    if (errors.length) throw new AggregateError(errors, "Original lifetime failed");
  }
  function inspect() { return { structural: structuralErrors(), rejected: operations.filter(op => op.rejected), candidates: operations.filter(cancellationCandidate), cancelWitnesses: readers.filter(cancellationWitness) }; }
  function restore() { const errors: unknown[] = []; for (const undo of restores.splice(0).reverse()) try { undo(); } catch (error) { errors.push(error); } if (errors.length) throw new AggregateError(errors, "Observer restore failed"); }
  return { failure: (error: unknown) => failures.push(error), bind, record, acquire, observeResponse, observeStream, settle, inspect, join, restore, operations, readers, acquisitions,
    summary: () => ({ operations: operations.length, pending: operations.filter(op => op.state === "pending").length, rejected: operations.filter(op => op.rejected).length, readers: readers.length, releases: acquisitions.reduce((n, row) => n + row.releaseFulfilled, 0) }) };
}

function requirePreabortOutcome(life: ReturnType<typeof originalLifetime>, owner: any) {
  if (owner.outcome !== "preabort" || !owner.caller?.signal || !owner.caller.initial.aborted
    || owner.terminal?.stopReason !== "error" || owner.terminal.empty !== true || owner.terminal.errorMatchesCaller !== true
    || life.acquisitions.some(row => row.owner === owner) || life.readers.some(row => row.owner === owner)) throw new Error("Original preabort contract missing");
}
async function requireNativeControlLifetime(life: ReturnType<typeof originalLifetime>, owner: any, outcome: string) {
  await life.settle();
  const proof = life.inspect();
  if (proof.structural.length) throw new AggregateError(proof.structural, "Control structural failure");
  if (outcome === "preabort") requirePreabortOutcome(life, owner);
  else {
    if (!owner.verified || life.acquisitions.length !== 1 || !life.acquisitions[0].returned || life.readers.length !== 1) throw new Error("Control original acquisition missing");
    if (outcome === "success" && (owner.terminal?.stopReason !== "stop" || !life.readers[0].nonempty || !life.readers[0].eof || proof.rejected.length)) throw new Error("Control original EOF missing");
    if (outcome === "cancel" && (proof.cancelWitnesses.length !== 1 || proof.candidates.length !== proof.rejected.length)) throw new Error("Control bound cancellation missing");
    if (outcome === "embedded" && (owner.caller?.signal || owner.terminal?.stopReason !== "error" || proof.candidates.length)) throw new Error("Provider error is not caller cancellation");
  }
  // Controls assert the unchanged strict verdict, including defined/undefined errors.
  let rejected = false, reason: any;
  try { await life.join(); } catch (error) { rejected = true; reason = error; }
  if (rejected !== (proof.rejected.length > 0) || rejected && (!(reason instanceof AggregateError) || reason.errors.length !== proof.rejected.length || reason.errors.some((error: unknown, i: number) => error !== proof.rejected[i].reason))) throw new Error("Control strict verdict mismatch");
  return outcome === "cancel" ? proof.candidates.map(op => op.kind) : [];
}
const controlReceiptPrefix = "ZAI_NATIVE_CONTROL_V1 ";
function controlReceipt(text: unknown) {
  if (typeof text !== "string" || text.length > 2 * 1024 * 1024) return [];
  return text.split("\n").filter(line => line.startsWith(controlReceiptPrefix) && line.length <= 256).map(line => {
    const value = JSON.parse(line.slice(controlReceiptPrefix.length));
    if (!value || Object.keys(value).sort().join() !== "id,mask,v" || value.v !== 1 || !nativeControlCases().some(row => row.id === value.id) || !Number.isInteger(value.mask) || value.mask < 0 || value.mask > 7 || value.id !== "control_cancel" && value.mask !== 0) throw new Error("Invalid native control receipt");
    return { v: 1, id: value.id, mask: value.mask };
  });
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
        ...[...regionalCases(), ...regionalNegativeCases(), ...nativeControlCases()].map(row => row.id)];
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
const nativeQualification = new Set<string>(), qualifiedRejectionKinds = new Set<string>();
const sdkQualified = (kind: string) => nativeQualification.size === 4 && qualifiedRejectionKinds.has(kind);
let lifetime: ReturnType<typeof originalLifetime>;
let activeCase = "original";
const expectedRequests = new Map<string, any>();
function bind(id: string, role: string, path: string, apiKey: string, optional = false, callerSignal?: AbortSignal, outcome = "success") {
  const owner = lifetime.bind({ caseId: id, role, path, credential: apiKey, optional, outcome, verified: false }, callerSignal);
  expectedRequests.set(`${apiKey}:${path}`, owner); return owner;
}
function observeGuard(original: any, receiver: any, args: any[], role: "chat" | "catalog") {
  try {
  const options = args[0], url = new URL(options.url), headers = new Headers(options.init?.headers);
  const expected = expectedRequests.get(`${headers.get("authorization")?.replace(/^Bearer /, "")}:${url.pathname}`);
  if (!expected || url.origin !== origin) throw new Error("Unexpected original SDK acquisition");
  if (role === "catalog" && expected.role === "chat") return Reflect.apply(original, receiver, args);
  if (expected.role !== role || (options.init?.method ?? "GET") !== (role === "chat" ? "POST" : "GET")) throw new Error("Original SDK role or method mismatch");
  if (expected.verified) throw new Error("Duplicate original SDK acquisition");
  expected.verified = true;
  return lifetime.acquire(original, receiver, args, expected);
  } catch (error) { lifetime.failure(error); throw error; }
}
function sdkFailure(phase: string, error: unknown) {
  try {
    const protocol = diagnosticProtocol(nodeTypes.isProxy), summary = lifetime?.summary();
    const record = protocol.validate({ v: 1, layer: "sdk", caseId: activeCase, phase, category: error === undefined ? "undefined" : error === null ? "null" : "failure", ...(summary ? { pending: summary.pending, rejected: summary.rejected, operations: summary.operations } : {}) });
    if (record) process.stdout.write(protocol.prefix + JSON.stringify(record) + "\n");
  } catch { /* Reporting never replaces an original failure. */ }
}
async function withSdkObservation(body: () => unknown, control?: string) {
    lifetime = originalLifetime({ sdkQualified: control ? () => false : sdkQualified }); expectedRequests.clear(); activeCase = control ?? "original";
    let controlKinds: string[] = [];
    const stage = async (phase: string, run: () => any) => { try { return await run(); } catch (error) { sdkFailure(phase, error); throw error; } };
    await allFailures(async () => {
      await stage("setup", () => {
        clearLiveCatalogCacheForTests();
        vi.spyOn(transport, "fetchWithProviderHttpGuard").mockImplementation(function (...args) { return observeGuard(originalInferenceGuard, this, args, "chat"); });
        vi.spyOn(guard, "fetchWithSsrFGuard").mockImplementation(function (...args) { return observeGuard(originalCatalogGuard, this, args, "catalog"); });
      });
      return stage("body", body);
    }, [() => stage("join", async () => {
      for (const request of expectedRequests.values()) if (request.outcome === "preabort") requirePreabortOutcome(lifetime, request);
      if (control) controlKinds = await verifyNativeControl(control);
      else await lifetime.join();
      for (const request of expectedRequests.values()) if (!request.optional) expect(lifetime.acquisitions.filter(row => row.owner === request).length).toBe(1);
    }), () => stage("restore", () => lifetime.restore()),
      () => stage("restore", () => vi.restoreAllMocks()), () => stage("restore", () => clearLiveCatalogCacheForTests())]);
    if (control) {
      if (nativeQualification.has(control)) throw new Error("Duplicate native control completion");
      nativeQualification.add(control); for (const kind of controlKinds) qualifiedRejectionKinds.add(kind);
      const mask = ["read", "closed", "cancel"].reduce((n, kind, i) => n | (controlKinds.includes(kind) ? 1 << i : 0), 0);
      process.stdout.write(controlReceiptPrefix + JSON.stringify({ v: 1, id: control, mask }) + "\n");
    }
}
function it(title: string, body: () => unknown) {
  productIt(title, () => withSdkObservation(body));
}

async function run(id: string, modelId = models[0], simple = true, reasoning: "off" | "low" | "high" = "high", invalid = false, signal?: AbortSignal) {
  activeCase = id;
  const owner = bind(id, "chat", "/v1/native/zai/chat/completions", invalid ? "clawrouter-live-zai_m0_simple-invalid" : `clawrouter-live-zai_${id}-fixture-secret`, signal?.aborted === true, signal, id === "aborted" ? "preabort" : "success");
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
    const replayRegistry = createEmptyPluginRegistry();
    replayRegistry.providers.push({ pluginId: "zai", provider, source: "test" });
    return withPluginRuntimeGenerationRegistryScope(replayRegistry, () => sanitizeSessionHistory({ provider: model.provider, modelId, modelApi: model.api, model, policy, env: {}, config: {}, workspaceDir: state.workspaceDir, sessionId: `zai-${id}`,
      sessionManager: makeInMemorySessionManager([makeModelSnapshotEntry({ timestamp: 0, provider: model.provider, modelApi: model.api, modelId })]), messages: history }));
  });
  const context: Context = { systemPrompt: "Synthetic instructions", messages: convertToLlm(messages), tools: [{ name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: {} } }] };
  const thinkingLevel = id.startsWith("default") ? undefined : reasoning;
  const extraParams = provider.prepareExtraParams?.({ provider: model.provider, modelId,
    extraParams: id === "preserve" ? { preserveThinking: true } : id === "tool_off" ? { tool_stream: false } : {} } as never);
  expect(extraParams?.tool_stream).toBe(id === "tool_off" ? false : true);
  const wrap = simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({ provider: model.provider, modelId, model, streamFn: simple ? streamSimple : stream, thinkingLevel, extraParams });
  expect(wrapped).toBeDefined();
  return lifetime.observeStream(wrapped!(model, context, { apiKey: invalid ? "clawrouter-live-zai_m0_simple-invalid" : `clawrouter-live-zai_${id}-fixture-secret`, maxTokens: 128,
    ...(thinkingLevel === undefined ? {} : { reasoning: thinkingLevel }), signal }), owner).result();
}

async function verifyNativeControl(id: string) {
  const row = nativeControlCases().find(row => row.id === id)!;
  const owners = [...expectedRequests.values()]; expect(owners.length).toBe(1);
  const kinds = await requireNativeControlLifetime(lifetime, owners[0], row.outcome);
  // The actual Worker joins this control's own original work before replying.
  const response = await fetch(origin + "/fixture/control?id=" + id, { signal: AbortSignal.timeout(15_000) });
  const proof = await response.json(); expect(response.status).toBe(200);
  const expected = row.outcome === "preabort" ? 0 : 1;
  expect(proof.ingress).toBe(expected); expect(proof.calls).toBe(expected);
  for (const side of [proof.router, proof.upstream]) { expect(side.pending).toBe(0); expect(side.rejected).toBe(0); }
  expect(proof.expired).toBe(false);
  return kinds;
}

describe("genuine registered Z.AI native lifetime controls", { concurrent: false }, () => {
  for (const row of nativeControlCases()) productIt(row.id, () => withSdkObservation(async () => {
    activeCase = row.id;
    if (row.outcome === "preabort") {
      const caller = new AbortController(); caller.abort(new DOMException("Synthetic control cancellation", "AbortError"));
      const result = await (await regional(row, caller.signal)).result();
      expect(result.stopReason).toBe("error"); expect(result.errorMessage).toBe(caller.signal.reason.message); expect(result.content).toEqual([]);
    } else if (row.outcome === "cancel") {
      const caller = new AbortController(), original = await regional(row, caller.signal); let partial = false;
      for await (const event of original) if (event.type === "text_delta" && event.delta.length) { partial = true; caller.abort(new DOMException("Synthetic control cancellation", "AbortError")); break; }
      expect(partial).toBe(true); expect((await original.result()).stopReason).toBe("aborted");
    } else {
      const result = await (await regional(row)).result(); expect(result.stopReason).toBe(row.outcome === "success" ? "stop" : "error");
      if (row.outcome === "success") expect(result.content).toContainEqual({ type: "text", text: "synthetic-answer" });
    }
  }, row.id));
});

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
  const owner = bind(row.id, "chat", path, apiKey, signal?.aborted === true, signal, row.outcome);
  const context: Context = { messages: [{ role: "user", content: `synthetic zai_${row.id}`, timestamp: 1 }] };
  const extraParams = row.route === "native" ? provider.prepareExtraParams?.({ provider: "zai", modelId: row.model, extraParams: {} }) : undefined;
  const wrapper = row.simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  expect(wrapper).toBeTypeOf("function");
  const wrapped = wrapper({ provider: model.provider, modelId: model.id, model, streamFn: row.simple ? streamSimple : stream, thinkingLevel: "high", extraParams });
  expect(wrapped).toBeTypeOf("function");
  return lifetime.observeStream(wrapped(model, context, { apiKey, maxTokens: 128, reasoning: "high", signal }), owner);
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
