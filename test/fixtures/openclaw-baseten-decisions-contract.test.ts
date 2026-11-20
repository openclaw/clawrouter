import "openclaw/plugin-sdk/compiled-subprocess-testing";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { activateDecisionRegistry, resetDecisionTestRuntime } from "../../src/agents/decision-inference.test-support.js";
import { acquireAgentRunPreparedModelRuntime } from "../../src/agents/prepared-model-runtime.js";
import { resolveAgentDir } from "../../src/agents/agent-scope.js";
import { createDecisionTool } from "../../src/agents/tools/decision-tool.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
expect(process.env.CLAWROUTER_BASETEN_CONTRACT).toBe("baseten.systemone.v1");
const guardContract = process.env.CLAWROUTER_BASETEN_GUARD_CONTRACT!;
expect(guardContract).toMatch(/^[a-f0-9]{64}$/);
const guardKey = Symbol.for("clawrouter.baseten.guard." + guardContract);
const models = ["decision-models/baseten-elephant-9b-latest", "decision-models/baseten-mammoth-27b-latest", "decision-models/baseten-joey-2b-latest"];
const ids = ["elephant", "mammoth", "joey", "text", "rotated", "unmetered", "malformed", "usage", "overflow", "provider_error", "invalid", "foreign", "budget", "unpriced", "revoked", "stale", "foreign_offer", "wrong_format", "preabort", "unsupported", "options_over"];
const blocked = new Set(["invalid", "foreign", "budget", "unpriced", "revoked", "stale", "foreign_offer", "wrong_format", "preabort", "unsupported", "options_over"]);
const failed = new Set(["malformed", "usage", "overflow", "provider_error"]);
const key = (id: string) => "clawrouter-live-baseten_" + id + "-fixture-secret";
const originalFetch = globalThis.fetch;
type GuardModule = { site: "catalog" | "decision"; faults: unknown[] };
const identities = new Map<string, { module: GuardModule; callee: Function }>();
let activeId: string | undefined;
let guardChannel: { modules: Set<GuardModule>; observe: typeof observeGuard } | undefined;
type Binding = { fn?: Function; receiver?: unknown; args?: unknown[] };
type Row = Binding & { kind: string; state: "pending" | "fulfilled" | "rejected"; error?: unknown; original?: Promise<unknown>; result?: unknown };
const rows: Row[] = [], tails: Promise<unknown>[] = [], acquisitions: { response: Response; releases: number }[] = [];
let retired: string | undefined;
const faults: unknown[] = [], readers: { body: ReadableStream<Uint8Array>; unlocks: number }[] = [];
function observe<T>(kind: string, original: Promise<T>, fulfilled?: (value: T) => void, binding: Binding = {}): Promise<T> {
  const row: Row = { kind, state: "pending", original, ...binding }; rows.push(row);
  tails.push(original.then(value => { row.state = "fulfilled"; row.result = value; try { fulfilled?.(value); } catch (error) { faults.push(error); } },
    error => { row.state = "rejected"; row.error = error; }));
  return original;
}
function call<T>(kind: string, fn: (...args: any[]) => Promise<T>, receiver: unknown, args: unknown[], fulfilled?: (value: T) => void): Promise<T> {
  let original: Promise<T>;
  try { original = Reflect.apply(fn, receiver, args); }
  catch (error) { rows.push({ kind, state: "rejected", error, fn, receiver, args }); throw error; }
  return observe(kind, original, fulfilled, { fn, receiver, args });
}
function installAcquisition(result: { response: Response; release: () => Promise<void> }) {
  const acquisition = { result, response: result.response, releases: 0 }; acquisitions.push(acquisition);
  const release = result.release;
  result.release = function (...releaseArgs) {
    acquisition.releases++;
    return call("release", release, this, releaseArgs);
  };
  const body = result.response.body;
  if (!body) return;
  const getReader = body.getReader;
  body.getReader = function (...readerArgs: []) {
    if (this !== body) faults.push(new Error("foreign body receiver"));
    const reader = Reflect.apply(getReader, this, readerArgs) as ReadableStreamDefaultReader<Uint8Array>;
    const owned = { body, unlocks: 0 }; readers.push(owned);
    observe("closed", reader.closed);
    const read = reader.read, cancel = reader.cancel, unlock = reader.releaseLock;
    reader.read = function (...a) { if (this !== reader) faults.push(new Error("foreign reader receiver")); return call("read", read, this, a); };
    reader.cancel = function (...a) { if (this !== reader) faults.push(new Error("foreign reader receiver")); return call("cancel", cancel, this, a); };
    reader.releaseLock = function (...a) { if (this !== reader) faults.push(new Error("foreign reader receiver")); const value = Reflect.apply(unlock, this, a); owned.unlocks++; return value; };
    return reader;
  } as typeof getReader;
}

