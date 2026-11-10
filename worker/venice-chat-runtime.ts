import { createPrivateJsonBodyParser, parseBoundedJson } from "./json-body.ts";
import { inputRetirement } from "./input-retirement.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { extractUsageTokens } from "./token-usage.ts";
import { sseEventBoundary, type SseBoundaryCursor } from "./proxy-response.ts";
import { prepareVeniceChatBinding, validateVeniceReturnedModel, type VeniceChatBinding } from "./venice-chat-binding.ts";
import { HttpError } from "./utils.ts";
import { identityFailure } from "./identity-admission.ts";
import { checkOwnedHttpVeniceCodec, checkOwnedHttpVeniceResponse, fundOwnedHttpVeniceCodec, prepareOwnedHttpCodecConsumers,
  beginOwnedHttpVeniceSource, ownOwnedHttpVeniceRetirement, startOwnedHttpVeniceCodec, holdOwnedHttpVeniceSource,
  retireOwnedHttpVeniceBacking, ownedHttpCodecFailure, finishOwnedCodecDiagnostics,
  type OwnedHttpRevalidation, type OwnedHttpRequest } from "./http-identity-owner.ts";
import { revalidateOwnedVeniceChat, assertOwnedVeniceChatLive } from "./venice-chat-authority.ts";
import { acceptOwnedHttpVeniceUsage } from "./proxy.ts";
import type { ValidatedNativeUsage } from "./native-response.ts";

const limit = 2 * 1024 * 1024, maxReads = 8192, frameLimit = 128 * 1024;
export function veniceChat(selection: ProxySelection): boolean {
  return selection.provider.id === "venice" && selection.capability === "llm.chat";
}

export function prepareVeniceChatResponse(selection: ProxySelection, authority?: { revalidate(signal: AbortSignal): Promise<void>; assertLive(): void }): NativeResponse | undefined {
  if (!veniceChat(selection)) return;
  const { provider, endpoint, model, body } = selection;
  if (!model || !model.capabilities.includes("llm.chat") || Array.isArray(body)
    || provider.base_urls.default !== "https://api.venice.ai/api/v1"
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/chat/completions"
    || endpoint.request_format !== "openai.chat_completions" || endpoint.response_format !== "openai.chat_completions"
    || endpoint.path_params.length || endpoint.upstreamPath !== undefined || Object.keys(endpoint.query).length
    || endpoint.websocket || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.inputProfile || endpoint.requestPricing
    || body.stream !== undefined && typeof body.stream !== "boolean")
    throw new HttpError(400, "invalid_venice_chat_request", "Venice Chat requires its explicitly selected model and canonical HTTP route");
  const binding = prepareVeniceChatBinding(body, model.upstream), streaming = body.stream === true;
  return {
    origin: "https://api.venice.ai", path: "/api/v1/chat/completions",
    acquire: () => nativeResponseLease((streaming ? 8 : 32) * 1024 * 1024),
    async read(response, signal) {
      if (streaming) {
        if (!authority) {
          if (response.body) await inputRetirement(response.body.getReader()).retire("cancel");
          invalid();
        }
        return { response: await gatedEvents(response, signal, binding, authority), observeUsage: true as const };
      }
      const wire = await readWire(response, signal, false);
      const context = { providerId: "venice", requestFormat: "openai.chat_completions", responseFormat: "openai.chat_completions" };
      const value = parseBoundedJson(new TextDecoder("utf-8", { fatal: true }).decode(wire));
      validateVeniceReturnedModel(binding, value);
      if (value && typeof value === "object" && Object.hasOwn(value, "error")) invalid();
      const tokens = extractUsageTokens(value, context);
      signal.throwIfAborted();
      const headers = new Headers(response.headers);
      for (const name of ["content-encoding", "etag", "digest", "content-md5"]) headers.delete(name);
      headers.set("content-length", String(wire.byteLength)); headers.set("cache-control", "private, no-store");
      return { response: new Response(wire, { status: 200, headers }), usage: { tokens, outcome: "success" as const } };
    },
  };
}

async function readWire(response: Response, signal: AbortSignal, streaming: boolean): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
  if (!response.body) invalid();
  const reader = response.body.getReader(), input = inputRetirement(reader);
  if (response.status !== 200 || response.redirected || response.headers.has("content-range")
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== (streaming ? "text/event-stream" : "application/json")
    || encoding !== null && encoding.trim().toLowerCase() !== "identity"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
    await input.retire("cancel"); invalid();
  }
  const wire = new Uint8Array(limit); let size = 0, reads = 0, eof = false;
  const abort = () => { void input.retire("cancel", signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      if (++reads > maxReads) invalid();
      const next = await input.read(() => reader.read()); signal.throwIfAborted(); if (next.done) { eof = true; break; }
      if (next.value.byteLength > limit - size) invalid();
      wire.set(next.value, size); size += next.value.byteLength;
    }
    if (!size || length !== null && Number(length) !== size) invalid();
    return wire.subarray(0, size);
  } catch (error) { await input.retire("cancel", error); throw error; }
  finally { signal.removeEventListener("abort", abort); await input.retire(eof ? "eof" : "cancel", signal.reason); }
}

