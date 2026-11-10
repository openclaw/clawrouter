import { measurePrivateJsonBody } from "./json-body.ts";
import type { HttpOperation } from "./http-operation.ts";
import type { ValidatedNativeUsage } from "./native-response.ts";
import { googleField, googleInt32, googleServiceTier } from "./google-protocol.ts";
import { anthropicModifiers, type AnthropicModifiers } from "./anthropic-pricing.ts";
import { identityFailure, isIdentityFailure } from "./identity-admission.ts";
import { fundOwnedHttpAcceptedUsage, settleOwnedHttpCodecConsumerCapture, forwardOwnedHttpCodecUsage, holdOwnedHttpVeniceSource, type OwnedHttpRevalidation } from "./http-identity-owner.ts";
import { checkOwnedAcceptedUsageReceiver, matchesOwnedAcceptedUsageSnapshot,
  revokeOwnedUsageRejection, checkOwnedUsageRetirement, checkOwnedAcceptedUsageTerminal, consumerFailure, retireConsumerReader, sealConsumer, readConsumer,
  type CodecReader, type CodecConsumer, type ObservedUsage } from "./proxy-response.ts";

export interface UsageTokens {
  reasoning?: number | null; // Subset of output, never an additional billable category.
  webSearchRequests?: number | null; // Anthropic cumulative usage, not content-block count.
  image?: { textInput: number; imageInput: number; imageOutput: number };
  serviceTier?: string | null;
  anthropic?: AnthropicModifiers;
  input: number | null;
  output: number | null;
  total: number | null;
  cached: number | null;
  cacheWrite: number | null; // Total writes, including the duration-specific buckets below.
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  billable?: false;
  billedTokens?: { input: number | null; output: number | null };
}

export interface UsageTokenContext { providerId: string; requestFormat: string; responseFormat: string }