function observeGuard(module: GuardModule, callee: Function, receiver: unknown, args: unknown[], returned: boolean, value: unknown) {
  expect(receiver).toBe(undefined); expect(args).toHaveLength(1); expect(typeof callee).toBe("function");
  expect(["catalog", "decision"]).toContain(module.site); expect(Array.isArray(module.faults)).toBe(true);
  const prior = identities.get(module.site);
  if (!prior) identities.set(module.site, { module, callee });
  else { expect(module).toBe(prior.module); expect(callee).toBe(prior.callee); }
  expect(activeId).toBeDefined();
  const own = (value: object, field: string) => { const d = Object.getOwnPropertyDescriptor(value, field); assert.ok(d && "value" in d); return d.value; };
  const input = args[0] as object, url = own(input, "url"), init = own(input, "init");
  expect(new URL(url).origin).toBe(origin);
  const headers = new Headers(init.headers);
  expect(headers.get("authorization")).toBe("Bearer " + key(activeId!));
  expect(headers.get("x-api-key")).toBeNull();
  expect(new URL(url).pathname).toBe(module.site === "catalog" ? "/v1/catalog" : "/v1/native/baseten/systemone");
  if (!returned) { rows.push({ kind: "guard", state: "rejected", error: value, fn: callee, receiver, args }); return; }
  observe("guard", value as Promise<{ response: Response; release: () => Promise<void> }>, installAcquisition, { fn: callee, receiver, args });
}
beforeEach(() => {
  activeId = retired = undefined;
  rows.length = tails.length = acquisitions.length = faults.length = readers.length = 0;
  identities.clear(); guardChannel = undefined;
  expect(Object.getOwnPropertyDescriptor(globalThis, guardKey)).toBeUndefined();
  guardChannel = Object.freeze({ modules: new Set<GuardModule>(), observe: observeGuard });
  Object.defineProperty(globalThis, guardKey, { configurable: true, value: guardChannel });
});
afterEach(async () => {
  const failures: unknown[] = [];
  const check = (fn: () => void) => { try { fn(); } catch (error) { failures.push(error); } };
  try { while (tails.length) for (const result of await Promise.allSettled(tails.splice(0))) if (result.status === "rejected") failures.push(result.reason); }
  catch (error) { failures.push(error); }
  check(() => expect(faults).toEqual([])); check(() => expect(rows.filter(row => row.state !== "fulfilled")).toEqual([]));
  check(() => expect(guardChannel?.modules.size).toBe(identities.size));
  for (const module of guardChannel?.modules ?? []) check(() => expect(module.faults).toEqual([]));
  for (const row of acquisitions) check(() => expect(row.releases).toBe(1));
  for (const row of readers) check(() => { expect(row.unlocks).toBe(1); expect(row.body.locked).toBe(false); });
  if (guardChannel) check(() => { expect(Object.getOwnPropertyDescriptor(globalThis, guardKey)?.value).toBe(guardChannel); expect(Reflect.deleteProperty(globalThis, guardKey)).toBe(true); });
  if (failures.length) throw new AggregateError(failures, "Baseten original guard, reader, release and observer retirement");
  if (retired) console.log("BASETEN_DECISIONS_RETIRED " + JSON.stringify({ id: retired, acquisitions: acquisitions.length, reads: rows.filter(row => row.kind === "read").length, readers: readers.length, releases: acquisitions.reduce((n, row) => n + row.releases, 0) }));
});
const batch = {
  state: { type: "json", value: { parcel: "synthetic damaged parcel" } },
  questions: {
    damaged: { type: "boolean", instructions: "Inspect", criteria: { true: { damaged: true }, false: "Intact" } },
    route: { type: "choice", criteria: { support: { team: "support" }, billing: "Billing" } },
    severity: { type: "score", criteria: ["Low", { level: "Medium" }, "High"] },
  },
};
async function preserve(body: () => Promise<void>, cleanup: () => Promise<void>) {
  const errors: unknown[] = [];
  try { await body(); } catch (error) { errors.push(error); }
  try { await cleanup(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Baseten case and registry retirement");
}
async function transition(id: string) {
  const response = await call("control.fetch", originalFetch, undefined, [origin + "/fixture/transition/" + id, { method: "POST" }]);
  expect(response.status).toBe(204);
  await call("control.body", response.arrayBuffer, response, []);
}
async function runCase(id: string) {
  activeId = id;
  const model = models[Math.max(0, ["elephant", "mammoth", "joey"].indexOf(id))];
  await withOpenClawTestState({ prefix: "router-baseten-decisions-", prepareProfileCatalog: false,
    env: { OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("..", import.meta.url)), OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      CLAWROUTER_API_KEY: undefined, BASETEN_API_KEY: "must-not-fallback", OPENAI_API_KEY: "must-not-fallback",
      HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, all_proxy: undefined } }, async state => {
    const config = { agents: { defaults: { workspace: path.join(state.root, "workspace"), decisionModel: "clawrouter/baseten/" + model } },
      models: { providers: { clawrouter: { baseUrl: origin + "/v1", auth: "api-key" as const, apiKey: key(id), models: [], request: { allowPrivateNetwork: true } } } },
      plugins: { allow: ["clawrouter"], slots: { memory: "none" } } };
    await preserve(async () => {
      const registry = await activateDecisionRegistry(config, { onlyPluginIds: ["clawrouter"], pluginSdkResolution: "src", preferBuiltPluginArtifacts: false, cache: false });
      expect(registry.decisionProviders.filter(row => row.host.provider.id === "clawrouter")).toHaveLength(1);
      await using prepared = await acquireAgentRunPreparedModelRuntime({ config, agentId: "main", agentDir: resolveAgentDir(config, "main"), workspaceDir: config.agents.defaults.workspace,
        loadRuntimePlugins: true, runtimePluginSelections: [{ provider: "clawrouter", modelId: "baseten/" + model, agentId: "main" }] }, { catalogMode: "live" });
      const offered = prepared.snapshot.modelCatalog.entries.filter(row => row.provider === "clawrouter" && models.some(model => row.id === "baseten/" + model));
      expect(offered.map(row => row.id).sort()).toEqual(models.map(model => "baseten/" + model).sort());
      for (const row of offered) { expect(row.api).toBeUndefined(); expect(row.contextWindow).toBeUndefined(); expect(row.inference).toMatchObject({ chat: false, decision: { protocol: "baseten-systemone", outputTokensPerQuestion: 1, limits: { maxTotalOptions: 512, maxStateAndQuestionTokens: 16384 } } }); }
      expect(identities.has("catalog")).toBe(true); expect(acquisitions.length).toBeGreaterThanOrEqual(1);
      await transition(id);
      const tool = createDecisionTool("main", { config, preparedModelRuntime: prepared.snapshot });
      expect(tool?.name).toBe("decision_evaluate"); expect(tool?.description).toContain("512 total options");
      const input = structuredClone(batch), controller = new AbortController();
      if (id === "text") (input as any).state = { type: "text", text: "synthetic damaged parcel" };
      if (id === "unsupported") (input as any).state = { type: "image", url: "https://example.com/synthetic.png" };
      if (id === "options_over") (input as any).questions = { route: { type: "choice", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), "Synthetic"])) } };
      if (id === "preabort") {
        const reason = new Error("synthetic pre-dispatch owner abort"); controller.abort(reason);
        const outcome = await tool!.execute("baseten-" + id, { contractVersion: 2, ...input }, controller.signal).then(value => ({ value }), error => ({ error }));
        assert.ok("error" in outcome); assert.strictEqual(outcome.error, reason);
      } else {
        const output = await tool!.execute("baseten-" + id, { contractVersion: 2, ...input }, controller.signal);
        if (blocked.has(id) || failed.has(id)) expect(output.details).toMatchObject({ status: "unavailable" });
        else expect(output.details).toMatchObject({ status: "ok", result: { model: "synthetic-served-backend", answers: { damaged: { probabilityTrue: 0.9 }, route: { confidence: 0.2 }, severity: { score: 1.25 } }, usage: { inputTokens: 11, outputTokens: 3 } }, provenance: { providerId: "clawrouter" } });
      }
      expect(identities.has("decision")).toBe(!blocked.has(id));
      if (!blocked.has(id)) expect(acquisitions.length).toBeGreaterThanOrEqual(2);
      expect(readers.length).toBeGreaterThanOrEqual(1);
    }, resetDecisionTestRuntime);
  });
  retired = id;
}
describe("actual registered Baseten DecisionV2 through Worker and SQLite", { concurrent: false }, () => {
  for (const id of ids) it(id + " preserves the original selected capability, accounting and retirement", () => runCase(id), 45000);
});
