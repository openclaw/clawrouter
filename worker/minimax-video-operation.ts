import { BodyLease } from "./body-budget.ts";
import { HttpOperation } from "./http-operation.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { createJsonTokenizer } from "./json-tokens.ts";
import { jsonBodyTransport } from "./json-body.ts";
import { HttpError } from "./utils.ts";

const KiB = 1024;
export const videoControlHeader = "x-clawrouter-video-control";
export const videoControlVersion = "clawrouter.minimax-video.v1";
export const videoCharge = 96 * KiB * KiB;
export const videoControlBytes = 64 * KiB;
export const videoWindowBytes = 16 * KiB;
export const videoReadLimit = 8192;
type Profile = "control" | "input" | "native" | "metadata";
const limits = {
  control: { bytes: videoControlBytes, depth: 16, values: 512, members: 512, entries: 512, strings: 32768, scalar: 16384 },
  input: { bytes: 64 * KiB, depth: 16, values: 128, members: 128, entries: 128, strings: 32768, scalar: 16384 },
  native: { bytes: KiB * KiB, depth: 32, values: 4096, members: 4096, entries: 4096, strings: 262144, scalar: 65536 },
  metadata: { bytes: 64 * KiB, depth: 32, values: 4096, members: 4096, entries: 4096, strings: 262144, scalar: 65536 },
} as const;
export function videoUnavailable(): never { throw new HttpError(503, "minimax_video_unavailable", "MiniMax video resource or owner qualification is unavailable"); }

// Count before stringify/encode/copy. Object accessors and non-JSON graphs are
// excluded; undefined object properties have the same omission as JSON.stringify.
export function videoJsonBytes(value: unknown, profile: Profile = "control"): number {
  const cap = limits[profile]; let bytes = 0, values = 0, members = 0, entries = 0, units = 0;
  const add = (n: number) => { if ((bytes += n) > cap.bytes) videoUnavailable(); };
  const string = (text: string) => {
    if (text.length > cap.scalar || (units += text.length) > cap.strings) videoUnavailable();
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
    if (++values > cap.values || depth > cap.depth) videoUnavailable();
    if (item === null) { add(4); return; }
    if (typeof item === "string") { string(item); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number") { if (!Number.isFinite(item)) videoUnavailable(); add(String(item).length); return; }
    if (typeof item !== "object") videoUnavailable();
    if (Array.isArray(item)) {
      if ((entries += item.length) > cap.entries) videoUnavailable();
      add(2 + Math.max(0, item.length - 1));
      for (let i = 0; i < item.length; i++) visit(item[i] ?? null, depth + 1);
      return;
    }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) videoUnavailable();
    add(2); let emitted = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (++members > cap.members) videoUnavailable();
      const field = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in field)) videoUnavailable();
      if (field.value === undefined) continue;
      if (emitted++) add(1);
      string(key); add(1); visit(field.value, depth + 1);
    }
  };
  visit(value, 1); return bytes;
}

export interface VideoJsonCounts { values: number; members: number; entries: number; units: number }
export function videoJsonInspector(profile: Profile) {
  const cap = limits[profile], stack: boolean[] = [];
  let values = 0, members = 0, entries = 0, units = 0, scalar = 0;
  const value = () => {
    if (++values > cap.values || stack.length + 1 > cap.depth) videoUnavailable();
    if (stack.at(-1) && ++entries > cap.entries) videoUnavailable();
  };
  const tokenizer = createJsonTokenizer(token => {
    switch (token.name) {
      case "startObject": case "startArray": value(); stack.push(token.name === "startArray"); break;
      case "endObject": case "endArray": stack.pop(); break;
      case "startKey": if (++members > cap.members) videoUnavailable(); scalar = 0; break;
      case "startString": value(); scalar = 0; break;
      case "stringChunk":
        if ((scalar += token.value.length) > cap.scalar || (units += token.value.length) > cap.strings) videoUnavailable();
        break;
      case "startNumber": value(); scalar = 0; break;
      case "numberChunk": if ((scalar += token.value.length) > 128) videoUnavailable(); break;
      case "nullValue": case "trueValue": case "falseValue": value(); break;
    }
  });
  return { ...tokenizer, counts: (): VideoJsonCounts => ({ values, members, entries, units }) };
}

