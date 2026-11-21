import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import * as catalogTransport from "../../src/infra/net/fetch-guard.js";
import * as guardedTransport from "../../src/agents/provider-transport-dispatcher-pool.js";
import { stream, type AssistantMessage, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { wrapStreamFnWithProviderPromptState } from "../../src/agents/embedded-agent-runner/provider-prompt-state.js";
import type { GoogleContinuationOptions } from "../google/transport-stream-types.js";
import { beforeEach, describe, expect, it as nativeIt, vi } from "vitest";
import plugin from "./index.js";

/* OWNED_LIFETIME_IMPLEMENTATION */

// BEGIN GOOGLE BINDINGS
function createGoogleBindings() {
  const bindings: any[] = [], seen = new WeakSet<object>();
  return {
    bindings,
    expect(id: string, kind: string, url: string, method: string, credential: string, caller?: AbortSignal, header = "authorization") {
      if (bindings.some(row => row.id === id && row.kind === kind)) throw new Error("duplicate Google expectation");
      const row: any = { id, kind, url, method, credential, caller, header, claimed: false }; bindings.push(row); return row;
    },
    claim(input: Request | URL | string, init: RequestInit | undefined, kind: string) {
      const request = input instanceof Request ? input : undefined;
      const url = new URL(request?.url ?? String(input)).href, method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers !== undefined ? init.headers : request?.headers), identity = request ?? init;
      if (!identity || typeof identity !== "object" || seen.has(identity)) throw new Error("duplicate or unbound Google original input");
      const row = bindings.find(row => !row.claimed && row.kind === kind && row.url === url && row.method === method && headers.get(row.header) === (row.header === "authorization" ? "Bearer " : "") + row.credential);
      if (!row) throw new Error("unbound Google transport");
      row.claimed = true; row.input = identity; seen.add(identity); return row;
    },
    verify() { if (bindings.some(row => !row.claimed)) throw new Error("missing original Google transport"); },
  };
}
// END GOOGLE BINDINGS

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const contract = JSON.parse(process.env.CLAWROUTER_GOOGLE_CONTINUATION_CONTRACT!);
assert.equal(contract.provider, "google-gemini");
assert.equal(contract.model, "google/gemini-3.5-flash");
const invocation = new AsyncLocalStorage<any>();
const originalCatalog = catalogTransport.fetchWithSsrFGuard;
const originalGuard = guardedTransport.fetchWithProviderHttpGuard;
const key = (id: string) => "clawrouter-live-gcont_" + id + "-fixture-secret";
let lifetime: ReturnType<typeof createLifetimeObserver>, bindings: ReturnType<typeof createGoogleBindings>, bodySucceeded: boolean;

// BEGIN GOOGLE CLAIM
function claimOwned(url: any, init: any, kind: string) {
  try {
    const owner = bindings.claim(url, init, kind);
    if (owner !== invocation.getStore()) throw new Error("foreign Google invocation");
    return owner;
  } catch (error) { lifetime.errors.push(error); throw error; }
}
// END GOOGLE CLAIM

async function runCase(body: () => unknown) {
  await preserveFailures(async () => { await body(); bodySucceeded = true; }, [
    () => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(),
  ]);
  expect(lifetime.guards.length).toBe(bindings.bindings.length);
  expect(lifetime.summary().releases).toBe(bindings.bindings.length);
  expect(lifetime.guards.length).toBeGreaterThan(0);
  if (bindings.bindings.some(row => row.id === "complete_1")) console.log("GOOGLE_CONTINUATION_TWO_HOPS_RETIRED");
  if (bindings.bindings.some(row => row.id === "cancel")) console.log("GOOGLE_CONTINUATION_CANCEL_RETIRED");
}
const it = Object.assign((name: string, body: () => unknown) => nativeIt(name, () => runCase(body)), {
  each: (rows: any) => (name: string, body: (...args: any[]) => unknown) => nativeIt.each(rows)(name, (...args) => runCase(() => body(...args))),
});
async function control(action: string, id: string) {
  const target = action === "mutate" ? origin : process.env.CLAWROUTER_GOOGLE_CONTROL_ORIGIN!;
  const response = await fetch(target + "/fixture/" + action + "?id=" + encodeURIComponent(id));
  expect(response.status).toBe(200);
  return response.json();
}

