import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as guardedTransport from "../../src/infra/net/fetch-guard.js";
import { generateImage } from "../../src/image-generation/runtime.js";
import { createImageGenerateTool } from "../../src/agents/tools/image-generate-tool.js";
import { saveMediaBuffer } from "../../src/media/store.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createCapturedPluginRegistration } from "../../src/plugins/captured-registration.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope, getPluginRuntimeGenerationRegistry } from "../../src/plugins/runtime/generation-scope.js";
import { acquirePluginCapabilityProviders } from "../../src/plugins/capability-provider-acquisition.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { describe, expect, it, vi } from "vitest";

/* OWNED_LIFETIME_IMPLEMENTATION */

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const models = ["google/gemini-3.1-flash-image", "google/gemini-3-pro-image"];
const input = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=", "base64");
const output = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
const originalGuard = guardedTransport.fetchWithSsrFGuard;
const noCatalog = new Set(["aborted", "registry"]);
const noImage = new Set([...noCatalog, "unpriced", "invalid", "foreign", "stale", "scope"]);
const key = (id: string) => `clawrouter-live-gimage_${id}-fixture-secret`;
const modelFor = (id: string) => models[id.startsWith("model1") ? 1 : 0]!;

async function runCase(id: string, body: (run: (signal?: AbortSignal) => Promise<any>, context: any) => Promise<void>) {
  const bindings = createRequestBindings(); let succeeded = false;
  const lifetime = createLifetimeObserver({ bindings: bindings.bindings, bodySucceeded: () => succeeded });
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let abortAfterRead: { controller: AbortController; reason: Error; observed: boolean } | undefined;
  try { await preserveFailures(async () => {
    state = await createOpenClawTestState({ label: "clawrouter-google-image", applyEnv: true,
      env: { CLAWROUTER_API_KEY: undefined, GOOGLE_API_KEY: "must-not-fallback", GEMINI_API_KEY: "must-not-fallback",
        HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, all_proxy: undefined } });
    assert.equal(process.env.CLAWROUTER_API_KEY, undefined);
    const credential = id === "invalid" ? "clawrouter-live-gimage_model0_text-invalid" : key(id);
    const cfg: OpenClawConfig = { plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
      agents: { defaults: { mediaModels: { image: { primary: "clawrouter/" + modelFor(id) } } } },
      models: { providers: { clawrouter: { baseUrl: origin, apiKey: credential, models: [], request: { allowPrivateNetwork: true } },
        google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "must-not-fallback", models: [] } } } };
    const captured = createCapturedPluginRegistration();
    const facade = await loadBundledPluginFacade<{ default: { register: (api: typeof captured.api) => void } }>({ pluginId: "clawrouter", artifactBasename: "index.ts" });
    facade.default.register(captured.api);
    const providers = captured.imageGenerationProviders.filter(provider => provider.id === "clawrouter"); assert.equal(providers.length, 1);
    const rootDir = fileURLToPath(new URL(".", import.meta.url)), pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.imageGenerationProviders = providers.map(provider => ({ pluginId: "clawrouter", source: "fixture", rootDir, provider }));
    const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [{ id: "clawrouter", rootDir,
      providers: ["clawrouter"], contracts: { imageGenerationProviders: ["clawrouter"] } }] });
    vi.spyOn(guardedTransport, "fetchWithSsrFGuard").mockImplementation(function (this: unknown, ...args) {
      const options = args[0]; let owner;
      try { owner = bindings.claim(options.url, options.init, options.url === origin + "/v1/catalog" ? "catalog" : "chat"); }
      catch (error) { lifetime.errors.push(error); throw error; }
      lifetime.signal(owner, options.signal ?? options.init?.signal);
      const pending = lifetime.guard(originalGuard, this, args, owner);
      if (owner.kind === "chat" && abortAfterRead) {
        const observed = pending.then((acquisition: any) => {
          const body = acquisition.response.body, getReader = body.getReader;
          lifetime.patch(body, "getReader", function (this: unknown, ...operands: any[]) {
            const reader: any = Reflect.apply(getReader, this, operands), read = reader.read;
            lifetime.patch(reader, "read", function (this: unknown, ...operands: any[]) {
              const original: Promise<any> = Reflect.apply(read, this, operands) as Promise<any>;
              const observation = original.then((value: any) => {
                if (!abortAfterRead!.observed && !value.done && value.value?.byteLength > 0) {
                  const rows = lifetime.readers.filter((row: any) => row.owner === owner && row.reader === reader && row.body === body);
                  assert.equal(rows.length, 1); assert.strictEqual(this, reader);
                  abortAfterRead!.observed = true; lifetime.partial(owner); abortAfterRead!.controller.abort(abortAfterRead!.reason);
                }
              }, () => undefined);
              lifetime.watch("observer.abort", observation, owner); return original;
            }); return reader;
          });
        });
        lifetime.watch("observer.acquisition", observed, owner);
      }
      return pending;
    });
    const previous = getPluginRuntimeGenerationRegistry();
    await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, async () => {
      await Promise.resolve(); assert.strictEqual(getPluginRuntimeGenerationRegistry(), pluginRegistry);
      const expectRequests = (signal?: AbortSignal) => {
        if (!noCatalog.has(id)) bindings.expect(id, "catalog", origin + "/v1/catalog", "GET", credential, signal);
        if (!noImage.has(id)) {
          const owner = bindings.expect(id, "chat", origin + "/v1/native/google-gemini/v1beta/models/" + modelFor(id).slice(7) + ":generateContent", "POST", credential, signal);
          owner.callerObservation = {}; lifetime.signal(owner.callerObservation, signal);
        }
      };
      const selected = await acquirePluginCapabilityProviders({ key: "imageGenerationProviders", cfg });
      try { assert.equal(selected.providers.length, 1); assert.strictEqual(selected.providers[0]!.generateImage, providers[0]!.generateImage); }
      finally { await selected.release(); }
      const run = (signal?: AbortSignal) => {
        expectRequests(signal);
        return generateImage({ cfg, agentDir: state!.agentDir(), prompt: "synthetic gimage_" + id, modelOverride: "clawrouter/" + modelFor(id),
          autoProviderFallback: false, timeoutMs: 10000, signal, aspectRatio: "1:1", resolution: "1K",
          ...(id.endsWith("edit") ? { inputImages: [{ buffer: input, mimeType: "image/png" }] } : {}) });
      };
      await body(run, { lifetime, bindings, cfg, state, pluginRegistry, metadataSnapshot, providers, expectRequests, armAbort(controller: AbortController, reason: Error) { abortAfterRead = { controller, reason, observed: false }; return abortAfterRead; } });
    });
    assert.strictEqual(getPluginRuntimeGenerationRegistry(), previous);
    assert.equal(lifetime.guards.length, noCatalog.has(id) ? 0 : noImage.has(id) ? 1 : 2, id + " original acquisitions");
    assert.ok(lifetime.guards.every((row: any) => row.acquired && row.releaseCalls === 1), id + " original release");
    succeeded = true;
  }, [() => lifetime.join(), () => bindings.verify(), () => lifetime.restore(), () => vi.restoreAllMocks(), () => state?.cleanup()]);
  } catch (error) { console.log("GOOGLE_IMAGE_FAILURE " + id + " " + JSON.stringify({ summary: lifetime.summary(), join: lifetime.joinDiagnostic() })); throw error; }
  console.log("GOOGLE_IMAGE_RETIRED " + id + " " + JSON.stringify(lifetime.summary()));
}