async function gatedEvents(response: Response, signal: AbortSignal, binding: VeniceChatBinding,
  authority: { revalidate(signal: AbortSignal): Promise<void>; assertLive(): void }): Promise<Response> {
  const length = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
  if (!response.body) invalid();
  const reader = response.body.getReader(), input = inputRetirement(reader);
  if (response.status !== 200 || response.redirected || response.headers.has("content-range")
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream"
    || encoding !== null && encoding.trim().toLowerCase() !== "identity"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    await input.retire("cancel"); invalid();
  }
  const frame = new Uint8Array(frameLimit);
  let size = 0, pending: Uint8Array | null = null, offset = 0, total = 0, emptyReads = 0;
  const cursor: SseBoundaryCursor = { offset: 0, lineStart: 0 };
  let terminal = false, modelSeen = false, authorityReady = false, closed = false, upstreamDone = false;
  let pulling: Promise<void> | undefined, canceled = false;
  let resolveRetired!: () => void, rejectRetired!: (reason: unknown) => void;
  const retired = new Promise<void>((resolve, reject) => { resolveRetired = resolve; rejectRetired = reject; });
  void retired.catch(() => undefined);
  let output: ReadableStreamDefaultController<Uint8Array>;
  function finish(kind: "eof" | "cancel", reason?: unknown): Promise<void> {
    if (closed) return retired; closed = true;
    signal.removeEventListener("abort", abort);
    const active = pulling, cleanup = input.retire(kind, reason);
    // Pull never awaits this join: authority work must exit before ownership
    // retires, including a late successful callback after cancellation.
    void Promise.all([cleanup, active]).then(() => { pending = null; size = 0; resolveRetired(); }, rejectRetired);
    return retired;
  }
  const failAfterRetirement = (error: unknown) => {
    void finish("cancel", error).then(() => { if (!canceled) output.error(error); }, reason => { if (!canceled) output.error(reason); });
  };
  const abort = () => { if (!closed) failAfterRetirement(signal.reason ?? new Error("request canceled")); };
  const body = new ReadableStream<Uint8Array>({
    start(controller) { output = controller; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    pull(controller) {
      const work = Promise.resolve().then(async () => {
        try {
          while (!closed) {
            signal.throwIfAborted();
            const boundary = sseEventBoundary(frame, 0, size, cursor);
            if (boundary) {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, boundary.start));
              let lines = 0; for (const char of text) if ((char === "\n" || char === "\r") && ++lines > 256) invalid();
              const data: string[] = [];
              for (const line of text.split(/\r\n|\r|\n/)) {
                if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
                if (/^event:\s*error\s*$/.test(line)) invalid();
              }
              if (data.length) {
                if (terminal) invalid();
                const value = data.join("\n");
                if (value === "[DONE]") { if (!modelSeen) invalid(); terminal = true; }
                else {
                  const payload = parseBoundedJson(value); validateVeniceReturnedModel(binding, payload);
                  if (payload && typeof payload === "object" && Object.hasOwn(payload, "error")) invalid();
                  modelSeen = true;
                }
              }
              // Authorize the first data publication after its complete frame.
              // Later frames reuse this request authority, with synchronous expiry
              // checks; streaming never adds a DO round trip for each token.
              if (data.length && !authorityReady) { await authority.revalidate(signal); authorityReady = true; }
              signal.throwIfAborted(); authority.assertLive(); if (closed) return;
              const bytes = frame.slice(0, boundary.end);
              frame.copyWithin(0, boundary.end, size); size -= boundary.end; cursor.offset = 0; cursor.lineStart = 0;
              controller.enqueue(bytes); return;
            }
            if (upstreamDone) {
              if (size || !terminal || !modelSeen || length !== null && Number(length) !== total) invalid();
              void finish("eof").then(() => { if (!canceled) controller.close(); }, error => { if (!canceled) controller.error(error); });
              return;
            }
            if (size === frameLimit) invalid();
            if (pending && offset < pending.length) {
              const count = Math.min(pending.length - offset, frameLimit - size);
              frame.set(pending.subarray(offset, offset + count), size); size += count; offset += count;
              if (offset === pending.length) { pending = null; offset = 0; }
              continue;
            }
            const next = await input.read(() => reader.read()); if (closed) return; signal.throwIfAborted();
            if (next.done) { upstreamDone = true; cursor.eof = true; continue; }
            if (next.value.byteLength > limit || next.value.buffer.byteLength > limit || !Number.isSafeInteger(total += next.value.byteLength)) invalid();
            if (!next.value.byteLength) { if (++emptyReads > 32) invalid(); continue; }
            emptyReads = 0; pending = next.value; offset = 0;
          }
        } catch (error) { if (!closed) failAfterRetirement(error); }
      });
      pulling = work;
      return work.finally(() => { if (pulling === work) pulling = undefined; });
    },
    cancel(reason) { canceled = true; return finish("cancel", reason ?? new Error("delivery canceled")); },
  }, { highWaterMark: 0 });
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "etag", "digest", "content-md5"]) headers.delete(name);
  headers.set("cache-control", "private, no-store");
  return new Response(body, { status: 200, headers });
}

