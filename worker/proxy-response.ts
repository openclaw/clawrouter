import { inputRetirement } from "./input-retirement.ts";
import { extractVoyageEmbeddingUsage } from "./voyage-embeddings.ts";
import type { ValidatedNativeUsage } from "./native-response.ts";
import { createResponseReceiptInspection, type RequestTariff } from "./request-tariff.ts";
import { createNativeEventObserver } from "./native-events.ts";
import { createRadiusEventInspector } from "./provider-radius.ts";
import { createOllamaChatInspector, ollamaChatFormat } from "./provider-ollama.ts";
import { createBedrockEventStreamInspector } from "./bedrock-eventstream.ts";
import { extractImageUsageTokens } from "./image-generation.ts";
import { extractCompactUsageTokens } from "./responses-compact.ts";
import { createResponsesUsageInspector, type ResponsesInspectionTools } from "./responses-usage.ts";
import { createSseUsageInspector, extractUsageTokens, responseOutcome, usageInspectionLimit, type ResponsesObservation, type UsageInspection, type UsageTokenContext } from "./token-usage.ts";
import { HttpOperation } from "./http-operation.ts";
import { nativeErrorEnvelope, type NativeErrorContext, type NativeErrorDetails } from "./native-errors.ts";

import type { HostedSearchUsage } from "./responses-hosted-usage.ts";
import { identityFailure } from "./identity-admission.ts";
import { checkOwnedHttpCodecConsumer, checkOwnedHttpCodecNormalization, checkOwnedHttpCodecUsage, forwardOwnedHttpCodecUsage, fundOwnedHttpCodecConsumerHeaders, beginOwnedCodecConsumerDiagnostics,
  ownedHttpCodecFailure, finishOwnedCodecDiagnostics, ownOwnedCodecConsumerRetirement, holdOwnedHttpVeniceSource,
  type OwnedHttpRequest, type OwnedHttpRevalidation } from "./http-identity-owner.ts";
import { matchesOwnedVeniceOutputBody, matchesOwnedVeniceOutputFailure, matchesOwnedVeniceUsage } from "./venice-chat-runtime.ts";

export interface ObservedUsage extends UsageInspection { delivery: "complete" | "failed" | "canceled"; binaryComplete?: true; nonbillable?: true; hostedSearch?: HostedSearchUsage; requestTariffOutcome?: import("./request-tariff.ts").RequestTariffOutcome; requestCostReceipt?: import("./pricing.ts").RequestCostReceipt }
export interface ResponseBodyInspection {
  push(bytes: Uint8Array): Promise<void>; end(): Promise<void>;
  acceptJson?(value: unknown, failed?: boolean): void;
  tools?: ResponsesInspectionTools;
  qualify?(): Promise<void>;
  observe?(fact: ResponsesObservation): Promise<void>;
}

export type OwnedCodecConsumer = OwnedHttpRevalidation;
interface CodecConsumer {
  codec: OwnedHttpRevalidation; current: Response; phase: "new" | "normalizing" | "normalized" | "usage" | "sealed";
  delivering?: ObservedUsage;
  reader?: CodecReader; replacement?: CodecReader; retired: Promise<void>; resolve: () => void; done: boolean;
  finalizing?: Promise<void>; usage?: Promise<void>; clearUsage?: () => void;
}
interface CodecReader {
  owner: CodecConsumer; role: 1 | 2; body?: ReadableStream<Uint8Array>;
  reader?: ReadableStreamDefaultReader<Uint8Array>; closed?: Promise<void>; reading?: Promise<void>;
  cancellation?: Promise<void>; retirement?: Promise<void>; pulling?: Promise<void>;
  // stopped=1, unlocked=2, native propagated read=4, native closed=8,
  // errored=16, transferred sniff=32, sniff EOF=64. Independent states persist.
  flags: number; unlockFailure?: object;
  prefix?: Uint8Array[]; prefixIndex?: number;
}
const consumerNativeRead = ReadableStreamDefaultReader.prototype.read;
const consumerNativeCancel = ReadableStreamDefaultReader.prototype.cancel;
const consumerNativeClosed = Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, "closed")!.get;
const consumerLookupGetter = (Object.prototype as { __lookupGetter__?: unknown }).__lookupGetter__;
let codecConsumers: WeakMap<OwnedCodecConsumer, CodecConsumer> | undefined;
let codecConsumerCount = 0;

