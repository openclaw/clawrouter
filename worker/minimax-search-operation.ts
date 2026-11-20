import { BodyLease } from "./body-budget.ts";
import { HttpOperation } from "./http-operation.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { createJsonTokenizer } from "./json-tokens.ts";
import { HttpError } from "./utils.ts";

const KiB = 1024;
export const searchControlHeader = "x-clawrouter-search-control";
export const searchControlVersion = "clawrouter.minimax-search.v1";
export const searchCharge = 72 * KiB * KiB;
export const searchControlBytes = 16 * KiB;
export const searchWindowBytes = 16 * KiB;
export const searchReadLimit = 8192;
type Profile = "control" | "input" | "native";
const limits = {
  control: { bytes: searchControlBytes, depth: 16, values: 128, members: 128, entries: 128, strings: 8192, scalar: 4096 },
  input: { bytes: 64 * KiB, depth: 16, values: 128, members: 128, entries: 128, strings: 32768, scalar: 16384 },
  native: { bytes: KiB * KiB, depth: 64, values: 8192, members: 8192, entries: 8192, strings: KiB * KiB, scalar: 65536 },
} as const;
export function searchUnavailable(): never { throw new HttpError(503, "minimax_search_unavailable", "MiniMax search resource or owner qualification is unavailable"); }

// Count before stringify/encode/copy. Object accessors and non-JSON graphs are
// excluded; undefined object properties have the same omission as JSON.stringify.
export function searchJsonBytes(value: unknown, profile: Profile = "control"): number {
  const cap = limits[profile]; let bytes = 0, values = 0, members = 0, entries = 0, units = 0;
  const add = (n: number) => { if ((bytes += n) > cap.bytes) searchUnavailable(); };
  const string = (text: string) => {
    if (text.length > cap.scalar || (units += text.length) > cap.strings) searchUnavailable();
    add(2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i), next = text.charCodeAt(i + 1);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) add(2);
      else if (c < 32) add(6);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { add(4); i++; }
      else add(c >= 0xd800 && c <= 0xdfff ? 6 : 3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (++values > cap.values || depth > cap.depth) searchUnavailable();
    if (item === null) { add(4); return; }
    if (typeof item === "string") { string(item); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number") { if (!Number.isFinite(item)) searchUnavailable(); add(String(item).length); return; }
    if (typeof item !== "object") searchUnavailable();
    if (Array.isArray(item)) {
      if ((entries += item.length) > cap.entries) searchUnavailable();
      add(2 + Math.max(0, item.length - 1));
      for (let i = 0; i < item.length; i++) visit(item[i] ?? null, depth + 1);
      return;
    }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) searchUnavailable();
    add(2); let emitted = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (++members > cap.members) searchUnavailable();
      const field = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in field)) searchUnavailable();
      if (field.value === undefined) continue;
      if (emitted++) add(1);
      string(key); add(1); visit(field.value, depth + 1);
    }
  };
  visit(value, 1); return bytes;
}

export function searchJsonInspector(profile: Profile) {
  const cap = limits[profile], stack: boolean[] = [];
  let values = 0, members = 0, entries = 0, units = 0, scalar = 0;
  const value = () => {
    if (++values > cap.values || stack.length + 1 > cap.depth) searchUnavailable();
    if (stack.at(-1) && ++entries > cap.entries) searchUnavailable();
  };
  return createJsonTokenizer(token => {
    switch (token.name) {
      case "startObject": case "startArray": value(); stack.push(token.name === "startArray"); break;
      case "endObject": case "endArray": stack.pop(); break;
      case "startKey": if (++members > cap.members) searchUnavailable(); scalar = 0; break;
      case "startString": value(); scalar = 0; break;
      case "stringChunk":
        if ((scalar += token.value.length) > cap.scalar || (units += token.value.length) > cap.strings) searchUnavailable();
        break;
      case "startNumber": value(); scalar = 0; break;
      case "numberChunk": if ((scalar += token.value.length) > 128) searchUnavailable(); break;
      case "nullValue": case "trueValue": case "falseValue": value(); break;
    }
  });
}

export function inspectSearchJson(text: string, profile: Profile = "control"): void {
  const inspect = searchJsonInspector(profile);
  // <=256 UTF-16 units keeps each feed <=1KiB UTF-8, including supplementary pairs.
  for (let i = 0; i < text.length;) {
    let end = Math.min(text.length, i + 256);
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
    inspect.push(text.slice(i, end)); i = end;
  }
  inspect.end();
}

