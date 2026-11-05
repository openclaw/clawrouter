import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as mediaStore from "../../media/store.js";
import { acquirePluginRegistryForInspection } from "../../plugins/loader.js";
import { writePlugin, resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { UnifiedModelCatalogProviderContext } from "../../plugins/types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resetGeneratedMediaTaskActivityForTests } from "../media-generation-activity.test-support.js";
import { prepareWorkspaceBuildGroup } from "../prepared-model-runtime.facts.js";
import { discardPreparedPluginGeneration } from "../prepared-model-runtime.plugin-lifetime.js";
import { snapshot } from "./media-resource-fixtures.test-support.js";
import { createMusicGenerateTool } from "./music-generate-tool.js";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
const route = process.env.CLAWROUTER_CONTRACT_ROUTE;
if (route !== "native" && route !== "manifest") throw new Error("explicit Lyria fixture transport required");
const audio = JSON.parse(process.env.CLAWROUTER_CONTRACT_AUDIO!) as { mp3: string; wav: string };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQI12NkYPj/n4GBgYGJAQoAHRkCAhxhMhsAAAAASUVORK5CYII=";
const CLIP = "google/lyria-3-clip-preview", PRO = "google/lyria-3-pro-preview";
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let acquired: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>;
let prepared: Awaited<ReturnType<typeof prepareWorkspaceBuildGroup>> | undefined;
let config: OpenClawConfig;
let tool: NonNullable<ReturnType<typeof createMusicGenerateTool>>;
let alternate: ReturnType<typeof writePlugin>;

function configuration(id: string): OpenClawConfig {
  return {
    plugins: { allow: ["clawrouter", alternate.id], entries: { clawrouter: { enabled: true }, [alternate.id]: { enabled: true } }, load: { paths: [alternate.file] }, slots: { memory: "none" } },
    models: { providers: { clawrouter: { baseUrl: origin, apiKey: `clawrouter-live-${id}-fixture-secret`, models: [], request: { allowPrivateNetwork: true },
      headers: { "x-goog-api-key": "must-not-forward", "x-api-key": "must-not-forward" } } } },
    agents: { defaults: { workspace: state.workspaceDir, mediaModels: { music: { primary: `clawrouter/${id.endsWith("_pro") ? PRO : CLIP}`, fallbacks: [`${alternate.id}/fixture`] } } } },
  };
}
async function select(id: string) {
  if (prepared) await discardPreparedPluginGeneration(prepared.pluginGeneration);
  config = configuration(id);
  if (id.endsWith("_missing")) delete config.models!.providers!.clawrouter.apiKey;
  prepared = await prepareWorkspaceBuildGroup([{ agentId: "main", agentDir: state.agentDir(), workspaceDir: state.workspaceDir, config, skipCredentials: true }],
    "static", { includeCredentialProviders: false }, () => acquired.registry);
  const created = createMusicGenerateTool({ config, agentDir: state.agentDir(), workspaceDir: state.workspaceDir, preparedModelRuntime: snapshot(prepared) });
  expect(created).not.toBeNull(); tool = created!;
}
const execute = (id: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => withPluginRuntimeRegistryScope(acquired.registry, () =>
  tool.execute(id, { prompt: `Synthetic ${id}`, lyrics: "Synthetic lyrics", instrumental: true, ...args }, signal));
const requests = async () => await (await fetch(origin + "/fixture/requests")).json() as Array<{ path: string; method: string; authorization: string | null; acceptEncoding: string | null }>;
const originalPosts = (calls: Awaited<ReturnType<typeof requests>>) => calls.filter(call => call.method === "POST" && call.path.startsWith("/v1/"));

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "clawrouter-lyria-worker", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    CLAWROUTER_API_KEY: undefined, GOOGLE_API_KEY: "must-not-fallback", GEMINI_API_KEY: undefined } });
  alternate = writePlugin({ id: "music-alternate-fixture", dir: state.statePath("alternate"),
    registration: `api.registerMusicGenerationProvider({ id: "music-alternate-fixture", defaultModel: "fixture", capabilities: {}, async generateMusic() {
      await fetch(${JSON.stringify(origin + "/fixture/alternate")}); return { tracks: [{ buffer: Buffer.from(${JSON.stringify(audio.mp3)}, "base64"), mimeType: "audio/mpeg" }] }; } });` });
  await state.writeJson("alternate/openclaw.plugin.json", { id: alternate.id, contracts: { musicGenerationProviders: [alternate.id] }, configSchema: { type: "object", additionalProperties: false, properties: {} } });
  await state.writeAuthProfiles({ version: 1, profiles: { "google:native": { type: "api_key", provider: "google", key: "must-not-fallback" } } });
  await fs.writeFile(`${state.workspaceDir}/lyria-reference.png`, Buffer.from(png, "base64"));
  acquired = await acquirePluginRegistryForInspection({ config: configuration(`lyria_${route}_clip`) });
  expect(acquired.registry.musicGenerationProviders.some(entry => entry.provider.id === alternate.id)).toBe(true);
});
afterEach(() => { vi.restoreAllMocks(); resetGeneratedMediaTaskActivityForTests(); });
afterAll(async () => {
  if (prepared) await discardPreparedPluginGeneration(prepared.pluginGeneration);
  await acquired?.release(); clearPluginMetadataLifecycleCaches(); resetPluginLoaderTestStateForTest(); await state?.cleanup();
});