export function beginOwnedCodecConsumer(http: OwnedHttpRequest, codec: OwnedHttpRevalidation, response: Response,
  operation: HttpOperation, streaming: boolean, requestId: string, validated?: ValidatedNativeUsage, usageContext?: Readonly<UsageTokenContext>): OwnedCodecConsumer {
  checkOwnedHttpCodecConsumer(http, codec, response, operation, streaming, requestId, usageContext);
  if (typeof consumerLookupGetter !== "function" || codecConsumers?.has(codec) || !matchesOwnedVeniceUsage(codec, response, validated)
    || usageContext?.providerId !== "venice" || usageContext.requestFormat !== "openai.chat_completions"
    || usageContext.responseFormat !== "openai.chat_completions") throw identityFailure("protocol");
  // Fixed prefix/consumer metadata was admitted before preparation. Header
  // copies are measured before their constructors, with no whole-key array.
  let pairs = 0, units = 0;
  response.headers.forEach((value, key) => { pairs++; units += key.length + value.length; });
  fundOwnedHttpCodecConsumerHeaders(codec, pairs, units);
  const cap = codec;
  let resolve!: () => void;
  const retired = new Promise<void>(done => { resolve = done; });
  const owner: CodecConsumer = { codec, current: response, phase: "new", retired, resolve, done: false };
  (codecConsumers ??= new WeakMap()).set(cap, owner); codecConsumerCount++;
  ownOwnedCodecConsumerRetirement(http, cap, retired);
  return cap;
}
function consumerOwner(cap: OwnedCodecConsumer): CodecConsumer {
  const owner = codecConsumers?.get(cap); if (!owner || owner.done) throw identityFailure("protocol"); return owner;
}
export function matchesOwnedCodecConsumerRetirement(cap: OwnedCodecConsumer, work: Promise<void>): boolean {
  const owner = codecConsumers?.get(cap); return !!owner && owner.retired === work;
}
export function ownedCodecUsageCompletion(cap: OwnedCodecConsumer): Promise<void> {
  const owner = codecConsumers?.get(cap); if (!owner?.usage) throw identityFailure("protocol"); return owner.usage;
}
export function ownedCodecConsumerRetirement(cap: OwnedCodecConsumer): Promise<void> {
  const owner = codecConsumers?.get(cap); if (!owner) throw identityFailure("protocol"); return owner.retired;
}
function consumerFailure(reader: CodecReader, phase: Parameters<typeof ownedHttpCodecFailure>[2], reason: unknown): object {
  return ownedHttpCodecFailure(reader.owner.codec, reader.role, phase, reason);
}
function publishedConsumerFailure(reader: CodecReader, reason: unknown): boolean {
  return matchesOwnedVeniceOutputBody(reader.owner.codec, reader.body ?? null)
    && matchesOwnedVeniceOutputFailure(reader.owner.codec, reason);
}
function acquireConsumerReader(owner: CodecConsumer, response: Response): CodecReader {
  if (owner.current !== response || owner.replacement !== undefined) throw identityFailure("protocol");
  const role = beginOwnedCodecConsumerDiagnostics(owner.codec);
  const state: CodecReader = { owner, role, flags: 0 };
  if (owner.reader) owner.replacement = state; else owner.reader = state; // BEFORE getReader.
  try {
    state.body = response.body ?? undefined;
    if (!state.body || role === 1 && !matchesOwnedVeniceOutputBody(owner.codec, state.body)) throw identityFailure("protocol");
    state.reader = state.body.getReader();
    const reader = state.reader;
    if (Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype && !Object.hasOwn(reader, "closed")
      && typeof consumerLookupGetter === "function" && consumerLookupGetter.call(reader, "closed") === consumerNativeClosed) state.flags |= 8;
    let original: Promise<void> | undefined = reader.closed;
    state.closed = original.then(() => undefined, reason => {
      state.flags |= 16;
      if (!((state.flags & 8) !== 0 && publishedConsumerFailure(state, reason))) consumerFailure(state, "closed", reason);
    });
    original = undefined;
    return state;
  } catch (reason) {
    const failure = consumerFailure(state, state.reader ? "closed" : "acquire", reason); reason = undefined;
    void retireConsumerReader(state, "cancel", false);
    throw failure;
  }
}
function readConsumer(state: CodecReader): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (state.flags & 1 || !state.reader || state.reading) throw identityFailure("protocol");
  const reader = state.reader;
  let resolve!: () => void;
  const settled = new Promise<void>(done => { resolve = done; });
  state.reading = settled; // A source can cancel synchronously inside read().
  let observed: Promise<ReadableStreamReadResult<Uint8Array>>;
  try {
    const method = reader.read;
    const nativeRead = (state.flags & 8) !== 0 && Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype
      && !Object.hasOwn(reader, "closed") && method === consumerNativeRead;
    let original: Promise<ReadableStreamReadResult<Uint8Array>> | undefined = Reflect.apply(method, reader, []);
    observed = original!.then(value => value, reason => {
      if (nativeRead && publishedConsumerFailure(state, reason)) { state.flags |= 4; throw reason; }
      state.flags &= ~4; throw consumerFailure(state, "read", reason);
    });
    original = undefined;
  } catch (reason) {
    const failure = consumerFailure(state, "read", reason); reason = undefined;
    observed = Promise.reject(failure);
  }
  void observed.then(() => { if (state.reading === settled) state.reading = undefined; resolve(); },
    () => { if (state.reading === settled) state.reading = undefined; resolve(); });
  return observed;
}
function unlockConsumer(state: CodecReader): object | undefined {
  if (state.flags & 2) return;
  state.flags |= 2;
  if (!state.reader) return;
  let failure: object | undefined;
  try { state.reader.releaseLock(); }
  catch (reason) { failure = consumerFailure(state, "unlock", reason); state.unlockFailure = failure; }
  try { if (state.body?.locked) holdOwnedHttpVeniceSource(state.owner.codec); }
  catch (reason) { consumerFailure(state, "retire", reason); holdOwnedHttpVeniceSource(state.owner.codec); }
  return failure;
}
function retireConsumerReader(state: CodecReader, kind: "eof" | "cancel", immediateUnlock: boolean): Promise<void> {
  if (state.retirement) return state.retirement;
  let resolve!: () => void;
  state.retirement = new Promise<void>(done => { resolve = done; });
  // Publish the original join BEFORE cancellation can synchronously re-enter.
  state.flags |= 1;
  const reading = state.reading, pulling = state.pulling;
  if (kind === "cancel") {
    try {
      let original: Promise<void> | undefined;
      let nativeCancel = false;
      if (state.reader) {
        const reader = state.reader, method = reader.cancel;
        nativeCancel = (state.flags & 8) !== 0 && Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype
          && !Object.hasOwn(reader, "closed") && method === consumerNativeCancel;
        original = Reflect.apply(method, reader, []);
      } else if (state.body && !state.body.locked) original = state.body.cancel();
      else { holdOwnedHttpVeniceSource(state.owner.codec); return state.retirement; }
      state.cancellation = original!.then(() => undefined, reason => {
        if (!(nativeCancel && (state.flags & 4) !== 0 && (state.flags & 16) !== 0)) consumerFailure(state, "cancel", reason);
      });
      original = undefined;
    } catch (reason) { consumerFailure(state, "cancel", reason); }
  }
  if (immediateUnlock) unlockConsumer(state);
  let joining: Promise<void> | undefined = (async () => {
    await reading; await state.cancellation;
    if (!immediateUnlock) unlockConsumer(state);
    await state.closed; await pulling;
    try { if (state.body?.locked) { holdOwnedHttpVeniceSource(state.owner.codec); return await new Promise<void>(() => {}); } }
    catch (reason) { consumerFailure(state, "retire", reason); holdOwnedHttpVeniceSource(state.owner.codec); return await new Promise<void>(() => {}); }
    if (state.prefix) state.prefix.length = 0; state.prefix = undefined;
    state.reader = undefined; state.reading = undefined; state.cancellation = undefined; state.closed = undefined; state.pulling = undefined;
    state.body = undefined;
    finishOwnedCodecDiagnostics(state.owner.codec, state.role);
  })();
  void joining.then(resolve, reason => { consumerFailure(state, "retire", reason); holdOwnedHttpVeniceSource(state.owner.codec); });
  joining = undefined;
  return state.retirement;
}
function sealConsumer(owner: CodecConsumer): void {
  if (owner.finalizing) return;
  owner.phase = "sealed";
  if (owner.reader && !owner.reader.retirement) void retireConsumerReader(owner.reader, "cancel", !!(owner.reader.flags & 32));
  if (owner.replacement && !owner.replacement.retirement) void retireConsumerReader(owner.replacement, "cancel", false);
  owner.finalizing = (async () => {
    await owner.reader?.retirement; await owner.replacement?.retirement;
    owner.done = true; owner.resolve();
  })();
}
export function abandonOwnedCodecConsumer(cap: OwnedCodecConsumer): void {
  const owner = codecConsumers?.get(cap); if (!owner) throw identityFailure("protocol");
  if (!owner.done) sealConsumer(owner);
}
export function retireOwnedCodecConsumers(codec: OwnedHttpRevalidation): void {
  const owner = codecConsumers?.get(codec); if (!owner) return;
  if (!owner.done) throw identityFailure("protocol");
  const clear = owner.clearUsage; owner.clearUsage = undefined; clear?.();
  if (owner.reader) { owner.reader.unlockFailure = undefined; owner.reader.owner = undefined as never; }
  if (owner.replacement) { owner.replacement.unlockFailure = undefined; owner.replacement.owner = undefined as never; }
  owner.reader = undefined; owner.replacement = undefined; owner.current = undefined as never;
  owner.delivering = undefined; owner.codec = undefined as never; owner.usage = undefined; owner.finalizing = undefined;
  codecConsumers!.delete(codec);
  if (!--codecConsumerCount) codecConsumers = undefined;
}

