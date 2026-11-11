import { OwnedUsageRegistrations, createSseUsageAccumulator, createSseFrames, parseSseData, ownedUsageJsonParse, type SseUsageEvidence, createSseUsageInspector, extractUsageTokens, responseOutcome, usageInspectionLimit, type ResponsesObservation, type UsageInspection, type UsageTokenContext } from "./token-usage.ts";
import { fundOwnedHttpAcceptedUsage, settleOwnedHttpCodecConsumerCapture, forwardOwnedHttpCodecUsage, holdOwnedHttpVeniceSource, fundOwnedHttpGenericUsage, createOwnedHttpCodecUsageResponse, createOwnedHttpGenericUsageResponse, bindOwnedHttpGenericBodylessResponse, bindOwnedHttpGenericUsageOutput, forwardOwnedHttpGenericUsage, type OwnedHttpUsage, type OwnedHttpRevalidation, checkOwnedHttpCodecConsumer, checkOwnedHttpCodecNormalization, checkOwnedHttpCodecUsage, fundOwnedHttpCodecConsumerHeaders, fundOwnedHttpCodecConsumerCapture, beginOwnedHttpNormalization, bindOwnedHttpNormalizationReplay, checkOwnedHttpNormalizationReaderCreation, fundOwnedHttpNormalization, fundOwnedHttpNormalizationCapture, ownOwnedHttpNormalizationReader, ownedHttpNormalizationFailure, holdOwnedHttpNormalization, publishOwnedHttpNormalizationOutput, clearOwnedHttpNormalizationOutput, finishOwnedHttpNormalizationReader, endOwnedHttpNormalization, fundOwnedHttpCodecNormalization, beginOwnedCodecConsumerDiagnostics, ownedHttpCodecFailure, finishOwnedCodecDiagnostics, ownOwnedCodecConsumerRetirement, checkOwnedHttpGenericUsage, checkOwnedHttpGenericUsageInspection, ownOwnedHttpGenericUsageReader, bindOwnedHttpGenericUsageBody, fundOwnedHttpGenericUsageCapture, ownedHttpGenericUsageFailure, ownedHttpGenericUsageInstallationFailure, holdOwnedHttpGenericUsage, acceptOwnedHttpNormalizerIntoUsage, offerOwnedHttpGenericUsageOutput, clearOwnedHttpGenericUsageOutput, finishOwnedHttpGenericUsageReader, ownedHttpGenericUsageRetirement, type OwnedHttpRequest, type OwnedHttpUpload, type OwnedHttpNormalization } from "./http-identity-owner.ts";
import { identityFailure, isIdentityFailure } from "./identity-admission.ts";
import { measurePrivateJsonBody, privateMappedErrorJson } from "./json-body.ts";
import { OwnedReaderDriver, claimOwnedHttpStaticCustody, inspectOwnedBytes, isLocalOwnedByteView, newOwnedBytes, ownedByteBackingBytes, ownedByteLength, ownedByteSubarray, copyOwnedBytes, enqueueOwnedBytes, newOwnedDecoder, decodeOwnedBytes, measureOwnedHeaders, newOwnedHeaders, getOwnedHeader, setOwnedHeader, deleteOwnedHeader, newOwnedResponse } from "./proxy-completion.ts";
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
import { HttpOperation } from "./http-operation.ts";
import { nativeErrorEnvelope, type NativeErrorContext, type NativeErrorDetails } from "./native-errors.ts";

