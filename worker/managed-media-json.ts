import { BodyLease } from "./body-budget.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { createJsonTokenizer } from "./json-tokens.ts";
import { jsonBodyTransport } from "./json-body.ts";
import { HttpOperation } from "./http-operation.ts";
import { HttpError } from "./utils.ts";

// Legacy protocol wrappers retain their existing reader unless explicitly
// supplied the Wan ownership profile below.
export const managedMediaEnvelopeBytes = 1024 * 1024;

export function mediaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalMediaBase64(value: unknown, limit: number, fail: () => never): { base64: string; decodedBytes: number } {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(limit / 3) * 4
    || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) fail();
  const standard = value.replace(/-/g, "+").replace(/_/g, "/"), unpadded = standard.replace(/=+$/, "");
  if (unpadded.length % 4 === 1 || standard.includes("=") && standard.length % 4) fail();
  const canonical = unpadded + "=".repeat((4 - unpadded.length % 4) % 4), tail = canonical.slice(-4);
  if (standard.includes("=") && standard !== canonical || btoa(atob(tail)) !== tail) fail();
  const decodedBytes = Math.floor(unpadded.length * 3 / 4);
  if (decodedBytes > limit) fail();
  return { base64: canonical, decodedBytes };
}

export function exactMediaParams(params: Record<string, string>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(params, key))
    || Object.keys(params).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("invalid_managed_media_params");
}

export function noMediaQuery(query: URLSearchParams): void {
  if (query.size) throw new Error("unsupported_managed_media_query");
}

export async function readMediaJson(response: Response, allowed: (status: number) => boolean = status => status >= 200 && status < 300,
  wan?: WanJsonInput): Promise<{
  text: string; body: Record<string, unknown>;
}> {
  if (wan) {
    try {
      const value = await readWanJson(response, managedMediaEnvelopeBytes, wan, allowed);
      if (!mediaObject(value.body)) throw wanFailure();
      return { text: value.text, body: value.body };
    } catch {
      // Provider/control rejection is an unavailable observation, not bad caller
      // JSON. The registered physical owner still retains its cleanup boundary.
      throw new Error("invalid_managed_media_response");
    }
  }
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (response.redirected || !allowed(response.status) || mime !== "application/json" || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_managed_media_response");
  }
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > managedMediaEnvelopeBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("managed_media_response_too_large");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > managedMediaEnvelopeBytes) throw new Error("managed_media_response_too_large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    if (!mediaObject(body)) throw new Error("invalid_managed_media_envelope");
    return { text, body };
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("invalid_managed_media_envelope");
  } finally { reader.releaseLock(); }
}

export function mediaPublicPath(path: string | undefined): string {
  if (typeof path !== "string" || !/^\/(?!\/)[a-zA-Z0-9_/-]+(?:\?[a-zA-Z0-9_=&-]+)?$/.test(path)) {
    throw new Error("invalid_managed_media_public_path");
  }
  return path;
}

export function dropMediaControlUrls(body: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...body };
  for (const key of ["urls", "links", "_links", "status_url", "response_url", "cancel_url", "stream_url"]) delete copy[key];
  return copy;
}

const KiB = 1024, MiB = 1024 * KiB;
export const wanRequestBytes = 8 * MiB;
export const wanRecordBytes = 64 * KiB;
export const wanOutputBytes = 2 * MiB;
export const wanOperationCharge = 72 * MiB;
const wanWindowBytes = 16 * KiB, wanReadLimit = 8192;
const wanJsonLimits = { depth: 32, values: 4096, members: 4096, perObject: 128, perArray: 1024, string: 65536, strings: 262144 };
const wanControlLimits = { depth: 16, values: 256, members: 256, perObject: 128, perArray: 256, string: 16384, strings: 16384 };
const wanFailure = () => new HttpError(400, "invalid_wan_json", "Wan JSON exceeds its bounded operation profile");

export interface WanJsonInput {
  signal: AbortSignal;
  registerInput(input: InputRetirement, response?: Response): void;
  control?: boolean;
  empty?: boolean;
}