function invalid(): never { throw new HttpError(502, "invalid_venice_chat_response", "Venice Chat response could not confirm complete selected-model delivery"); }

// Private codec components share the foreground owner's SINGLE additive
// ledger. These are logical payload vectors, not extra leases or heap sizes.
const ownedCodecMetadata = 65536;
const ownedJsonSource = 10 * limit + 24 * 65536 + ownedCodecMetadata;
const ownedSseParsing = 2 * limit + 14 * frameLimit + 24 * 65536 + ownedCodecMetadata;
const ownedSseResting = 2 * limit + 2 * frameLimit + ownedCodecMetadata;
interface OwnedVeniceCodec {
  cap: OwnedHttpRevalidation; native?: NativeResponse; binding?: VeniceChatBinding;
  streaming: boolean; started: boolean; headersBytes: number;
  source?: OwnedVeniceSource; events?: OwnedVeniceEvents; output?: Response; outputBody?: ReadableStream<Uint8Array>; usage?: ValidatedNativeUsage;
  outputRetired?: Promise<void>; outputDone?: true;
  outputFailure?: unknown; outputFailed?: true;
}
let ownedCodecs: WeakMap<OwnedHttpRevalidation, OwnedVeniceCodec> | undefined;
let ownedCodecCount = 0;
export function prepareOwnedVeniceChatCodec(cap: OwnedHttpRevalidation, selection: ProxySelection, native: NativeResponse): void {
  checkOwnedHttpVeniceCodec(cap, selection);
  if (ownedCodecs?.has(cap) || !native || native !== selection.nativeResponse
    || native.origin !== "https://api.venice.ai" || native.path !== "/api/v1/chat/completions" || !selection.model) throw identityFailure("protocol");
  fundOwnedHttpVeniceCodec(cap, ownedCodecMetadata + 4 * selection.model.upstream.length);
  prepareOwnedHttpCodecConsumers(cap);
  const binding = prepareVeniceChatBinding(selection.body as Record<string, unknown>, selection.model.upstream);
  const state: OwnedVeniceCodec = { cap, native, binding, streaming: !Array.isArray(selection.body) && selection.body.stream === true,
    started: false, headersBytes: 4 * selection.model.upstream.length };
  (ownedCodecs ??= new WeakMap()).set(cap, state); ownedCodecCount++;
}
function codecOwner(cap: OwnedHttpRevalidation): OwnedVeniceCodec {
  const state = ownedCodecs?.get(cap); if (!state) throw identityFailure("protocol"); return state;
}
export function checkOwnedVeniceChatCodec(cap: OwnedHttpRevalidation, native: NativeResponse): void {
  const state = codecOwner(cap);
  if (state.started || state.native !== native) throw identityFailure("protocol");
}
function codecPhase(state: OwnedVeniceCodec, bytes: number): void {
  fundOwnedHttpVeniceCodec(state.cap, bytes + state.headersBytes);
}
export function matchesOwnedVeniceUsage(cap: OwnedHttpRevalidation, response: Response, usage: ValidatedNativeUsage | undefined): boolean {
  const state = ownedCodecs?.get(cap); return !!state && state.output === response && state.usage === usage;
}
export function matchesOwnedVeniceOutputBody(cap: OwnedHttpRevalidation, body: ReadableStream<Uint8Array> | null): boolean {
  return !!body && ownedCodecs?.get(cap)?.outputBody === body;
}
export function matchesOwnedVeniceConsumerInput(cap: OwnedHttpRevalidation, response: Response, streaming: boolean): boolean {
  const state = ownedCodecs?.get(cap);
  return !!state?.started && state.output === response && state.streaming === streaming
    && !!state.outputBody && !!state.source;
}
export function matchesOwnedVeniceOutputFailure(cap: OwnedHttpRevalidation, failure: unknown): boolean {
  const state = ownedCodecs?.get(cap);
  // This is the exact value published by our fixed codec, never a traversal of
  // a foreign AggregateError. The caller independently proves forwarded body
  // lineage and use of the original native reader method.
  return !!state?.outputFailed && state.outputFailure === failure;
}
export function forwardOwnedVeniceUsage(cap: OwnedHttpRevalidation, http: OwnedHttpRequest, response: Response): void {
  const state = codecOwner(cap);
  if (state.output !== response) throw identityFailure("protocol");
  acceptOwnedHttpVeniceUsage(http, cap, response, state.usage);
}
export function matchesOwnedVeniceRetirement(cap: OwnedHttpRevalidation, work: Promise<void>): boolean {
  const state = ownedCodecs?.get(cap);
  return !!state && (state.source?.retired === work || state.outputRetired === work);
}
export function retireOwnedVeniceChatCodec(cap: OwnedHttpRevalidation): void {
  const state = ownedCodecs?.get(cap); if (!state) return;
  if (state.source && (!state.source.done || state.source.pulling) || state.outputRetired && !state.outputDone) throw identityFailure("protocol");
  state.source?.clear(); state.events?.clear(); state.events = undefined; state.source = undefined; state.output = undefined; state.outputBody = undefined; state.usage = undefined;
  state.native = undefined; state.binding = undefined;
  state.outputRetired = undefined; state.outputDone = undefined;
  state.outputFailure = undefined; state.outputFailed = undefined;
  retireOwnedHttpVeniceBacking(cap); ownedCodecs!.delete(cap);
  if (!--ownedCodecCount) ownedCodecs = undefined;
}