export function inspectVideoJson(text: string, profile: Profile = "control"): VideoJsonCounts {
  const inspect = videoJsonInspector(profile);
  // <=256 UTF-16 units keeps each feed <=1KiB UTF-8, including supplementary pairs.
  for (let i = 0; i < text.length;) {
    let end = Math.min(text.length, i + 256);
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
    inspect.push(text.slice(i, end)); i = end;
  }
  inspect.end();
  return inspect.counts();
}

export function assertVideoHeaders(headers: Headers, control = false): void {
  let count = 0, bytes = 0;
  for (const [key, value] of headers) {
    if (++count > 32) videoUnavailable();
    // Fetch Headers are byte strings. Reject before any new Headers copy.
    bytes += key.length + value.length + 4;
    if (bytes > 4 * KiB) videoUnavailable();
  }
}

export async function readVideoJson(source: Request | Response, signal: AbortSignal, profile: Profile,
  register: (input: InputRetirement, source: Request | Response) => void, parse: (text: string) => unknown = JSON.parse): Promise<unknown> {
  if (!source.body || source.bodyUsed || source.body.locked) videoUnavailable();
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
    if (!byob) videoUnavailable();
    assertVideoHeaders(source.headers, profile === "control");
    const type = source.headers.get("content-type"), length = source.headers.get("content-length");
    if (source instanceof Response && (source.redirected || profile !== "control" && source.status !== 200) || !type || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(type.trim())
      || source.headers.has("content-range") || ![null, "identity"].includes(source.headers.get("content-encoding"))
      || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limits[profile].bytes)) videoUnavailable();
    const raw = new Uint8Array(limits[profile].bytes), decoder = new TextDecoder("utf-8", { fatal: true }), inspect = videoJsonInspector(profile);
    let window = new Uint8Array(videoWindowBytes), bytes = 0, reads = 0;
    for (;;) {
      signal.throwIfAborted(); if (++reads > videoReadLimit) videoUnavailable();
      const chunk = await input.read(() => (reader as ReadableStreamBYOBReader).read(window));
      signal.throwIfAborted();
      if (chunk.value && (!(chunk.value instanceof Uint8Array) || !(chunk.value.buffer instanceof ArrayBuffer)
        || chunk.value.buffer.byteLength > videoWindowBytes || chunk.value.byteLength > videoWindowBytes)) videoUnavailable();
      if (chunk.done) { if (chunk.value?.byteLength) videoUnavailable(); eof = true; break; }
      if (!chunk.value || (bytes += chunk.value.byteLength) > raw.length) videoUnavailable();
      raw.set(chunk.value, bytes - chunk.value.byteLength);
      for (let at = 0; at < chunk.value.length; at += 256) inspect.push(decoder.decode(chunk.value.subarray(at, at + 256), { stream: true }));
      if (byob) { const backing = chunk.value.buffer; if (!(backing instanceof ArrayBuffer) || !backing.byteLength) videoUnavailable(); window = new Uint8Array(backing); }
    }
    inspect.push(decoder.decode()); inspect.end();
    if (length !== null && Number(length) !== bytes) videoUnavailable();
    await input.retire("eof");
    return parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, bytes)));
  } catch (error) {
    void input.retire(eof ? "eof" : "cancel", error).catch(() => undefined);
    throw error;
  } finally { signal.removeEventListener("abort", abort); }
}

export async function discardVideoInput(response: Response, register?: (owner: InputRetirement, response?: Response) => void): Promise<void> {
  if (!response.body || response.bodyUsed || response.body.locked) return;
  const input = inputRetirement(response.body.getReader());
  register?.(input, response);
  await input.retire("cancel", new Error("invalid video response"));
}

