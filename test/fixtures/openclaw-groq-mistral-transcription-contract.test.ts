import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { upsertAuthProfileAsync, type OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import * as guardedFetch from "../../src/infra/net/fetch-guard.js";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

type Case = { id: string; provider: "groq" | "mistral"; model: string; route: string; scenario: string };
const sourceHead = "6de028c4e960db91bdf87882989cb6756a6429c3";
const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const cases = JSON.parse(process.env.CLAWROUTER_CONTRACT_CASES!) as Case[];
const originalFetch = globalThis.fetch;
const undici = createRequire(import.meta.url)("undici/index.js") as typeof import("undici");
const originalRuntimeFetch = undici.fetch;
const originalGuard = guardedFetch.fetchWithSsrFGuard;
const token = (row: Case, rotated = false) => `clawrouter-live-${row.id}-${rotated ? "rotated-secret" : "fixture-secret"}`;

async function finishOwned(failures: unknown[], operations: Array<() => unknown>): Promise<void> {
  for (const operation of operations) {
    try { await operation(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "transcription body or owned cleanup failed");
}
// END owned cleanup

type Operation = { kind: string; original: Promise<unknown>; allowedReadAbort: boolean };
type Transport = {
  path: string; credential: string; status?: number; operations: Operation[];
  closeStarted: Promise<void>; closeCalls: Array<{ depth: number; value?: unknown; failure?: { error: unknown } }>;
  readers: Array<{ body: ReadableStream<Uint8Array>; unlocked: boolean }>;
};
function observe(list: Operation[], kind: string, original: Promise<unknown>, signal?: AbortSignal | null) {
  const item: Operation = { kind, original, allowedReadAbort: false }; list.push(item);
  void original.then(undefined, error => { item.allowedReadAbort = kind === "read" && signal?.aborted === true && error === signal.reason; });
  return original;
}
async function joinOriginal(transport: Transport): Promise<void> {
  await transport.closeStarted;
  const failures: unknown[] = [];
  const roots = transport.closeCalls.filter(call => call.depth === 0);
  if (roots.length !== 1) failures.push(new Error("original dispatcher close must run once"));
  for (const call of roots) {
    if (call.failure) failures.push(call.failure.error);
    else if (!call.value || typeof (call.value as Promise<unknown>).then !== "function") failures.push(new Error("missing original dispatcher close promise"));
    else { try { expect(await call.value).toBeNull(); } catch (error) { failures.push(error); } }
  }
  const outcomes = await Promise.allSettled(transport.operations.map(item => item.original));
  outcomes.forEach((outcome, index) => { if (outcome.status === "rejected" && !transport.operations[index]!.allowedReadAbort) failures.push(outcome.reason); });
  for (const reader of transport.readers) if (!reader.unlocked || reader.body.locked) failures.push(new Error("original response reader is still owned"));
  await finishOwned(failures, []);
}
async function control(action: string, row: Case): Promise<Record<string, unknown>> {
  const response = await originalFetch(`${origin}/fixture/${action}/${row.id}`, { method: "POST", headers: { "x-fixture-control": "transcription" } });
  const value = await response.json(); expect(response.status).toBe(200); return value;
}
function wav(): Buffer {
  const bytes = Buffer.alloc(2048, 42);
  bytes.write("RIFF"); bytes.writeUInt32LE(2040, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(2004, 40); return bytes;
}

async function runCase(row: Case): Promise<void> {
  const failures: unknown[] = [], transports: Transport[] = [], unexpected: unknown[] = [];
  let callbackFailure: { error: unknown } | undefined;
  try {
    await withOpenClawTestState({ prefix: "openclaw-native-transcription-", env: { CLAWROUTER_API_KEY: undefined, GROQ_API_KEY: "must-not-fallback", MISTRAL_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback" } }, async state => {
      const bodyFailures: unknown[] = [];
      let pending: Promise<{ value: unknown } | { error: unknown }> | undefined;
      const caller = new AbortController(), callerReason = new Error("original transcription caller abort");
      try {
        expect(process.env.CLAWROUTER_CONTRACT_SOURCE_HEAD).toBe(sourceHead);
        expect(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sourceHead);
        expect(cases).toHaveLength(30);
        const observeFetch = async (input: RequestInfo | URL, supplied?: RequestInit): Promise<Response> => {
          const init = supplied as RequestInit & { dispatcher?: import("undici").Dispatcher };
          const url = new URL(input instanceof Request ? input.url : String(input));
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          const credential = headers.get("authorization") ?? "";
          if (url.origin !== origin || url.search || !["/v1/catalog", row.route].includes(url.pathname)
            || ![`Bearer ${token(row)}`, `Bearer ${token(row, true)}`].includes(credential) || headers.has("x-api-key") || !init?.dispatcher) {
            const error = new Error("unexpected registered transcription transport"); unexpected.push(error); throw error;
          }
          const method = init.method ?? (input instanceof Request ? input.method : "GET");
          expect(method).toBe(url.pathname === "/v1/catalog" ? "GET" : "POST");
          const dispatcher = init.dispatcher, close = dispatcher.close;
          let started!: () => void, depth = 0;
          const transport: Transport = { path: url.pathname, credential, operations: [], closeStarted: new Promise(resolve => { started = resolve; }), closeCalls: [], readers: [] };
          transports.push(transport);
          vi.spyOn(dispatcher, "close").mockImplementation(function(this: typeof dispatcher, ...args: unknown[]) {
            const call: Transport["closeCalls"][number] = { depth }; transport.closeCalls.push(call); depth++;
            try { const value = Reflect.apply(close, this, args); call.value = value; return value; }
            catch (error) { call.failure = { error }; throw error; }
            finally { depth--; if (call.depth === 0) started(); }
          } as typeof dispatcher.close);
          const response = await Reflect.apply(originalRuntimeFetch, undici, [input, init]) as unknown as Response;
          transport.status = response.status;
          const body = response.body;
          if (body) {
            const getReader = body.getReader, cancelBody = body.cancel;
            vi.spyOn(body, "cancel").mockImplementation(function(this: typeof body, reason?: unknown) {
              return observe(transport.operations, "cancel", Reflect.apply(cancelBody, this, [reason]), init.signal) as Promise<void>;
            });
            vi.spyOn(body, "getReader").mockImplementation(function(this: typeof body, ...args: unknown[]) {
              const reader = Reflect.apply(getReader, this, args) as ReadableStreamDefaultReader<Uint8Array>;
              const state = { body, unlocked: false }; transport.readers.push(state);
              const read = reader.read, cancel = reader.cancel, unlock = reader.releaseLock;
              vi.spyOn(reader, "read").mockImplementation(function(this: typeof reader) { return observe(transport.operations, "read", Reflect.apply(read, this, []), init.signal) as ReturnType<typeof read>; });
              vi.spyOn(reader, "cancel").mockImplementation(function(this: typeof reader, reason?: unknown) { return observe(transport.operations, "cancel", Reflect.apply(cancel, this, [reason]), init.signal) as Promise<void>; });
              vi.spyOn(reader, "releaseLock").mockImplementation(function(this: typeof reader) { Reflect.apply(unlock, this, []); state.unlocked = true; });
              return reader;
            } as typeof body.getReader);
          }
          return response;
        };
        // Plain pass-through keeps the original guard's genuine dispatcher path.
        vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
          if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw new Error("direct vendor fetch is forbidden");
          return originalFetch(input, init);
        });
        vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: observeFetch });
        const observeGuard: typeof originalGuard = async options => {
          const result = await originalGuard(options);
          const transport = transports.findLast(item => item.path === new URL(String(options.url)).pathname && item.credential === new Headers(options.init?.headers).get("authorization"));
          // Supplemental across module graphs; original transport is mandatory.
          if (!transport) return result;
          return { ...result, release: () => observe(transport.operations, "release", result.release()) as Promise<void> };
        };
        vi.spyOn(guardedFetch, "fetchWithSsrFGuard").mockImplementation(observeGuard);
        vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(observeGuard);
        const filePath = state.path(`${row.id}.wav`); await writeFile(filePath, wav());
        const cfg: OpenClawConfig = { plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
          models: { providers: { clawrouter: { baseUrl: origin + "/v1", apiKey: token(row), request: { allowPrivateNetwork: true }, models: [] } } },
          tools: { media: { models: [{ provider: "clawrouter", model: row.model, capabilities: ["audio"] }], audio: { enabled: true } } } };
        const agentDir = state.agentDir();
        const provider = cfg.models!.providers!.clawrouter!, model = cfg.tools!.media!.models![0]!;
        const params = { cfg, filePath, agentDir, mime: "audio/wav", language: "en", ...(row.provider === "groq" ? { prompt: "Synthetic café 東京" } : {}) };
        const call = () => transcribeAudioFile(params, { signal: caller.signal, assertCurrent: () => caller.signal.throwIfAborted() });
        if (row.scenario === "success") {
          await upsertAuthProfileAsync({ agentDir, profileId: "clawrouter:audio", credential: { type: "api_key", provider: "clawrouter", key: token(row) } });
          await upsertAuthProfileAsync({ agentDir, profileId: `${row.provider}:audio`, credential: { type: "api_key", provider: row.provider, key: "must-not-fallback" } });
          model.profile = `${row.provider}:audio`; await expect(call()).rejects.toThrow(/unavailable for ClawRouter/);
          expect(transports).toHaveLength(0); model.profile = "clawrouter:audio";
        }
        if (row.scenario === "rotation") {
          await control("rotate", row); await expect(call()).rejects.toThrow();
          expect(transports.filter(value => value.path === row.route)).toHaveLength(0);
          expect(transports.at(-1)?.status).toBe(401); provider.apiKey = token(row, true);
        }
        if (row.scenario === "missing_key") delete provider.apiKey;
        if (row.scenario === "unsafe_headers") provider.headers = { "x-api-key": "must-not-replace" };
        if (row.scenario === "invalid_input") params.prompt = row.provider === "mistral" ? "unsupported" : "x".repeat(4097);
        if (row.scenario === "preabort") caller.abort(callerReason);
        if (row.scenario === "abort") {
          pending = call().then(value => ({ value }), error => ({ error }));
          const deadline = Date.now() + 10000;
          let held = false;
          while (Date.now() < deadline) {
            const state = await control("state", row);
            if ((state.calls as Array<{ id: string }>).some(value => value.id === row.id) && state.held === 1) { held = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(held).toBe(true); caller.abort(callerReason);
          const outcome = await pending; expect("error" in outcome).toBe(true);
          // Caller failure is separate from this controlled original Worker abort.
          // No claim that the client disconnect propagated across the service binding.
        } else if (["success", "rotation"].includes(row.scenario)) {
          expect(await call()).toMatchObject({ text: "café 東京 🦊", provider: "clawrouter", model: row.model });
        } else await expect(call()).rejects.toThrow();
        const uploads = transports.filter(value => value.path === row.route);
        expect(uploads).toHaveLength(["success", "rotation", "stale", "malformed", "partial", "error", "redirect", "truncated", "abort"].includes(row.scenario) ? 1 : 0);
        if (row.scenario === "stale") expect(uploads[0]?.status).toBe(403);
      } catch (error) { bodyFailures.push(error); }
      try {
        await finishOwned(bodyFailures, [
          () => { if (!caller.signal.aborted) caller.abort(callerReason); },
          () => row.scenario === "abort" && control("abort", row),
          async () => { if (pending) { const result = await pending; expect("error" in result).toBe(true); } },
          ...transports.map(transport => () => joinOriginal(transport)),
          () => control("join", row),
          () => { if (unexpected.length) throw new AggregateError(unexpected, "unexpected transport"); },
        ]);
      } catch (error) { callbackFailure = { error }; throw error; }
    });
  } catch (error) {
    if (callbackFailure && error !== callbackFailure.error) failures.push(callbackFailure.error);
    failures.push(error);
  }
  await finishOwned(failures, [() => vi.restoreAllMocks(), () => vi.unstubAllGlobals(), () => vi.unstubAllEnvs()]);
}

describe("registered native Groq/Mistral transcription against shipping Worker", () => {
  it.each(cases)("$id", runCase, 30000);
});
