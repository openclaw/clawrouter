import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { generateVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const origin = process.env.CLAWROUTER_CONTRACT_ORIGIN!;
expect(process.env.CLAWROUTER_PIXVERSE_IMAGE_CONTRACT).toBe("pixverse.composed-image.v1");
const asset = "https://example.com/clawrouter-pixverse-fixture.mp4";
const nativeFetch = globalThis.fetch;
const guardContract = process.env.CLAWROUTER_PIXVERSE_GUARD_CONTRACT!;
expect(guardContract).toMatch(/^[a-f0-9]{64}$/);
const guardKey = Symbol.for("clawrouter.pixverse.guard." + guardContract);
type GuardModule = { faults: unknown[] };
let guardIdentity: { module: GuardModule; callee: Function } | undefined;
let guardChannel: { modules: Set<GuardModule>; observe: typeof observeGuard } | undefined;
type Binding = { fn?: Function; receiver?: unknown; args?: unknown[] };
type Row = Binding & { kind: string; state: "pending" | "fulfilled" | "rejected"; error?: unknown; original?: Promise<unknown>; result?: unknown };
const rows: Row[] = [], tails: Promise<unknown>[] = [], acquisitions: { response: Response; releases: number }[] = [];
let retired: string | undefined;
let currentId: string | undefined;
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
  const bodyCancel = body.cancel;
  body.cancel = function (...args) {
    if (this !== body) faults.push(new Error("foreign body cancel receiver"));
    return call("body.cancel", bodyCancel, this, args);
  };
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
  const input = args[0] as { url: string; init?: RequestInit };
  expect(new URL(input.url).origin).toBe(origin);
  expect(new Headers(input.init?.headers).get("authorization")).toBe("Bearer clawrouter-live-piximage_" + currentId + "-fixture-secret");
  expect(typeof callee).toBe("function"); expect(Array.isArray(module.faults)).toBe(true);
  if (!guardIdentity) guardIdentity = { module, callee };
  expect(module).toBe(guardIdentity.module); expect(callee).toBe(guardIdentity.callee);
  if (!returned) { rows.push({ kind: "guard", state: "rejected", error: value, fn: callee, receiver, args }); return; }
  observe("guard", value as Promise<{ response: Response; release: () => Promise<void> }>, installAcquisition, { fn: callee, receiver, args });
}
beforeEach(() => {
  retired = undefined; currentId = undefined;
  rows.length = tails.length = acquisitions.length = faults.length = readers.length = 0;
  guardChannel = undefined;
  expect(Object.getOwnPropertyDescriptor(globalThis, guardKey)).toBe(undefined);
  guardChannel = Object.freeze({ modules: new Set<GuardModule>(), observe: observeGuard });
  Object.defineProperty(globalThis, guardKey, { configurable: true, value: guardChannel });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = new Request(input, init);
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
  if (failures.length) throw new AggregateError(failures, "PixVerse original guard, retirement and observation restoration");
  if (retired) console.log("PIXVERSE_IMAGE_RETIRED " + retired);
});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const environment = { env: { CLAWROUTER_API_KEY: undefined, PIXVERSE_API_KEY: "must-not-fallback" } };
function config(id: string, model: string): OpenClawConfig {
  return {
    plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
    agents: { defaults: { mediaModels: { video: { primary: "clawrouter/pixverse/" + model } } } },
    models: { providers: { clawrouter: { auth: "api-key", apiKey: "clawrouter-live-piximage_" + id + "-fixture-secret", models: [],
      baseUrl: origin + "/v1", request: { allowPrivateNetwork: true } } } },
  };
}
function run(id: string, model = "v6", extras: Record<string, unknown> = {}) {
  currentId = id;
  return generateVideo({ cfg: config(id, model), prompt: "Synthetic " + id, timeoutMs: 20000, autoProviderFallback: false,
    inputImages: [{ buffer: png, mimeType: "image/png" }], durationSeconds: 5, resolution: "720p", ...extras });
}
describe("registered ClawRouter PixVerse composed image through Worker and SQLite", () => {
  for (const model of ["v6", "c1"]) it(model + " owns upload, create, original ID polling and terminal video", async () => {
    await withTempHome(async () => {
      const result = await run(model, model);
      expect(result).toMatchObject({ provider: "clawrouter", model: "pixverse/" + model, attempts: [], metadata: { status: 1 } });
      expect(result.videos).toHaveLength(1); expect(result.videos[0]).toEqual({ url: asset, mimeType: "video/mp4" });
      expect(globalThis.fetch).not.toHaveBeenCalledWith(asset, expect.anything());
      expect(acquisitions.length).toBeGreaterThanOrEqual(4);
      retired = model;
    }, environment);
  });
  for (const id of ["failed", "ambiguous"]) it(id + " preserves terminal failure without another create or fallback", async () => {
    await withTempHome(async () => { await expect(run(id)).rejects.toThrow(); expect(acquisitions.length).toBeGreaterThanOrEqual(2); }, environment);
  });
  for (const id of ["unpriced", "globalfee", "nouploadprice", "nocreateprice", "retention", "foreign", "foreignprofile", "budget"]) it(id + " cannot acquire image dispatch authority", async () => {
    await withTempHome(async () => { await expect(run(id)).rejects.toThrow(); expect(acquisitions).toHaveLength(1); }, environment);
  });
  for (const [id, extras] of [
    ["forged", { providerOptions: { img_id: 123 } }],
    ["remote", { inputImages: [{ url: "https://example.com/input.png" }] }],
    ["badmime", { inputImages: [{ buffer: png, mimeType: "image/jpeg" }] }],
  ] as const) it(id + " is rejected before catalog or paid transport", async () => {
    await withTempHome(async () => { await expect(run(id, "v6", extras)).rejects.toThrow(); expect(globalThis.fetch).not.toHaveBeenCalled(); expect(acquisitions).toHaveLength(0); }, environment);
  });
});