export async function readVideoFileBytes(response: Response, maxBytes: number, signal: AbortSignal,
  register?: (input: InputRetirement, response?: Response) => void): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16 || maxBytes > 16 * KiB * KiB
    || !response.body || response.bodyUsed || response.body.locked) videoUnavailable();
  let reader: ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>, byob = false;
  try { reader = response.body.getReader({ mode: "byob" }); byob = true; }
  catch { reader = response.body.getReader(); }
  let first: Promise<void> | undefined;
  const base = inputRetirement({ cancel(reason) {
    first ??= reader.cancel(reason); void first.catch(() => undefined); return first;
  }, releaseLock: () => reader.releaseLock() });
  const retired = base.retired.then(() => first);
  void retired.catch(() => undefined);
  const input: InputRetirement = { read: start => base.read(start), retired,
    retire(kind, reason) { void base.retire(kind, reason).catch(() => undefined); return retired; } };
  const abort = () => { void input.retire("cancel", signal.reason).catch(() => undefined); };
  let eof = false, registered = false;
  try {
    register?.(input, response);
    registered = !!register;
    signal.addEventListener("abort", abort, { once: true }); signal.throwIfAborted();
    if (!byob) videoUnavailable();
    assertVideoHeaders(response.headers);
    const mime = response.headers.get("content-type")?.trim().toLowerCase();
    const length = response.headers.get("content-length");
    if (response.status !== 200 || response.redirected || response.headers.has("content-range")
      || !["video/mp4", "application/octet-stream", "application/json"].includes(mime ?? "")
      || ![null, "identity"].includes(response.headers.get("content-encoding"))
      || length !== null && (!/^(?:0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes))
      videoUnavailable();
    const bytes = new Uint8Array(maxBytes);
    let window = new Uint8Array(videoWindowBytes), offset = 0, reads = 0;
    for (;;) {
      signal.throwIfAborted(); if (++reads > videoReadLimit) videoUnavailable();
      const result = await input.read(() => (reader as ReadableStreamBYOBReader).read(window));
      signal.throwIfAborted();
      if (result.value && (!(result.value.buffer instanceof ArrayBuffer) || result.value.buffer.byteLength > videoWindowBytes)) videoUnavailable();
      if (result.done) { if (result.value?.byteLength) videoUnavailable(); eof = true; break; }
      if (!result.value || offset + result.value.length > maxBytes || !result.value.buffer.byteLength) videoUnavailable();
      bytes.set(result.value, offset); offset += result.value.length;
      window = new Uint8Array(result.value.buffer);
    }
    if (!offset || length !== null && Number(length) !== offset) videoUnavailable();
    await input.retire("eof");
    return bytes.subarray(0, offset);
  } catch (error) {
    const cleanup = input.retire(eof ? "eof" : "cancel", error);
    if (!registered) await cleanup.catch(() => undefined);
    else void cleanup.catch(() => undefined);
    throw error;
  } finally { signal.removeEventListener("abort", abort); }
}

type VideoKind = "create" | "poll" | "collector" | "file";
type PhysicalResponse = { release: () => void; signal: AbortSignal; abort: () => void };

// A fresh owner belongs to ONE invocation. Its fixed reservation includes all
// ticket representations, caller intake, file backing and downstream delivery.
export class MiniMaxVideoOperation {
  readonly operation: HttpOperation;
  readonly deadline: number;
  readonly kind: VideoKind;
  private readonly lease = new BodyLease();
  private readonly execution: HttpOperation;
  private detached = false;
  private ordinary = 0;
  private mandatory = 0;
  private active = [0, 0];
  private readonly queues: Array<Array<() => void>> = [[], []];
  private readonly work = new Set<Promise<unknown>>();
  private registrations = 0;
  private readonly inputs: InputRetirement[] = [];
  private readonly physicalBodies: ReadableStream<Uint8Array>[] = [];
  private readonly responses = new Map<Response, PhysicalResponse>();
  private readonly owners = new WeakMap<Response, InputRetirement>();
  private readonly disposals = new WeakMap<Response, Promise<void>>();
  private readonly request?: Request;
  private inputClaimed = false;
  private ownershipFailed = false;
  private cleanupFailed = false;
  private finishing?: Promise<void>;
  private closed = false;
  private pinValue?: string;
  private providerRelease?: () => void;
  private providerStarted = false;
  private outputStarted = false;