export function extractUsageTokens(value: unknown, context?: Readonly<UsageTokenContext>): UsageTokens | null {
  const root = record(value);
  if (root && ("usageMetadata" in root || "usage_metadata" in root)) return googleUsageTokens(googleField(root, "usageMetadata", "usage_metadata"));
  const usage = root?.type === "message-end" ? record(record(root.delta)?.usage) : usageRecord(root);
  if (usage && ("tokens" in usage || "billed_units" in usage)) return cohereUsageTokens(usage);
  if (!usage) return null;
  const reportedInput = pickNumber(usage, "input_tokens", "prompt_tokens", "inputTokens");
  const output = pickNumber(usage, "output_tokens", "completion_tokens", "outputTokens");
  const details = record(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const outputDetails = record(usage.output_tokens_details ?? usage.completion_tokens_details);
  const reportedReasoning = outputDetails && Object.hasOwn(outputDetails, "reasoning_tokens")
    ? subsetCounter(outputDetails.reasoning_tokens, output) : undefined;
  const inclusivePrompt = "prompt_tokens" in usage;
  const cached = inclusivePrompt ? promptCachedTokens(usage, details, reportedInput, context)
    : details ? pickNumber(details, "cached_tokens", "cache_read_input_tokens") : pickNumber(usage, "cache_read_input_tokens");
  const cacheCreation = record(usage.cache_creation);
  const cacheWrite5m = cacheCreation ? pickNumber(cacheCreation, "ephemeral_5m_input_tokens") : pickNumber(usage, "cache_creation_ephemeral_5m_input_tokens");
  const cacheWrite1h = cacheCreation ? pickNumber(cacheCreation, "ephemeral_1h_input_tokens") : pickNumber(usage, "cache_creation_ephemeral_1h_input_tokens");
  const cacheWrite = (details ? pickNumber(details, "cache_write_tokens") : null) ?? pickNumber(usage, "cache_creation_input_tokens")
    ?? (cacheWrite5m != null || cacheWrite1h != null ? (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0) : null);
  // Anthropic's top-level buckets exclude ordinary input. Chat prompt totals
  // already include cache hits, whether reported in details or top-level fields.
  const input = reportedInput == null ? null : reportedInput + (details || inclusivePrompt ? 0 : (cached ?? 0) + (cacheWrite ?? 0));
  const total = pickNumber(usage, "total_tokens", "totalTokens") ?? (input != null || output != null ? (input ?? 0) + (output ?? 0) : null);
  // Anthropic reports usage for classifier refusals before any output, but does
  // not bill it. Keep observed counts separate from the settlement decision.
  const unbilled = root?.type === "message" && root.stop_reason === "refusal"
    && Array.isArray(root.content) && root.content.length === 0 && output === 0;
  const modifiers = anthropicModifiers(usage);
  const serviceTier = modifiers.serviceTier !== undefined ? modifiers.serviceTier : extractServiceTier(record(root?.response) ?? root);
  const webSearchRequests = searchRequests(record(usage.server_tool_use)?.web_search_requests);
  return { input, output, total, cached, cacheWrite, cacheWrite5m, cacheWrite1h, ...(reportedReasoning !== undefined ? { reasoning: reportedReasoning } : {}), ...(root?.type === "message" && Object.hasOwn(usage, "server_tool_use") ? { webSearchRequests } : {}), ...(Object.keys(modifiers).length ? { anthropic: modifiers } : {}), ...(serviceTier !== undefined ? { serviceTier } : {}), ...(unbilled ? { billable: false as const } : {}) };
}

// Cohere reports observed context separately from the units it bills. Missing
// billed counters cannot borrow observed counts or imply a free response.
function cohereUsageTokens(usage: Record<string, unknown>): UsageTokens {
  const observed = record(usage.tokens), billed = record(usage.billed_units);
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const input = count(observed?.input_tokens), output = count(observed?.output_tokens);
  const total = input !== null && output !== null && Number.isSafeInteger(input + output) ? input + output : null;
  return { input, output, total, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null,
    billedTokens: { input: count(billed?.input_tokens), output: count(billed?.output_tokens) } };
}

function promptCachedTokens(usage: Record<string, unknown>, details: Record<string, unknown> | null, input: number | null, context?: Readonly<UsageTokenContext>): number | null {
  // StepFun standard Chat reports a cache-hit subset at usage.cached_tokens.
  // Neither the response's model field nor another product grants this meaning.
  const stepfun = (context?.providerId === "stepfun" || context?.providerId === "stepfun-cn")
    && context.requestFormat === "openai.chat_completions" && context.responseFormat === "openai.chat_completions";
  const hits = [details?.cached_tokens, details?.cache_read_input_tokens, usage.prompt_cache_hit_tokens,
    ...(stepfun ? [usage.cached_tokens] : [])].filter(value => value !== undefined);
  const prompt = usage.prompt_tokens, miss = usage.prompt_cache_miss_tokens;
  // Conflicting or invalid cache evidence cannot establish a discount. Keep the
  // observed inclusive input and let pricing charge it at the full input rate.
  if (input == null || !Number.isSafeInteger(prompt) || prompt !== input || !hits.length) return null;
  if (hits.some(hit => typeof hit !== "number" || !Number.isSafeInteger(hit) || hit < 0 || hit > input || hit !== hits[0])) return null;
  const hit = hits[0] as number;
  if (miss !== undefined && (typeof miss !== "number" || !Number.isSafeInteger(miss) || miss < 0 || miss !== input - hit)) return null;
  return hit;
}

function googleUsageTokens(value: unknown): UsageTokens | null {
  if (!record(value)) return null;
  // These implicit-presence int32 counters omit zeros. Prompt already includes
  // cache hits; thinking is separately reported but billed as generated output.
  const counter = (camel: string, proto: string) => googleInt32(googleField(value, camel, proto) ?? 0);
  const input = counter("promptTokenCount", "prompt_token_count"), cached = counter("cachedContentTokenCount", "cached_content_token_count");
  const candidates = counter("candidatesTokenCount", "candidates_token_count"), thoughts = counter("thoughtsTokenCount", "thoughts_token_count");
  const total = counter("totalTokenCount", "total_token_count");
  if (input == null || cached == null || candidates == null || thoughts == null || total == null) return null;
  const tier = googleField(value, "serviceTier", "service_tier");
  // Absent/null ProtoJSON fields are unset; null in normalized usage instead
  // records an explicit invalid tier so accounting cannot assume Standard.
  return { input, output: candidates + thoughts, total, cached, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null, reasoning: thoughts,
    ...(tier == null ? {} : { serviceTier: googleServiceTier(tier) }) };
}

export type ResponseOutcome = "success" | "provider_error" | null;
export interface UsageInspection { tokens: UsageTokens | null; outcome: ResponseOutcome }
export const usageInspectionLimit = 2 * 1024 * 1024;

// JSON and SSE Responses share terminal semantics; incomplete output is still a
// successful, billable response. Absence of usage says nothing about outcome.
export function responseOutcome(value: unknown): ResponseOutcome {
  const root = record(value);
  if (!root) return null;
  if (root.error || root.type === "error" || root.type === "response.failed" || root.type === "response.cancelled") return "provider_error";
  if (root.type === "message-end") {
    const reason = record(root.delta)?.finish_reason;
    return typeof reason === "string" && ["COMPLETE", "STOP_SEQUENCE", "MAX_TOKENS", "TOOL_CALL"].includes(reason) ? "success" : "provider_error";
  }
  if (root.type === "response.completed" || root.type === "response.incomplete") return "success";
  const response = record(root.response) ?? (root.object === "response" ? root : null);
  return response?.status === "failed" || response?.status === "cancelled" ? "provider_error" : response?.status === "completed" || response?.status === "incomplete" ? "success" : null;
}

export interface ResponsesObservation {
  id: string;
  status: "queued" | "in_progress" | "completed" | "incomplete" | "failed" | "cancelled";
  terminal: boolean;
  tokens: UsageTokens | null;
}

// Delivery EOF/error is not a generation status. Only a validated protocol
// document can supply these facts; the streaming projector calls this at its
// complete JSON/document or delimited SSE boundary.
export function responsesObservation(value: unknown): ResponsesObservation | null {
  const root = record(value);
  if (!root) return null;
  const event = typeof root.type === "string" && root.type.startsWith("response.") ? root.type.slice(9) : null;
  const response = event ? record(root.response) : root.object === "response" ? root : null;
  const id = response?.id, status = response?.status;
  const statuses = ["queued", "in_progress", "completed", "incomplete", "failed", "cancelled"];
  if (!response || typeof id !== "string" || !id || new TextEncoder().encode(id).length > 256 || !statuses.includes(status as string)) return null;
  if (event && statuses.includes(event) && event !== status) return null;
  return { id, status: status as ResponsesObservation["status"], terminal: status !== "queued" && status !== "in_progress", tokens: extractUsageTokens(root) };
}

export function extractSseUsageTokens(text: string, context?: Readonly<UsageTokenContext>): UsageTokens | null {
  const inspector = createSseUsageInspector(undefined, undefined, context);
  inspector.push(new TextEncoder().encode(text));
  return inspector.result().tokens;
}

export type SseUsageEvidence = { kind: "data"; value: unknown } | { kind: "done" } | { kind: "error"; value?: unknown } | { kind: "invalid" } | { kind: "unavailable" };

function rejectionOnlyEvidence(evidence: SseUsageEvidence, context?: Readonly<UsageTokenContext>): boolean {
  const root = evidence.kind === "data" || evidence.kind === "error" ? record(evidence.value) : null;
  // A failure is not necessarily a rejection before generation. Usage and
  // nonempty output take precedence over its error/terminal classification.
  const outputs = [root?.output, record(root?.response)?.output];
  if (root && (extractUsageTokens(root, context) || outputs.some(output => Array.isArray(output) ? output.length > 0 : output != null))) return false;
  return evidence.kind === "error" || evidence.kind === "done" || root?.type === "message_stop" || responseOutcome(root) === "provider_error";
}

export function createSseUsageInspector(revokeRejection?: () => void, acceptJson?: (value: unknown, failed?: boolean) => void, context?: Readonly<UsageTokenContext>) {
  const accumulator = createSseUsageAccumulator(revokeRejection, context);
  function evidence(frame: string | null): SseUsageEvidence | null {
    if (frame === null) return { kind: "unavailable" };
    const lines = frame.split("\n");
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
    const error = lines.some(line => /^event:\s*error\s*$/.test(line));
    return parseSseData(data, error);
  }
  const frames = createSseFrames(frame => {
    const next = evidence(frame);
    if (next) accumulator.accept(next);
    if (next?.kind === "data") acceptJson?.(next.value);
    else if (next?.kind === "error" || next?.kind === "invalid" || next?.kind === "unavailable") acceptJson?.(undefined, true);
  });
  return {
    push: frames.push,
    end() {
      if (!acceptJson) return;
      if (frames.overflowed() || frames.pending()?.split("\n").some(line => line.trim() && !line.startsWith(":"))) acceptJson?.(undefined, true);
    },
    result(ended = true): UsageInspection {
      if (revokeRejection) accumulator.unfinished(evidence(frames.pending()));
      return accumulator.result(ended, frames.overflowed());
    },
  };
}

// One native grammar/value constructor for ordinary and private SSE, and the
// private JSON body. Admission is deliberately outside its syntax catch.
function parseSseData(data: string, error: boolean, owned?: OwnedAcceptedUsage): SseUsageEvidence | null {
  if (!error && !data) return null;
  if (!error && data === "[DONE]") return { kind: "done" };
  owned?.admitJson(data);
  if (error) {
    try { return { kind: "error", value: JSON.parse(data) }; }
    catch { return { kind: "error" }; }
  }
  try { return { kind: "data", value: JSON.parse(data) }; }
  catch { return { kind: "invalid" }; }
}

// The set is private and populated only after genuine consumer validation.
// Ordinary accumulator fields, arbitrary-JS inputs and returned layout stay
// unchanged. Only the private retained message summary projects stop_reason.
let privateUsageAccumulators: WeakSet<ReturnType<typeof createSseUsageAccumulator>["accept"]> | undefined;

// Both bounded frame parsing and the Responses scalar projection feed one
// accounting state owner; parser limits cannot invent a terminal provider error.
export function createSseUsageAccumulator(revokeRejection?: () => void, context?: Readonly<UsageTokenContext>) {
  let provisionalRejection = !!revokeRejection;
  function continuedWork() {
    if (!provisionalRejection) return;
    provisionalRejection = false; revokeRejection?.();
    // The original operation retains its error status. Resume usage collection
    // only for this first-event rejection; normal terminal semantics stay fixed.
    outcome = null; terminalTokens = null;
  }
  let found: UsageTokens | null = null, terminalTokens: UsageTokens | null = null;
  let message: Record<string, unknown> | null = null, messageUsage: Record<string, unknown> | null = null;
  let messageDeltaSeen = false, uncertain = false;
  let protocol: "message" | "response" | "chat" | "cohere" | null = null;
  let outcome: ResponseOutcome = null, chatTier: string | undefined;
  function accept(evidence: SseUsageEvidence) {
    const root = evidence.kind === "data" || evidence.kind === "error" ? record(evidence.value) : null;
    // End markers carry no content or usage; later work still revokes rejection.
    if (provisionalRejection && !rejectionOnlyEvidence(evidence, context)) continuedWork();
    if (evidence.kind === "unavailable") {
      // Skipped oversized evidence is not proof of provider failure. A later
      // bounded terminal can restore authoritative outcome and usage.
      uncertain = true; found = null; messageUsage = null;
      return;
    }
    if (evidence.kind === "error") {
      // Preserve the normal event:error precedence. Only the provisional
      // rejection path can resume accounting from a usage-bearing error event.
      if (revokeRejection && !provisionalRejection && outcome === null) terminalTokens = extractUsageTokens(root, context);
      outcome = "provider_error"; return;
    }
    if (outcome !== null) return;
    if (evidence.kind === "done") {
      if (protocol === "message" || protocol === "response" || protocol === "cohere") { outcome = "provider_error"; return; }
      outcome = "success";
      terminalTokens = found && chatTier ? { ...found, serviceTier: chatTier } : found;
      return;
    }
    if (evidence.kind === "invalid") { if (protocol) outcome = "provider_error"; found = null; return; }
    if (!root) { if (protocol) outcome = "provider_error"; found = null; return; }
    const terminal = responseOutcome(root);
    if (terminal) { outcome = terminal; terminalTokens = extractUsageTokens(root, context); return; }
    if (typeof root.type === "string" && root.type.startsWith("response.")) protocol = "response";
    if (typeof root.type === "string" && /^(message|content|tool-call|tool-plan|citation)-/.test(root.type)) protocol = "cohere";
    if (root.object === "chat.completion.chunk") {
      protocol = "chat";
      chatTier = extractServiceTier(root) ?? chatTier;
    }
    if (root.type === "message_start") {
      protocol = "message";
      const initial = record(root.message);
      message = { type: "message", stop_reason: privateUsageAccumulators?.has(accept)
        ? initial?.stop_reason === "refusal" ? "refusal" : undefined : initial?.stop_reason,
        content: Array.isArray(initial?.content) && initial.content.length === 0 ? [] : undefined };
      messageUsage = messageCounters(usageRecord(root));
      messageDeltaSeen = false;
    } else if (root.type === "message_delta") {
      if (!messageUsage) return;
      const messageDelta = record(root.delta);
      if (message && messageDelta && "stop_reason" in messageDelta) message.stop_reason = privateUsageAccumulators?.has(accept)
        ? messageDelta.stop_reason === "refusal" ? "refusal" : undefined : messageDelta.stop_reason;
      const delta = messageCounters(usageRecord(root));
      messageDeltaSeen = delta != null && pickNumber(delta, "output_tokens") != null;
      if (delta) {
        // Cumulative deltas omit unchanged counters. Merge before normalizing
        // so disjoint cache input is added once, never once per frame.
        const updates = Object.fromEntries(Object.entries(delta).filter(([key, value]) => value != null && !(key === "inference_geo" && value === "not_available")));
        const creation = record(updates.cache_creation);
        if (creation) updates.cache_creation = { ...record(messageUsage.cache_creation), ...creation };
        Object.assign(messageUsage, updates);
      }
    } else if (root.type === "content_block_start" || root.type === "content_block_delta") {
      if (message) message.content = undefined;
    } else if (root.type === "message_stop") {
      outcome = "success";
      terminalTokens = messageUsage && messageDeltaSeen ? extractUsageTokens({ ...message, usage: messageUsage }, context) : null;
    } else {
      const tokens = extractUsageTokens(root, context);
      // A malformed final native snapshot invalidates an earlier partial one.
      // Ordinary content-only chunks still retain the latest usage snapshot.
      found = root && ("usageMetadata" in root || "usage_metadata" in root) ? tokens : tokens ?? found;
    }
  }
  return {
    accept,
    unfinished(evidence: SseUsageEvidence | null) {
      // EOF/cancellation cannot certify unfinished nonempty data as error-only.
      // Never accept its usage or terminal facts without an SSE boundary.
      if (provisionalRejection && evidence && !rejectionOnlyEvidence(evidence, context)) {
        continuedWork(); uncertain = true; found = null; messageUsage = null;
      }
    },
    result(ended = true, overflowed = false): UsageInspection {
      // An oversized trailing frame cannot certify that delivered bytes were
      // error-only; retain conservative billing when bounded inspection fails.
      if (overflowed) continuedWork();
      return { tokens: outcome ? terminalTokens : protocol || !ended ? null : found, outcome: outcome ?? (ended && protocol && !uncertain && !overflowed ? "provider_error" : null) };
    },
  };
}

type OwnedUsageMode = "sse" | "json" | "none";
const ownedUsageMetadata = 65536;
let ownedAcceptedUsage: WeakMap<OwnedHttpRevalidation, OwnedAcceptedUsage> | undefined;
let ownedFrameConsumers: WeakMap<(frame: string | null) => void, OwnedAcceptedUsage> | undefined;

function trimCode(code: number): boolean {
  return code >= 9 && code <= 13 || code === 32 || code === 160 || code === 5760
    || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}

class OwnedAcceptedUsage {
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
  constructor(readonly cap: OwnedHttpRevalidation, protected mode: OwnedUsageMode,
    protected context: Readonly<UsageTokenContext> | undefined, protected provisional: boolean) {}
  initialize(): void {
    if (ownedAcceptedUsage?.has(this.cap)) throw identityFailure("protocol");
    (ownedAcceptedUsage ??= new WeakMap()).set(this.cap, this);
    this.epoch = 0;
    if (this.flags & 16) throw identityFailure("protocol");
    this.flags |= 16;
    if (this.mode === "sse") {
      this.accumulator = createSseUsageAccumulator(this.provisional ? this.revoke.bind(this) : undefined, this.context);
      (privateUsageAccumulators ??= new WeakSet()).add(this.accumulator.accept);
      this.consumeFrame = this.consume.bind(this);
      (ownedFrameConsumers ??= new WeakMap()).set(this.consumeFrame, this);
      this.frames = createSseFrames(this.consumeFrame);
    } else if (this.mode === "json") this.decoder = new TextDecoder();
  }
  reserve(temporary: number): void {
    if (!Number.isSafeInteger(temporary) || temporary < 0) throw identityFailure("protocol");
    fundOwnedHttpAcceptedUsage(this.cap, ownedUsageMetadata + this.bufferBytes + 2 * this.text.length + temporary);
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
  private revoke(): void { revokeOwnedUsageRejection(this.cap); }
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
      || !matchesOwnedAcceptedUsageSnapshot(this.cap, epoch, bytes)) throw identityFailure("protocol");
    this.flags |= 64;
    if (this.frames) {
      try { this.frames.push(bytes); }
      catch (error) { this.flags |= 32; throw error; }
    }
    else if (this.mode === "json" && !(this.flags & 8)) {
      this.bytes += bytes.byteLength;
      if (this.bytes > usageInspectionLimit) { this.flags |= 8; this.text = ""; this.reserve(0); return; }
      this.reserve(2 * this.text.length + 4 * (bytes.byteLength + 2));
      let chunk = this.decoder!.decode(bytes, { stream: true });
      this.text += chunk; chunk = ""; this.reserve(0);
    }
  }
  finishInspection(ended: boolean): void {
    checkOwnedAcceptedUsageTerminal(this.cap, ended);
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
        let tail = this.decoder!.decode(); this.text += tail; tail = "";
        this.admitJson(this.text, true);
        let valid = false;
        try { value = JSON.parse(this.text); valid = true; } catch { /* Native syntax failure only. */ }
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
    checkOwnedUsageRetirement(this.cap);
    if (this.consumeFrame) ownedFrameConsumers!.delete(this.consumeFrame);
    if (this.accumulator) privateUsageAccumulators!.delete(this.accumulator.accept);
    this.frames = undefined; this.accumulator = undefined; this.consumeFrame = undefined;
    this.decoder = undefined; this.text = ""; this.frame = undefined; this.result = undefined;
    ownedAcceptedUsage!.delete(this.cap);
    fundOwnedHttpAcceptedUsage(this.cap, 0);
  }
}
export class OwnedChatUsage extends OwnedAcceptedUsage {
  private state: CodecReader;
  private signal: AbortSignal;
  private snapshot?: Uint8Array;
  private resolve!: () => void;
  private ready: Promise<void>;
  private downstream!: ReadableStreamDefaultController<Uint8Array>;
  private listener: () => void;
  constructor(owner: CodecConsumer, reader: CodecReader, private operation: HttpOperation,
    private validated?: ValidatedNativeUsage, usageContext?: Readonly<UsageTokenContext>) {
    super(owner.codec, "none", usageContext, false);
    this.state = reader;
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
      if (this.signal.aborted) this.aborted();
      else {
        try { this.signal.addEventListener("abort", this.listener, { once: true }); }
        catch (reason) { throw consumerFailure(this.state, "listenerAdd", reason); }
      }
      const output = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      owner.current = output;
      owner.usage = this.ready.then(this.forward.bind(this));
      return output;
    } catch (reason) {
      try { this.finish("failed", reason); }
      catch (cleanup) { throw new AggregateError([reason, cleanup], "owned usage publication"); }
      throw reason;
    } finally { response = undefined as never; }
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
    if (this.state.reading || this.state.originalRead || this.state.driverCapturing || this.state.retirement) return null;
    // One serial highWaterMark:0 usage pull owns the current snapshot. A later
    // pull cannot start before the preceding output handoff has completed.
    // These are actual backing identities, not equality/interning assumptions.
    const prefix = this.state.prefixWire?.buffer, crossing = this.state.crossingWire?.buffer;
    const captured = this.state.captured?.buffer, snapshot = this.snapshot?.buffer;
    let bytes = prefix?.byteLength ?? 0;
    if (crossing && crossing !== prefix) bytes += crossing.byteLength;
    if (captured && captured !== prefix && captured !== crossing) bytes += captured.byteLength;
    if (snapshot && snapshot !== prefix && snapshot !== crossing && snapshot !== captured) bytes += snapshot.byteLength;
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
    this.snapshot = undefined; this.result = undefined;
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
    this.resolve();
    // Logical usage can start accounting before physical reader retirement.
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
        bytes = new Uint8Array(this.state.prefixUsed); bytes.set(this.state.prefixWire.subarray(0, this.state.prefixUsed));
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
      if (!this.finished) controller.enqueue(bytes!);
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

export function matchesOwnedUsageInspection(cap: OwnedHttpRevalidation, value: UsageInspection): boolean {
  const state = ownedAcceptedUsage?.get(cap); return !!state && state.result === value;
}
export function retireOwnedAcceptedUsage(cap: OwnedHttpRevalidation): void { ownedAcceptedUsage?.get(cap)?.clearInspection(); }

export function createSseFrames(consume: (frame: string | null) => void, fatalUtf8 = false) {
  ownedFrameConsumers?.get(consume)?.resize(0, 8192);
  let buffer = new Uint8Array(8192), length = 0, lineLength = 0, overflow = false, skipLf = false;
  ownedFrameConsumers?.get(consume)?.resized(8192, 0);
  const decoder = new TextDecoder("utf-8", { fatal: fatalUtf8 });
  const decode = () => {
    ownedFrameConsumers?.get(consume)?.reserve(2 * length);
    let text: string | null;
    try { text = decoder.decode(buffer.subarray(0, length)); } catch { text = null; }
    const owned = ownedFrameConsumers?.get(consume);
    if (owned && owned.flags & 2) {
      owned.resize(buffer.byteLength, 8192); buffer = new Uint8Array(8192);
      owned.resized(8192, text === null ? 0 : 2 * text.length);
    }
    return text;
  };
  function append(bytes: Uint8Array) {
    if (overflow) return;
    if (length + bytes.length > usageInspectionLimit) { overflow = true; length = 0; return; }
    if (length + bytes.length > buffer.length) {
      const owned = ownedFrameConsumers?.get(consume), temporary = owned?.temporaryBytes ?? 0;
      owned?.resize(buffer.byteLength, Math.min(usageInspectionLimit, Math.max(buffer.length * 2, length + bytes.length)));
      const next = new Uint8Array(Math.min(usageInspectionLimit, Math.max(buffer.length * 2, length + bytes.length)));
      next.set(buffer.subarray(0, length)); buffer = next;
      owned?.resized(buffer.byteLength, temporary);
    }
    buffer.set(bytes, length); length += bytes.length;
  }
  return {
    overflowed: () => overflow,
    pending: () => overflow ? null : decode(),
    push(bytes: Uint8Array) {
      let start = 0;
      for (let index = 0; index < bytes.length; index++) {
        const byte = bytes[index];
        if (skipLf) { skipLf = false; if (byte === 10) { start = index + 1; continue; } }
        if (byte !== 10 && byte !== 13) continue;
        append(bytes.subarray(start, index)); lineLength += index - start;
        if (lineLength === 0) {
          const owned = ownedFrameConsumers?.get(consume);
          if (owned) {
            owned.flags |= 2;
            try { owned.stageFrame(overflow ? null : decode()); consume(null); }
            finally { owned.flags &= ~2; }
          } else consume(overflow ? null : decode());
          length = 0; overflow = false;
        }
        else append(new Uint8Array([10]));
        lineLength = 0; skipLf = byte === 13; start = index + 1;
      }
      append(bytes.subarray(start)); lineLength += bytes.length - start;
    },
  };
}

function messageCounters(usage: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!usage) return null;
  // Stream history is unbounded; retain only the finite cumulative counter set.
  const counters = Object.fromEntries(["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "cache_creation_ephemeral_5m_input_tokens", "cache_creation_ephemeral_1h_input_tokens"].filter(key => numeric(usage[key]) != null).map(key => [key, usage[key]]));
  // Explicit malformed snapshots invalidate an older valid count; omitted
  // unchanged counters retain it. Never retain tool inputs or result content.
  const serverTools = record(usage.server_tool_use);
  if (Object.hasOwn(usage, "server_tool_use") && (!serverTools || Object.hasOwn(serverTools, "web_search_requests"))) {
    counters.server_tool_use = { web_search_requests: searchRequests(serverTools?.web_search_requests) };
  }
  for (const key of ["speed", "inference_geo", "service_tier"]) if (Object.hasOwn(usage, key)) counters[key] = usage[key] === null ? null : typeof usage[key] === "string" && usage[key].length <= 64 ? usage[key] : "invalid";
  const creation = record(usage.cache_creation);
  if (creation) counters.cache_creation = Object.fromEntries(["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"].filter(key => numeric(creation[key]) != null).map(key => [key, creation[key]]));
  return counters;
}

export function extractServiceTier(root: Record<string, unknown> | null): string | undefined {
  const tier = root?.service_tier;
  return typeof tier === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(tier) ? tier : undefined;
}

function usageRecord(root: Record<string, unknown> | null): Record<string, unknown> | null {
  return root ? record(root.usage ?? record(root.response)?.usage ?? record(root.message)?.usage ?? root.meta) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function pickNumber(value: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const number = numeric(value[key]);
    if (number != null) return number;
  }
  return null;
}

function subsetCounter(value: unknown, inclusive: number | null): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && inclusive !== null && value <= inclusive ? value : null;
}

function searchRequests(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}