// A feed emits a bounded token vector; strings/numbers are never packed by the
// tokenizer. Duplicate keys and discarded metadata count BEFORE JSON.parse.
function wanJsonInspector(control: boolean) {
  const limit = control ? wanControlLimits : wanJsonLimits;
  const kinds = new Uint8Array(limit.depth), entries = new Uint16Array(limit.depth);
  let depth = 0, values = 0, members = 0, strings = 0, scalar = 0;
  const value = () => {
    if (++values > limit.values) throw wanFailure();
    if (depth && kinds[depth - 1] === 2 && ++entries[depth - 1] > limit.perArray) throw wanFailure();
  };
  const tokenizer = createJsonTokenizer(token => {
    switch (token.name) {
      case "startObject": case "startArray":
        value();
        if (depth >= limit.depth) throw wanFailure();
        kinds[depth] = token.name === "startArray" ? 2 : 1; entries[depth++] = 0;
        break;
      case "endObject": case "endArray": depth--; break;
      case "startKey":
        if (++members > limit.members || ++entries[depth - 1] > limit.perObject) throw wanFailure();
        scalar = 0; break;
      case "startString": value(); scalar = 0; break;
      case "stringChunk":
        scalar += token.value.length; strings += token.value.length;
        if (scalar > limit.string || strings > limit.strings) throw wanFailure();
        break;
      case "startNumber": value(); scalar = 0; break;
      case "numberChunk": scalar += token.value.length; if (scalar > 128) throw wanFailure(); break;
      case "nullValue": case "trueValue": case "falseValue": value(); break;
    }
  });
  return { push: tokenizer.push, end() { tokenizer.end(); if (depth || !values) throw wanFailure(); } };
}

export function assertWanHeaders(headers: Headers): void {
  let count = 0, bytes = 0;
  for (const [name, value] of headers) {
    if (++count > 64) throw wanFailure();
    bytes += 4;
    for (const text of [name, value]) for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i), next = text.charCodeAt(i + 1);
      if (code < 128) bytes++; else if (code < 2048) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;
      if (bytes > 16 * KiB) throw wanFailure();
    }
  }
}