describe(`actual registered Lyria ${route} through Worker`, () => {
  it("discovers the two entitled music models through the actual registered catalog", async () => {
    await select(`lyria_${route}_clip`);
    const selected = acquired.registry.modelCatalogProviders.find(entry => entry.provider.provider === "clawrouter" && entry.provider.kinds.includes("music_generation"))!.provider;
    const auth = () => ({ apiKey: config.models!.providers!.clawrouter.apiKey as string, mode: "api_key" as const, source: "env" as const });
    const context: UnifiedModelCatalogProviderContext = { config, env: {}, includeLive: true, agentDir: state.agentDir(), resolveProviderApiKey: auth, resolveProviderAuth: auth };
    const rows = await selected.liveCatalog!(context);
    expect(rows?.map(row => [row.kind, row.model, row.default])).toEqual([["music_generation", CLIP, undefined], ["music_generation", PRO, undefined]]);
  });

  it.each(["clip", "pro", "image"])("delivers complete real audio with the unchanged serializer (%s)", async kind => {
    const id = `lyria_${route}_${kind}`; await select(id);
    const save = vi.spyOn(mediaStore, "saveMediaBuffer"), before = (await requests()).length;
    await execute(id, kind === "image" ? { image: `${state.workspaceDir}/lyria-reference.png` } : kind === "pro" ? { format: "wav" } : {});
    expect(save.mock.calls).toHaveLength(1);
    expect(save.mock.calls[0]?.[0]).toEqual(Buffer.from(kind === "pro" ? audio.wav : audio.mp3, "base64"));
    const calls = (await requests()).slice(before), posts = originalPosts(calls);
    expect(posts).toHaveLength(1); expect(posts[0]?.acceptEncoding).toBe("identity"); expect(posts[0]?.path).toBe(route === "native" ? `/v1/native/google-gemini/v1beta/models/${kind === "pro" ? "lyria-3-pro-preview" : "lyria-3-clip-preview"}:generateContent` : "/v1/proxy/google-gemini/music_generate");
    expect(calls.some(call => call.path === "/fixture/alternate")).toBe(false);
  });

  it.each(["text", "eof", "error"])("publishes no partial audio or paid fallback after %s", async kind => {
    const id = `lyria_${route}_${kind}`; await select(id);
    const save = vi.spyOn(mediaStore, "saveMediaBuffer"), before = (await requests()).length;
    await expect(execute(id)).rejects.toThrow("502");
    expect(save).not.toHaveBeenCalled(); const calls = (await requests()).slice(before);
    expect(originalPosts(calls)).toHaveLength(1); expect(calls.some(call => call.path === "/fixture/alternate")).toBe(false);
  });

  it("does not replay after local asset persistence fails following complete EOF", async () => {
    const id = `lyria_${route}_persist`; await select(id);
    vi.spyOn(mediaStore, "saveMediaBuffer").mockRejectedValueOnce(new Error("synthetic disk failure"));
    const before = (await requests()).length;
    await expect(execute(id)).rejects.toThrow("synthetic disk failure");
    const calls = (await requests()).slice(before); expect(originalPosts(calls)).toHaveLength(1);
    expect(calls.some(call => call.path === "/fixture/alternate")).toBe(false);
  });

  it("honors the actual caller abort after EOF without another paid operation", async () => {
    const id = `lyria_${route}_cancel`; await select(id);
    const controller = new AbortController(), reason = new Error("synthetic caller cancellation after EOF");
    const realSave = mediaStore.saveMediaBuffer;
    vi.spyOn(mediaStore, "saveMediaBuffer").mockImplementation(async (...args) => { const saved = await realSave(...args); controller.abort(reason); return saved; });
    const before = (await requests()).length;
    await expect(execute(id, {}, controller.signal)).rejects.toThrow(reason.message);
    expect(controller.signal.reason).toBe(reason);
    const calls = (await requests()).slice(before); expect(originalPosts(calls)).toHaveLength(1);
    expect(calls.some(call => call.path === "/fixture/alternate")).toBe(false);
  });

  it.each(["budget", "denied", "missing", "stale", "foreign", "preabort"])("denies explicit selected-proxy %s before any music POST", async kind => {
    const id = `lyria_${route}_${kind}`; await select(id);
    const before = (await requests()).length, save = vi.spyOn(mediaStore, "saveMediaBuffer");
    const controller = new AbortController(); if (kind === "preabort") controller.abort(new Error("synthetic caller cancellation before dispatch"));
    await expect(execute(id, { model: `clawrouter/${CLIP}` }, controller.signal)).rejects.toThrow();
    const calls = (await requests()).slice(before); expect(originalPosts(calls)).toHaveLength(0);
    expect(calls.some(call => call.path === "/fixture/alternate")).toBe(false); expect(save).not.toHaveBeenCalled();
  });
});