export function proxyResponseHeaders(response: Response, providerId: string): Headers {
  const headers = new Headers(response.headers);
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "trailer", "transfer-encoding", "upgrade", "x-clawrouter-grant-failover", "x-clawrouter-error-code", "openai-organization", "openai-project", "anthropic-organization-id", "anthropic-workspace-id"]) headers.delete(name);
  headers.set("x-clawrouter-upstream-provider", providerId);
  return headers;
}

// Accounting observes the delivered stream; a tee would drain upstream ahead of
// the client and buffer arbitrary output. Responses retain only bounded scalar
// metadata; other formats keep their existing bounded JSON/frame inspection.
export function observeUsage(response: Response, operation = new HttpOperation(), bodyInspection?: ResponseBodyInspection, responseFormat?: string, tariff?: RequestTariff, validated?: ValidatedNativeUsage, usageContext?: Readonly<UsageTokenContext>): { response: Response; result: Promise<ObservedUsage>; retired: Promise<void> } {
  const signal = operation.signal;
  const speech = responseFormat === "audio.binary";
  if (!response.body) { operation.stop("complete"); return { response, retired: Promise.resolve(), result: Promise.resolve({ tokens: null, outcome: speech || [ollamaChatFormat, "radius.messages"].includes(responseFormat ?? "") ? "provider_error" : null, delivery: "complete" }) }; }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const mime = contentType.split(";")[0].trim();
  const audio = /^audio\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(mime) || mime === "application/octet-stream";
  const eventStream = !speech && contentType.includes("text/event-stream"), json = !speech && contentType.includes("json");
  const images = responseFormat === "openai.images_generations";
  const compact = responseFormat === "openai.responses_compact";
  const revokeRejection = response.ok && operation.receivedRejection ? () => operation.revokeRejection() : undefined;
  const receipt = tariff?.kind === "outcome_request" ? createResponseReceiptInspection(tariff) : undefined;
  const responses = compact && json ? createResponsesUsageInspector(false, bodyInspection?.tools, undefined, extractCompactUsageTokens) : images && json ? createResponsesUsageInspector(false, undefined, undefined, extractImageUsageTokens) : responseFormat === "openai.responses" && (eventStream || json) ? createResponsesUsageInspector(eventStream, bodyInspection?.tools, bodyInspection?.observe, undefined, revokeRejection, receipt) : null;
  const bedrock = responseFormat === "aws_bedrock.eventstream" && mime === "application/vnd.amazon.eventstream" ? createBedrockEventStreamInspector() : null;
  const radius = responseFormat === "radius.messages" && eventStream ? createNativeEventObserver(createRadiusEventInspector()) : null;
  const nativeChat = responseFormat === ollamaChatFormat || responseFormat === "radius.messages";
  const ollama = responseFormat === ollamaChatFormat && ["application/json", "application/x-ndjson"].includes(mime) ? createOllamaChatInspector(mime === "application/json" ? "json" : "ndjson") : null;
  const sse = !nativeChat && !bedrock && !compact && !images && !responses && eventStream ? createSseUsageInspector(revokeRejection, bodyInspection?.acceptJson, usageContext) : null;
  let inspect = !validated && !nativeChat && !bedrock && !compact && !images && !responses && !sse && json;
  const decoder = new TextDecoder();
  const reader = response.body.getReader(), input = inputRetirement(reader);
  let text = "", bytes = 0, nonempty = false, finished = false;
  let completedJson: UsageInspection | undefined;
  let resolve!: (result: ObservedUsage) => void;
  const result = new Promise<ObservedUsage>(done => { resolve = done; });
  let resolveRetired!: () => void, rejectRetired!: (reason: unknown) => void;
  const retired = new Promise<void>((yes, no) => { resolveRetired = yes; rejectRetired = no; });
  void retired.catch(() => undefined);
  let pulling: Promise<void> | undefined;
  // Abort notifies delivery/accounting immediately. The actual callback must
  // still settle before its retained chunk/inspection owner can retire.
  async function publication<T>(pending: Promise<T>): Promise<T> {
    try { return await pending; }
    catch (error) { operation.stop("publication", error); throw error; }
  }
  function finish(delivery: ObservedUsage["delivery"], reason?: unknown): void {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", aborted);
    if (delivery === "canceled") operation.cancel(reason);
    else operation.stop(delivery === "complete" ? "complete" : "upstream", reason);
    delivery = operation.delivery ?? delivery;
    let inspection: UsageInspection = validated ?? radius?.result() ?? ollama?.result(delivery === "complete") ?? bedrock?.result(delivery === "complete") ?? responses?.result(delivery === "complete") ?? sse?.result(delivery === "complete") ?? { tokens: null, outcome: null };
    if (nativeChat && (!ollama && !radius || delivery === "complete" && !inspection.outcome)) inspection.outcome = "provider_error";
    if (delivery === "complete" && completedJson) inspection = completedJson;
    else if (delivery === "complete" && inspect) {
      try {
        text += decoder.decode();
        const value: unknown = JSON.parse(text);
        inspection = { tokens: responseFormat === "voyage.embeddings"
          ? response.ok && mime === "application/json" ? extractVoyageEmbeddingUsage(value) : null
          : extractUsageTokens(value, usageContext), outcome: responseOutcome(value) };
      } catch { inspection.outcome = "provider_error"; }
    }
    responses?.stop(); text = "";
    // Binary delivery supplies completion only, never synthetic token usage.
    // A partial, empty, or wrong-MIME response cannot discount the reservation.
    const binaryComplete = speech && response.ok && delivery === "complete" && audio && nonempty;
    if (speech && !binaryComplete) inspection.outcome = "provider_error";
    const hostedSearch = responses && !images && !compact ? responses.hostedUsage(delivery === "complete") : undefined;
    const requestCostReceipt = receipt?.result(delivery === "complete") ?? validated?.requestCostReceipt;
    resolve({ ...inspection, delivery, ...(operation.receivedRejection ? { nonbillable: true as const } : {}), ...(binaryComplete ? { binaryComplete: true as const } : {}),
      ...(hostedSearch ? { hostedSearch } : {}), ...(requestCostReceipt ? { requestCostReceipt } : {}) });
    // Claim completion before cancellation can resolve/reject a pending read.
    // The result owns accounting even if the transport's cancellation rejects.
    const cleanup = input.retire(delivery === "complete" ? "eof" : "cancel", reason);
    // finish() never awaits this from inside pull: joining our own active pull
    // here is safe only because the pull returns without awaiting retirement.
    void Promise.all([cleanup, pulling]).then(resolveRetired, rejectRetired);
    // Downstream cancellation remains prompt. Only retired certifies cleanup
    // and permits the proxy's separately retained capacity owner to release.
  }
  let downstream: ReadableStreamDefaultController<Uint8Array>;
  function aborted() {
    if (finished) return;
    void finish("canceled", signal.reason);
    downstream.error(signal.reason);
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) { downstream = controller; },
    pull(controller) {
      const work = (async () => {
      try {
        const next = await input.read(() => reader.read());
        if (finished) return; // A pending read can resolve after consumer cancellation.
        if (next.done) {
          sse?.end();
          if (inspect && bodyInspection?.acceptJson) {
            try {
              text += decoder.decode();
              const value: unknown = JSON.parse(text);
              completedJson = { tokens: extractUsageTokens(value, usageContext), outcome: responseOutcome(value) };
              bodyInspection.acceptJson(value);
            } catch { completedJson = { tokens: null, outcome: "provider_error" }; }
            text = ""; inspect = false;
          }
          if (bodyInspection) await publication(bodyInspection.end()); if (finished) return;
          if (responses) await (bodyInspection?.observe ? publication(responses.end()) : responses.end()); if (finished) return;
          if (responses && bodyInspection?.qualify) await publication(bodyInspection.qualify()); if (finished) return;
          finish("complete"); controller.close(); return;
        }
        nonempty ||= next.value.byteLength > 0;
        if (bodyInspection?.observe) await publication(bodyInspection.push(next.value));
        if (finished) return;
        if (responses) { await (bodyInspection?.observe ? publication(responses.push(next.value)) : responses.push(next.value)); if (finished) return; }
        sse?.push(next.value);
        bedrock?.push(next.value);
        ollama?.push(next.value);
        radius?.push(next.value);
        if (inspect) {
          bytes += next.value.byteLength;
          if (bytes > usageInspectionLimit) { inspect = false; text = ""; }
          else text += decoder.decode(next.value, { stream: true });
        }
        // Identity registration owns publication; the same reader still owns
        // demand, cancellation, and usage when the durable write fails.
        if (bodyInspection && !bodyInspection.observe) await publication(bodyInspection.push(next.value));
        if (finished) return;
        if (responses && bodyInspection?.qualify) await publication(bodyInspection.qualify());
        if (!finished) controller.enqueue(next.value);
      } catch (error) { if (!finished) { finish("failed", error); controller.error(error); } }
      })();
      pulling = work;
      return work.finally(() => { if (pulling === work) pulling = undefined; });
    },
    cancel(reason) { return finish("canceled", reason); },
  }, { highWaterMark: 0 });
  // workerd can drop its response pump without calling the JS stream's cancel.
  // Ingress abort is the authoritative caller-lifecycle signal in that case.
  if (signal.aborted) aborted();
  else signal.addEventListener("abort", aborted, { once: true });
  return { response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), result, retired };
}
export function observeOwnedCodecUsage(cap: OwnedCodecConsumer, response: Response, operation: HttpOperation,
  validated?: ValidatedNativeUsage, usageContext?: Readonly<UsageTokenContext>): Response {
  const owner = consumerOwner(cap);
  if (owner.phase !== "normalized" || owner.current !== response) throw identityFailure("protocol");
  checkOwnedHttpCodecUsage(cap, operation, validated, usageContext);
  owner.phase = "usage";
  try { return observeOwnedChatUsage(owner, response, operation, validated, usageContext); }
  catch (error) { owner.delivering = undefined; sealConsumer(owner); throw error; }
  finally { response = undefined as never; }
}
export function matchesOwnedCodecUsage(cap: OwnedCodecConsumer, response: Response, usage: ObservedUsage): boolean {
  const owner = codecConsumers?.get(cap);
  return !!owner && (owner.phase === "usage" || owner.phase === "sealed")
    && owner.current === response && owner.delivering === usage;
}
// Only the genuine Unified Chat consumer reaches this orchestration. The SSE
// inspector and JSON usage algorithms are exactly the ordinary implementations.
function observeOwnedChatUsage(owner: CodecConsumer, response: Response, operation: HttpOperation,
  validated?: ValidatedNativeUsage, usageContext?: Readonly<UsageTokenContext>): Response {
  let signal = operation.signal;
  let state = usageConsumerReader(owner, response);
  let contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  let sse = contentType.includes("text/event-stream") ? createSseUsageInspector(
    response.ok && operation.receivedRejection ? () => operation.revokeRejection() : undefined, undefined, usageContext) : null;
  let inspect = !validated && !sse && contentType.includes("json");
  let decoder = inspect ? new TextDecoder() : undefined;
  let text = "", bytes = 0, finished = false;
  let resolve!: () => void;
  let ready = new Promise<void>(done => { resolve = done; });
  let downstream!: ReadableStreamDefaultController<Uint8Array>;
  let body!: ReadableStream<Uint8Array>, output!: Response;
  function clearUsage(): void {
    if (!owner.done) throw identityFailure("protocol");
    // The root calls this only after the original consumer and public boundary
    // joined. Clear closures explicitly; a closed native stream is not credit.
    sse = null; decoder = undefined; text = ""; contentType = "";
    validated = undefined; usageContext = undefined; response = undefined as never;
    body = undefined as never; output = undefined as never; downstream = undefined as never;
    ready = undefined as never; resolve = undefined as never; signal = undefined as never;
    state = undefined as never; operation = undefined as never; owner = undefined as never;
  }
  owner.clearUsage = clearUsage;
  function finish(delivery: ObservedUsage["delivery"], reason?: unknown): void {
    if (finished) return;
    finished = true;
    let listenerFailure: object | undefined;
    try { signal.removeEventListener("abort", aborted); }
    catch (error) { listenerFailure = consumerFailure(state, "listenerRemove", error); holdOwnedHttpVeniceSource(owner.codec); }
    if (delivery === "canceled") operation.cancel(reason);
    else operation.stop(delivery === "complete" ? "complete" : "upstream", reason);
    delivery = operation.delivery ?? delivery;
    let inspection: UsageInspection = validated ?? sse?.result(delivery === "complete") ?? { tokens: null, outcome: null };
    if (delivery === "complete" && inspect) {
      try {
        text += decoder!.decode();
        const value: unknown = JSON.parse(text);
        inspection = { tokens: extractUsageTokens(value, usageContext), outcome: responseOutcome(value) };
      } catch { inspection.outcome = "provider_error"; }
    }
    text = "";
    owner.delivering = { ...inspection, delivery, ...(operation.receivedRejection ? { nonbillable: true as const } : {}),
      ...(validated?.requestCostReceipt ? { requestCostReceipt: validated.requestCostReceipt } : {}) };
    resolve();
    // Outcome starts accounting now. The already enrolled consumer receipt
    // separately joins the SAME read, FIRSTcancel, unlock, closed and pull.
    void retireConsumerReader(state, delivery === "complete" ? "eof" : "cancel", !!(state.flags & 32));
    sealConsumer(owner);
    if (listenerFailure) throw listenerFailure;
  }
  function aborted(): void {
    if (finished) return;
    let failure: unknown = signal.reason;
    try { finish("canceled", failure); } catch (error) { failure = error; }
    downstream.error(failure); failure = undefined;
  }
  body = new ReadableStream<Uint8Array>({
    start(controller) { downstream = controller; },
    pull(controller) {
      let settled!: () => void;
      const joining = new Promise<void>(done => { settled = done; });
      state.pulling = joining; // BEFORE even synchronous prefix/EOF work.
      let original: Promise<void> | undefined = (async () => {
        let phase: "read" | "usage" | "finish" = "usage";
        try {
          let next: ReadableStreamReadResult<Uint8Array>;
          if (state.prefix && state.prefixIndex! < state.prefix.length) {
            const index = state.prefixIndex!; state.prefixIndex = index + 1;
            next = { done: false, value: state.prefix[index] }; delete state.prefix[index];
          } else {
            if (state.prefix) { state.prefix.length = 0; state.prefix = undefined; state.prefixIndex = undefined; }
            phase = "read";
            next = state.flags & 64 ? { done: true, value: undefined } : await readConsumer(state);
          }
          if (finished) return;
          phase = "usage";
          if (next.done) {
            sse?.end(); phase = "finish"; finish("complete"); phase = "usage"; controller.close(); return;
          }
          sse?.push(next.value);
          if (inspect) {
            bytes += next.value.byteLength;
            if (bytes > usageInspectionLimit) { inspect = false; text = ""; }
            else text += decoder!.decode(next.value, { stream: true });
          }
          if (!finished) controller.enqueue(next.value);
        } catch (error) {
          const failure = phase === "usage" ? consumerFailure(state, "pull", error) : error;
          error = undefined;
          if (!finished) {
            try { finish("failed", failure); } catch { /* Separate listener origin already retained. */ }
            controller.error(failure);
          } else if (phase === "finish") { controller.error(failure); }
        }
      })();
      const observed = original.then(() => {
        if (state.pulling === joining) state.pulling = undefined; settled();
      }, reason => {
        const failure = consumerFailure(state, "pull", reason);
        if (state.pulling === joining) state.pulling = undefined; settled(); throw failure;
      });
      original = undefined;
      return observed;
    },
    cancel(reason) { finish("canceled", reason); },
  }, { highWaterMark: 0 });
  try {
    if (signal.aborted) aborted();
    else {
      try { signal.addEventListener("abort", aborted, { once: true }); }
      catch (error) { throw consumerFailure(state, "listenerAdd", error); }
    }
    output = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    owner.current = output;
    owner.usage = ready.then(() => {
      const value = owner.delivering!;
      try { forwardOwnedHttpCodecUsage(owner.codec, output, value); }
      finally { owner.delivering = undefined; }
    });
    return output;
  } catch (error) {
    try { finish("failed", error); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "owned usage publication"); }
    throw error;
  } finally { response = undefined as never; }
}