// One code point is passed to the unchanged parser at a time. The tokenizer's
// entire batch therefore precedes at most ONE new parent before the consumer's
// existing depth-128 check. Strings, escapes and surrogate pairing are unchanged.
function parseOwnedVeniceJson(state: OwnedVeniceCodec, text: string): unknown {
  if (codecOwner(state.cap) !== state || !state.started || !state.source) throw identityFailure("protocol");
  const parser = createPrivateJsonBodyParser();
  try {
    for (let offset = 0; offset < text.length;) {
      const high = text.charCodeAt(offset), low = text.charCodeAt(offset + 1);
      const end = offset + (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1);
      parser.push(text.slice(offset, end)); offset = end;
    }
    return parser.take();
  } finally { parser.discard(); text = ""; }
}

const ownedDefaultCancel = ReadableStreamDefaultReader.prototype.cancel;
const ownedByobCancel = ReadableStreamBYOBReader.prototype.cancel;
const ownedSourceThen = Promise.prototype.then;
const ownedDefaultRead = ReadableStreamDefaultReader.prototype.read;
const ownedByobRead = ReadableStreamBYOBReader.prototype.read;
const ownedDefaultClosed = Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, "closed")!.get;
const ownedByobClosed = Object.getOwnPropertyDescriptor(ReadableStreamBYOBReader.prototype, "closed")!.get;
const ownedLookupGetter = (Object.prototype as { __lookupGetter__?: unknown }).__lookupGetter__;
class OwnedVeniceSource {
  readonly state: OwnedVeniceCodec;
  body?: ReadableStream<Uint8Array> | null;
  response?: Response;
  reader?: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;
  reading?: Promise<void>;
  cancelling?: Promise<void>;
  originalRead?: Promise<ReadableStreamReadResult<Uint8Array>>;
  signal?: AbortSignal;
  listener?: () => void;
  closed?: Promise<void>;
  unlocking?: Promise<void>;
  private nativeFailure?: object;
  pulling?: Promise<void>;
  retired: Promise<void>;
  private resolve!: () => void;
  // finishing=1, errored=2, read failed=4, BYOB=8,
  // cleanup reported=16, unreadable body=32, unlock attempted=64, native closed=128.
  // Native propagation also requires the actual original method/body lineage.
  private flags = 0;
  private cleanup: object[] = [];
  abortFailure?: object;
  outputAbort?: () => void;
  done = false;
  constructor(state: OwnedVeniceCodec) {
    this.state = state; beginOwnedHttpVeniceSource(state.cap);
    this.retired = new Promise(resolve => { this.resolve = resolve; });
    state.source = this;
    ownOwnedHttpVeniceRetirement(state.cap, this.retired);
  }
  adopt(response: Response): void {
    this.response = response;
    try { this.body = response.body; }
    catch (reason) { this.flags |= 32; holdOwnedHttpVeniceSource(this.state.cap); throw this.failure("acquire", reason); }
  }
  open(response: Response, signal: AbortSignal): void {
    if (this.response !== response) throw identityFailure("protocol");
    this.signal = signal;
    if (!this.body) invalid();
    try {
      if (!this.state.streaming) this.flags |= 8;
      this.reader = (this.flags & 8) ? this.body.getReader({ mode: "byob" }) : this.body.getReader();
    } catch (reason) { if (this.body.locked) holdOwnedHttpVeniceSource(this.state.cap); throw this.failure("acquire", reason); }
    let resolveClosed!: () => void;
    this.closed = new Promise<void>(done => { resolveClosed = done; });
    let following = false;
    try {
      let original: Promise<void> | undefined;
      {
        const reader = this.reader;
        if (Object.getPrototypeOf(reader) === ((this.flags & 8) ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype)
          && !Object.hasOwn(reader, "closed") && typeof ownedLookupGetter === "function"
          && ownedLookupGetter.call(reader, "closed") === ((this.flags & 8) ? ownedByobClosed : ownedDefaultClosed)) this.flags |= 128;
        original = reader.closed;
      }
      following = true;
      const then = original.then; if (then !== ownedSourceThen) this.flags &= ~128;
      void Reflect.apply(then, original, [() => { resolveClosed(); }, (reason: unknown) => {
        this.flags |= 2;
        // This exact body's native read/closed pair can propagate one failure.
        // Modified getters/promises always retain their independent origin.
        if (!((this.flags & 128) && this.nativeFailure)) {
          const failure = this.failure("closed", reason);
          if (this.flags & 128) this.nativeFailure = failure;
        }
        reason = undefined; resolveClosed();
      }]);
      original = undefined;
    } catch (reason) {
      const failure = this.failure("closed", reason); reason = undefined;
      if (following) holdOwnedHttpVeniceSource(this.state.cap); else resolveClosed();
      throw failure;
    }
    this.listener = () => {
      this.abortFailure ??= this.failure("abort", signal.reason);
      if (this.outputAbort) this.outputAbort(); else void this.finish("cancel");
    };
    try { signal.addEventListener("abort", this.listener, { once: true }); }
    catch (reason) { throw this.failure("listenerAdd", reason); }
    this.checkAbort();
  }
  failure(phase: Parameters<typeof ownedHttpCodecFailure>[2], reason: unknown): object {
    return ownedHttpCodecFailure(this.state.cap, 0, phase, reason);
  }
  checkAbort(): void {
    if (this.signal?.aborted) { this.abortFailure ??= this.failure("abort", this.signal.reason); throw this.abortFailure; }
    if (this.flags & 256) invalid();
  }
  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    this.checkAbort();
    if (this.reading || this.flags & 1 || !this.reader) throw identityFailure("protocol");
    let resolve!: () => void;
    const pending = new Promise<void>(done => { resolve = done; }); this.reading = pending;
    let accept!: (value: ReadableStreamReadResult<Uint8Array>) => void, reject!: (reason: unknown) => void;
    const observed = new Promise<ReadableStreamReadResult<Uint8Array>>((yes, no) => { accept = yes; reject = no; });
    try {
      const reader = this.reader, method = reader.read;
      let native = !!(this.flags & 128) && Object.getPrototypeOf(reader) === ((this.flags & 8) ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype)
        && method === ((this.flags & 8) ? ownedByobRead : ownedDefaultRead);
      this.originalRead = Reflect.apply(method, reader, (this.flags & 8) ? [new Uint8Array(limit)] : []);
      const then = this.originalRead!.then; native &&= then === ownedSourceThen;
      void Reflect.apply(then, this.originalRead, [(value: ReadableStreamReadResult<Uint8Array>) => {
        if (this.reading !== pending) return;
        try {
          const bytes = value.value;
          if (!bytes) { accept({ done: value.done, value: undefined } as ReadableStreamReadResult<Uint8Array>); return; }
          // The existing whole-backing profile is checked before the copy. Its
          // source and destination were both admitted by the current phase.
          if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.buffer.byteLength > limit) {
            this.flags |= 256; accept({ done: value.done, value: undefined } as ReadableStreamReadResult<Uint8Array>); return;
          }
          const captured = new Uint8Array(bytes.byteLength); captured.set(bytes);
          accept({ done: value.done, value: captured } as ReadableStreamReadResult<Uint8Array>);
        } catch (reason) { reject(this.failure("read", reason)); reason = undefined; }
        finally { value = undefined as never; this.originalRead = undefined; if (this.reading === pending) this.reading = undefined; resolve(); }
      }, (reason: unknown) => {
        if (this.reading !== pending) return;
        this.originalRead = undefined; this.flags |= 4;
        const failure = native && this.nativeFailure ? this.nativeFailure : this.failure("read", reason); reason = undefined;
        if (native) this.nativeFailure = failure;
        reject(failure); if (this.reading === pending) this.reading = undefined; resolve();
      }]);
    } catch (reason) {
      this.flags |= 4; const failure = this.failure("read", reason); reason = undefined;
      if (this.reading !== pending) return observed.then(() => { throw failure; }, () => { throw failure; });
      if (this.originalRead) { holdOwnedHttpVeniceSource(this.state.cap); reject(failure); return observed; }
      reject(failure); if (this.reading === pending) this.reading = undefined; resolve();
      return observed;
    }
    return observed;
  }
  private cancel(): void {
    if (this.cancelling) return;
    let resolve!: () => void;
    this.cancelling = new Promise<void>(done => { resolve = done; });
    let following = false;
    try {
      let original: Promise<void>, native = false;
      if (this.reader) {
        const reader = this.reader, method = reader.cancel;
        native = Object.getPrototypeOf(reader) === ((this.flags & 8) ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype)
          && method === ((this.flags & 8) ? ownedByobCancel : ownedDefaultCancel);
        original = Reflect.apply(method, reader, []);
      } else if (!this.body) { resolve(); return; }
      else if (this.body.locked) { holdOwnedHttpVeniceSource(this.state.cap); return; }
      else original = this.body.cancel();
      following = true;
      const then = original.then; native &&= then === ownedSourceThen;
      void Reflect.apply(then, original, [() => { resolve(); }, (reason: unknown) => {
        if (!(native && (this.flags & 128) && (this.flags & 2) && this.nativeFailure)) this.cleanup.push(this.failure("cancel", reason));
        reason = undefined; resolve();
      }]);
      original = undefined as never;
    } catch (reason) {
      this.cleanup.push(this.failure("cancel", reason)); reason = undefined;
      if (following) holdOwnedHttpVeniceSource(this.state.cap); else resolve();
    }
  }
  private unlock(): void {
    if (this.flags & 64) return;
    this.flags |= 64;
    let resolve!: () => void;
    this.unlocking = new Promise<void>(done => { resolve = done; });
    let following = false;
    try {
      let original: unknown;
      { const reader = this.reader!, method = reader.releaseLock; original = Reflect.apply(method, reader, []); }
      if (original === undefined) { resolve(); return; }
      following = true;
      void Promise.resolve(original).then(() => { resolve(); }, reason => {
        this.cleanup.push(this.failure("unlock", reason)); reason = undefined; resolve();
      });
      original = undefined;
    } catch (reason) {
      this.cleanup.push(this.failure("unlock", reason)); reason = undefined;
      if (following) holdOwnedHttpVeniceSource(this.state.cap); else resolve();
    }
  }
  finish(kind: "eof" | "cancel"): Promise<void> {
    if ((this.flags & 1)) return this.retired;
    this.flags |= 1;
    const active = this.pulling;
    if (this.listener) {
      try { this.signal!.removeEventListener("abort", this.listener); }
      catch (reason) { holdOwnedHttpVeniceSource(this.state.cap); this.cleanup.push(this.failure("listenerRemove", reason)); }
    }
    if (kind === "cancel") this.cancel();
    // The read and cancellation slots are published before their methods can
    // reenter. This tail never sits beneath the pull that it joins.
    const joined = (async () => {
      await this.reading; await this.cancelling;
      if (this.reader) this.unlock();
      await this.unlocking; await this.closed; await active;
      try { if ((this.flags & 32) || this.body?.locked) { holdOwnedHttpVeniceSource(this.state.cap); return; } }
      catch (reason) { this.cleanup.push(this.failure("retire", reason)); holdOwnedHttpVeniceSource(this.state.cap); return; }
      this.body = undefined; this.reader = undefined; this.reading = undefined; this.cancelling = undefined;
      this.originalRead = undefined; this.closed = undefined; this.unlocking = undefined; this.response = undefined;
      this.listener = undefined; this.done = true; this.resolve();
    })();
    void joined.then(() => undefined, reason => { this.cleanup.push(this.failure("retire", reason)); holdOwnedHttpVeniceSource(this.state.cap); });
    return this.retired;
  }
  checkCleanup(hasPrimary = false, primary?: unknown): void {
    if (this.cleanup.length && !(this.flags & 16)) {
      this.flags |= 16;
      throw new AggregateError(hasPrimary ? [primary, ...this.cleanup] : this.cleanup, "owned Venice source retirement");
    }
    if (hasPrimary) throw primary;
  }
  clear(): void {
    if (!this.done || this.pulling) throw identityFailure("protocol");
    this.cleanup.length = 0; this.nativeFailure = undefined; this.abortFailure = undefined; this.signal = undefined; this.outputAbort = undefined;
    finishOwnedCodecDiagnostics(this.state.cap, 0);
  }
}