// Counts escaped UTF-8 without stringify, encoding, Object.entries or sorting.
// A successful pass bounds the later canonical sort and every full string/copy.
export function preflightWanJson(value: unknown, maximumBytes = wanRecordBytes, control = false): number {
  const limit = control ? wanControlLimits : wanJsonLimits;
  let bytes = 0, values = 0, members = 0, strings = 0;
  const add = (amount: number) => { bytes += amount; if (bytes > maximumBytes) throw wanFailure(); };
  const quoted = (text: string) => {
    if (text.length > limit.string || (strings += text.length) > limit.strings) throw wanFailure();
    add(2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i), next = text.charCodeAt(i + 1);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) add(2);
      else if (code < 32) add(6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { add(4); i++; }
      else add(code >= 0xd800 && code <= 0xdfff ? 6 : 3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (++values > limit.values || depth > limit.depth) throw wanFailure();
    if (typeof item === "string") { quoted(item); return; }
    if (item === null) { add(4); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number") { if (!Number.isFinite(item)) throw wanFailure(); add(String(item).length); return; }
    if (typeof item !== "object") throw wanFailure();
    if (Array.isArray(item)) {
      if (item.length > limit.perArray) throw wanFailure();
      add(2 + Math.max(0, item.length - 1));
      for (let i = 0; i < item.length; i++) visit(item[i] ?? null, depth + 1);
      return;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw wanFailure();
    let count = 0, emitted = 0;
    add(2);
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (++count > limit.perObject || ++members > limit.members) throw wanFailure();
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in descriptor)) throw wanFailure();
      if (descriptor.value === undefined) continue;
      if (emitted++) add(1);
      quoted(key); add(1); visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 1);
  return bytes;
}

export async function readWanJson(source: Request | Response, maximumBytes: number, input: WanJsonInput,
  allowed: (status: number) => boolean = status => status >= 200 && status < 300): Promise<{ text: string; body: unknown }> {
  if (!source.body || source.bodyUsed || source.body.locked) throw wanFailure();
  let reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;
  let byob = false;
  try { reader = source.body.getReader({ mode: "byob" }); byob = true; }
  catch { reader = source.body.getReader(); }
  const owner = inputRetirement(reader);
  input.registerInput(owner, source instanceof Response ? source : undefined);
  const abort = () => { void owner.retire("cancel", input.signal.reason).catch(() => undefined); };
  input.signal.addEventListener("abort", abort, { once: true });
  let ended = false;
  try {
    input.signal.throwIfAborted();
    assertWanHeaders(source.headers);
    const type = source.headers.get("content-type")?.trim().toLowerCase();
    const length = source.headers.get("content-length");
    if (source instanceof Response && (source.redirected || !allowed(source.status))
      || !input.empty && (!type || !/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/.test(type))
      || source.headers.has("content-range") || ![null, "identity"].includes(source.headers.get("content-encoding"))
      || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximumBytes)) throw wanFailure();
    const raw = new Uint8Array(maximumBytes), decoder = new TextDecoder("utf-8", { fatal: true });
    const inspect = wanJsonInspector(input.control === true);
    let window = new Uint8Array(wanWindowBytes), bytes = 0, reads = 0;
    for (;;) {
      input.signal.throwIfAborted();
      if (++reads > wanReadLimit) throw wanFailure();
      const chunk = await owner.read(() => byob
        ? (reader as ReadableStreamBYOBReader).read(window)
        : (reader as ReadableStreamDefaultReader<Uint8Array>).read());
      input.signal.throwIfAborted();
      if (chunk.value && (!(chunk.value instanceof Uint8Array) || !(chunk.value.buffer instanceof ArrayBuffer)
        || chunk.value.byteLength > wanWindowBytes || chunk.value.buffer.byteLength > wanWindowBytes)) throw wanFailure();
      if (chunk.done) { if (chunk.value?.byteLength) throw wanFailure(); ended = true; break; }
      if (!(chunk.value instanceof Uint8Array) || !(chunk.value.buffer instanceof ArrayBuffer)
        || byob && !chunk.value.buffer.byteLength || (bytes += chunk.value.byteLength) > maximumBytes) throw wanFailure();
      raw.set(chunk.value, bytes - chunk.value.byteLength);
      for (let offset = 0; offset < chunk.value.byteLength; offset += 1024) {
        // Decoder carry is <=3 bytes. Keep the complete tokenizer feed <=1KiB.
        const end = Math.min(chunk.value.byteLength, offset + 1024);
        const text = decoder.decode(chunk.value.subarray(offset, end), { stream: true });
        for (let cursor = 0; cursor < text.length;) {
          let stop = Math.min(text.length, cursor + 256);
          if (stop < text.length && /[\uD800-\uDBFF]/.test(text[stop - 1])) stop--;
          inspect.push(text.slice(cursor, stop)); cursor = stop;
        }
      }
      if (byob) window = new Uint8Array(chunk.value.buffer);
    }
    const tail = decoder.decode(); if (tail) inspect.push(tail);
    if (!input.empty) inspect.end();
    if (length !== null && Number(length) !== bytes) throw wanFailure();
    await owner.retire("eof");
    if (input.empty) return { text: "", body: {} };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, bytes));
    const body: unknown = JSON.parse(text);
    if (!mediaObject(body) && !(input.control && body === null)) throw wanFailure();
    return { text, body };
  } catch (error) {
    // The registered physical owner outlives this public failure. A held FIRST
    // cancel must not delay error reporting or certify that cleanup succeeded.
    void owner.retire(ended ? "eof" : "cancel", error).catch(() => undefined);
    throw error;
  } finally { input.signal.removeEventListener("abort", abort); }
}