export function normalizePreStreamError(response: Response, streamingRequested: boolean, operation = new HttpOperation(), native?: NativeErrorContext): Promise<Response> {
  return normalizePreStreamErrorWithOwner(response, streamingRequested, operation, native);
}
export async function normalizeOwnedCodecPreStreamError(cap: OwnedCodecConsumer, response: Response, streamingRequested: boolean, operation: HttpOperation, native?: NativeErrorContext): Promise<Response> {
  const owner = consumerOwner(cap);
  if (owner.phase !== "new" || owner.current !== response || native?.format !== "openai") throw identityFailure("protocol");
  checkOwnedHttpCodecNormalization(cap, response, streamingRequested, operation, native.requestId);
  owner.phase = "normalizing";
  try {
    const result = await normalizePreStreamErrorWithOwner(response, streamingRequested, operation, native, owner);
    owner.current = result; owner.phase = "normalized"; return result;
  } catch (error) { sealConsumer(owner); throw error; }
  finally { response = undefined as never; }
}
async function normalizePreStreamErrorWithOwner(response: Response, streamingRequested: boolean, operation: HttpOperation, native?: NativeErrorContext, consumer?: CodecConsumer): Promise<Response> {
  if (!streamingRequested) return response;
  const eventStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
  if (response.status >= 400) {
    try {
      if (eventStream && (consumer || response.body)) return await normalizeFirstSseEvent(response, response.status, operation, native, consumer);
      const body = await readLimited(response, 64 * 1024, operation, consumer);
      // Valid native JSON errors are already the wire contract: preserve even
      // whitespace and extension fields instead of rebuilding their envelope.
      if (native && nativeJsonError(body, native)) return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      return mappedUpstreamError(response, upstreamError(body), response.status, native);
    } catch {
      // Failure to read error details cannot replace an accepted HTTP status.
      // The operation still owns cancellation and the accounting cause.
      return mappedUpstreamError(response, {}, response.status, native);
    }
  }
  if (!response.ok || !eventStream || !consumer && !response.body) return response;
  return normalizeFirstSseEvent(response, null, operation, native, consumer);
}

