import assert from "node:assert/strict";
import { beforeAll, describe, it, vi } from "vitest";
import plugin from "./index.js";
import { createCapturedPluginRegistration, createEmptyPluginRegistry } from "../../src/plugin-sdk/plugin-test-runtime.js";
import { withPluginRuntimeRegistryScope } from "../../src/plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../src/plugins/runtime/generation-state.js";
import { getRegisteredEmbeddingProvider } from "../../src/plugins/embedding-providers.js";
import { createEmbeddingProvider } from "../memory-core/src/memory/embeddings.js";
import { MemoryManagerEmbeddingOps } from "../memory-core/src/memory/manager-embedding-ops.js";
import * as guard from "../../src/infra/net/fetch-guard.js";
import { withRemoteHttpResponse } from "../../packages/memory-host-sdk/src/host/remote-http.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["embedding-v1", "bge-large-zh", "bge-large-en"];
const captured = createCapturedPluginRegistration();
const credential = (index: number, mode: string) => `qmem_${index}_${mode}`;
const key = (id: string) => `clawrouter-live-${id}-fixture-secret`;
const vectors = (count: number) => Array.from({ length: count }, (_, i) => [i + 1, i + 2, i + 3]);

function inRegistry<T>(run: () => T, include = true) {
  const registry = createEmptyPluginRegistry();
  const provider = captured.embeddingProviders.find(p => p.id === "qianfan");
  assert.ok(provider);
  if (include) registry.embeddingProviders.push({ pluginId: "qianfan", provider, source: "test" });
  return withPluginRuntimeRegistryScope(registry, () => withPluginRuntimeGenerationRegistryScope(registry, run));
}

async function client(index: number, mode: string, model = models[index]) {
  const id = credential(index, mode);
  const result = await createEmbeddingProvider({ provider: "qianfan", model, fallback: "none",
    config: { plugins: { enabled: false }, models: { providers: {
      qianfan: { baseUrl: origin + "/v1/native/qianfan", api: "openai-completions", models: [] },
    } } }, remote: { apiKey: key(id) } });
  assert.equal(result.requestedProvider, "qianfan");
  assert.equal(result.provider?.id, "qianfan"); assert.equal(result.runtime?.id, "qianfan");
  assert.equal(result.fallbackFrom, undefined);
  return result;
}

// Preserve every original acquisition and release promise. A spy being installed
// is not proof: each expected real request must produce one completed acquisition.
async function observed<T>(requests: number, run: () => Promise<T>) {
  const original = guard.fetchWithSsrFGuard, rows: any[] = [], tails: Promise<unknown>[] = [], faults: unknown[] = [];
  const spy = vi.spyOn(guard, "fetchWithSsrFGuard").mockImplementation(function (...args) {
    const pending = Reflect.apply(original, this, args);
    const row: any = { pending, args, releases: [] }; rows.push(row);
    tails.push(pending.then(result => {
      row.result = result;
      const release = result.release;
      row.descriptor = Object.getOwnPropertyDescriptor(result, "release");
      result.release = function (...operands) {
        const entry: any = { original: release, receiver: this, operands }; row.releases.push(entry);
        try {
          const value = Reflect.apply(release, this, operands); entry.pending = value;
          tails.push(Promise.resolve(value).then(() => { entry.settled = true; }, error => { faults.push(error); }));
          return value;
        } catch (error) { faults.push(error); throw error; }
      };
      row.wrapper = result.release;
    }, error => { faults.push(error); }).catch(error => { faults.push(error); }));
    return pending;
  });
  let value: T | undefined;
  try { value = await run(); } catch (error) { faults.push(error); }
  try {
    for (let i = 0; i < tails.length; i++) await tails[i];
    assert.equal(rows.length, requests, "actual guarded acquisition count");
    for (const row of rows) {
      assert.ok(row.result); assert.equal(row.releases.length, 1);
      assert.equal(row.releases[0].settled, true);
      assert.equal(row.result.response.body?.locked ?? false, false);
      assert.equal(row.result.response.bodyUsed, true);
    }
  } catch (error) { faults.push(error); }
  for (const row of rows) if (row.result && row.wrapper) {
    try {
      assert.equal(row.result.release, row.wrapper, "original release observer custody");
      if (row.descriptor) Object.defineProperty(row.result, "release", row.descriptor);
      else assert.equal(Reflect.deleteProperty(row.result, "release"), true);
    } catch (error) { faults.push(error); }
  }
  try { spy.mockRestore(); assert.equal(guard.fetchWithSsrFGuard, original); } catch (error) { faults.push(error); }
  if (faults.length) throw new AggregateError(faults, "Qianfan memory originals and cleanup");
  return value as T;
}