export function assertSearchHeaders(headers: Headers, control = false): void {
  let count = 0, bytes = 0;
  for (const [key, value] of headers) {
    if (++count > (control ? 32 : 64)) searchUnavailable();
    // Fetch Headers are byte strings. Reject before any new Headers copy.
    bytes += key.length + value.length + 4;
    if (bytes > (control ? 4 : 16) * KiB) searchUnavailable();
  }
}

export async function readSearchJson(source: Request | Response, signal: AbortSignal, profile: Profile,
  register: (input: InputRetirement, source: Request | Response) => void): Promise<unknown> {
  if (!source.body || source.bodyUsed || source.body.locked) searchUnavailable();
  let reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader, byob = false;
  try { reader = source.body.getReader({ mode: "byob" }); byob = true; }
  catch { reader = source.body.getReader(); }
  let firstCancel: Promise<void> | undefined;
  const base = inputRetirement({ cancel(reason) {
    if (!firstCancel) { firstCancel = reader.cancel(reason); void firstCancel.catch(() => undefined); }
    return firstCancel;
  }, releaseLock: () => reader.releaseLock() });
  const retired = base.retired.then(() => firstCancel);
  void retired.catch(() => undefined);
  const input: InputRetirement = { read: start => base.read(start), retired,
    retire(kind, reason) { void base.retire(kind, reason).catch(() => undefined); return retired; } };
  try { register(input, source); }
  catch (error) { await input.retire("cancel", error).catch(() => undefined); throw error; }
  const abort = () => { void input.retire("cancel", signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let eof = false;
  try {
    signal.throwIfAborted();
    // A default reader cannot bound the backing before acquisition. Own its
    // cancellation, but refuse BEFORE read; only a byte-stream BYOB is admitted.
    if (!byob) searchUnavailable();
    assertSearchHeaders(source.headers, profile === "control");
    const type = source.headers.get("content-type"), length = source.headers.get("content-length");
    if (source instanceof Response && (source.redirected || profile === "native" && source.status !== 200) || !type || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(type.trim())
      || source.headers.has("content-range") || ![null, "identity"].includes(source.headers.get("content-encoding"))
      || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limits[profile].bytes)) searchUnavailable();
    const raw = new Uint8Array(limits[profile].bytes), decoder = new TextDecoder("utf-8", { fatal: true }), inspect = searchJsonInspector(profile);
    let window = new Uint8Array(searchWindowBytes), bytes = 0, reads = 0;
    for (;;) {
      signal.throwIfAborted(); if (++reads > searchReadLimit) searchUnavailable();
      const chunk = await input.read(() => (reader as ReadableStreamBYOBReader).read(window));
      signal.throwIfAborted();
      if (chunk.value && (!(chunk.value instanceof Uint8Array) || !(chunk.value.buffer instanceof ArrayBuffer)
        || chunk.value.buffer.byteLength > searchWindowBytes || chunk.value.byteLength > searchWindowBytes)) searchUnavailable();
      if (chunk.done) { if (chunk.value?.byteLength) searchUnavailable(); eof = true; break; }
      if (!chunk.value || (bytes += chunk.value.byteLength) > raw.length) searchUnavailable();
      raw.set(chunk.value, bytes - chunk.value.byteLength);
      for (let at = 0; at < chunk.value.length; at += 256) inspect.push(decoder.decode(chunk.value.subarray(at, at + 256), { stream: true }));
      if (byob) { const backing = chunk.value.buffer; if (!(backing instanceof ArrayBuffer) || !backing.byteLength) searchUnavailable(); window = new Uint8Array(backing); }
    }
    inspect.push(decoder.decode()); inspect.end();
    if (length !== null && Number(length) !== bytes) searchUnavailable();
    await input.retire("eof");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, bytes))) as unknown;
  } catch (error) {
    void input.retire(eof ? "eof" : "cancel", error).catch(() => undefined);
    throw error;
  } finally { signal.removeEventListener("abort", abort); }
}