async function selected(id: string) {
  clearLiveCatalogCacheForTests();
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("clawrouter");
  const config = { models: { providers: { clawrouter: { baseUrl: origin + "/v1", auth: "api-key" as const, apiKey: key(id), models: [] } } } };
  const owner = bindings.expect(id + "_catalog", "catalog", origin + "/v1/catalog", "GET", key(id));
  const catalog = await invocation.run(owner, () => withOpenClawTestState({ label: "google-continuation-catalog" }, state => provider.catalog!.run({ config, env: {}, agentDir: state.agentDir(), workspaceDir: state.workspaceDir,
    resolveProviderAuth: () => ({ apiKey: key(id), discoveryApiKey: key(id), mode: "api_key", source: "config" }) } as any)));
  const actual = catalog && "provider" in catalog ? catalog.provider?.models.find((row: any) => row.id === contract.model) : undefined;
  assert(actual, "actual credential-owned Google catalog row required");
  const raw = { ...actual, provider: "clawrouter" } as Model<any>;
  const model = provider.normalizeResolvedModel?.({ provider: "clawrouter", modelId: contract.model, model: raw } as any) ?? raw;
  expect(model).toMatchObject({ id: contract.model, provider: "clawrouter", api: "google-generative-ai", baseUrl: origin + "/v1/native/google-gemini/v1beta" });
  return { provider, model };
}

async function scenario(id: string) {
  const { provider, model } = await selected(id);
  const context: Context = { systemPrompt: "Synthetic continuation " + id,
    messages: [{ role: "user", content: "Synthetic unchanged original input", timestamp: 1 }] };
  const wrapped = provider.wrapStreamFn?.({ provider: "clawrouter", modelId: model.id, model, sourceApi: model.api, thinkingLevel: "low", streamFn: stream } as any);
  assert(wrapped, "registered ClawRouter stream wrapper required");
  let temperature = 0.25;
  const policyInputs: unknown[] = [];
  const finalPolicy = async (payload: unknown) => {
    assert(payload && typeof payload === "object" && !Array.isArray(payload));
    const input = payload as Record<string, any>;
    const replacement = { ...input, generationConfig: { ...input.generationConfig, temperature } };
    policyInputs.push(structuredClone(replacement));
    await Promise.resolve();
    return replacement;
  };
  const policyStream = wrapStreamFnWithProviderPromptState({ streamFn: wrapped, state: {}, effectiveContextTokenBudget: 128_000, transformPayload: finalPolicy });
  const options = { apiKey: key(id), maxTokens: 128, sessionId: "synthetic-google-session", authProfileId: "synthetic-google-profile", maxRetries: 0 };
  const invoke = (hop: number, replay?: AssistantMessage["providerReplay"], changes: any = {}, reaches = true) => {
    const activeModel = changes.model ?? model, input = changes.context ?? context;
    const caller = changes.signal as AbortSignal | undefined;
    const owner = reaches ? bindings.expect(id === "cancel" ? "cancel" : id + "_" + hop, "chat", origin + contract.nativePath, "POST", key(id), caller)
      : { id: id + "_denied", kind: "local-denial", caller };
    owner.callerObservation = {}; lifetime.signal(owner.callerObservation, caller);
    const supplied: GoogleContinuationOptions = { ...options, ...changes.options, signal: caller, googleContinuation: replay };
    return invocation.run(owner, () => policyStream(activeModel, input, supplied));
  };
  return { model, context, invoke, policyInputs, changePolicy() { temperature = 0.75; } };
}

async function firstReceipt(id: string, s: Awaited<ReturnType<typeof scenario>>) {
  const active = await s.invoke(0), result = active.result();
  let settled = false; void result.then(() => { settled = true; }, () => { settled = true; });
  let sawFinal = false;
  for await (const event of active) {
    if (sawFinal || event.type !== "text_delta" || !event.delta.includes("final")) continue;
    sawFinal = true;
    assert(event.partial, "original Google partial event required");
    expect(event.partial.providerReplay).toBeUndefined();
    const state = await control("state", id);
    expect(state).toMatchObject({ calls: 1, eof: false, released: false, expired: false });
    expect(settled).toBe(false);
    expect(lifetime.operations.some(op => op.owner?.id === id + "_0" && op.kind === "reader.read" && op.state === "pending")).toBe(true);
    expect((await control("release", id)).released).toBe(true);
  }
  expect(sawFinal).toBe(true);
  const output = await result;
  expect(output.stopReason, output.errorMessage).toBe("length");
  expect(output.providerReplay).toMatchObject({ v: 1, type: "google.generate_content.continuation", id: "synthetic-continuation-" + id, provider: "clawrouter", api: "google-generative-ai" });
  expect((await control("state", id)).eof).toBe(true);
  return output.providerReplay!;
}