import type { HostedSearchUsage } from "./responses-hosted-usage.ts";
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
export interface CodecConsumer {
  codec: OwnedHttpRevalidation; current: Response; phase: "new" | "normalizing" | "normalized" | "usage" | "sealed";
  delivering?: ObservedUsage;
  reader?: CodecReader; replacement?: CodecReader; retired: Promise<void>; resolve: () => void; done: boolean;
  usage?: Promise<void>; usageOwner?: OwnedChatUsage;
  outputFailed?: true; outputFailure?: object; normalizationUnits?: number;
}
export class CodecReader extends OwnedReaderDriver {
  flags = 0;
  unlockFailure?: object;
  prefixWire?: Uint8Array; prefixUsed?: number; prefixRead?: number;
  crossingWire?: Uint8Array; crossingRead?: number;
  retirement?: Promise<void>;
  declare public owner: CodecConsumer;
  declare readonly role: 1 | 2;
  constructor(owner: CodecConsumer, role: 1 | 2) { super();
    this.owner = owner; this.role = role; }
  protected holdDriver(): void { holdOwnedHttpVeniceSource(this.owner.codec); }
  protected driverProtocolFailure(): Error { return identityFailure("protocol"); }
  protected recordDriverFailure(kind: "read" | "closed" | "cancel" | "unlock" | "pull" | "retire", reason: unknown): object { return consumerFailure(this, kind, reason); }
  protected captureDriverFailure(reason: unknown): object { return isIdentityFailure(reason) ? reason : consumerFailure(this, "read", reason); }
  protected propagatedDriverFailure(reason: unknown): boolean { return publishedConsumerFailure(this, reason); }
  protected driverCleanupFailure(kind: "closed" | "cancel" | "unlock", failure: object): void { if (kind === "unlock") this.unlockFailure = failure; }
  protected captureDriverValue(value: ReadableStreamReadResult<Uint8Array>): void {
    // Consumer role observes value, then funding/copy, then done. No shared
    // result adapter may reverse these observable getter operations.
    const bytes = value.value;
    if (!bytes) this.captured = undefined;
    else {
      if (!isLocalOwnedByteView(bytes)) throw identityFailure("protocol");
      const proof = inspectOwnedBytes(bytes);
      fundOwnedHttpCodecConsumerCapture(this.owner.codec, 8192 + proof.backing + 3 * proof.length
        + (this.prefixWire ? ownedByteBackingBytes(this.prefixWire) : 0) + (this.crossingWire ? ownedByteBackingBytes(this.crossingWire) : 0));
      const copy = newOwnedBytes(proof.length); copyOwnedBytes(copy, bytes); this.captured = copy;
    }
    this.readDone = !!value.done;
  }
  open(body: ReadableStream<Uint8Array>): void {
    this.body = body;
    this.reader = this.body.getReader();
    const reader = this.reader;
    this.observeDriverClosed(Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype && !Object.hasOwn(reader, "closed")
      && typeof consumerLookupGetter === "function" && consumerLookupGetter.call(reader, "closed") === consumerNativeClosed);
  }
  read(): Promise<void> { return this.startDriverRead(); }
  beginPull(): void { this.beginDriverPull(); }
  ownPull(work: Promise<void>): Promise<void> { return this.ownDriverPull(work); }
  retire(kind: "eof" | "cancel", immediateUnlock: boolean): Promise<void> {
    if (!this.retirement) { this.flags |= 1; this.retirement = this.retired; this.stopDriver(kind === "cancel", immediateUnlock); }
    return this.retirement;
  }
  protected driverCleared(): void {
    this.prefixWire = undefined; this.crossingWire = undefined;
    finishOwnedCodecDiagnostics(this.owner.codec, this.role);
  }
  protected driverRetired(): void { finishConsumer(this.owner); }
}

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
export function matchesOwnedCodecOutputFailure(cap: OwnedCodecConsumer, body: ReadableStream<Uint8Array> | null, reason: unknown): boolean {
  const owner = codecConsumers?.get(cap);
  return !!owner?.outputFailed && owner.current.body === body && owner.outputFailure === reason;
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
export function consumerFailure(reader: CodecReader, phase: Parameters<typeof ownedHttpCodecFailure>[2], reason: unknown): object {
  return ownedHttpCodecFailure(reader.owner.codec, reader.role, phase, reason);
}
function publishedConsumerFailure(reader: CodecReader, reason: unknown): boolean {
  return matchesOwnedVeniceOutputBody(reader.owner.codec, reader.body ?? null)
    && matchesOwnedVeniceOutputFailure(reader.owner.codec, reason);
}
function acquireConsumerReader(owner: CodecConsumer, response: Response): CodecReader {
  if (owner.current !== response || owner.replacement !== undefined) throw identityFailure("protocol");
  const role = beginOwnedCodecConsumerDiagnostics(owner.codec);
  let body: ReadableStream<Uint8Array> | null;
  try { body = response.body; }
  catch (reason) { holdOwnedHttpVeniceSource(owner.codec); throw ownedHttpCodecFailure(owner.codec, role, "acquire", reason); }
  if (!body || role === 1 && !matchesOwnedVeniceOutputBody(owner.codec, body)) throw identityFailure("protocol");
  if (!claimOwnedHttpStaticCustody()) throw identityFailure("limit");
  const state = new CodecReader(owner, role);
  if (owner.reader) owner.replacement = state; else owner.reader = state;
  try { state.open(body); body = null; return state; }
  catch (reason) {
    const failure = consumerFailure(state, state.reader ? "closed" : "acquire", reason); reason = undefined;
    void state.retire("cancel", false); throw failure;
  }
}
export function readConsumer(state: CodecReader): Promise<void> { return state.read(); }
export function retireConsumerReader(state: CodecReader, kind: "eof" | "cancel", immediateUnlock: boolean): Promise<void> { return state.retire(kind, immediateUnlock); }
function finishConsumer(owner: CodecConsumer): void {
  if (owner.phase !== "sealed" || owner.done || owner.reader && !owner.reader.driverDone || owner.replacement && !owner.replacement.driverDone) return;
  owner.done = true; owner.resolve();
}
export function sealConsumer(owner: CodecConsumer): void {
  if (owner.phase === "sealed") return;
  owner.phase = "sealed";
  if (owner.reader && !owner.reader.retirement) void owner.reader.retire("cancel", !!(owner.reader.flags & 32));
  if (owner.replacement && !owner.replacement.retirement) void owner.replacement.retire("cancel", false);
  finishConsumer(owner);
}
export function abandonOwnedCodecConsumer(cap: OwnedCodecConsumer): void {
  const owner = codecConsumers?.get(cap); if (!owner) throw identityFailure("protocol");
  try { owner.usageOwner?.abandon(); }
  finally { if (!owner.done) sealConsumer(owner); }
}
export function retireOwnedCodecConsumers(codec: OwnedHttpRevalidation): void {
  const owner = codecConsumers?.get(codec); if (!owner) return;
  if (!owner.done) throw identityFailure("protocol");
  owner.usageOwner?.clear(); owner.usageOwner = undefined;
  if (owner.reader) { owner.reader.unlockFailure = undefined; owner.reader.owner = undefined as never; }
  if (owner.replacement) { owner.replacement.unlockFailure = undefined; owner.replacement.owner = undefined as never; }
  owner.reader = undefined; owner.replacement = undefined; owner.current = undefined as never;
  owner.delivering = undefined; owner.outputFailure = undefined; owner.outputFailed = undefined; owner.codec = undefined as never; owner.usage = undefined;
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
// The generic Chat receiver is a distinct genuine child, never a codec cap.
export class GenericUsageReader extends OwnedReaderDriver {
  #cap: OwnedHttpUsage;
  usage?: OwnedGenericChatUsage;
  private output?: Uint8Array;
  private transferred = false;
  private constructor(cap: OwnedHttpUsage) { super(); this.#cap = cap; }
  get usageCap(): OwnedHttpUsage { return this.#cap; }
  static owns(cap: OwnedHttpUsage, reader: unknown): reader is GenericUsageReader {
    return reader !== null && typeof reader === "object" && #cap in reader && reader.#cap === cap;
  }
  static checkInspection(reader: GenericUsageReader): void {
    if (!reader || typeof reader !== "object" || !(#cap in reader)) throw identityFailure("protocol");
    checkOwnedHttpGenericUsageInspection(reader.#cap, reader);
  }
  static create(cap: OwnedHttpUsage, response: Response, operation: HttpOperation, validated: ValidatedNativeUsage | undefined,
    context: Readonly<UsageTokenContext> | undefined): GenericUsageReader {
    checkOwnedHttpGenericUsage(cap, response, operation, validated, context);
    const reader = new GenericUsageReader(cap); ownOwnedHttpGenericUsageReader(cap, reader); return reader;
  }
  protected holdDriver(): void { holdOwnedHttpGenericUsage(this.#cap); }
  protected driverProtocolFailure(): Error { return new Error("private usage read failed"); }
  protected recordDriverFailure(kind: "read" | "cancel" | "unlock" | "closed" | "pull" | "retire", reason: unknown): object {
    return this.failure(kind, reason);
  }
  protected recordDriverInstallationFailure(kind: "read" | "cancel" | "unlock" | "closed" | "pull", reason: unknown): object {
    return ownedHttpGenericUsageInstallationFailure(this.#cap, this, kind, reason);
  }
  failure(kind: "acquire" | "read" | "cancel" | "unlock" | "closed" | "pull" | "retire" | "listener-add" | "listener-remove", reason: unknown): object {
    return ownedHttpGenericUsageFailure(this.#cap, this, kind, reason);
  }
  hold(): void { this.uncertain(); }
  protected propagatedDriverFailure(_reason: unknown): boolean { return false; }
  protected captureDriverFailure(reason: unknown): object { return isIdentityFailure(reason) ? reason : this.failure("read", reason); }
  protected driverPullFailure(_failure: object): void { this.uncertain(); }
  protected captureDriverValue(part: ReadableStreamReadResult<Uint8Array>): void {
    // FIRST is already consumed by the base. Finished-late results have no
    // payload projection at all, including DONE and arbitrary extra metadata.
    if (this.usage!.finished) return;
    this.readDone = !!part.done;
    if (this.readDone) { this.captured = undefined; return; }
    let bytes = part.value;
    let proof: ReturnType<typeof inspectOwnedBytes>;
    try { proof = inspectOwnedBytes(bytes); } catch { throw this.driverProtocolFailure(); }
    fundOwnedHttpGenericUsageCapture(this.#cap, this, 8192 + proof.backing + proof.length
      + (this.output ? ownedByteBackingBytes(this.output) : 0));
    const copy = newOwnedBytes(proof.length); copyOwnedBytes(copy, bytes!);
    acceptOwnedHttpNormalizerIntoUsage(this.#cap, this, bytes!); bytes = undefined;
    this.captured = copy;
  }
  open(body: ReadableStream<Uint8Array>): void {
    this.body = body; bindOwnedHttpGenericUsageBody(this.#cap, this, body);
    try {
      this.reader = body.getReader();
      const reader = this.reader;
      this.observeDriverClosed(Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype && !Object.hasOwn(reader, "closed")
        && typeof consumerLookupGetter === "function" && consumerLookupGetter.call(reader, "closed") === consumerNativeClosed);
    } catch (reason) { const failure = this.failure(this.reader ? "closed" : "acquire", reason); reason = undefined; throw failure; }
  }
  read(): Promise<void> {
    this.clearOutput();
    if (this.output || this.driverCapturing) { this.uncertain(); throw this.driverProtocolFailure(); }
    this.captured = undefined; return this.startDriverRead();
  }
  beginPull(): void { this.beginDriverPull(); }
  ownPull(original: Promise<void>): Promise<void> { return this.ownDriverPull(original); }
  stop(cancel: boolean, reason?: unknown): void {
    // A substituted downstream operand cannot discharge an offered snapshot.
    // Cancellation joins originals but supplies no missing transfer receipt.
    if (this.output && !this.transferred) this.uncertain();
    try { void this.stopUsageDriver(cancel, reason); } finally { reason = undefined; }
  }
  emit(controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array): void {
    if (this.output) { this.uncertain(); throw this.driverProtocolFailure(); }
    this.output = bytes; this.transferred = false;
    offerOwnedHttpGenericUsageOutput(this.#cap, this, bytes);
    try { enqueueOwnedBytes(controller, bytes); }
    catch (reason) { this.uncertain(); throw reason; }
    finally { bytes = undefined as never; }
  }
  acknowledge(bytes: Uint8Array): void {
    if (this.output !== bytes || this.driverDone) throw this.driverProtocolFailure();
    this.transferred = true; this.clearOutput();
  }
  private clearOutput(): void {
    if (!this.output || !this.transferred || this.driverCapturing || this.pulling || this.driverFlags & 32) return;
    clearOwnedHttpGenericUsageOutput(this.#cap, this, this.output); this.output = undefined; this.transferred = false;
  }
  protected driverPullRetired(): void { this.clearOutput(); }
  protected driverCleared(): void { this.output = undefined; }
  protected driverRetired(): void { finishOwnedHttpGenericUsageReader(this.#cap, this); }
  clearUsage(): void { this.usage?.clear(); this.usage = undefined; }
}
export function observeOwnedGenericUsage(cap: OwnedHttpUsage, response: Response, operation: HttpOperation,
  validated?: ValidatedNativeUsage, context?: Readonly<UsageTokenContext>): Response {
  checkOwnedHttpGenericUsage(cap, response, operation, validated, context);
  const signal = operation.signal;
  const reader = GenericUsageReader.create(cap, response, operation, validated, context);
  try {
    const usage = new OwnedGenericChatUsage(reader, operation, signal, validated, context); reader.usage = usage;
    // Preserve the ordinary bodyless early return and actual body/header points.
    if (!response.body) { usage.bodyless(response); return response; }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    usage.prepare(contentType, response.ok && operation.receivedRejection);
    reader.open(response.body!);
    return usage.publish(response);
  } catch (reason) {
    if (reader.usage) reader.usage.failPublication(reason); else reader.stop(true, reason);
    throw reason;
  } finally { response = undefined as never; }
}
export function ownedGenericUsageRetirement(cap: OwnedHttpUsage): Promise<void> {
  return ownedHttpGenericUsageRetirement(cap);
}
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
export function matchesOwnedCodecUsagePublication(cap: OwnedCodecConsumer, reader: CodecReader, source: Response,
  body: ReadableStream<Uint8Array>, operation: HttpOperation): boolean {
  const owner = codecConsumers?.get(cap);
  return !!owner && (owner.phase === "usage" || owner.phase === "sealed") && !owner.done && owner.current === source
    && (owner.reader === reader || owner.replacement === reader) && reader.owner === owner
    && owner.usageOwner?.matchesPublication(body, operation) === true;
}
export function matchesOwnedCodecUsage(cap: OwnedCodecConsumer, response: Response, usage: ObservedUsage): boolean {
  const owner = codecConsumers?.get(cap);
  return !!owner && (owner.phase === "usage" || owner.phase === "sealed")
    && owner.current === response && owner.delivering === usage;
}
export function checkOwnedAcceptedUsageReceiver(cap: OwnedCodecConsumer, response: Response, mode: "sse" | "json" | "none",
  context: Readonly<UsageTokenContext> | undefined, provisional: boolean): void {
  const owner = codecConsumers?.get(cap);
  if (!owner || owner.phase !== "usage" || !owner.usageOwner?.matchesReceiver(response, mode, context, provisional))
    throw identityFailure("protocol");
}
export function matchesOwnedAcceptedUsageSnapshot(cap: OwnedCodecConsumer, epoch: number, bytes: Uint8Array): boolean {
  const owner = codecConsumers?.get(cap);
  return !!owner && owner.phase === "usage" && owner.usageOwner?.matchesSnapshot(epoch, bytes) === true;
}
export function revokeOwnedUsageRejection(cap: OwnedCodecConsumer): void {
  const owner = codecConsumers?.get(cap);
  if (!owner?.usageOwner || owner.phase !== "usage") throw identityFailure("protocol");
  owner.usageOwner.revokeRejection();
}
export function checkOwnedUsageRetirement(cap: OwnedCodecConsumer): void {
  const owner = codecConsumers?.get(cap);
  if (!owner?.done || !owner.usageOwner) throw identityFailure("protocol");
}
export function checkOwnedAcceptedUsageTerminal(cap: OwnedCodecConsumer, ended: boolean): void {
  const owner = codecConsumers?.get(cap);
  if (!owner?.usageOwner?.matchesTerminal(ended)) throw identityFailure("protocol");
}
export function ownedUsageCaptureBytes(cap: OwnedCodecConsumer): number | null {
  const owner = codecConsumers?.get(cap);
  if (!owner?.usageOwner || owner.replacement) return null;
  return owner.usageOwner.captureBytes();
}
// Only the genuine Unified Chat consumer reaches this orchestration. The SSE
// inspector and JSON usage algorithms are exactly the ordinary implementations.
function observeOwnedChatUsage(owner: CodecConsumer, response: Response, operation: HttpOperation,
  validated?: ValidatedNativeUsage, usageContext?: Readonly<UsageTokenContext>): Response {
  fundOwnedHttpAcceptedUsage(owner.codec, 65536);
  const state = new OwnedChatUsage(owner, usageConsumerReader(owner, response), operation, validated, usageContext);
  return state.publish(response);
}

// Inspect only a bounded error prefix and replay it through the original reader.
// Oversized, fragmented or malformed errors retain their original wire response.
export async function inspectJsonError(response: Response, operation: HttpOperation): Promise<{ response: Response; body?: string }> {
  if (!response.body) return { response };
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let bytes = 0, body = "", done = false;
  try {
    for (let reads = 0; reads < 128; reads++) {
      const next = await operation.wait(reader.read());
      done = next.done;
      if (done) return { response: replayResponse(response, reader, chunks, true), body: body + decoder.decode() };
      chunks.push(next.value);
      bytes += next.value.byteLength;
      if (bytes > 64 * 1024) break;
      body += decoder.decode(next.value, { stream: true });
    }
  } catch {
    if (operation.signal.aborted) {
      void reader.cancel(operation.signal.reason).catch(() => undefined); reader.releaseLock();
      operation.signal.throwIfAborted();
    }
  }
  return { response: replayResponse(response, reader, chunks, done) };
}

interface OwnedHttpNormalizer {
  receipt: OwnedHttpNormalization; response: Response; operation: HttpOperation; normalizationUnits: number;
  reader?: OwnedNormalizerReader;
}
type OwnedNormalizer = CodecConsumer | OwnedHttpNormalizer;
function fundNormalizer(owner: OwnedNormalizer, bytes: number): void {
  if ("receipt" in owner) fundOwnedHttpNormalization(owner.receipt, bytes);
  else fundOwnedHttpCodecNormalization(owner.codec, bytes);
}

// The three roles share ORIGINAL operation custody, never their EOF projection.
// This private reader has no identity/codec authority and no result graph API.
export class OwnedNormalizerReader extends OwnedReaderDriver {
  #cap: OwnedHttpNormalization;
  private mode: "limited" | "sniff" | "replay";
  limitedBytes = 0;
  limitedExceeded = false;
  prefixWire?: Uint8Array;
  prefixUsed = 0;
  sniffWire?: Uint8Array;
  unlockFailure?: object;
  private output?: Uint8Array;
  private outputTransferred = false;
  private constructor(cap: OwnedHttpNormalization, mode: "limited" | "sniff") { super(); this.#cap = cap; this.mode = mode; }
  static limited(cap: OwnedHttpNormalization): OwnedNormalizerReader { checkOwnedHttpNormalizationReaderCreation(cap); return new OwnedNormalizerReader(cap, "limited"); }
  static sniff(cap: OwnedHttpNormalization): OwnedNormalizerReader { checkOwnedHttpNormalizationReaderCreation(cap); return new OwnedNormalizerReader(cap, "sniff"); }
  static owns(cap: OwnedHttpNormalization, reader: unknown): reader is OwnedNormalizerReader {
    return reader !== null && typeof reader === "object" && #cap in reader && reader.#cap === cap;
  }
  protected holdDriver(): void { holdOwnedHttpNormalization(this.#cap); }
  protected driverProtocolFailure(): Error { return new Error("private normalization read failed"); }
  protected recordDriverFailure(kind: "read" | "closed" | "cancel" | "unlock" | "pull" | "retire", reason: unknown): object {
    return ownedHttpNormalizationFailure(this.#cap, this, kind, reason);
  }
  protected captureDriverFailure(reason: unknown): object {
    return isIdentityFailure(reason) ? reason : this.recordDriverFailure("read", reason);
  }
  protected propagatedDriverFailure(_reason: unknown): boolean { return false; }
  protected driverCleanupFailure(kind: "closed" | "cancel" | "unlock", failure: object): void {
    if (kind === "unlock") this.unlockFailure = failure;
  }
  protected driverPullFailure(_failure: object): void { this.uncertain(); }
  protected captureDriverValue(part: ReadableStreamReadResult<Uint8Array>): void {
    this.readDone = !!part.done;
    let bytes = part.value;
    if (this.readDone && this.mode !== "sniff") { bytes = undefined; this.captured = undefined; return; }
    if (this.mode === "sniff" && !bytes) { this.captured = undefined; return; }
    let proof: ReturnType<typeof inspectOwnedBytes>;
    try {
      proof = inspectOwnedBytes(bytes);
    } catch { throw this.driverProtocolFailure(); }
    if (this.mode === "limited" && proof.length > 65536 - this.limitedBytes) {
      this.limitedExceeded = true; bytes = undefined; this.captured = undefined; return;
    }
    if (this.mode === "sniff" && !proof.length) { bytes = undefined; this.captured = undefined; return; }
    fundOwnedHttpNormalizationCapture(this.#cap, this, 8192 + proof.backing + proof.length
      + (this.prefixWire ? ownedByteBackingBytes(this.prefixWire) : 0)
      + (this.sniffWire ? ownedByteBackingBytes(this.sniffWire) : 0)
      + (this.output ? ownedByteBackingBytes(this.output) : 0));
    const copy = newOwnedBytes(proof.length); copyOwnedBytes(copy, bytes!); bytes = undefined;
    this.captured = copy;
    if (this.mode === "limited") this.limitedBytes += proof.length;
  }
  open(): void {
    this.reader = this.body!.getReader();
    const reader = this.reader;
    this.observeDriverClosed(Object.getPrototypeOf(reader) === ReadableStreamDefaultReader.prototype && !Object.hasOwn(reader, "closed")
      && typeof consumerLookupGetter === "function" && consumerLookupGetter.call(reader, "closed") === consumerNativeClosed);
  }
  prepareSniff(): void {
    fundOwnedHttpNormalizationCapture(this.#cap, this, 8192 + 2 * FIRST_SSE_EVENT_LIMIT);
    this.prefixWire = newOwnedBytes(FIRST_SSE_EVENT_LIMIT); this.sniffWire = newOwnedBytes(FIRST_SSE_EVENT_LIMIT);
  }
  read(): Promise<void> {
    this.clearOutput();
    if (this.output || this.driverCapturing) throw this.driverProtocolFailure();
    this.captured = undefined;
    return this.startDriverRead();
  }
  coalesce(): void {
    if (!this.captured) return;
    copyOwnedBytes(this.prefixWire!, this.captured, this.prefixUsed);
    this.prefixUsed += ownedByteLength(this.captured); this.captured = undefined;
  }
  replay(): ReadableStream<Uint8Array> {
    if (this.mode !== "sniff" || this.driverCapturing || this.driverFlags & 1) throw this.driverProtocolFailure();
    this.mode = "replay"; this.sniffWire = undefined;
    return new ReadableStream<Uint8Array>({ pull: this.pull.bind(this), cancel: this.cancel.bind(this) }, { highWaterMark: 0 });
  }
  cancelForOperation(operation: HttpOperation): void {
    if (this.output && !this.outputTransferred) this.uncertain();
    void this.stopNormalizerOperationDriver(operation);
  }
  cancel(reason: unknown): void {
    if (this.output && !this.outputTransferred) this.uncertain();
    try { if (!this.driverDone) void this.stopNormalizerDriver(reason); }
    finally { reason = undefined; }
  }
  private emit(controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array): void {
    this.output = bytes; this.outputTransferred = false;
    publishOwnedHttpNormalizationOutput(this.#cap, this, bytes);
    try { enqueueOwnedBytes(controller, bytes); }
    catch (reason) { this.uncertain(); throw reason; }
    finally { bytes = undefined as never; }
  }
  pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> | void {
    if (this.driverDone) return;
    this.beginDriverPull();
    this.clearOutput();
    return this.ownDriverPull(this.next(controller));
  }
  private async next(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    try {
      if (this.driverFlags & 1) return;
      if (this.output) { this.uncertain(); throw this.driverProtocolFailure(); }
      if (this.prefixUsed) {
        this.emit(controller, ownedByteSubarray(this.prefixWire!, 0, this.prefixUsed));
        this.prefixUsed = 0; this.prefixWire = undefined; return;
      }
      if (this.captured) { this.emit(controller, this.captured); this.captured = undefined; return; }
      if (!this.readDone) await this.read();
      if (this.driverFlags & 1) return;
      if (this.readDone) {
        void this.finishNormalizerDriver(); if (this.unlockFailure) throw this.unlockFailure;
        controller.close();
      } else { this.emit(controller, this.captured!); this.captured = undefined; }
    } catch (reason) {
      const failure = isIdentityFailure(reason) ? reason : this.recordDriverFailure("pull", reason); reason = undefined;
      void this.finishNormalizerDriver(); controller.error(failure);
    } finally { controller = undefined as never; }
  }
  acknowledge(cap: OwnedHttpNormalization, bytes: Uint8Array): void {
    if (this.#cap !== cap || this.output !== bytes || this.driverDone) throw this.driverProtocolFailure();
    this.outputTransferred = true; this.clearOutput();
  }
  private clearOutput(): void {
    if (!this.output || !this.outputTransferred || this.pulling || this.driverCapturing || this.driverFlags & 32) return;
    clearOwnedHttpNormalizationOutput(this.#cap, this, this.output);
    this.output = undefined; this.outputTransferred = false;
  }
  protected driverPullRetired(): void { this.clearOutput(); }
  protected driverCleared(): void {
    this.prefixWire = undefined; this.sniffWire = undefined; this.output = undefined; this.unlockFailure = undefined;
  }
  protected driverRetired(): void { finishOwnedHttpNormalizationReader(this.#cap, this); }
}
export function ownsOwnedNormalizerReader(cap: OwnedHttpNormalization, reader: unknown): reader is OwnedNormalizerReader {
  return OwnedNormalizerReader.owns(cap, reader);
}
export function acknowledgeOwnedNormalizerOutput(cap: OwnedHttpNormalization, reader: OwnedNormalizerReader, bytes: Uint8Array): void {
  if (!OwnedNormalizerReader.owns(cap, reader)) throw identityFailure("protocol");
  reader.acknowledge(cap, bytes);
}
function acquireNormalizer(owner: OwnedHttpNormalizer, response: Response, kind: "limited" | "sniff"): OwnedNormalizerReader {
  if (owner.response !== response || owner.reader) throw identityFailure("protocol");
  const body = response.body!;
  const reader = kind === "limited" ? OwnedNormalizerReader.limited(owner.receipt) : OwnedNormalizerReader.sniff(owner.receipt);
  reader.body = body; owner.reader = reader;
  ownOwnedHttpNormalizationReader(owner.receipt, reader, body);
  try { reader.open(); return reader; }
  catch (reason) {
    const failure = ownedHttpNormalizationFailure(owner.receipt, reader, reader.reader ? "closed" : "acquire", reason); reason = undefined;
    reader.cancelForOperation(owner.operation); throw failure;
  }
}
export async function normalizeOwnedHttpPreStreamError(http: OwnedHttpRequest, attempt: OwnedHttpUpload, response: Response,
  streamingRequested: boolean, operation: HttpOperation, native?: NativeErrorContext): Promise<Response> {
  const receipt = beginOwnedHttpNormalization(http, attempt, response, operation);
  const owner: OwnedHttpNormalizer = { receipt, response, operation, normalizationUnits: 0 };
  try { return await normalizePreStreamErrorWithOwner(response, streamingRequested, operation, native, undefined, owner); }
  catch (reason) { owner.reader?.cancelForOperation(operation); throw reason; }
  finally {
    endOwnedHttpNormalization(receipt);
    owner.response = undefined as never; owner.operation = undefined as never; owner.reader = undefined; response = undefined as never;
  }
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
async function normalizePreStreamErrorWithOwner(response: Response, streamingRequested: boolean, operation: HttpOperation, native?: NativeErrorContext, consumer?: CodecConsumer, normalization?: OwnedHttpNormalizer): Promise<Response> {
  const normalizer = consumer ?? normalization;
  if (!streamingRequested) return response;
  const eventStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
  if (response.status >= 400) {
    try {
      if (eventStream && (consumer || response.body)) return await normalizeFirstSseEvent(response, response.status, operation, native, consumer, normalization);
      const body = await readLimited(response, 64 * 1024, operation, consumer, normalization);
      // Valid native JSON errors are already the wire contract: preserve even
      // whitespace and extension fields instead of rebuilding their envelope.
      if (native && nativeJsonError(body, native, normalizer)) return normalizer ? preserveOwnedNativeError(normalizer, response, body) : new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      return mappedUpstreamError(response, upstreamError(body, normalizer), response.status, native, normalizer);
    } catch (error) {
      if (normalizer && isIdentityFailure(error)) throw error;
      // Failure to read error details cannot replace an accepted HTTP status.
      // The operation still owns cancellation and the accounting cause.
      return mappedUpstreamError(response, {}, response.status, native, normalizer);
    }
  }
  if (!response.ok || !eventStream || !consumer && !response.body) return response;
  return normalizeFirstSseEvent(response, null, operation, native, consumer, normalization);
}

const FIRST_SSE_EVENT_LIMIT = 8 * 1024;

async function normalizeFirstSseEvent(response: Response, errorStatus: number | null, operation: HttpOperation, native?: NativeErrorContext, consumer?: CodecConsumer, normalization?: OwnedHttpNormalizer): Promise<Response> {
  const normalizer = consumer ?? normalization;
  const ownedReader = consumer ? acquireConsumerReader(consumer, response) : undefined;
  const httpReader = normalization ? acquireNormalizer(normalization, response, "sniff") : undefined;
  const reader = ownedReader || httpReader ? undefined : response.body!.getReader();
  const chunks: Uint8Array[] | undefined = ownedReader || httpReader ? undefined : [];
  if (ownedReader) {
    fundOwnedHttpCodecConsumerCapture(ownedReader.owner.codec, 4 * FIRST_SSE_EVENT_LIMIT);
    ownedReader.prefixWire = newOwnedBytes(FIRST_SSE_EVENT_LIMIT); ownedReader.prefixUsed = 0; ownedReader.prefixRead = 0;
  }
  if (httpReader) {
    try { httpReader.prepareSniff(); }
    catch (reason) { httpReader.cancelForOperation(operation); throw reason; }
  }
  let sniffed = httpReader ? httpReader.sniffWire! : ownedReader ? newOwnedBytes(FIRST_SSE_EVENT_LIMIT) : new Uint8Array(FIRST_SSE_EVENT_LIMIT);
  let sniffedLength = 0;
  let eventStart = 0;
  let transferred = false;
  let hasPrimary = false, primary: unknown;
  try {
    while (true) {
      // Missing details on a known rejection must leave its fallback body readable.
      // A failed HTTP 200 sniff still owns the failure before reader cleanup.
      let done: boolean, value: Uint8Array | undefined;
      if (ownedReader) {
        await operation.wait(readConsumer(ownedReader), errorStatus === null ? "upstream" : undefined);
        done = ownedReader.readDone; value = ownedReader.captured;
      } else if (httpReader) {
        await operation.wait(httpReader.read(), errorStatus === null ? "upstream" : undefined);
        done = httpReader.readDone; value = httpReader.captured;
      } else ({ done, value } = await operation.wait(reader!.read(), errorStatus === null ? "upstream" : undefined));
      if (value && (ownedReader || httpReader ? ownedByteLength(value) : value.byteLength)) {
        if (chunks) chunks.push(value);
        else if (ownedReader) ownedReader.crossingWire = value;
        const copyLength = Math.min(ownedReader || httpReader ? ownedByteLength(value) : value.byteLength, FIRST_SSE_EVENT_LIMIT - sniffedLength);
        if (copyLength > 0) {
          if (ownedReader || httpReader) copyOwnedBytes(sniffed, ownedByteSubarray(value, 0, copyLength), sniffedLength);
          else sniffed.set(value.subarray(0, copyLength), sniffedLength);
          sniffedLength += copyLength;
        }
      }
      while (eventStart < sniffedLength) {
        const boundary = sseEventBoundary(sniffed, eventStart, sniffedLength);
        if (!boundary) break;
        if (normalization) fundNormalizer(normalization, 8192 + 8 * (boundary.start - eventStart));
        const event = ownedReader ? classifySseText(decodeOwnedBytes(newOwnedDecoder(), ownedByteSubarray(sniffed, eventStart, boundary.start)), normalizer)
          : normalizer ? classifySseText(decodeOwnedBytes(newOwnedDecoder(), ownedByteSubarray(sniffed, eventStart, boundary.start)), normalizer)
          : classifySseEvent(sniffed.subarray(eventStart, boundary.start));
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
          if (errorStatus !== null || !native) return mappedUpstreamError(response, upstream, status, native, normalizer);
        }
        if (httpReader) {
          const output = replayNormalizerResponse(normalization!, response, httpReader); transferred = true; return output;
        }
        transferred = true;
        return ownedReader ? transferSniffReader(response, ownedReader, done) : replayResponse(response, reader!, chunks!, done);
      }
      if (done || sniffedLength === FIRST_SSE_EVENT_LIMIT) {
        if (errorStatus === null) {
          if (httpReader) { const output = replayNormalizerResponse(normalization!, response, httpReader); transferred = true; return output; }
          transferred = true; return ownedReader ? transferSniffReader(response, ownedReader, done) : replayResponse(response, reader!, chunks!, done);
        }
        return mappedUpstreamError(response, {}, errorStatus, native, normalizer);
      }
      if (httpReader) httpReader.coalesce();
      if (ownedReader?.crossingWire) {
        // This read contained no complete nonempty event and did not reach the
        // sniff cutoff. Coalescing it cannot advance accepted usage evidence.
        const bytes = ownedReader.crossingWire;
        copyOwnedBytes(ownedReader.prefixWire!, bytes, ownedReader.prefixUsed!);
        ownedReader.prefixUsed! += ownedByteLength(bytes);
        ownedReader.crossingWire = undefined; ownedReader.captured = undefined;
      }
      if (httpReader) value = undefined;
    }
  } catch (error) { if (ownedReader || httpReader) { hasPrimary = true; primary = error; } throw error; }
  finally {
    try {
      if (!transferred) {
        if (ownedReader) {
          void retireConsumerReader(ownedReader, "cancel", true);
          const cleanup = ownedReader.unlockFailure;
          if (cleanup) { if (hasPrimary) throw new AggregateError([primary, cleanup], "owned sniff retirement"); throw cleanup; }
        } else if (httpReader) {
          httpReader.cancelForOperation(operation);
          if (httpReader.unlockFailure) { if (hasPrimary) throw new AggregateError([primary, httpReader.unlockFailure], "owned normalization cleanup"); throw httpReader.unlockFailure; }
        } else { void reader!.cancel(operation.signal.reason).catch(() => undefined); reader!.releaseLock(); }
      }
    } finally { primary = undefined; if (ownedReader || httpReader) sniffed = undefined as never; }
  }
}

function transferSniffReader(response: Response, state: CodecReader, done: boolean): Response {
  if (state.owner.phase !== "normalizing" || state.owner.current !== response || !state.prefixWire || (state.flags & 1))
    throw identityFailure("protocol");
  state.prefixRead = 0; state.crossingRead = 0; state.flags |= 32 | (done ? 64 : 0);
  // This locked response stays invocation-local. The fixed usage command must
  // consume this SAME reader; it cannot be returned to a public caller.
  return response;
}
function usageConsumerReader(owner: CodecConsumer, response: Response): CodecReader {
  const sniff = owner.reader;
  if (sniff?.prefixWire && !(sniff.flags & 1)) {
    if (owner.current !== response || !(sniff.flags & 32) || sniff.prefixRead !== 0) throw identityFailure("protocol");
    return sniff;
  }
  // JSON and mapped replacements acquire their own actual body. Any abandoned
  // codec reader remains separately joined; replacement is never its receipt.
  return acquireConsumerReader(owner, response);
}
function replayNormalizerResponse(owner: OwnedHttpNormalizer, response: Response, reader: OwnedNormalizerReader): Response {
  const body = reader.replay();
  const status = response.status, statusText = response.statusText, headers = response.headers;
  if (typeof status !== "number" || typeof statusText !== "string") throw identityFailure("protocol");
  const measured = measureOwnedHeaders(headers);
  fundNormalizer(owner, 8192 + 128 * owner.normalizationUnits + 3 * measured + 6 * statusText.length);
  if (measureOwnedHeaders(headers) > measured) throw identityFailure("protocol");
  const output = newOwnedResponse(body, status, statusText, headers);
  bindOwnedHttpNormalizationReplay(owner.receipt, reader, output); return output;
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
  return classifySseText(new TextDecoder().decode(bytes));
}
function classifySseText(text: string, consumer?: OwnedNormalizer): { kind: "empty" } | { kind: "healthy" | "error"; upstream: ReturnType<typeof upstreamError> } {
  if (consumer) admitOwnedNormalizerText(consumer, text);
  let eventType = "";
  const dataLines: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
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
  const upstream = upstreamError(data, consumer);
  return eventType === "error" || hasTopLevelError(data, consumer) ? { kind: "error", upstream } : { kind: "healthy", upstream };
}

function hasTopLevelError(data: string, consumer?: OwnedNormalizer): boolean {
  if (consumer) admitOwnedNormalizerText(consumer, data);
  try {
    const value: unknown = consumer ? ownedNormalizerParse(data) : JSON.parse(data);
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "error");
  } catch { return false; }
}

function mappedUpstreamError(response: Response, upstream: NativeErrorDetails, status: number, native?: NativeErrorContext, consumer?: OwnedNormalizer): Response {
  if (consumer) return mappedOwnedUpstreamError(consumer, response, upstream, status, native);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  const message = upstream.message ?? (response.ok ? "upstream request failed" : response.statusText || "upstream request failed");
  const body = native ? nativeErrorEnvelope(native, status, {
    ...upstream, message, requestId: upstream.requestId === undefined ? headers.get("request-id") ?? native.requestId : upstream.requestId,
  }) : { error: { message, type: upstream.type ?? "upstream_error", code: upstream.code ?? status } };
  return Response.json(body, { status, statusText: status === response.status ? response.statusText : "", headers });
}

const ownedNormalizerParse = JSON.parse;
function admitOwnedNormalizerText(consumer: OwnedNormalizer, text: string): void {
  if (!("receipt" in consumer) && consumer.phase !== "normalizing") throw identityFailure("protocol");
  const units = Math.max(consumer.normalizationUnits ?? 0, text.length);
  // Two simultaneous parsed graphs (classification plus projected param),
  // decoded/SSE text occurrences and line/member cells. No depth/node cap is
  // imposed on this existing bounded source. The complete inventory separates
  // fixed execution from these representation/workspace products.
  fundNormalizer(consumer, 8192 + 128 * units);
  consumer.normalizationUnits = units;
}
function preserveOwnedNativeError(consumer: OwnedNormalizer, response: Response, body: string): Response {
  const status = response.status, statusText = response.statusText, headers = response.headers;
  if (typeof statusText !== "string") throw identityFailure("protocol");
  const measured = measureOwnedHeaders(headers);
  fundNormalizer(consumer, 8192 + 128 * (consumer.normalizationUnits ?? 0)
    + 3 * measured + 6 * statusText.length + 8 * body.length);
  if (measureOwnedHeaders(headers) > measured) throw identityFailure("protocol");
  return newOwnedResponse(body, status, statusText, headers);
}
function mappedOwnedUpstreamError(consumer: OwnedNormalizer, response: Response, upstream: NativeErrorDetails,
  status: number, native?: NativeErrorContext): Response {
  if (!("receipt" in consumer) && consumer.phase !== "normalizing") throw identityFailure("protocol");
  const source = response.headers, measured = measureOwnedHeaders(source), sourceUnits = consumer.normalizationUnits ?? 0;
  fundNormalizer(consumer, 16384 + 128 * sourceUnits + 3 * measured);
  if (measureOwnedHeaders(source) > measured) throw identityFailure("protocol");
  const headers = newOwnedHeaders(source);
  deleteOwnedHeader(headers, "content-length"); setOwnedHeader(headers, "content-type", "application/json; charset=utf-8");
  const message = upstream.message ?? (response.ok ? "upstream request failed" : response.statusText || "upstream request failed");
  const requestId = native ? upstream.requestId === undefined ? getOwnedHeader(headers, "request-id") ?? native.requestId : upstream.requestId : undefined;
  const statusText = status === response.status ? response.statusText : "";
  if (typeof message !== "string" || typeof statusText !== "string") throw identityFailure("protocol");
  // JSON number normalization takes at most32 units per source token; quoted
  // lexemes do not expand. The external fallback/header strings are additional
  // occurrences, each with the six-unit escape bound, before envelope creation.
  const external = message.length + (upstream.type?.length ?? 0) + (typeof upstream.code === "string" ? upstream.code.length : 0)
    + (requestId?.length ?? 0), serialized = 32 * sourceUnits + 6 * external + 512;
  const finalHeaders = measureOwnedHeaders(headers);
  fundNormalizer(consumer, 16384 + 128 * sourceUnits + 3 * measured + 3 * finalHeaders
    + 6 * statusText.length + 8 * external + 14 * serialized);
  const body = native ? nativeErrorEnvelope(native, status, { ...upstream, message, requestId })
    : { error: { message, type: upstream.type ?? "upstream_error", code: upstream.code ?? status } };
  const text = privateMappedErrorJson(body);
  if (measureOwnedHeaders(headers) > finalHeaders) throw identityFailure("protocol");
  return newOwnedResponse(text, status, statusText, headers);
}

function nativeJsonError(body: string, native: NativeErrorContext, consumer?: OwnedNormalizer): boolean {
  if (consumer) admitOwnedNormalizerText(consumer, body);
  try {
    const value = consumer ? ownedNormalizerParse(body) : JSON.parse(body), error = value?.error;
    if (!error || typeof error.message !== "string" || typeof error.type !== "string") return false;
    return native.format === "anthropic" ? value.type === "error" && (typeof value.request_id === "string" || value.request_id === null) : Object.hasOwn(error, "param") && Object.hasOwn(error, "code");
  } catch { return false; }
}

function upstreamError(body: string, consumer?: OwnedNormalizer): NativeErrorDetails {
  if (consumer) admitOwnedNormalizerText(consumer, body);
  let value: unknown;
  try {
    const eventData = firstSseData(body);
    value = consumer ? ownedNormalizerParse(eventData || body) : JSON.parse(eventData || body);
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

async function readLimited(response: Response, limit: number, operation: HttpOperation, consumer?: CodecConsumer, normalization?: OwnedHttpNormalizer): Promise<string> {
  if (!consumer && !response.body) return "";
  const ownedReader = consumer ? acquireConsumerReader(consumer, response) : undefined;
  const httpReader = normalization ? acquireNormalizer(normalization, response, "limited") : undefined;
  const reader = ownedReader || httpReader ? undefined : response.body!.getReader();
  let decoder: TextDecoder;
  if (httpReader) {
    try { decoder = newOwnedDecoder(); }
    catch (reason) { httpReader.cancelForOperation(operation); throw reason; }
  } else decoder = ownedReader ? newOwnedDecoder() : new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      let done: boolean, value: Uint8Array | undefined;
      if (ownedReader) { await operation.wait(readConsumer(ownedReader)); done = ownedReader.readDone; value = ownedReader.captured; }
      else if (httpReader) { await operation.wait(httpReader.read()); done = httpReader.readDone; value = httpReader.captured; }
      else ({ done, value } = await operation.wait(reader!.read()));
      if (done) break;
      if (httpReader?.limitedExceeded) return "";
      size += ownedReader || httpReader ? ownedByteLength(value!) : value!.byteLength;
      if (size > limit) return "";
      if (normalization) fundNormalizer(normalization, 8192 + 8 * size);
      text += ownedReader || httpReader ? decodeOwnedBytes(decoder, value, true) : decoder.decode(value, { stream: true });
      if (httpReader) value = undefined;
    }
    return text + (ownedReader || httpReader ? decodeOwnedBytes(decoder) : decoder.decode());
  } finally {
    if (ownedReader) { void retireConsumerReader(ownedReader, "cancel", true); if (ownedReader.unlockFailure) throw ownedReader.unlockFailure; }
    else if (httpReader) { httpReader.cancelForOperation(operation); if (httpReader.unlockFailure) throw httpReader.unlockFailure; }
    else { void reader!.cancel(operation.signal.reason).catch(() => undefined); reader!.releaseLock(); }
  }
}

type OwnedUsageMode = "sse" | "json" | "none";
const ownedUsageMetadata = 65536;
let ownedAcceptedUsage: WeakMap<OwnedHttpRevalidation | OwnedHttpUsage, OwnedAcceptedUsage<CodecReader | GenericUsageReader>> | undefined;


function trimCode(code: number): boolean {
  return code >= 9 && code <= 13 || code === 32 || code === 160 || code === 5760
    || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}

export class OwnedAcceptedUsage<T extends CodecReader | GenericUsageReader = CodecReader> {
  frames?: ReturnType<typeof createSseFrames>;
  accumulator?: ReturnType<typeof createSseUsageAccumulator>;
  consumeFrame?: (frame: string | null) => void;
  decoder?: TextDecoder;
  text = "";
  bytes = 0;
  epoch = -1;
  flags = 0; // finished=1, complete frame decode=2, event:error=4, JSON overflow=8.
  bufferBytes = 0;
  temporaryBytes = 0;
  frame?: string | null;
  result?: UsageInspection;
  declare protected state: T;
  declare protected mode: OwnedUsageMode;
  declare protected context: Readonly<UsageTokenContext> | undefined;
  declare protected provisional: boolean;
  constructor(state: T, mode: OwnedUsageMode,
    context: Readonly<UsageTokenContext> | undefined, provisional: boolean) {
    this.state = state; this.mode = mode; this.context = context; this.provisional = provisional;
  }
  private get cap(): OwnedHttpRevalidation | OwnedHttpUsage {
    return this.state instanceof GenericUsageReader ? this.state.usageCap : (this.state as CodecReader).owner.codec;
  }
  initialize(): void {
    if (ownedAcceptedUsage?.has(this.cap)) throw identityFailure("protocol");
    (ownedAcceptedUsage ??= new WeakMap()).set(this.cap, this);
    this.epoch = 0;
    if (this.flags & 16) throw identityFailure("protocol");
    this.flags |= 16;
    if (this.mode === "sse") {
      this.accumulator = createSseUsageAccumulator(this.provisional ? this.revoke.bind(this) : undefined, this.context);
      (OwnedUsageRegistrations.privateUsageAccumulators ??= new WeakSet()).add(this.accumulator.accept);
      this.consumeFrame = this.consume.bind(this);
      (OwnedUsageRegistrations.ownedFrameConsumers ??= new WeakMap()).set(this.consumeFrame, this);
      this.frames = createSseFrames(this.consumeFrame);
    } else if (this.mode === "json") this.decoder = newOwnedDecoder();
  }
  reserve(temporary: number): void {
    if (!Number.isSafeInteger(temporary) || temporary < 0) throw identityFailure("protocol");
    const bytes = ownedUsageMetadata + this.bufferBytes + 2 * this.text.length + temporary;
    if (this.state instanceof GenericUsageReader) fundOwnedHttpGenericUsage(this.state.usageCap, this.state, bytes);
    else fundOwnedHttpAcceptedUsage((this.state as CodecReader).owner.codec, bytes);
    this.temporaryBytes = temporary;
  }
  resize(before: number, after: number): void {
    // Old and replacement are both live until the actual buffer assignment.
    if (before !== this.bufferBytes) throw identityFailure("protocol");
    this.reserve(this.temporaryBytes + after);
  }
  resized(after: number, temporary: number): void {
    this.bufferBytes = after;
    this.reserve(temporary);
  }
  admitJson(data: string, retainedText = false): void {
    // The caller retains this exact text until evidence/extraction has ended.
    // The fixed metadata also backs the finite counter projections, old/new
    // summary and extraction/update/entries/filter/fromEntries intermediates.
    // Retain every already-paid temporary while admitting the receipt factory.
    this.reserve(Math.max(this.temporaryBytes, retainedText ? 0 : 2 * data.length));
    let census: ReturnType<typeof measurePrivateJsonBody> | undefined = measurePrivateJsonBody(data);
    const upper = census.upper; census = undefined;
    this.reserve((retainedText ? 0 : 2 * data.length) + upper);
  }
  private revoke(): void {
    if (this.state instanceof GenericUsageReader) this.state.usage!.revokeRejection();
    else revokeOwnedUsageRejection((this.state as CodecReader).owner.codec);
  }
  private fold(frame: string): string {
    let units = 0, lines = 0;
    this.flags &= ~4;
    for (let start = 0; start <= frame.length;) {
      let end = start; while (end < frame.length && frame.charCodeAt(end) !== 10) end++;
      if (frame.startsWith("data:", start)) {
        let a = start + 5, b = end;
        while (a < b && trimCode(frame.charCodeAt(a))) a++;
        while (b > a && trimCode(frame.charCodeAt(b - 1))) b--;
        units += b - a + (lines++ ? 1 : 0);
      }
      if (frame.startsWith("event:", start)) {
        let a = start + 6, b = end;
        while (a < b && trimCode(frame.charCodeAt(a))) a++;
        while (b > a && trimCode(frame.charCodeAt(b - 1))) b--;
        if (b - a === 5 && frame.startsWith("error", a)) this.flags |= 4;
      }
      if (end === frame.length) break;
      start = end + 1;
    }
    this.reserve(2 * frame.length + 4 * units);
    let data = "", count = 0;
    for (let start = 0; start <= frame.length;) {
      let end = start; while (end < frame.length && frame.charCodeAt(end) !== 10) end++;
      if (frame.startsWith("data:", start)) {
        let a = start + 5, b = end;
        while (a < b && trimCode(frame.charCodeAt(a))) a++;
        while (b > a && trimCode(frame.charCodeAt(b - 1))) b--;
        if (count++) data += "\n";
        data += frame.slice(a, b);
      }
      if (end === frame.length) break;
      start = end + 1;
    }
    frame = "";
    return data;
  }
  stageFrame(frame: string | null): void {
    if (!(this.flags & 2) || this.frame !== undefined) throw identityFailure("protocol");
    this.frame = frame;
  }
  private consume(): void {
    // The framer's decode/staging calls have returned before this command.
    // No caller argument retains the decoded frame during graph construction.
    let frame = this.frame ?? null; this.frame = undefined;
    let data = "", evidence: SseUsageEvidence | null = null;
    try {
      if (frame === null) evidence = { kind: "unavailable" };
      else { data = this.fold(frame); frame = null; evidence = parseSseData(data, !!(this.flags & 4), this); }
      if (evidence) this.accumulator!.accept(evidence);
    } finally {
      frame = null; data = ""; evidence = null;
      this.reserve(0);
    }
  }
  push(epoch: number, bytes: Uint8Array): void {
    if (this.flags & (1 | 64) || epoch !== this.epoch
      || !(this.state instanceof GenericUsageReader ? this.state.usage!.matchesSnapshot(epoch, bytes)
        : matchesOwnedAcceptedUsageSnapshot((this.state as CodecReader).owner.codec, epoch, bytes))) throw identityFailure("protocol");
    this.flags |= 64;
    if (this.frames) {
      try { this.frames.push(bytes); }
      catch (error) { this.flags |= 32; throw error; }
    }
    else if (this.mode === "json" && !(this.flags & 8)) {
      this.bytes += ownedByteLength(bytes);
      if (this.bytes > usageInspectionLimit) { this.flags |= 8; this.text = ""; this.reserve(0); return; }
      this.reserve(2 * this.text.length + 4 * (ownedByteLength(bytes) + 2));
      let chunk = decodeOwnedBytes(this.decoder!, bytes, true);
      this.text += chunk; chunk = ""; this.reserve(0);
    }
  }
  finishInspection(ended: boolean): void {
    if (this.state instanceof GenericUsageReader) {
      if (!this.state.usage!.matchesTerminal(ended)) throw identityFailure("protocol");
    } else checkOwnedAcceptedUsageTerminal((this.state as CodecReader).owner.codec, ended);
    if (this.flags & 1) return;
    let pending: string | null = null, data = "", evidence: SseUsageEvidence | null = null, value: unknown;
    try {
      if (this.flags & 32) {
        // A failed accepted-frame operation is terminal. Do not retry its
        // partial frame during retirement or classify admission as JSON syntax.
        this.result = { tokens: null, outcome: null };
      } else if (this.frames) {
        if (this.provisional) {
          pending = this.frames.pending();
          if (pending === null) evidence = { kind: "unavailable" };
          else { data = this.fold(pending); pending = null; evidence = parseSseData(data, !!(this.flags & 4), this); }
          this.accumulator!.unfinished(evidence);
        }
        this.result = this.accumulator!.result(ended, this.frames.overflowed());
      } else if (this.mode === "json" && ended && !(this.flags & 8)) {
        this.reserve(2 * this.text.length + 8);
        let tail = decodeOwnedBytes(this.decoder!); this.text += tail; tail = "";
        this.admitJson(this.text, true);
        let valid = false;
        try { value = ownedUsageJsonParse(this.text); valid = true; } catch { /* Native syntax failure only. */ }
        this.result = valid ? { tokens: extractUsageTokens(value, this.context), outcome: responseOutcome(value) }
          : { tokens: null, outcome: "provider_error" };
      } else this.result = { tokens: null, outcome: null };
      this.flags |= 1;

    } finally {
      pending = null; data = ""; evidence = null; value = undefined; this.text = "";
      this.reserve(0);
    }
  }
  clearInspection(): void {
    if (this.state instanceof GenericUsageReader) {
      if (!this.state.driverDone) throw identityFailure("protocol");
    } else checkOwnedUsageRetirement((this.state as CodecReader).owner.codec);
    if (this.consumeFrame) OwnedUsageRegistrations.ownedFrameConsumers!.delete(this.consumeFrame);
    if (this.accumulator) OwnedUsageRegistrations.privateUsageAccumulators!.delete(this.accumulator.accept);
    this.frames = undefined; this.accumulator = undefined; this.consumeFrame = undefined;
    this.decoder = undefined; this.text = ""; this.frame = undefined; this.result = undefined;
    ownedAcceptedUsage?.delete(this.cap);
    if (!(this.state instanceof GenericUsageReader)) fundOwnedHttpAcceptedUsage((this.state as CodecReader).owner.codec, 0);
  }
}
export class OwnedChatUsage extends OwnedAcceptedUsage {
  private signal: AbortSignal;
  private snapshot?: Uint8Array;
  private resolve!: () => void;
  private ready: Promise<void>;
  private downstream!: ReadableStreamDefaultController<Uint8Array>;
  private listener: () => void;
  private publishingBody?: ReadableStream<Uint8Array>;
  declare private operation: HttpOperation;
  declare private validated?: ValidatedNativeUsage;
  constructor(owner: CodecConsumer, reader: CodecReader, operation: HttpOperation,
    validated?: ValidatedNativeUsage, usageContext?: Readonly<UsageTokenContext>) {
    super(reader, "none", usageContext, false);
    this.operation = operation; this.validated = validated;
    this.signal = operation.signal;
    this.ready = new Promise<void>(done => { this.resolve = done; });
    this.listener = this.aborted.bind(this);
    owner.usageOwner = this;
  }
  private get finished(): number { return this.flags >>> 8 & 3; }
  private set finished(value: number) { this.flags = this.flags & ~768 | value << 8; }
  publish(response: Response): Response {
    const owner = this.state.owner;
    try {
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      this.mode = contentType.includes("text/event-stream") ? "sse" : contentType.includes("json") ? "json" : "none";
      this.provisional = response.ok && this.operation.receivedRejection;
      checkOwnedAcceptedUsageReceiver(owner.codec, response, this.mode, this.context, this.provisional);
      this.initialize();
      const body = new ReadableStream<Uint8Array>(this, { highWaterMark: 0 });
      this.publishingBody = body;
      if (this.signal.aborted) this.aborted();
      else {
        try { this.signal.addEventListener("abort", this.listener, { once: true }); }
        catch (reason) { throw consumerFailure(this.state, "listenerAdd", reason); }
      }
      const status = response.status, statusText = response.statusText, headers = response.headers;
      const output = createOwnedHttpCodecUsageResponse(owner.codec, this.state, this.operation, response, body, status, statusText, headers);
      owner.current = output;
      owner.usage = this.ready;
      return output;
    } catch (reason) {
      try { this.finish("failed", reason); }
      catch (cleanup) { throw new AggregateError([reason, cleanup], "owned usage publication"); }
      throw reason;
    } finally { response = undefined as never; }
  }
  abandon(): void { if (!this.finished) this.finish("failed"); }
  matchesPublication(body: ReadableStream<Uint8Array>, operation: HttpOperation): boolean {
    return this.publishingBody === body && this.operation === operation;
  }
  revokeRejection(): void { this.operation.revokeRejection(); }
  matchesReceiver(response: Response, mode: "sse" | "json" | "none", context: Readonly<UsageTokenContext> | undefined, provisional: boolean): boolean {
    return !this.finished && this.state.owner.current === response && response.body === this.state.body && mode === this.mode
      && context === this.context && provisional === (response.ok && this.operation.receivedRejection);
  }
  matchesSnapshot(epoch: number, bytes: Uint8Array): boolean {
    return !this.finished && this.epoch === epoch && this.snapshot === bytes;
  }
  matchesTerminal(ended: boolean): boolean { return this.finished === (ended ? 2 : 1) && this.snapshot === undefined; }
  captureBytes(): number | null {
    if (this.state.reading || this.state.driverCapturing || this.state.retirement) return null;
    // One serial highWaterMark:0 usage pull owns the current snapshot. A later
    // pull cannot start before the preceding output handoff has completed.
    // These are actual backing identities, not equality/interning assumptions.
    const prefix = this.state.prefixWire ? inspectOwnedBytes(this.state.prefixWire).buffer : undefined;
    const crossing = this.state.crossingWire ? inspectOwnedBytes(this.state.crossingWire).buffer : undefined;
    const captured = this.state.captured ? inspectOwnedBytes(this.state.captured).buffer : undefined;
    const snapshot = this.snapshot ? inspectOwnedBytes(this.snapshot).buffer : undefined;
    let bytes = prefix ? ownedByteBackingBytes(this.state.prefixWire!) : 0;
    if (crossing && crossing !== prefix) bytes += ownedByteBackingBytes(this.state.crossingWire!);
    if (captured && captured !== prefix && captured !== crossing) bytes += ownedByteBackingBytes(this.state.captured!);
    if (snapshot && snapshot !== prefix && snapshot !== crossing && snapshot !== captured) bytes += ownedByteBackingBytes(this.snapshot!);
    return bytes;
  }
  private forward(): void {
    const owner = this.state.owner, value = owner.delivering!;
    try { forwardOwnedHttpCodecUsage(owner.codec, owner.current, value); }
    finally { owner.delivering = undefined; }
  }
  clear(): void {
    if (!this.state.owner.done) throw identityFailure("protocol");
    // Root retirement already joined the actual consumer and public reader.
    // Empty fields remain fields until this owner itself becomes unreachable.
    this.snapshot = undefined; this.result = undefined; this.publishingBody = undefined;
    this.clearInspection();
    this.validated = undefined; this.context = undefined;
    this.downstream = undefined as never; this.ready = undefined as never; this.resolve = undefined as never;
    this.listener = undefined as never; this.signal = undefined as never;
    this.operation = undefined as never; this.state = undefined as never;
  }
  private finish(delivery: ObservedUsage["delivery"], reason?: unknown): void {
    if (this.finished) return;
    this.finished = 1;
    const owner = this.state.owner;
    let listenerFailure: object | undefined;
    try { this.signal.removeEventListener("abort", this.listener); }
    catch (error) { listenerFailure = consumerFailure(this.state, "listenerRemove", error); holdOwnedHttpVeniceSource(owner.codec); }
    delivery = this.operation.delivery ?? delivery;
    if (delivery === "complete") this.finished = 2;
    let hasInspectionFailure = false, inspectionFailure: unknown;
    try {
      if (this.epoch < 0) this.result = { tokens: null, outcome: null };
      else this.finishInspection(delivery === "complete");
    }
    catch (failure) {
      hasInspectionFailure = true; inspectionFailure = failure; delivery = "failed";
      // A trusted admission failure escapes below. This prepaid terminal
      // record only settles conservative accounting and the cleanup owner.
      this.result = { tokens: null, outcome: null };
    }
    if (delivery === "canceled") this.operation.cancel(reason);
    else this.operation.stop(delivery === "complete" ? "complete" : "upstream", hasInspectionFailure ? inspectionFailure : reason);
    owner.delivering = { ...this.result!, delivery, ...(this.operation.receivedRejection ? { nonbillable: true as const } : {}),
      ...(this.validated?.requestCostReceipt ? { requestCostReceipt: this.validated.requestCostReceipt } : {}) };
    this.forward(); this.resolve();
    // Logical usage is already in the funded request handoff. Publication is
    // its only remaining logical barrier; physical retirement is independent.
    void retireConsumerReader(this.state, delivery === "complete" ? "eof" : "cancel", !!(this.state.flags & 32));
    sealConsumer(owner);
    if (hasInspectionFailure) {
      if (listenerFailure) throw new AggregateError([inspectionFailure, listenerFailure], "owned usage terminal");
      throw inspectionFailure;
    }
    if (listenerFailure) throw listenerFailure;
  }
  private aborted(): void {
    if (this.finished) return;
    let failure: unknown = this.signal.reason;
    try { this.finish("canceled", failure); } catch (error) { failure = error; }
    this.state.owner.outputFailed = true; this.state.owner.outputFailure = failure as object;
    this.downstream.error(failure); failure = undefined;
  }
  start(controller: ReadableStreamDefaultController<Uint8Array>): void { this.downstream = controller; }
  pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    this.state.beginPull();
    return this.state.ownPull(this.next(controller));
  }
  private async next(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    let phase: "read" | "usage" | "finish" = "usage";
    try {
      let bytes: Uint8Array | undefined, done = false;
      if (this.state.prefixWire && !this.state.prefixRead && this.state.prefixUsed) {
        bytes = newOwnedBytes(this.state.prefixUsed); copyOwnedBytes(bytes, ownedByteSubarray(this.state.prefixWire, 0, this.state.prefixUsed));
        this.state.prefixRead = this.state.prefixUsed;
      } else if (this.state.crossingWire && !this.state.crossingRead) {
        this.state.crossingRead = 1; bytes = this.state.crossingWire;
      } else {
        this.state.prefixWire = undefined; this.state.crossingWire = undefined;
        settleOwnedHttpCodecConsumerCapture(this.state.owner.codec);
        phase = "read";
        if (this.state.flags & 64) done = true;
        else { await readConsumer(this.state); done = this.state.readDone; bytes = this.state.captured; }
      }
      if (this.finished) { bytes = undefined; return; }
      phase = "usage";
      if (done) {
        bytes = undefined; this.state.captured = undefined;
        settleOwnedHttpCodecConsumerCapture(this.state.owner.codec);
        phase = "finish"; this.finish("complete"); phase = "usage"; controller.close(); return;
      }
      this.snapshot = bytes!;
      this.epoch = this.epoch === Number.MAX_SAFE_INTEGER ? 1 : this.epoch + 1;
      settleOwnedHttpCodecConsumerCapture(this.state.owner.codec);
      this.flags &= ~64;
      try { this.push(this.epoch, bytes!); }
      finally { this.snapshot = undefined; }
      if (!this.finished) enqueueOwnedBytes(controller, bytes!);
      this.state.captured = undefined; bytes = undefined;
    } catch (error) {
      let failure = phase === "usage" && !isIdentityFailure(error) ? consumerFailure(this.state, "pull", error) : error;
      error = undefined;
      if (!this.finished) {
        try { this.finish("failed", failure); }
        catch (cleanup) { failure = new AggregateError([failure, cleanup], "owned usage cleanup"); }
        this.state.owner.outputFailed = true; this.state.owner.outputFailure = failure as object; controller.error(failure);
      } else if (phase === "finish") {
        this.state.owner.outputFailed = true; this.state.owner.outputFailure = failure as object; controller.error(failure);
      }
    }
  }
  cancel(reason: unknown): void { this.finish("canceled", reason); }
}

export class OwnedGenericChatUsage extends OwnedAcceptedUsage<GenericUsageReader> {
  private snapshot?: Uint8Array;
  private resolve!: () => void;
  readonly ready: Promise<void>;
  private downstream?: ReadableStreamDefaultController<Uint8Array>;
  private listener: () => void;
  private listening = false;
  private delivering?: ObservedUsage;
  declare private operation: HttpOperation;
  declare private signal: AbortSignal;
  declare private validated?: ValidatedNativeUsage;
  constructor(reader: GenericUsageReader, operation: HttpOperation, signal: AbortSignal,
    validated?: ValidatedNativeUsage, context?: Readonly<UsageTokenContext>) {
    GenericUsageReader.checkInspection(reader);
    super(reader, "none", context, false);
    this.operation = operation; this.signal = signal; this.validated = validated;
    this.ready = new Promise<void>(resolve => { this.resolve = resolve; }); this.listener = this.aborted.bind(this);
  }
  get finished(): number { return this.flags >>> 8 & 3; }
  private setFinished(value: number): void { this.flags = this.flags & ~768 | value << 8; }
  prepare(contentType: string, provisional: boolean): void {
    this.mode = contentType.includes("text/event-stream") ? "sse" : !this.validated && contentType.includes("json") ? "json" : "none";
    this.provisional = provisional; this.initialize();
  }
  bodyless(response: Response): void {
    bindOwnedHttpGenericBodylessResponse(this.state.usageCap, this.state, response);
    this.setFinished(2); this.operation.stop("complete");
    this.deliver({ tokens: null, outcome: null, delivery: "complete" }); this.state.stop(false);
  }
  publish(response: Response): Response {
    const body = new ReadableStream<Uint8Array>(this, { highWaterMark: 0 });
    bindOwnedHttpGenericUsageOutput(this.state.usageCap, this.state, body);
    if (this.signal.aborted) this.aborted();
    else {
      try { this.listening = true; this.signal.addEventListener("abort", this.listener, { once: true }); }
      catch (reason) { this.state.hold(); throw this.state.failure("listener-add", reason); }
    }
    const status = response.status, statusText = response.statusText, headers = response.headers;
    return createOwnedHttpGenericUsageResponse(this.state.usageCap, this.state, response, body, status, statusText, headers);
  }
  revokeRejection(): void { this.operation.revokeRejection(); }
  matchesSnapshot(epoch: number, bytes: Uint8Array): boolean { return !this.finished && epoch === this.epoch && this.snapshot === bytes; }
  matchesTerminal(ended: boolean): boolean { return this.finished === (ended ? 2 : 1) && !this.snapshot; }
  matchesDelivery(value: ObservedUsage): boolean { return this.delivering === value; }
  private deliver(value: ObservedUsage): void {
    this.delivering = value;
    try { forwardOwnedHttpGenericUsage(this.state.usageCap, this.state, value); this.resolve(); }
    finally { this.delivering = undefined; value = undefined as never; }
  }
  private finish(delivery: ObservedUsage["delivery"], reason?: unknown): void {
    if (this.finished) return;
    this.setFinished(1);
    let listenerFailure: object | undefined, inspectionFailure: unknown, hasInspectionFailure = false;
    if (this.listening) {
      try { this.signal.removeEventListener("abort", this.listener); this.listening = false; }
      catch (error) { listenerFailure = this.state.failure("listener-remove", error); this.state.hold(); }
    }
    // Generic usage stops/cancels BEFORE terminal inspection. Codec ordering is
    // deliberately separate. A recursive abort observes the finished latch.
    if (delivery === "canceled") this.operation.cancel(reason);
    else this.operation.stop(delivery === "complete" ? "complete" : "upstream", reason);
    delivery = this.operation.delivery ?? delivery;
    if (delivery === "complete") this.setFinished(2);
    try {
      if (this.validated) this.result = this.validated;
      else if (this.epoch < 0) this.result = { tokens: null, outcome: null };
      else this.finishInspection(delivery === "complete");
    } catch (error) {
      hasInspectionFailure = true; inspectionFailure = error; delivery = "failed";
      this.result = { tokens: null, outcome: null };
    }
    try {
      this.deliver({ ...this.result!, delivery, ...(this.operation.receivedRejection ? { nonbillable: true as const } : {}),
        ...(this.validated?.requestCostReceipt ? { requestCostReceipt: this.validated.requestCostReceipt } : {}) });
    } finally { this.state.stop(delivery !== "complete", reason); reason = undefined; }
    if (hasInspectionFailure) throw inspectionFailure;
    if (listenerFailure) throw listenerFailure;
  }
  failPublication(reason: unknown): void {
    try { if (!this.finished) this.finish("failed", reason); }
    finally { reason = undefined; }
  }
  abandon(): void { if (!this.finished) this.finish("failed"); else this.state.stop(true); }
  private aborted(): void {
    if (this.finished) return;
    let reason: unknown = this.signal.reason;
    try { this.finish("canceled", reason); }
    catch (error) { reason = isIdentityFailure(error) ? error : this.state.failure("pull", error); }
    try { this.downstream?.error(reason); } finally { reason = undefined; }
  }
  start(controller: ReadableStreamDefaultController<Uint8Array>): void { this.downstream = controller; }
  pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    this.state.beginPull(); return this.state.ownPull(this.next(controller));
  }
  private async next(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    let bytes: Uint8Array | undefined, phase: "read" | "usage" | "finish" = "read";
    try {
      await this.state.read();
      if (this.finished) { this.state.captured = undefined; return; }
      if (this.state.readDone) { this.state.captured = undefined; phase = "finish"; this.finish("complete"); controller.close(); return; }
      phase = "usage";
      bytes = this.state.captured!; this.snapshot = bytes;
      this.epoch = this.epoch === Number.MAX_SAFE_INTEGER ? 1 : this.epoch + 1; this.flags &= ~64;
      try { this.push(this.epoch, bytes); } finally { this.snapshot = undefined; }
      if (!this.finished) this.state.emit(controller, bytes);
    } catch (error) {
      let failure = phase === "read" || isIdentityFailure(error) ? error : this.state.failure("pull", error); error = undefined;
      if (!this.finished) { try { this.finish("failed", failure); } catch (cleanup) { failure = isIdentityFailure(cleanup) ? cleanup : this.state.failure("retire", cleanup); } }
      controller.error(failure); failure = undefined;
    } finally { this.snapshot = undefined; this.state.captured = undefined; bytes = undefined; controller = undefined as never; }
  }
  cancel(reason: unknown): void { try { this.finish("canceled", reason); } finally { reason = undefined; } }
  clear(): void {
    if (!this.state.driverDone) throw identityFailure("protocol");
    this.clearInspection(); this.snapshot = undefined; this.validated = undefined; this.context = undefined;
    this.delivering = undefined; this.downstream = undefined; this.resolve = undefined as never; this.listener = undefined as never;
    this.signal = undefined as never; this.operation = undefined as never; this.state = undefined as never;
  }
}

export function matchesOwnedUsageInspection(cap: OwnedHttpRevalidation, value: UsageInspection): boolean {
  const state = ownedAcceptedUsage?.get(cap); return !!state && state.result === value;
}
export function retireOwnedAcceptedUsage(cap: OwnedHttpRevalidation): void { ownedAcceptedUsage?.get(cap)?.clearInspection(); }
