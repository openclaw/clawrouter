import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { generateVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
expect(process.env.CLAWROUTER_VYDRA_MODELS_CONTRACT).toBe("vydra.models.kling-veo3.v1");
const video = Buffer.from(process.env.CLAWROUTER_CONTRACT_VIDEO_BASE64!, "base64");
const asset = "https://example.com/clawrouter-vydra-fixture.mp4";
const nativeFetch = globalThis.fetch;
const guardContract = process.env.CLAWROUTER_VYDRA_GUARD_CONTRACT!;
expect(guardContract).toMatch(/^[a-f0-9]{64}$/);
const guardKey = Symbol.for("clawrouter.vydra.guard." + guardContract);
type GuardModule = { faults: unknown[] };
let guardIdentity: { module: GuardModule; callee: Function } | undefined;
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
  expect(receiver).toBe(undefined); expect(args).toHaveLength(1);
  expect(typeof callee).toBe("function"); expect(Array.isArray(module.faults)).toBe(true);
  if (!guardIdentity) guardIdentity = { module, callee };
  expect(module).toBe(guardIdentity.module); expect(callee).toBe(guardIdentity.callee);
  if (!returned) { rows.push({ kind: "guard", state: "rejected", error: value, fn: callee, receiver, args }); return; }
  observe("guard", value as Promise<{ response: Response; release: () => Promise<void> }>, installAcquisition, { fn: callee, receiver, args });
}
beforeEach(() => {
  retired = undefined;
  rows.length = tails.length = acquisitions.length = faults.length = readers.length = 0;
  guardChannel = undefined;
  expect(Object.getOwnPropertyDescriptor(globalThis, guardKey)).toBe(undefined);
  guardChannel = Object.freeze({ modules: new Set<GuardModule>(), observe: observeGuard });
  Object.defineProperty(globalThis, guardKey, { configurable: true, value: guardChannel });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
    if (request.url === asset) {
      expect(request.method).toBe("GET");
      expect([...request.headers]).toEqual([]);
      return nativeFetch(origin + "/fixture/output", { signal: request.signal });
    }
    expect(new URL(request.url).origin).toBe(origin);
    return nativeFetch(input, init);
  });
});
afterEach(async () => {
  const failures: unknown[] = [];
  const check = (fn: () => void) => { try { fn(); } catch (error) { failures.push(error); } };
  try {
    while (tails.length) for (const row of await Promise.allSettled(tails.splice(0))) if (row.status === "rejected") failures.push(row.reason);
  } catch (error) { failures.push(error); }
  check(() => expect(faults).toEqual([]));
  check(() => expect(rows.filter(row => row.state !== "fulfilled")).toEqual([]));
  check(() => expect(guardChannel?.modules.size).toBe(acquisitions.length ? 1 : 0));
  for (const module of guardChannel?.modules ?? []) check(() => expect(module.faults).toEqual([]));
  for (const row of acquisitions) check(() => expect(row.releases).toBe(1));
  for (const row of readers) check(() => { expect(row.unlocks).toBe(1); expect(row.body.locked).toBe(false); });
  if (guardChannel) check(() => {
    expect(Object.getOwnPropertyDescriptor(globalThis, guardKey)?.value).toBe(guardChannel);
    expect(Reflect.deleteProperty(globalThis, guardKey)).toBe(true);
  });
  check(() => vi.restoreAllMocks());
  if (failures.length) throw new AggregateError(failures, "Vydra original guard, retirement and observation restoration");
  if (retired) console.log("VYDRA_MODELS_RETIRED " + retired);
});
const environment = { env: { VYDRA_API_KEY: undefined } };
function config(id: string, model: string, overflow = false): OpenClawConfig {
  return {
    plugins: { allow: ["vydra"], entries: { vydra: { enabled: true } } },
    agents: { defaults: { mediaModels: { video: { primary: "vydra/" + model } }, ...(overflow ? { mediaMaxMb: 0.000001 } : {}) } },
    models: { providers: { vydra: { apiKey: "clawrouter-live-vydra_" + id + "-fixture-secret", models: [],
      baseUrl: origin + "/v1/native/vydra/api/v1", request: { allowPrivateNetwork: true } } } },
  };
}
const refs = { inputImages: [{ url: "https://example.com/reference.png" }], inputVideos: [{ url: "https://example.com/motion.mp4" }] };
const run = (id: string, model = "kling", extras: Record<string, unknown> = {}, overflow = false) =>
  generateVideo({ cfg: config(id, model, overflow), prompt: "Synthetic " + id, timeoutMs: 15000, autoProviderFallback: false,
    ...(model === "kling" ? refs : {}), ...extras });

describe("actual registered Vydra Models through Worker and SQLite", () => {
  for (const model of ["kling", "veo3"]) it(model + " preserves the original job and downloads only terminal bytes", async () => {
    await withTempHome(async () => {
      const result = await run(model, model);
      expect(result).toMatchObject({ provider: "vydra", model, attempts: [], metadata: { jobId: "vydra_" + model, videoUrl: asset, status: "completed" } });
      expect(result.videos).toHaveLength(1); expect(result.videos[0]).toMatchObject({ buffer: video, mimeType: "video/mp4" });
      expect(acquisitions.length).toBeGreaterThanOrEqual(4);
      retired = model;
    }, environment);
  });
  it("rejects the provider's failed job without downloading a partial asset", async () => {
    await withTempHome(async () => { await expect(run("failed")).rejects.toThrow(); expect(acquisitions.length).toBeGreaterThanOrEqual(2); }, environment);
  });
  it("enforces the actual SDK asset byte bound and still releases the original guard", async () => {
    await withTempHome(async () => { await expect(run("overflow", "kling", {}, true)).rejects.toThrow(/exceeds/); expect(acquisitions.length).toBeGreaterThanOrEqual(3); }, environment);
  });
  it("keeps unknown monetary cost denied by the Worker", async () => {
    await withTempHome(async () => { await expect(run("unpriced")).rejects.toThrow(); expect(acquisitions).toHaveLength(1); }, environment);
  });
  for (const [id, extras] of [
    ["missingmotion", { inputVideos: [] }],
    ["samereference", { inputVideos: [{ url: "https://EXAMPLE.com:443/reference.png" }] }],
    ["credentialreference", { inputVideos: [{ url: "https://synthetic:synthetic@example.com/motion.mp4" }] }],
  ] as const) it(id + " is rejected before native transport", async () => {
    await withTempHome(async () => { await expect(run(id, "kling", extras)).rejects.toThrow(); expect(globalThis.fetch).not.toHaveBeenCalled(); expect(acquisitions).toHaveLength(0); }, environment);
  });
});