describe("registered Google continuation through Worker and SQLite", { concurrent: false }, () => {
  beforeEach(() => {
    bodySucceeded = false; bindings = createGoogleBindings();
    lifetime = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => bodySucceeded, current: () => invocation.getStore() });
    vi.spyOn(catalogTransport, "fetchWithSsrFGuard").mockImplementation(function (this: unknown, ...args) {
      const input = args[0]; if (input.url !== origin + "/v1/catalog") return Reflect.apply(originalCatalog, this, args);
      const owner = claimOwned(input.url, input.init, "catalog"); lifetime.signal(owner, input.signal ?? input.init?.signal); return lifetime.guard(originalCatalog, this, args, owner);
    });
    vi.spyOn(guardedTransport, "fetchWithProviderHttpGuard").mockImplementation(function (this: unknown, ...args) {
      const input = args[0], owner = claimOwned(input.url, input.init, "chat"); lifetime.signal(owner, input.signal ?? input.init?.signal); return lifetime.guard(originalGuard, this, args, owner);
    });
  });
  it("publishes only after HTTP EOF and makes exactly two explicit owned hops", async () => {
    const s = await scenario("complete"), receipt = await firstReceipt("complete", s);
    expect((await control("state", "complete")).calls).toBe(1);
    const result = await (await s.invoke(1, receipt)).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(result.providerReplay).toBeUndefined();
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "synthetic-second" }));
    expect(s.policyInputs).toHaveLength(2); expect(s.policyInputs[1]).toEqual(s.policyInputs[0]);
    expect((await control("state", "complete")).calls).toBe(2);
  });
  it.each(["body", "policy", "key", "profile", "session", "origin"])("rejects changed %s before another SDK transport", async id => {
    const s = await scenario(id), receipt = await firstReceipt(id, s), changes: any = {};
    if (id === "body") changes.context = { ...s.context, systemPrompt: "Changed original input" };
    if (id === "policy") s.changePolicy();
    if (id === "key") changes.options = { apiKey: "clawrouter-live-foreign-fixture-secret" };
    if (id === "profile") changes.options = { authProfileId: "another-profile" };
    if (id === "session") changes.options = { sessionId: "another-session" };
    if (id === "origin") changes.model = { ...s.model, baseUrl: "https://foreign.example/v1/native/google-gemini/v1beta" };
    const result = await (await s.invoke(1, receipt, changes, false)).result();
    expect(result.stopReason).toBe("error"); expect(result.providerReplay).toBeUndefined();
    expect((await control("state", id)).calls).toBe(1);
  });
  it.each(["grant_revoke", "grant_change", "policy_generation", "caller_budget", "provider_budget"])("preserves Worker authority and independent hop accounting for %s", async id => {
    const s = await scenario(id), receipt = await firstReceipt(id, s);
    expect((await control("mutate", id)).applied).toBe(true);
    const result = await (await s.invoke(1, receipt)).result();
    expect(result.stopReason).toBe("error"); expect(result.providerReplay).toBeUndefined();
    expect((await control("state", id)).calls).toBe(1);
  });
  it.each(["late_sse", "late_json", "truncated", "done_before_eof"])("retains %s failure without a usable receipt or replay", async id => {
    const s = await scenario(id), active = await s.invoke(0), result = active.result();
    let settled = false; void result.then(() => { settled = true; }, () => { settled = true; });
    let released = false;
    for await (const event of active) if (!released && event.type === "text_delta" && event.delta.includes("final")) {
      assert(event.partial, "original Google partial event required");
      expect(event.partial.providerReplay).toBeUndefined(); expect(settled).toBe(false);
      expect((await control("state", id)).eof).toBe(false);
      await control("release", id); released = true;
    }
    expect(released).toBe(true);
    const output = await result; expect(output.stopReason).toBe("error"); expect(output.providerReplay).toBeUndefined();
    expect((await control("state", id)).calls).toBe(1);
  });
  it("retires actual caller abort after observed content without continuation authority", async () => {
    const s = await scenario("cancel"), caller = new AbortController();
    const active = await s.invoke(0, undefined, { signal: caller.signal });
    for await (const event of active) if (event.type === "text_delta") {
      const owners = bindings.bindings.filter(row => row.id === "cancel" && row.kind === "chat");
      expect(owners).toHaveLength(1); lifetime.partial(owners[0]); caller.abort(new Error("synthetic-owned-abort")); break;
    }
    const output = await active.result(); expect(caller.signal.aborted).toBe(true);
    expect(output.stopReason).toBe("aborted"); expect(output.providerReplay).toBeUndefined();
  });
});