export function readOwnedVeniceChatResponse(cap: OwnedHttpRevalidation, response: Response, signal: AbortSignal): Promise<Response> {
  if (codecOwner(cap).started) throw identityFailure("protocol");
  return startOwnedHttpVeniceCodec(cap, response, signal);
}
export async function consumeOwnedVeniceChatResponse(cap: OwnedHttpRevalidation, response: Response, signal: AbortSignal): Promise<Response> {
  const state = codecOwner(cap);
  checkOwnedHttpVeniceResponse(cap, response, signal);
  if (state.started) throw identityFailure("protocol");
  state.started = true;
  const source = new OwnedVeniceSource(state);
  let result: Response | undefined, hasPrimary = false, primary: unknown;
  try {
    source.adopt(response);
    let pairs = 0, units = 0;
    response.headers.forEach((value, name) => { pairs++; units += name.length + value.length; });
    state.headersBytes += 32 * pairs + 8 * units;
    codecPhase(state, state.streaming ? ownedSseResting : ownedJsonSource);
    source.open(response, signal);
    const length = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
    if (response.status !== 200 || response.redirected || response.headers.has("content-range")
      || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== (state.streaming ? "text/event-stream" : "application/json")
      || encoding !== null && encoding.trim().toLowerCase() !== "identity"
      || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || !state.streaming && Number(length) > limit)) invalid();
    result = state.streaming ? ownedVeniceEvents(state, source, response, length) : await ownedVeniceJson(state, source, response, length);
    state.output = result;
    return result;
  } catch (error) { hasPrimary = true; primary = error; }
  finally { response = undefined as never; }
  await source.finish("cancel"); source.checkCleanup(hasPrimary, primary);
  throw identityFailure("protocol");
}