// One opaque operation owns all allocations. Tickets never refund; queue entries
// hold bounded descriptors, not serialized bodies. No object escapes into a cache.
export class MiniMaxSearchOperation {
  readonly operation: HttpOperation;
  private readonly lease = new BodyLease();
  private ordinary = 0;
  private mandatory = 0;
  private active = [0, 0];
  private queues: Array<Array<() => void>> = [[], []];
  private work: Promise<unknown>[] = [];
  private inputs: InputRetirement[] = [];
  private responses = new Map<Response, () => void>();
  private ownershipFailed = false;
  private inputClaimed = false;
  private readonly inputRequest: Request;
  private readonly owners = new WeakMap<Response, InputRetirement>();
  private readonly disposals = new WeakMap<Response, Promise<void>>();
  private readonly physicalBodies: ReadableStream<Uint8Array>[] = [];
  private providerRelease?: () => void;
  private providerStarted = false;
  private finished?: Promise<void>;
  private pinValue?: string;
  constructor(request: Request, timeoutMs: number) {
    if (!this.lease.grow(36 * KiB * KiB)) throw new HttpError(503, "server_overloaded", "MiniMax search capacity is busy; retry shortly");
    this.inputRequest = request;
    this.operation = new HttpOperation(request.signal, Math.min(timeoutMs, 120_000));
    this.operation.signal.addEventListener("abort", () => {
      for (const input of this.inputs) void input.retire("cancel", this.operation.signal.reason).catch(() => undefined);
      for (const response of this.responses.keys()) void this.discard(response).catch(() => undefined);
    }, { once: true });
  }
  pin(value: string): void { if (value.length > 4096 || this.pinValue !== undefined && this.pinValue !== value) searchUnavailable(); this.pinValue = value; }
  track<T>(promise: Promise<T>): Promise<T> {
    if (this.work.length >= 128) searchUnavailable();
    this.work.push(promise); void promise.catch(() => undefined); return promise;
  }
  registerInput = (input: InputRetirement, source: Request | Response): void => {
    if (this.inputs.length >= 40) searchUnavailable();
    this.inputs.push(input);
    if (source.body) this.physicalBodies.push(source.body);
    if (source === this.inputRequest) this.inputClaimed = true;
    if (source instanceof Response) {
      this.owners.set(source, input);
      const release = this.responses.get(source);
      this.responses.delete(source);
      if (release) void input.retired.finally(release).catch(() => undefined);
    }
  };
  discard(response: Response): Promise<void> {
    const existing = this.disposals.get(response);
    if (existing) return existing;
    const pending = (async () => {
      const owned = this.owners.get(response);
      if (owned) { await owned.retire("cancel", this.operation.signal.reason); return; }
      const release = this.responses.get(response); this.responses.delete(response);
      if (!response.body) { release?.(); return; }
      if (response.bodyUsed || response.body.locked) {
        this.ownershipFailed = true;
        for (const queue of this.queues) for (const wake of queue.splice(0)) wake();
        searchUnavailable();
      }
      const reader = response.body.getReader();
      let cancellation: Promise<void> | undefined;
      const base = inputRetirement({ cancel: reason => {
        if (!cancellation) { cancellation = reader.cancel(reason); void cancellation.catch(() => undefined); }
        return cancellation;
      }, releaseLock: () => reader.releaseLock() });
      const retired = base.retired.then(() => cancellation);
      void retired.catch(() => undefined);
      const input: InputRetirement = { read: start => base.read(start), retired,
        retire(kind, reason) { void base.retire(kind, reason).catch(() => undefined); return retired; } };
      this.registerInput(input, response);
      try { await input.retire("cancel", this.operation.signal.reason); }
      finally { if (!response.body.locked) release?.(); }
    })();
    this.disposals.set(response, pending); void pending.catch(() => undefined);
    return pending;
  }
  private async slot(mandatory: boolean): Promise<() => void> {
    if (this.ownershipFailed) searchUnavailable();
    const lane = mandatory ? 1 : 0, cap = mandatory ? 1 : 4;
    if (this.active[lane] >= cap) await new Promise<void>(resolve => this.queues[lane].push(resolve));
    else this.active[lane]++;
    if (this.ownershipFailed) searchUnavailable();
    let released = false;
    return () => {
      if (released) return; released = true;
      const next = this.queues[lane].shift();
      if (next) next(); else this.active[lane]--;
    };
  }
  private ticket(mandatory: boolean): void {
    if (mandatory ? ++this.mandatory > 10 : ++this.ordinary > 22) searchUnavailable();
  }
  reserveProvider(): Promise<void> {
    if (this.providerRelease || this.providerStarted) searchUnavailable();
    this.ticket(false);
    return this.track((async () => {
      const release = await this.slot(false);
      if (this.operation.signal.aborted) { release(); this.operation.signal.throwIfAborted(); }
      this.providerRelease = release;
    })());
  }
  providerFetch(start: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    if (!this.providerRelease || this.providerStarted) searchUnavailable();
    this.providerStarted = true;
    const release = this.providerRelease; this.providerRelease = undefined;
    return this.track((async () => {
      try {
        this.operation.signal.throwIfAborted();
        const response = await start(this.operation.signal);
        this.responses.set(response, release);
        if (this.operation.signal.aborted) { await this.discard(response); this.operation.signal.throwIfAborted(); }
        return response;
      } catch (error) { if (!this.ownershipFailed) release(); throw error; }
    })());
  }
  fetch(start: (signal: AbortSignal) => Promise<Response>, mandatory = false, signal = this.operation.signal): Promise<Response> {
    this.ticket(mandatory);
    return this.track((async () => {
      const release = await this.slot(mandatory);
      try {
        signal.throwIfAborted();
        const response = await start(signal);
        this.responses.set(response, release);
        if (signal.aborted) { await this.discard(response); signal.throwIfAborted(); }
        return response;
      } catch (error) { if (!this.ownershipFailed) release(); throw error; }
    })());
  }
  controlJson<T>(body: unknown, start: (text: string, signal: AbortSignal) => Promise<Response>, mandatory = false,
    signal?: AbortSignal): Promise<T> {
    searchJsonBytes(body);
    return this.track((async () => {
      // Accounting survives caller cancellation, but each physical HTTP attempt
      // has a finite 30s execution window. At most ten nonrefundable attempts
      // exist; a fallback starts only AFTER its predecessor physically retires.
      const completion = mandatory ? new HttpOperation(undefined, 30_000) : undefined;
      const activeSignal = completion?.signal ?? signal ?? this.operation.signal;
      let response: Response | undefined, input: InputRetirement | undefined;
      try {
        response = await this.fetch(active => start(JSON.stringify(body), active), mandatory, activeSignal);
        const result = await readSearchJson(response, activeSignal, "control", (owner, source) => { input = owner; this.registerInput(owner, source); });
        if (!response.ok) throw new HttpError(response.status, "minimax_search_control_unavailable", "MiniMax search control was not acknowledged");
        return result as T;
      } catch (error) {
        // A mandatory fallback cannot enter while its predecessor still owns
        // the sole mandatory slot. Public failure has its separate operation race.
        if (input) {
          if (mandatory) await input.retired.catch(() => undefined);
        } else if (response) {
          // Includes bodyless replies: release their slot before the existing
          // fallback. A locked unowned body poisons scheduling, never self-joins.
          await this.discard(response).catch(() => undefined);
        }
        throw error;
      } finally { completion?.stop("complete"); }
    })());
  }
  task<T>(start: () => Promise<T>, mandatory = false): Promise<T> {
    this.ticket(mandatory);
    return this.track((async () => {
      const release = await this.slot(mandatory);
      const completion = mandatory ? new HttpOperation(undefined, 30_000) : undefined;
      try {
        const signal = completion?.signal ?? this.operation.signal;
        signal.throwIfAborted();
        // R2/Queue expose no cancellation ACK: keep this slot until their actual
        // promise settles, even after the execution window closes. Never race-release.
        const result = await start(); signal.throwIfAborted(); return result;
      }
      finally { completion?.stop("complete"); release(); }
    })());
  }
  finish(): Promise<void> {
    if (this.finished) return this.finished;
    this.finished = (async () => {
      // Child registrations are made before their pre-registered root settles.
      let count = -1;
      while (count !== this.work.length) { count = this.work.length; await Promise.allSettled(this.work); }
      if (!this.inputClaimed && this.inputRequest.body && !this.inputRequest.bodyUsed && !this.inputRequest.body.locked) {
        const reader = this.inputRequest.body.getReader(), input = inputRetirement(reader);
        this.registerInput(input, this.inputRequest);
        await input.retire("cancel").catch(() => undefined);
      }
      if (this.responses.size) await Promise.allSettled([...this.responses.keys()].map(response => this.discard(response)));
      await Promise.allSettled(this.inputs.map(input => input.retired));
      if (this.ownershipFailed || this.physicalBodies.some(body => body.locked)) searchUnavailable();
      this.physicalBodies.length = 0;
      this.providerRelease?.(); this.providerRelease = undefined;
      this.work.length = 0; this.inputs.length = 0; this.pinValue = undefined;
      this.lease.release(); this.operation.stop("complete");
    })();
    return this.finished;
  }
}