  constructor(kind: VideoKind, request?: Request, timeoutMs = 120_000) {
    if (!this.lease.grow(48 * KiB * KiB)) {
      this.lease.release();
      throw new HttpError(503, "server_overloaded", "MiniMax video capacity is busy");
    }
    this.kind = kind; this.request = request;
    const duration = Math.max(0, Math.min(timeoutMs, kind === "collector" ? 10_000 : 120_000));
    this.deadline = Date.now() + duration;
    // Both clocks start at admission. Detaching the caller never extends time.
    this.operation = new HttpOperation(request?.signal, duration);
    this.execution = new HttpOperation(undefined, duration);
  }

  get controlSignal(): AbortSignal { return this.detached ? this.execution.signal : this.operation.signal; }
  get executionOperation(): HttpOperation { return this.detached ? this.execution : this.operation; }
  detachAtPost(): HttpOperation {
    if (this.kind !== "create" || this.detached || this.providerStarted) videoUnavailable();
    this.operation.signal.throwIfAborted(); this.execution.signal.throwIfAborted();
    if (Date.now() >= this.deadline) videoUnavailable();
    this.detached = true; return this.execution;
  }
  requireOrdinary(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || this.ordinary + count > 22) videoUnavailable();
  }
  pin(value: readonly unknown[] | string): void {
    if (typeof value !== "string") videoJsonBytes(value);
    const next = typeof value === "string" ? value : JSON.stringify(value);
    if (next.length > 16384 || this.pinValue !== undefined && this.pinValue !== next) videoUnavailable();
    this.pinValue = next;
  }
  track<T>(promise: Promise<T>): Promise<T> {
    if (this.closed || ++this.registrations > 128) videoUnavailable();
    this.work.add(promise);
    void promise.finally(() => this.work.delete(promise)).catch(() => undefined);
    return promise;
  }
  registerInput = (input: InputRetirement, source?: Request | Response): void => {
    // At most32 ticket bodies plus caller intake and the one output serializer.
    if (this.closed || this.inputs.length >= 34) videoUnavailable();
    this.inputs.push(input);
    if (source?.body) this.physicalBodies.push(source.body);
    if (source === this.request) this.inputClaimed = true;
    if (source instanceof Response) {
      if (this.owners.has(source)) videoUnavailable();
      this.owners.set(source, input);
      const physical = this.responses.get(source);
      this.responses.delete(source);
      if (physical) {
        source.body && physical.signal.removeEventListener("abort", physical.abort);
        void input.retired.finally(physical.release).catch(() => undefined);
      }
    }
    void input.retired.catch(() => { this.cleanupFailed = true; });
  };
  private ticket(mandatory: boolean): void {
    if (this.closed || (mandatory ? ++this.mandatory > 10 : ++this.ordinary > 22)) videoUnavailable();
  }
  private async slot(mandatory: boolean): Promise<() => void> {
    if (this.ownershipFailed) videoUnavailable();
    const lane = mandatory ? 1 : 0, limit = mandatory ? 1 : 4;
    if (this.active[lane] >= limit) await new Promise<void>(resolve => this.queues[lane].push(resolve));
    else this.active[lane]++;
    if (this.ownershipFailed) videoUnavailable();
    let done = false;
    return () => {
      if (done) return; done = true;
      const next = this.queues[lane].shift();
      if (next) next(); else this.active[lane]--;
    };
  }
  private response(response: Response, release: () => void, signal: AbortSignal): void {
    const abort = () => { void this.discard(response).catch(() => undefined); };
    this.responses.set(response, { release, signal, abort });
    signal.addEventListener("abort", abort, { once: true });
  }
  discardUnclaimed(response: Response): Promise<void> {
    return this.responses.has(response) ? this.discard(response) : Promise.resolve();
  }
  discard(response: Response): Promise<void> {
    const previous = this.disposals.get(response);
    if (previous) return previous;
    const pending = (async () => {
      const owned = this.owners.get(response);
      if (owned) { await owned.retire("cancel", new Error("unpublished video response")); return; }
      const physical = this.responses.get(response);
      this.responses.delete(response);
      physical?.signal.removeEventListener("abort", physical.abort);
      if (!response.body) { physical?.release(); return; }
      if (response.bodyUsed || response.body.locked) {
        this.ownershipFailed = true;
        for (const queue of this.queues) for (const wake of queue.splice(0)) wake();
        videoUnavailable();
      }
      const reader = response.body.getReader();
      let first: Promise<void> | undefined;
      const base = inputRetirement({ cancel: reason => {
        first ??= reader.cancel(reason); void first.catch(() => undefined); return first;
      }, releaseLock: () => reader.releaseLock() });
      const retired = base.retired.then(() => first);
      void retired.catch(() => undefined);
      const input: InputRetirement = { read: start => base.read(start), retired,
        retire(kind, reason) { void base.retire(kind, reason).catch(() => undefined); return retired; } };
      this.registerInput(input, response);
      try { await input.retire("cancel", new Error("unpublished video response")); }
      finally { if (!response.body.locked) physical?.release(); }
    })();
    this.disposals.set(response, pending); void pending.catch(() => undefined);
    return pending;
  }
  reserveProvider(): Promise<void> {
    if (this.providerRelease || this.providerStarted) videoUnavailable();
    this.ticket(false);
    return this.track((async () => {
      const release = await this.slot(false);
      if (this.operation.signal.aborted) { release(); this.operation.signal.throwIfAborted(); }
      this.providerRelease = release;
    })());
  }
  releaseUnsentProvider(): void { this.providerRelease?.(); this.providerRelease = undefined; }
  providerFetch(start: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    if (!this.providerRelease || this.providerStarted || !this.detached) videoUnavailable();
    const release = this.providerRelease; this.providerRelease = undefined;
    this.providerStarted = true;
    return this.track((async () => {
      let response: Response | undefined;
      try {
        this.execution.signal.throwIfAborted();
        response = await start(this.execution.signal);
        this.response(response, release, this.execution.signal);
        if (this.execution.signal.aborted) { await this.discard(response); this.execution.signal.throwIfAborted(); }
        return response;
      } catch (error) { if (!response) release(); throw error; }
    })());
  }
  nativeResponse(start: () => Promise<Response>, signal = this.controlSignal): Promise<Response> {
    return this.fetch(() => start(), false, signal);
  }
  fetch(start: (signal: AbortSignal) => Promise<Response>, mandatory = false, signal = this.controlSignal): Promise<Response> {
    this.ticket(mandatory);
    return this.track((async () => {
      const release = await this.slot(mandatory);
      let response: Response | undefined;
      try {
        signal.throwIfAborted();
        response = await start(signal);
        this.response(response, release, signal);
        if (signal.aborted) { await this.discard(response); signal.throwIfAborted(); }
        return response;
      } catch (error) { if (!response) release(); throw error; }
    })());
  }
  controlJson<T>(body: unknown, start: (text: string, signal: AbortSignal) => Promise<Response>,
    mandatory = false, signal?: AbortSignal): Promise<T> {
    videoJsonBytes(body);
    return this.track((async () => {
      const completion = mandatory ? new HttpOperation(undefined, 15_000) : undefined;
      const active = completion?.signal ?? signal ?? this.controlSignal;
      let response: Response | undefined, input: InputRetirement | undefined;
      try {
        response = await this.fetch(current => start(JSON.stringify(body), current), mandatory, active);
        const value = await readVideoJson(response, active, "control", (owner, source) => {
          input = owner; this.registerInput(owner, source);
        });
        if (!response.ok) throw new HttpError(response.status, "minimax_video_control_unavailable", "Video control was not acknowledged");
        return value as T;
      } catch (error) {
        if (input) { if (mandatory) await input.retired.catch(() => undefined); }
        else if (response) await this.discard(response).catch(() => undefined);
        throw error;
      } finally { completion?.stop("complete"); }
    })());
  }
  publish(value: unknown, status: number, headers: HeadersInit, caller = this.operation.signal): Response {
    if (this.outputStarted) videoUnavailable();
    this.outputStarted = true;
    videoJsonBytes(value, "native");
    caller = AbortSignal.any([caller, this.operation.signal]);
    const transport = jsonBodyTransport(value, KiB * KiB);
    const reader = transport.stream().getReader(), input = inputRetirement(reader);
    this.registerInput(input);
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const abort = () => {
      transport.discard(); void input.retire("cancel", caller.reason).catch(() => undefined);
      try { output?.error(caller.reason); } catch { /* already closed */ }
    };
    caller.addEventListener("abort", abort, { once: true });
    void input.retired.finally(() => caller.removeEventListener("abort", abort)).catch(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; if (caller.aborted) abort(); },
      async pull(controller) {
        try {
          const chunk = await input.read(() => reader.read());
          if (chunk.done) { await input.retire("eof"); controller.close(); }
          else if (!caller.aborted) controller.enqueue(chunk.value);
        } catch (error) { void input.retire("cancel", error).catch(() => undefined); controller.error(error); }
      },
      cancel(reason) { transport.discard(); void input.retire("cancel", reason).catch(() => undefined); },
    }, { highWaterMark: 0 });
    return new Response(body, { status, headers });
  }
  publishFile(bytes: Uint8Array, headers: HeadersInit): Response {
    if (this.outputStarted) videoUnavailable();
    this.outputStarted = true;
    if (bytes.buffer.byteLength > 16 * KiB * KiB || bytes.byteOffset !== 0 || !bytes.byteLength) videoUnavailable();
    let retained: Uint8Array | undefined = bytes, offset = 0;
    bytes = new Uint8Array(0);
    let done!: () => void;
    const retirement = new Promise<void>(resolve => { done = resolve; });
    this.track(retirement);
    const signal = this.operation.signal;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const retire = () => { retained = undefined; signal.removeEventListener("abort", abort); done(); };
    const abort = () => { try { output?.error(signal.reason); } finally { retire(); } };
    signal.addEventListener("abort", abort, { once: true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; if (signal.aborted) abort(); },
      pull(controller) {
        if (!retained || signal.aborted) return;
        if (offset === retained.byteLength) { controller.close(); retire(); return; }
        const end = Math.min(retained.byteLength, offset + videoWindowBytes);
        controller.enqueue(retained.subarray(offset, end)); offset = end;
      },
      cancel() { retire(); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: 200, headers });
  }
  finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.finishing = (async () => {
      // Registered roots may register children until they settle. Output
      // retirement is separate and cannot wait on this encompassing finish.
      while (this.work.size) await Promise.allSettled([...this.work]);
      if (!this.inputClaimed && this.request?.body) {
        if (this.request.bodyUsed || this.request.body.locked) this.ownershipFailed = true;
        else {
          const input = inputRetirement(this.request.body.getReader());
          this.registerInput(input, this.request);
          await input.retire("cancel").catch(() => undefined);
        }
      }
      await Promise.allSettled([...this.responses.keys()].map(response => this.discard(response)));
      this.closed = true;
      await Promise.allSettled(this.inputs.map(input => input.retired));
      if (this.ownershipFailed || this.physicalBodies.some(body => body.locked)) videoUnavailable();
      this.providerRelease?.(); this.providerRelease = undefined;
      this.operation.stop("complete"); this.execution.stop("complete");
      this.inputs.length = 0; this.physicalBodies.length = 0; this.pinValue = undefined;
      this.lease.release();
      if (this.cleanupFailed) throw new HttpError(503, "minimax_video_cleanup_failed", "Video input cleanup failed");
    })();
    return this.finishing;
  }
}