const FIRST_SSE_EVENT_LIMIT = 8 * 1024;

async function normalizeFirstSseEvent(response: Response, errorStatus: number | null, operation: HttpOperation, native?: NativeErrorContext, consumer?: CodecConsumer): Promise<Response> {
  const ownedReader = consumer ? acquireConsumerReader(consumer, response) : undefined;
  const reader = ownedReader ? undefined : response.body!.getReader();
  const chunks: Uint8Array[] = [];
  if (ownedReader) ownedReader.prefix = chunks;
  let sniffed = new Uint8Array(FIRST_SSE_EVENT_LIMIT);
  let sniffedLength = 0;
  let eventStart = 0;
  let transferred = false;
  let hasPrimary = false, primary: unknown;
  try {
    while (true) {
      // Missing details on a known rejection must leave its fallback body readable.
      // A failed HTTP 200 sniff still owns the failure before reader cleanup.
      const { done, value } = await operation.wait(ownedReader ? readConsumer(ownedReader) : reader!.read(), errorStatus === null ? "upstream" : undefined);
      if (value?.byteLength) {
        chunks.push(value);
        const copyLength = Math.min(value.byteLength, FIRST_SSE_EVENT_LIMIT - sniffedLength);
        if (copyLength > 0) {
          sniffed.set(value.subarray(0, copyLength), sniffedLength);
          sniffedLength += copyLength;
        }
      }
      while (eventStart < sniffedLength) {
        const boundary = sseEventBoundary(sniffed, eventStart, sniffedLength);
        if (!boundary) break;
        const event = classifySseEvent(sniffed.subarray(eventStart, boundary.start));
        eventStart = boundary.end;
        if (event.kind === "empty") continue;
        // A native HTTP-200 error event is still SSE, even when it is the
        // first event. Retain the sniff/deadline but never invent an HTTP 502.
        if (errorStatus !== null || event.kind === "error") {
          const upstream = event.upstream;
          const status = errorStatus ?? (typeof upstream.code === "number" && Number.isInteger(upstream.code) && upstream.code >= 400 && upstream.code <= 599 ? upstream.code : 502);
          // Preserve the pre-output rejection's zero charge independently of
          // native HTTP-200 SSE delivery, including later client cancellation.
          operation.acceptRejection(status);
          if (errorStatus !== null || !native) return mappedUpstreamError(response, upstream, status, native);
        }
        transferred = true;
        return ownedReader ? transferSniffReader(response, ownedReader, done) : replayResponse(response, reader!, chunks, done);
      }
      if (done || sniffedLength === FIRST_SSE_EVENT_LIMIT) {
        if (errorStatus === null) { transferred = true; return ownedReader ? transferSniffReader(response, ownedReader, done) : replayResponse(response, reader!, chunks, done); }
        return mappedUpstreamError(response, {}, errorStatus, native);
      }
    }
  } catch (error) { if (ownedReader) { hasPrimary = true; primary = error; } throw error; }
  finally {
    try {
      if (!transferred) {
        if (ownedReader) {
          void retireConsumerReader(ownedReader, "cancel", true);
          const cleanup = ownedReader.unlockFailure;
          if (cleanup) { if (hasPrimary) throw new AggregateError([primary, cleanup], "owned sniff retirement"); throw cleanup; }
        } else { void reader!.cancel(operation.signal.reason).catch(() => undefined); reader!.releaseLock(); }
      }
    } finally { primary = undefined; if (ownedReader) sniffed = undefined as never; }
  }
}