// One Wan operation owns this constant charge. No phase downshift or inferred
// producer acknowledgment; the retained lists are bounded by the approved ledger.
export class WanManagedOperation {
  private readonly lease = new BodyLease();
  private readonly work: Promise<unknown>[] = [];
  private readonly inputs: InputRetirement[] = [];
  private readonly unclaimed = new Map<Response, Promise<void> | null>();
  private ordinary = 0;
  private mandatory = 0;
  private ordinaryActive = false;
  private mandatoryActive = false;
  private closing = false;
  private finishing?: Promise<void>;
  private selected?: string;
  private readonly nativeSlots = new WeakMap<Response, () => void>();
  readonly kind: "create" | "poll" | "collector";
  controlSignal?: AbortSignal;
  constructor(kind: "create" | "poll" | "collector" = "create") {
    this.kind = kind;
    if (!this.lease.grow(36 * MiB)) {
      this.lease.release();
      throw new HttpError(503, "server_overloaded", "Wan operation capacity is busy");
    }
  }
  registerInput = (input: InputRetirement, response?: Response): void => {
    if (this.inputs.length >= 16) throw wanFailure();
    if (response) {
      this.unclaimed.delete(response);
      const release = this.nativeSlots.get(response);
      if (release) { this.nativeSlots.delete(response); void input.retired.finally(release).catch(() => undefined); }
    }
    this.inputs.push(input);
  };
  track<T>(work: Promise<T>): Promise<T> {
    if (this.work.length >= 32) throw wanFailure();
    this.work.push(work); void work.catch(() => undefined); return work;
  }
  fetchPhysical(pending: Promise<Response>, operation: HttpOperation): Promise<Response> {
    return this.track(pending.then(async response => {
      this.unclaimed.set(response, null);
      if (this.closing || operation.signal.aborted) { await this.discard(response); throw operation.signal.reason ?? wanFailure(); }
      return response;
    }));
  }
  async fetch(pending: Promise<Response>, operation: HttpOperation): Promise<Response> {
    const physical = this.fetchPhysical(pending, operation);
    return operation.wait(physical, "upstream", response => { void this.discard(response).catch(() => undefined); });
  }
  discard(response: Response): Promise<void> {
    const previous = this.unclaimed.get(response);
    if (previous) return previous;
    if (!response.body || response.bodyUsed && !response.body.locked) { this.unclaimed.delete(response); return Promise.resolve(); }
    if (response.body.locked) return Promise.reject(new Error("Wan response is owned by a different reader"));
    const input = inputRetirement(response.body.getReader());
    this.registerInput(input, response);
    const done = input.retire("cancel", new Error("unpublished Wan response"));
    this.unclaimed.set(response, done);
    return done;
  }
  discardUnclaimed(response: Response): Promise<void> {
    return this.unclaimed.has(response) ? this.discard(response) : Promise.resolve();
  }
  beginControl(mandatory: boolean): () => void {
    const reserved = this.kind === "create" ? 3 : this.kind === "poll" ? 1 : 0;
    if (mandatory ? this.mandatory >= reserved || this.mandatoryActive : this.ordinary >= 8 - reserved || this.ordinaryActive) throw wanFailure();
    if (mandatory) { this.mandatory++; this.mandatoryActive = true; }
    else { this.ordinary++; this.ordinaryActive = true; }
    let closed = false;
    return () => {
      if (closed) return; closed = true;
      if (mandatory) this.mandatoryActive = false; else this.ordinaryActive = false;
    };
  }
  requireOrdinary(count: number): void {
    const limit = this.kind === "create" ? 5 : this.kind === "poll" ? 7 : 8;
    if (!Number.isSafeInteger(count) || count < 0 || this.ordinary + count > limit) throw wanFailure();
  }
  pin(value: readonly unknown[]): void {
    preflightWanJson(value, wanRecordBytes, true);
    const identity = JSON.stringify(value);
    if (this.selected !== undefined && this.selected !== identity) throw wanFailure();
    this.selected = identity;
  }
  // Tickets count caller-side physical exchanges, not the owner's internal
  // ledger work. A public failure never returns the physical slot early.
  exchange<T>(operation: HttpOperation, start: () => Promise<Response>,
    read: (response: Response, register: WanJsonInput["registerInput"]) => Promise<T>, mandatory = false): Promise<T> {
    const release = this.beginControl(mandatory), inputs: InputRetirement[] = [];
    let response: Response | undefined;
    const physical = this.track((async () => {
      try {
        operation.signal.throwIfAborted();
        response = await this.fetchPhysical(start(), operation);
        return await read(response, (input, source) => { this.registerInput(input, source); inputs.push(input); });
      } catch (error) { operation.stop("upstream", error); throw error; }
      finally {
        try {
          if (response) await this.discardUnclaimed(response);
          await Promise.allSettled(inputs.map(input => input.retired));
        } finally { release(); }
      }
    })());
    return operation.wait(physical);
  }
  nativeResponse(start: () => Promise<Response>, signal: AbortSignal): Promise<Response> {
    const release = this.beginControl(false);
    return this.track((async () => {
      let response: Response | undefined;
      try {
        signal.throwIfAborted();
        response = await start();
        this.unclaimed.set(response, null); this.nativeSlots.set(response, release);
        if (this.closing || signal.aborted) { await this.discard(response); throw signal.reason ?? wanFailure(); }
        return response;
      } catch (error) { if (!response) release(); throw error; }
    })());
  }
  async controlJson<T>(body: unknown, start: (body: string, signal: AbortSignal) => Promise<Response>,
    mandatory = false, signal = this.controlSignal): Promise<T> {
    preflightWanJson(body, wanRecordBytes, true);
    const operation = new HttpOperation(mandatory ? undefined : signal, 15_000);
    try {
      return await this.exchange(operation, () => start(JSON.stringify(body), operation.signal), async (response, registerInput) => {
        const value = (await readWanJson(response, wanRecordBytes,
          { signal: operation.signal, registerInput, control: true }, status => status >= 200 && status < 600)).body;
        if (!response.ok) {
          const error = (value as { error?: { code?: unknown; message?: unknown } } | null)?.error;
          throw new HttpError(response.status, typeof error?.code === "string" ? error.code : "wan_control_unavailable",
            "the original Wan control was not acknowledged");
        }
        return value as T;
      }, mandatory);
    } finally { operation.stop("complete"); }
  }
  publish(value: unknown, status: number, headers: HeadersInit, caller?: AbortSignal): Response {
    preflightWanJson(value, wanOutputBytes);
    const transport = jsonBodyTransport(value, wanOutputBytes);
    const source = transport.stream(), reader = source.getReader(), input = inputRetirement(reader);
    this.registerInput(input);
    const abort = () => { transport.discard(); void input.retire("cancel", caller?.reason).catch(() => undefined); };
    caller?.addEventListener("abort", abort, { once: true });
    void input.retired.finally(() => caller?.removeEventListener("abort", abort)).catch(() => undefined);
    if (caller?.aborted) abort();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await input.read(() => reader.read());
          if (result.done) { await input.retire("eof"); controller.close(); }
          else controller.enqueue(result.value);
        } catch (error) { await input.retire("cancel", error); controller.error(error); }
      },
      cancel(reason) { void input.retire("cancel", reason).catch(() => undefined); },
    }, { highWaterMark: 0 });
    return new Response(body, { status, headers });
  }
  finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    this.closing = true;
    this.finishing = (async () => {
      // Work may register a late response. Close registration only after all
      // work, then retire unclaimed bodies; successful delivery remains owned.
      let registered = 0;
      while (registered < this.work.length) {
        const batch = this.work.slice(registered); registered = this.work.length;
        await Promise.allSettled(batch);
      }
      await Promise.allSettled([...this.unclaimed.keys()].map(response => this.discard(response)));
      await Promise.allSettled(this.inputs.map(input => input.retired));
      this.lease.release();
    })();
    return this.finishing;
  }
}