async function ownedVeniceJson(state: OwnedVeniceCodec, source: OwnedVeniceSource, response: Response, length: string | null): Promise<Response> {
  let wire: Uint8Array<ArrayBuffer> | undefined = new Uint8Array(limit), size = 0, eof = false;
  let text = "", value: unknown, hasPrimary = false, primary: unknown;
  try {
    for (let reads = 0; ; reads++) {
      if (reads >= maxReads) invalid();
      let next: ReadableStreamReadResult<Uint8Array> | undefined = await source.read();
      try {
        source.checkAbort();
        if (next.value) { if (next.value.byteLength > limit - size) invalid(); wire.set(next.value, size); size += next.value.byteLength; }
        if (next.done) { eof = true; break; }
      } finally { next = undefined; }
    }
    if (!size || length !== null && Number(length) !== size) invalid();
    await source.finish("eof"); source.checkCleanup(); source.checkAbort();
    text = new TextDecoder("utf-8", { fatal: true }).decode(wire.subarray(0, size));
    value = parseOwnedVeniceJson(state, text); text = "";
    validateVeniceReturnedModel(state.binding!, value);
    if (value && typeof value === "object" && Object.hasOwn(value, "error")) invalid();
    state.usage = { tokens: extractUsageTokens(value, { providerId: "venice", requestFormat: "openai.chat_completions", responseFormat: "openai.chat_completions" }), outcome: "success" };
    value = undefined;
    const headers = new Headers(response.headers);
    for (const name of ["content-encoding", "etag", "digest", "content-md5"]) headers.delete(name);
    headers.set("content-length", String(size)); headers.set("cache-control", "private, no-store");
    // Pre-enroll the output's own receipt before publication. A late result is
    // still cancelable under its originating owner after the logical wait ends.
    let outputWire: Uint8Array<ArrayBuffer> | undefined = wire; wire = undefined;
    let resolveOutput!: () => void, sent = false;
    state.outputRetired = new Promise(resolve => { resolveOutput = resolve; });
    ownOwnedHttpVeniceRetirement(state.cap, state.outputRetired);
    const finishOutput = () => { outputWire = undefined; state.outputDone = true; codecPhase(state, ownedCodecMetadata); resolveOutput(); };
    const stream = new ReadableStream<Uint8Array>({
      type: "bytes",
      pull(controller) {
        if (!sent) { sent = true; const bytes = outputWire!.subarray(0, size); outputWire = undefined; controller.enqueue(bytes); }
        else { controller.close(); controller.byobRequest?.respond(0); finishOutput(); }
      },
      cancel() { finishOutput(); },
    } satisfies UnderlyingByteSource, { highWaterMark: 0 });
    try {
      const result = new Response(stream, { status: 200, headers });
      state.outputBody = stream;
      codecPhase(state, 2 * limit + ownedCodecMetadata);
      source.checkAbort(); return result;
    } catch (error) {
      let cleanup: object | undefined;
      try { await stream.cancel(); } catch (reason) { cleanup = source.failure("cancel", reason); }
      if (cleanup) throw new AggregateError([error, cleanup], "owned Venice unpublished output");
      throw error;
    }
  } catch (error) { hasPrimary = true; primary = error; }
  finally { value = undefined; text = ""; wire = undefined; response = undefined as never; }
  await source.finish(eof ? "eof" : "cancel"); source.checkCleanup(hasPrimary, primary);
  throw identityFailure("protocol");
}