function transferSniffReader(response: Response, state: CodecReader, done: boolean): Response {
  if (state.owner.phase !== "normalizing" || state.owner.current !== response || !state.prefix || (state.flags & 1))
    throw identityFailure("protocol");
  state.prefixIndex = 0; state.flags |= 32 | (done ? 64 : 0);
  // This locked response stays invocation-local. The fixed usage command must
  // consume this SAME reader; it cannot be returned to a public caller.
  return response;
}
function usageConsumerReader(owner: CodecConsumer, response: Response): CodecReader {
  const sniff = owner.reader;
  if (sniff?.prefix && !(sniff.flags & 1)) {
    if (owner.current !== response || !(sniff.flags & 32) || sniff.prefixIndex !== 0) throw identityFailure("protocol");
    return sniff;
  }
  // JSON and mapped replacements acquire their own actual body. Any abandoned
  // codec reader remains separately joined; replacement is never its receipt.
  return acquireConsumerReader(owner, response);
}
function replayResponse(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, chunks: Uint8Array[], readerDone: boolean): Response {
  let chunkIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunkIndex < chunks.length) {
        controller.enqueue(chunks[chunkIndex++]);
        return;
      }
      if (readerDone) {
        reader.releaseLock();
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { reader.releaseLock(); controller.error(error); }
    },
    cancel(reason) { void reader.cancel(reason).catch(() => undefined); reader.releaseLock(); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export interface SseBoundaryCursor { offset: number; lineStart: number; eof?: boolean }
export function sseEventBoundary(bytes: Uint8Array, start: number, length: number, cursor?: SseBoundaryCursor): { start: number; end: number } | null {
  let lineStart = cursor?.lineStart ?? start;
  for (let index = cursor?.offset ?? start; index < length; index += 1) {
    if (bytes[index] !== 10 && bytes[index] !== 13) continue;
    if (cursor && bytes[index] === 13 && index + 1 === length && !cursor.eof) {
      cursor.offset = index; cursor.lineStart = lineStart; return null;
    }
    const next = bytes[index] === 13 && index + 1 < length && bytes[index + 1] === 10 ? index + 2 : index + 1;
    if (index === lineStart) return { start: lineStart, end: next };
    lineStart = next;
    index = next - 1;
  }
  if (cursor) { cursor.offset = length; cursor.lineStart = lineStart; }
  return null;
}

function classifySseEvent(bytes: Uint8Array): { kind: "empty" } | { kind: "healthy" | "error"; upstream: ReturnType<typeof upstreamError> } {
  let eventType = "";
  const dataLines: string[] = [];
  for (const line of new TextDecoder().decode(bytes).split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
  }
  const data = dataLines.join("\n");
  if (dataLines.length === 0) return { kind: "empty" };
  const upstream = upstreamError(data);
  return eventType === "error" || hasTopLevelError(data) ? { kind: "error", upstream } : { kind: "healthy", upstream };
}

function hasTopLevelError(data: string): boolean {
  try {
    const value: unknown = JSON.parse(data);
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "error");
  } catch { return false; }
}