describe("registered Qianfan memory scheduler through Worker and SQLite", { concurrent: false }, () => {
  beforeAll(() => { plugin.register(captured.api); });
  for (const [index, model] of models.entries()) {
    for (const count of [16, 17]) it(`${model}: actual scheduler ${count} preserves normalized route and order`, () => inRegistry(async () => {
      const mode = `batch${count}`, result = await client(index, mode, `qianfan/${model}`);
      assert.equal(result.provider!.model, model); assert.equal(result.provider!.maxInputsPerRequest, 16);
      const owner = Object.assign(Object.create(MemoryManagerEmbeddingOps.prototype), {
        provider: result.provider, providerRuntime: result.runtime, cache: { enabled: false }, settings: { sync: {} },
        // This notification is observed, never used to substitute a provider.
        degraded: [] as unknown[], markLocalEmbeddingProviderDegraded(error: unknown) { this.degraded.push(error); },
      });
      const inputs = Array.from({ length: count }, (_, i) => `${credential(index, mode)}:${i}`);
      const value = await observed(count === 16 ? 1 : 2, () => owner.embedBatchWithRetry(inputs));
      assert.deepEqual(value, vectors(count)); assert.deepEqual(owner.degraded, []);
    }));

    it(`${model}: query usage, exact normalization and pre-dispatch cancellation`, () => inRegistry(async () => {
      const result = await client(index, "query", ` openai-compatible/${model} `), usage: unknown[] = [];
      assert.equal(result.provider!.model, model); assert.equal(result.provider!.maxInputsPerRequest, 16);
      await observed(1, async () => {
        assert.deepEqual(await result.provider!.embed(`${credential(index, "query")}:0`, { onUsage: value => usage.push(value) }), [1, 2, 3]);
      });
      assert.deepEqual(usage, [{ promptTokens: 2, totalTokens: 2 }]);
      const reason = new Error("synthetic pre-dispatch cancellation");
      await observed(0, () => assert.rejects(result.provider!.embed("must not dispatch", { signal: AbortSignal.abort(reason) }), error => error === reason));
    }));

    for (const mode of ["embedded", "malformed", "eof"]) it(`${model}: ${mode} never produces a vector or retries`, () => inRegistry(async () => {
      const result = await client(index, mode);
      await observed(1, () => assert.rejects(result.provider!.embed(`${credential(index, mode)}:0`)));
    }));

    for (const mode of ["unpriced", "foreign", "missing", "revoked", "budget"]) it(`${model}: ${mode} denies without upstream dispatch`, () => inRegistry(async () => {
      const result = await client(index, mode);
      await observed(1, () => assert.rejects(result.provider!.embed(`${credential(index, mode)}:0`)));
    }));
  }

  it("unrelated models do not acquire Qianfan's batch cap", () => inRegistry(async () => {
    const result = await client(0, "query", "synthetic-unrelated-model");
    assert.equal(result.provider!.maxInputsPerRequest, undefined);
    assert.equal(result.provider!.model, "synthetic-unrelated-model");
  }));

  it("captured registration stays owned across nested/concurrent scopes and undefined failure", async () => {
    await inRegistry(async () => {
      const own = getRegisteredEmbeddingProvider("qianfan")!.adapter;
      assert.equal(own, captured.embeddingProviders.find(p => p.id === "qianfan"));
      await Promise.all([inRegistry(async () => {
        await Promise.resolve(); assert.equal(getRegisteredEmbeddingProvider("qianfan"), undefined);
      }, false), (async () => { await Promise.resolve(); assert.equal(getRegisteredEmbeddingProvider("qianfan")!.adapter, own); })()]);
      await assert.rejects(inRegistry(async () => { throw undefined; }, false), error => error === undefined);
      assert.equal(getRegisteredEmbeddingProvider("qianfan")!.adapter, own);
    });
  });

  // These are wrapper cleanup controls, not actual client-disconnect proof.
  it("real remote wrapper joins detached release and preserves independent falsey cleanup failures", async () => {
    for (const failure of [undefined, new Error("synthetic independent release failure")]) {
      let released = 0, callback = 0;
      const response = new Response("synthetic");
      const result = { response, finalUrl: "https://fixture.example/embeddings", release() { released++; return Promise.reject(failure); } };
      const pending = withRemoteHttpResponse({ url: result.finalUrl,
        fetchWithSsrFGuardImpl: async () => result, shouldUseEnvHttpProxyForUrlImpl: () => false,
        onResponse: async actual => { callback++; assert.equal(actual, response); await actual.text(); return "parsed"; } });
      await assert.rejects(pending, error => error === failure);
      assert.equal(released, 1); assert.equal(callback, 1);
    }
    let release!: () => void, finished = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = withRemoteHttpResponse({ url: "https://fixture.example/embeddings",
      fetchWithSsrFGuardImpl: async () => ({ response: new Response("done"), finalUrl: "https://fixture.example/embeddings", release: () => held }),
      shouldUseEnvHttpProxyForUrlImpl: () => false, onResponse: response => response.text() });
    void pending.then(() => { finished = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
    release(); assert.equal(await pending, "done"); assert.equal(finished, true);
  });
});