describe("registered Google image host and tool through Worker/SQLite", { concurrent: false }, () => {
  it.each(["model0_text", "model0_edit", "model1_text", "model1_edit"])("uses the exact current offer for %s", id => runCase(id, async run => {
    expect(await run()).toMatchObject({ provider: "clawrouter", model: modelFor(id), images: [{ buffer: output, mimeType: "image/png" }] });
  }));
  it("acquires the actual image tool registry and saves distinct inline edit output", () => runCase("tool_edit", async (_run, context) => {
    const { cfg, state, expectRequests } = context;
    assert.notDeepEqual(input, output);
    const upload = await saveMediaBuffer(input, "image/png", "inbound");
    const tool = createImageGenerateTool({ config: cfg, agentDir: state.agentDir(), workspaceDir: state.workspaceDir, fsPolicy: { workspaceOnly: true } });
    assert.ok(tool); expectRequests();
    const result = await tool.execute("google-inline-edit", { prompt: "synthetic gimage_tool_edit", model: "clawrouter/" + models[0], image: upload.path, aspectRatio: "1:1", resolution: "1K" });
    expect(result.details).toMatchObject({ provider: "clawrouter", model: models[0], count: 1 });
    const paths = (result.details as { paths: string[] }).paths; assert.equal(paths.length, 1); assert.notEqual(paths[0], upload.path);
    assert.deepEqual(await readFile(paths[0]!), output); assert.deepEqual(await readFile(upload.path), input);
  }));
  it.each(["unpriced", "invalid", "foreign", "stale", "scope"])("denies %s without a Google fallback", id => runCase(id, async run => { await expect(run()).rejects.toThrow(); }));
  it("pre-abort avoids catalog and paid creation", () => runCase("aborted", async run => {
    await expect(run(AbortSignal.abort(new Error("synthetic image pre-abort")))).rejects.toThrow();
  }));
  it.each(["incomplete", "malformed"])("retains the dispatched %s charge and cleanup", id => runCase(id, async run => { await expect(run()).rejects.toThrow(); }));
  it("rejects foreign registry entries while acquiring the configured bundled fallback", () => runCase("registry", async (_run, context) => {
    const { pluginRegistry, metadataSnapshot, providers } = context;
    const foreignProvider = { ...providers[0], id: "foreign", generateImage: async () => { throw new Error("foreign image provider executed"); } };
    for (const foreign of [false, true]) {
      const empty = createEmptyPluginRegistry();
      if (foreign) empty.imageGenerationProviders.push({ pluginId: "foreign", source: "fixture", provider: foreignProvider });
      await withPluginRuntimeGenerationScope({ pluginRegistry: empty, metadataSnapshot }, async () => {
        const acquired = await acquirePluginCapabilityProviders({ key: "imageGenerationProviders", cfg: context.cfg });
        try {
          await Promise.resolve(); assert.strictEqual(getPluginRuntimeGenerationRegistry(), empty);
          assert.deepEqual(acquired.providers.map(provider => provider.id), ["clawrouter"]);
          assert.notStrictEqual(acquired.providers[0], foreignProvider);
          assert.notStrictEqual(acquired.providers[0]!.generateImage, foreignProvider.generateImage);
          assert.equal(empty.imageGenerationProviders.length, foreign ? 1 : 0);
        } finally { await acquired.release(); }
      });
      assert.strictEqual(getPluginRuntimeGenerationRegistry(), pluginRegistry);
    }
  }));
  it("cancels the host during original validated-response delivery, separately from tool preparation", () => runCase("cancel", async (run, { armAbort }) => {
    const controller = new AbortController(), reason = new Error("synthetic Google image host canceled");
    const observation = armAbort(controller, reason);
    const result = await run(controller.signal).then(value => ({ value }), error => ({ error }));
    assert.equal(observation.observed, true); assert.ok("error" in result); assert.strictEqual(result.error, reason);
  }));
});
