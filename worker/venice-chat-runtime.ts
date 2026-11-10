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
  retireOwnedHttpVeniceBacking, ownedHttpIntakeFailure, finishOwnedHttpIntakeDiagnostics, retireOwnedVeniceReadDiagnostics,
  type OwnedHttpRevalidation, type OwnedHttpRequest, type OwnedHttpIntakeDiagnostics } from "./http-identity-owner.ts";
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
const ownedJsonSource = 9 * limit + 24 * 65536 + ownedCodecMetadata;
const ownedSseParsing = limit + 14 * frameLimit + 24 * 65536 + ownedCodecMetadata;
const ownedSseResting = limit + 2 * frameLimit + ownedCodecMetadata;
// The ordinary observer may allocate its full 2 MiB byte buffer and predecessor.
// Every frame fed by this codec is <=128 KiB, including its original boundary;
// decoded/split/join/parsed occurrences use that enforced complete-frame bound.
const ownedSseUsage = 3 * limit + 15 * frameLimit + ownedCodecMetadata;
interface OwnedVeniceCodec {
  cap: OwnedHttpRevalidation; native?: NativeResponse; binding?: VeniceChatBinding;
  streaming: boolean; started: boolean; headersBytes: number;
  source?: OwnedVeniceSource; output?: Response; outputBody?: ReadableStream<Uint8Array>; usage?: ValidatedNativeUsage;
  outputRetired?: Promise<void>; outputDone?: true;
  outputFailure?: unknown; outputFailed?: true;
}
let ownedCodecs: WeakMap<OwnedHttpRevalidation, OwnedVeniceCodec> | undefined;
let ownedCodecCount = 0;
export function prepareOwnedVeniceChatCodec(cap: OwnedHttpRevalidation, selection: ProxySelection, native: NativeResponse): void {
  checkOwnedHttpVeniceCodec(cap, selection);
  if (ownedCodecs?.has(cap) || !native || native !== selection.nativeResponse
    || native.origin !== "https://api.venice.ai" || native.path !== "/api/v1/chat/completions" || !selection.model) throw identityFailure("protocol");
  fundOwnedHttpVeniceCodec(cap, ownedCodecMetadata + 4 * selection.model.upstream.length, 0);
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
function codecPhase(state: OwnedVeniceCodec, bytes: number, usage = 0): void {
  fundOwnedHttpVeniceCodec(state.cap, bytes + state.headersBytes, usage);
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
  state.source?.clear(); state.source = undefined; state.output = undefined; state.outputBody = undefined; state.usage = undefined;
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
class OwnedVeniceSource {
  readonly state: OwnedVeniceCodec;
  readonly diagnostics: OwnedHttpIntakeDiagnostics;
  body?: ReadableStream<Uint8Array> | null;
  response?: Response;
  reader?: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;
  input?: ReturnType<typeof inputRetirement>;
  signal?: AbortSignal;
  listener?: () => void;
  closed?: Promise<void>;
  pulling?: Promise<void>;
  retired: Promise<void>;
  private resolve!: () => void;
  private finishing = false;
  private errored = false;
  private readFailed = false;
  private byob = false;
  private cleanup: object[] = [];
  private cleanupReported = false;
  private unreadableBody = false;
  abortFailure?: object;
  outputAbort?: () => void;
  done = false;
  constructor(state: OwnedVeniceCodec) {
    this.state = state; this.diagnostics = beginOwnedHttpVeniceSource(state.cap);
    this.retired = new Promise(resolve => { this.resolve = resolve; });
    state.source = this;
    ownOwnedHttpVeniceRetirement(state.cap, this.retired);
  }
  adopt(response: Response): void {
    this.response = response;
    try { this.body = response.body; }
    catch (reason) { this.unreadableBody = true; holdOwnedHttpVeniceSource(this.state.cap); throw this.failure("acquire", reason); }
  }
  open(response: Response, signal: AbortSignal): void {
    if (this.response !== response) throw identityFailure("protocol");
    this.signal = signal;
    if (!this.body) invalid();
    try {
      this.byob = !this.state.streaming;
      this.reader = this.byob ? this.body.getReader({ mode: "byob" }) : this.body.getReader();
    } catch (reason) { if (this.body.locked) holdOwnedHttpVeniceSource(this.state.cap); throw this.failure("acquire", reason); }
    this.input = inputRetirement({
      cancel: () => {
        try {
          const reader = this.reader!, propagated = this.readFailed && this.errored
            && Object.getPrototypeOf(reader) === (this.byob ? ReadableStreamBYOBReader.prototype : ReadableStreamDefaultReader.prototype)
            && !Object.hasOwn(reader, "closed") && reader.cancel === (this.byob ? ownedByobCancel : ownedDefaultCancel);
          let original: Promise<void> | undefined = reader.cancel();
          const settled = original.then(() => undefined, reason => { if (!propagated) this.cleanup.push(this.failure("cancel", reason)); });
          original = undefined; return settled;
        } catch (reason) { this.cleanup.push(this.failure("cancel", reason)); return Promise.resolve(); }
      },
      releaseLock: () => {
        try { this.reader!.releaseLock(); }
        catch (reason) { this.cleanup.push(this.failure("unlock", reason)); }
        if (this.body!.locked) holdOwnedHttpVeniceSource(this.state.cap);
      },
    });
    try { this.closed = this.reader.closed.then(() => undefined, () => { this.errored = true; }); }
    catch (reason) { throw this.failure("read", reason); }
    this.listener = () => {
      this.abortFailure ??= this.failure("abort", signal.reason);
      if (this.outputAbort) this.outputAbort(); else void this.finish("cancel");
    };
    try { signal.addEventListener("abort", this.listener, { once: true }); }
    catch (reason) { throw this.failure("listenerAdd", reason); }
    this.checkAbort();
  }
  failure(phase: Parameters<typeof ownedHttpIntakeFailure>[1], reason: unknown): object {
    return ownedHttpIntakeFailure(this.diagnostics, phase, reason);
  }
  checkAbort(): void {
    if (this.signal?.aborted) { this.abortFailure ??= this.failure("abort", this.signal.reason); throw this.abortFailure; }
  }
  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    this.checkAbort();
    return this.input!.read(() => {
      try {
        let original: Promise<ReadableStreamReadResult<Uint8Array>> | undefined = this.byob ? (this.reader as ReadableStreamBYOBReader).read(new Uint8Array(limit))
          : (this.reader as ReadableStreamDefaultReader<Uint8Array>).read();
        const settled = original.then(value => value, reason => { this.readFailed = true; throw this.failure("read", reason); });
        original = undefined; return settled;
      } catch (reason) { this.readFailed = true; throw this.failure("read", reason); }
    });
  }
  finish(kind: "eof" | "cancel"): Promise<void> {
    if (this.finishing) return this.retired;
    this.finishing = true;
    const active = this.pulling;
    if (this.listener) {
      try { this.signal!.removeEventListener("abort", this.listener); }
      catch (reason) { holdOwnedHttpVeniceSource(this.state.cap); this.cleanup.push(this.failure("listenerRemove", reason)); }
    }
    let cleanup: Promise<void>;
    try { cleanup = this.input ? this.input.retire(kind) : this.body && !this.body.locked ? this.cancelUntouched() : Promise.resolve(); }
    catch (reason) { this.cleanup.push(this.failure("retire", reason)); holdOwnedHttpVeniceSource(this.state.cap); cleanup = Promise.resolve(); }
    // Both roots are observed together. A pull never waits for this completion
    // from inside itself; public prefix delivery does not join its own consumer.
    const cleanupSettled = cleanup.then(() => undefined, reason => { this.cleanup.push(this.failure("retire", reason)); });
    const pullSettled = active?.then(() => undefined, reason => { this.cleanup.push(this.failure("pull", reason)); });
    void Promise.all([cleanupSettled, pullSettled]).then(async () => {
      await this.closed;
      try { if (this.unreadableBody || this.body?.locked) { holdOwnedHttpVeniceSource(this.state.cap); return; } }
      catch (reason) { this.cleanup.push(this.failure("retire", reason)); holdOwnedHttpVeniceSource(this.state.cap); return; }
      this.body = undefined; this.reader = undefined; this.input = undefined; this.closed = undefined;
      this.response = undefined;
      this.listener = undefined; this.done = true;
      retireOwnedVeniceReadDiagnostics(this.diagnostics); this.resolve();
    });
    return this.retired;
  }
  private cancelUntouched(): Promise<void> {
    try {
      let original: Promise<void> | undefined = this.body!.cancel();
      const settled = original.then(() => undefined, reason => { this.cleanup.push(this.failure("cancel", reason)); });
      original = undefined; return settled;
    }
    catch (reason) { this.cleanup.push(this.failure("cancel", reason)); return Promise.resolve(); }
  }
  checkCleanup(hasPrimary = false, primary?: unknown): void {
    if (this.cleanup.length && !this.cleanupReported) {
      this.cleanupReported = true;
      throw new AggregateError(hasPrimary ? [primary, ...this.cleanup] : this.cleanup, "owned Venice source retirement");
    }
    if (hasPrimary) throw primary;
  }
  clear(): void {
    if (!this.done || this.pulling) throw identityFailure("protocol");
    this.cleanup.length = 0; this.abortFailure = undefined; this.signal = undefined; this.outputAbort = undefined;
    finishOwnedHttpIntakeDiagnostics(this.diagnostics);
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
    codecPhase(state, state.streaming ? ownedSseResting : ownedJsonSource, state.streaming ? ownedCodecMetadata : 0);
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
    const finishOutput = () => { outputWire = undefined; state.outputDone = true; resolveOutput(); };
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
      codecPhase(state, 2 * limit + ownedCodecMetadata, ownedCodecMetadata);
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
  const frame = new Uint8Array(frameLimit), cursor: SseBoundaryCursor = { offset: 0, lineStart: 0 };
  let size = 0, pending: Uint8Array | undefined, offset = 0, total = 0, emptyReads = 0;
  let terminal = false, modelSeen = false, authorityReady = false, closed = false, upstreamDone = false, canceled = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const fail = (error: unknown) => {
    if (closed) return; closed = true;
    void source.finish("cancel").then(() => {
      pending = undefined; size = 0;
      try { source.checkCleanup(true, error); } catch (failure) {
        if (!canceled) { state.outputFailed = true; state.outputFailure = failure; output.error(failure); }
      }
    });
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      source.outputAbort = () => { fail(source.abortFailure); };
      if (source.abortFailure) source.outputAbort();
    },
    pull(controller) {
      const work = Promise.resolve().then(async () => {
        try {
          while (!closed) {
            source.checkAbort();
            const boundary = sseEventBoundary(frame, 0, size, cursor);
            if (boundary) {
              codecPhase(state, ownedSseParsing, authorityReady ? ownedSseUsage : ownedCodecMetadata);
              let text = "", data: string[] | undefined, lines: string[] | undefined, value = "", payload: unknown;
              let hasData = false;
              try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, boundary.start));
                let count = 0; for (const char of text) if ((char === "\n" || char === "\r") && ++count > 256) invalid();
                lines = text.split(/\r\n|\r|\n/); data = [];
                for (const line of lines) {
                  if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
                  if (/^event:\s*error\s*$/.test(line)) invalid();
                }
                hasData = data.length > 0;
                if (hasData) {
                  if (terminal) invalid(); value = data.join("\n");
                  if (value === "[DONE]") { if (!modelSeen) invalid(); terminal = true; }
                  else {
                    payload = parseOwnedVeniceJson(state, value); validateVeniceReturnedModel(state.binding!, payload);
                    if (payload && typeof payload === "object" && Object.hasOwn(payload, "error")) invalid();
                    modelSeen = true;
                  }
                }
              } finally { text = ""; value = ""; payload = undefined; data = undefined; lines = undefined; }
              codecPhase(state, ownedSseResting, authorityReady ? ownedSseUsage : ownedCodecMetadata);
              if (hasData && !authorityReady) { await revalidateOwnedVeniceChat(state.cap, source.signal!); authorityReady = true; }
              source.checkAbort(); assertOwnedVeniceChatLive(state.cap); if (closed) return;
              // The generic observer can only grow after this point. Its full
              // buffer, predecessor and bounded frame copies are additive.
              codecPhase(state, ownedSseResting, ownedSseUsage);
              const bytes = frame.slice(0, boundary.end);
              frame.copyWithin(0, boundary.end, size); size -= boundary.end; cursor.offset = 0; cursor.lineStart = 0;
              controller.enqueue(bytes); return;
            }
            if (upstreamDone) {
              if (size || !terminal || !modelSeen || length !== null && Number(length) !== total) invalid();
              closed = true;
              void source.finish("eof").then(() => {
                pending = undefined; size = 0;
                try { source.checkCleanup(); if (!canceled) controller.close(); }
                catch (error) {
                  if (!canceled) { state.outputFailed = true; state.outputFailure = error; controller.error(error); }
                }
              });
              return;
            }
            if (size === frameLimit) invalid();
            if (pending && offset < pending.length) {
              const count = Math.min(pending.length - offset, frameLimit - size);
              frame.set(pending.subarray(offset, offset + count), size); size += count; offset += count;
              if (offset === pending.length) { pending = undefined; offset = 0; }
              continue;
            }
            let next: ReadableStreamReadResult<Uint8Array> | undefined = await source.read();
            try {
              if (closed) return; source.checkAbort();
              if (next.done) { upstreamDone = true; cursor.eof = true; continue; }
              if (next.value.byteLength > limit || next.value.buffer.byteLength > limit || !Number.isSafeInteger(total += next.value.byteLength)) invalid();
              if (!next.value.byteLength) { if (++emptyReads > 32) invalid(); continue; }
              emptyReads = 0; pending = next.value; offset = 0;
            } finally { next = undefined; }
          }
        } catch (error) { fail(error); }
      });
      source.pulling = work;
      return work.finally(() => { if (source.pulling === work) source.pulling = undefined; });
    },
    cancel() {
      canceled = true; closed = true;
      return source.finish("cancel").then(() => { pending = undefined; size = 0; source.checkCleanup(); });
    },
  }, { highWaterMark: 0 });
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "etag", "digest", "content-md5"]) headers.delete(name);
  headers.set("cache-control", "private, no-store");
  state.outputBody = body;
  return new Response(body, { status: 200, headers });
}