function mappedUpstreamError(response: Response, upstream: NativeErrorDetails, status: number, native?: NativeErrorContext): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  const message = upstream.message ?? (response.ok ? "upstream request failed" : response.statusText || "upstream request failed");
  const body = native ? nativeErrorEnvelope(native, status, {
    ...upstream, message, requestId: upstream.requestId === undefined ? headers.get("request-id") ?? native.requestId : upstream.requestId,
  }) : { error: { message, type: upstream.type ?? "upstream_error", code: upstream.code ?? status } };
  return Response.json(body, { status, statusText: status === response.status ? response.statusText : "", headers });
}

function nativeJsonError(body: string, native: NativeErrorContext): boolean {
  try {
    const value = JSON.parse(body), error = value?.error;
    if (!error || typeof error.message !== "string" || typeof error.type !== "string") return false;
    return native.format === "anthropic" ? value.type === "error" && (typeof value.request_id === "string" || value.request_id === null) : Object.hasOwn(error, "param") && Object.hasOwn(error, "code");
  } catch { return false; }
}

function upstreamError(body: string): NativeErrorDetails {
  let value: unknown;
  try {
    const eventData = firstSseData(body);
    value = JSON.parse(eventData || body);
  } catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const error = "error" in value && value.error && typeof value.error === "object" && !Array.isArray(value.error) ? value.error as Record<string, unknown> : value as Record<string, unknown>;
  return {
    message: typeof error.message === "string" ? error.message : undefined,
    type: typeof error.type === "string" ? error.type : undefined,
    code: typeof error.code === "string" || typeof error.code === "number" || error.code === null ? error.code : undefined,
    param: error.param,
    requestId: "request_id" in value && (typeof value.request_id === "string" || value.request_id === null) ? value.request_id : undefined,
  };
}

function firstSseData(body: string): string | null {
  const dataLines: string[] = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (!line) {
      if (dataLines.some((value) => value !== "")) break;
      dataLines.length = 0;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") continue;
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  }
  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

async function readLimited(response: Response, limit: number, operation: HttpOperation, consumer?: CodecConsumer): Promise<string> {
  if (!consumer && !response.body) return "";
  const ownedReader = consumer ? acquireConsumerReader(consumer, response) : undefined;
  const reader = ownedReader ? undefined : response.body!.getReader(), decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { done, value } = await operation.wait(ownedReader ? readConsumer(ownedReader) : reader!.read());
      if (done) break;
      size += value.byteLength;
      if (size > limit) return "";
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (ownedReader) { void retireConsumerReader(ownedReader, "cancel", true); if (ownedReader.unlockFailure) throw ownedReader.unlockFailure; }
    else { void reader!.cancel(operation.signal.reason).catch(() => undefined); reader!.releaseLock(); }
  }
}