function ownedVeniceEvents(state: OwnedVeniceCodec, source: OwnedVeniceSource, response: Response, length: string | null): Response {
  const events = new OwnedVeniceEvents(state, source, length);
  state.events = events;
  return events.publish(response);
}
function ownedEventSpace(code: number): boolean {
  return code >= 9 && code <= 13 || code === 32 || code === 160 || code === 5760
    || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}
class OwnedVeniceEvents {
  private frame: Uint8Array = new Uint8Array(frameLimit);
  private cursor: SseBoundaryCursor = { offset: 0, lineStart: 0 };
  private size = 0;
  private pending?: Uint8Array;
  private offset = 0;
  private total = 0;
  private emptyReads = 0;
  // terminal=1, model seen=2, first authority settled=4, closed=8,
  // upstream EOF=16, public cancellation=32.
  private flags = 0;
  private output!: ReadableStreamDefaultController<Uint8Array>;
  constructor(private state: OwnedVeniceCodec, private source: OwnedVeniceSource, private length: string | null) {}
  publish(response: Response): Response {
    const body = new ReadableStream<Uint8Array>(this, { highWaterMark: 0 });
    const headers = new Headers(response.headers);
    for (const name of ["content-length", "content-encoding", "etag", "digest", "content-md5"]) headers.delete(name);
    headers.set("cache-control", "private, no-store");
    this.state.outputBody = body;
    return new Response(body, { status: 200, headers });
  }
  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.output = controller;
    this.source.outputAbort = this.abort.bind(this);
    if (this.source.abortFailure) this.abort();
  }
  private abort(): void { this.fail(this.source.abortFailure); }
  private fail(error: unknown): void {
    if (this.flags & 8) return;
    this.flags |= 8;
    void this.source.finish("cancel").then(() => {
      this.pending = undefined; this.size = 0;
      try { this.source.checkCleanup(true, error); } catch (failure) {
        if (!(this.flags & 32)) this.publishFailure(failure);
      } finally { error = undefined; }
    });
  }
  pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    let resolve!: () => void;
    const joining = new Promise<void>(done => { resolve = done; });
    this.source.pulling = joining; // Before synchronous work or an abort can reenter.
    const original = this.next(controller);
    return original.then(() => {
      if (this.source.pulling === joining) this.source.pulling = undefined; resolve();
    }, reason => {
      this.fail(reason); reason = undefined;
      if (this.source.pulling === joining) this.source.pulling = undefined; resolve();
    });
  }
  private async next(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    try {
      while (!(this.flags & 8)) {
        this.source.checkAbort();
        const boundary = sseEventBoundary(this.frame, 0, this.size, this.cursor);
        if (boundary) {
          codecPhase(this.state, ownedSseParsing);
          let text = "", value = "", payload: unknown;
          let hasData = false;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(this.frame.subarray(0, boundary.start));
            let count = 0;
            for (let index = 0; index < text.length; index++)
              if ((text.charCodeAt(index) === 10 || text.charCodeAt(index) === 13) && ++count > 256) invalid();
            // The original line split and data join retain up to two complete
            // vectors during parsing. Fold those same ranges synchronously;
            // CRLF is one separator, and data removes only ONE ASCII space.
            for (let start = 0; start <= text.length;) {
              let end = start;
              while (end < text.length && text.charCodeAt(end) !== 10 && text.charCodeAt(end) !== 13) end++;
              if (text.startsWith("data:", start)) {
                const from = start + 5 + Number(text.charCodeAt(start + 5) === 32);
                if (hasData) value += "\n";
                value += text.slice(from, end); hasData = true;
              }
              if (text.startsWith("event:", start)) {
                let from = start + 6, to = end;
                while (from < to && ownedEventSpace(text.charCodeAt(from))) from++;
                while (to > from && ownedEventSpace(text.charCodeAt(to - 1))) to--;
                if (to - from === 5 && text.startsWith("error", from)) invalid();
              }
              if (end === text.length) break;
              start = end + (text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10 ? 2 : 1);
            }
            if (hasData) {
              if (this.flags & 1) invalid();
              if (value === "[DONE]") { if (!(this.flags & 2)) invalid(); this.flags |= 1; }
              else {
                payload = parseOwnedVeniceJson(this.state, value); validateVeniceReturnedModel(this.state.binding!, payload);
                if (payload && typeof payload === "object" && Object.hasOwn(payload, "error")) invalid();
                this.flags |= 2;
              }
            }
          } finally { text = ""; value = ""; payload = undefined; }
          codecPhase(this.state, ownedSseResting);
          if (hasData && !(this.flags & 4)) { await revalidateOwnedVeniceChat(this.state.cap, this.source.signal!); this.flags |= 4; }
          this.source.checkAbort(); assertOwnedVeniceChatLive(this.state.cap); if (this.flags & 8) return;
          codecPhase(this.state, (this.pending?.buffer.byteLength ?? 0) + this.frame.buffer.byteLength + frameLimit + ownedCodecMetadata);
          const bytes = this.frame.slice(0, boundary.end);
          this.frame.copyWithin(0, boundary.end, this.size); this.size -= boundary.end; this.cursor.offset = 0; this.cursor.lineStart = 0;
          controller.enqueue(bytes); return;
        }
        if (this.flags & 16) {
          if (this.size || !(this.flags & 1) || !(this.flags & 2) || this.length !== null && Number(this.length) !== this.total) invalid();
          this.flags |= 8;
          void this.source.finish("eof").then(this.complete.bind(this));
          return;
        }
        if (this.size === frameLimit) invalid();
        if (this.pending && this.offset < this.pending.length) {
          const count = Math.min(this.pending.length - this.offset, frameLimit - this.size);
          this.frame.set(this.pending.subarray(this.offset, this.offset + count), this.size); this.size += count; this.offset += count;
          if (this.offset === this.pending.length) { this.pending = undefined; this.offset = 0; }
          continue;
        }
        codecPhase(this.state, ownedSseResting);
        let next: ReadableStreamReadResult<Uint8Array> | undefined = await this.source.read();
        try {
          if (this.flags & 8) return; this.source.checkAbort();
          if (next.done) { this.flags |= 16; this.cursor.eof = true; continue; }
          if (next.value.byteLength > limit || next.value.buffer.byteLength > limit || !Number.isSafeInteger(this.total += next.value.byteLength)) invalid();
          if (!next.value.byteLength) { if (++this.emptyReads > 32) invalid(); continue; }
          this.emptyReads = 0; this.pending = next.value; this.offset = 0;
        } finally { next = undefined; }
      }
    } catch (error) { this.fail(error); }
  }
  private publishFailure(failure: unknown): void {
    this.state.outputFailed = true; this.state.outputFailure = failure;
    try { this.output.error(failure); }
    catch (reason) { this.source.failure("pull", reason); holdOwnedHttpVeniceSource(this.state.cap); }
  }
  private complete(): void {
    this.pending = undefined; this.size = 0;
    try { this.source.checkCleanup(); if (!(this.flags & 32)) this.output.close(); }
    catch (error) {
      if (!(this.flags & 32)) this.publishFailure(error);
    }
  }
  cancel(): Promise<void> {
    this.flags |= 32 | 8;
    return this.source.finish("cancel").then(this.completeCancel.bind(this));
  }
  private completeCancel(): void {
    this.pending = undefined; this.size = 0; this.source.checkCleanup();
  }
  clear(): void {
    if (!this.source.done || this.source.pulling) throw identityFailure("protocol");
    this.frame = undefined as never; this.cursor = undefined as never; this.pending = undefined;
    this.output = undefined as never; this.length = null; this.source = undefined as never; this.state = undefined as never;
  }
}
