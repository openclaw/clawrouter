import type { UsageInspection, UsageTokens } from "./token-usage.ts";

export type BedrockJson = null | boolean | number | string | BedrockJson[] | { [key: string]: BedrockJson };
export type BedrockObject = { [key: string]: BedrockJson };
export const bedrockConverseLimit = 2 * 1024 * 1024;
export function bedrockRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function requireBedrock(value: unknown, field: string): asserts value {
  if (!value) throw new Error(`invalid_bedrock_${field}`);
}
export function bedrockJson(value: unknown, depth = 0): value is BedrockJson {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.every(item => bedrockJson(item, depth + 1));
  const record = bedrockRecord(value);
  return !!record && Object.values(record).every(item => bedrockJson(item, depth + 1));
}
export function bedrockObject(value: unknown): BedrockObject {
  requireBedrock(bedrockRecord(value) && bedrockJson(value), "object");
  requireBedrock(new TextEncoder().encode(JSON.stringify(value)).length <= bedrockConverseLimit, "body_limit");
  return value as BedrockObject;
}
export function bedrockBase64(value: unknown): string {
  requireBedrock(typeof value === "string" && value.length > 0 && value.length <= bedrockConverseLimit, "base64");
  const padded = value.replace(/\s/g, "");
  requireBedrock(/^[A-Za-z0-9+/]+={0,2}$/.test(padded) && padded.length % 4 !== 1, "base64");
  try {
    const bytes = atob(padded);
    const canonical = btoa(bytes);
    requireBedrock(canonical.replace(/=+$/, "") === padded.replace(/=+$/, ""), "base64");
    return canonical;
  } catch { throw new Error("invalid_bedrock_base64"); }
}
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value); }

/** Bedrock inputTokens excludes cache reads/writes; router input includes both. */
export function extractBedrockConverseUsage(value: unknown): UsageTokens | null {
  const usage = bedrockRecord(value);
  if (!usage || !count(usage.inputTokens) || !count(usage.outputTokens)) return null;
  const read = usage.cacheReadInputTokens === undefined ? 0 : usage.cacheReadInputTokens;
  const write = usage.cacheWriteInputTokens === undefined ? 0 : usage.cacheWriteInputTokens;
  if (!count(read) || !count(write) || (usage.totalTokens !== undefined && !count(usage.totalTokens))) return null;
  const input = usage.inputTokens + read + write, total = Math.max(usage.totalTokens as number ?? 0, input + usage.outputTokens);
  if (!count(input) || !count(total)) return null;
  let short: number | null = null, long: number | null = null;
  if (usage.cacheDetails !== undefined) {
    if (!Array.isArray(usage.cacheDetails) || usage.cacheDetails.length > 4096) return null;
    for (const item of usage.cacheDetails) {
      const detail = bedrockRecord(item);
      if (!detail || !count(detail.inputTokens)) return null;
      if (detail.ttl === "5m") short = (short ?? 0) + detail.inputTokens;
      else if (detail.ttl === "1h") long = (long ?? 0) + detail.inputTokens;
      else return null;
    }
    if (!count((short ?? 0) + (long ?? 0)) || (short ?? 0) + (long ?? 0) > write) return null;
  }
  return { input, output: usage.outputTokens, total, cached: read, cacheWrite: write, cacheWrite5m: short, cacheWrite1h: long };
}

export type BedrockStop = "stop" | "length" | "toolUse" | "refusal" | "error";
export function bedrockConverseStop(reason: unknown): BedrockStop {
  switch (reason) {
    case "end_turn": case "stop_sequence": return "stop";
    case "max_tokens": case "model_context_window_exceeded": return "length";
    case "tool_use": return "toolUse";
    case "refusal": return "refusal";
    default: return "error";
  }
}

function validateContent(value: unknown): asserts value is BedrockObject[] {
  requireBedrock(Array.isArray(value) && value.length > 0 && value.length <= 4096, "content");
  for (const item of value) {
    const block = bedrockRecord(item);
    requireBedrock(block && Object.keys(block).length === 1, "content_union");
    if (typeof block.text === "string") continue;
    const tool = bedrockRecord(block.toolUse), reasoning = bedrockRecord(block.reasoningContent);
    if (tool) {
      requireBedrock(identifier(tool.toolUseId) && identifier(tool.name) && bedrockRecord(tool.input) && bedrockJson(tool.input), "tool_use");
    } else if (reasoning) {
      const text = bedrockRecord(reasoning.reasoningText);
      requireBedrock(Object.keys(reasoning).length === 1, "reasoning_union");
      if (text) requireBedrock(typeof text.text === "string" && typeof text.signature === "string" && text.signature.length > 0, "reasoning_signature");
      else bedrockBase64(reasoning.redactedContent);
    } else {
      // Native response extensions stay explicit; never mistake an unknown block for text.
      throw new Error("invalid_bedrock_content_kind");
    }
  }
}

export interface BedrockConverseResult {
  content: BedrockObject[];
  stop: BedrockStop | null;
  inspection: UsageInspection;
  error: string | null;
}

export function decodeBedrockConverseResponse(value: unknown): BedrockConverseResult {
  const body = bedrockObject(value), output = bedrockRecord(body.output), message = bedrockRecord(output?.message);
  requireBedrock(message?.role === "assistant", "response_role");
  validateContent(message.content);
  const stop = bedrockConverseStop(body.stopReason), failed = stop === "error" || stop === "refusal";
  return {
    content: failed ? [] : message.content,
    stop,
    inspection: { tokens: extractBedrockConverseUsage(body.usage), outcome: failed ? "provider_error" : "success" },
    // stop_details can contain provider prose; callers get a content-free category.
    error: failed ? stop === "refusal" ? "bedrock_refusal" : "bedrock_stop_reason" : null,
  };
}

/** Selected model is a path binding; credentials/region/signing stay with the runtime owner. */
export function prepareBedrockConverseRequest(value: unknown, model: string, stream: boolean) {
  const body = bedrockObject(value);
  requireBedrock(typeof model === "string" && model.length > 0 && model.length <= 2048 && !/[\x00-\x1f\x7f]/.test(model), "model");
  requireBedrock(Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 4096, "messages");
  for (const value of body.messages) {
    const message = bedrockRecord(value);
    requireBedrock(message && ["user", "assistant"].includes(message.role as string) && Array.isArray(message.content) && message.content.length > 0, "message");
  }
  const { modelId: _model, stream: _stream, ...payload } = body;
  return { path: `/model/${encodeURIComponent(model)}/${stream ? "converse-stream" : "converse"}`, body: payload };
}

interface PendingBlock { content: BedrockObject; closed: boolean; arguments?: string; opaque?: string[] }
const errors = new Set(["internalServerException", "modelStreamErrorException", "validationException", "throttlingException", "serviceUnavailableException"]);

/** Accept decoded AWS EventStream event unions, never raw frames or SSE. */
export function createBedrockConverseDecoder() {
  const blocks = new Map<number, PendingBlock>();
  let started = false, stopped = false, sealed = false, metadata = false, size = 0;
  let stop: BedrockStop | null = null, error: string | null = null, invalid = false;
  let tokens: UsageTokens | null = null;
  function unavailable() { invalid = true; tokens = null; blocks.clear(); }
  function fail(category: string) { error = category; blocks.clear(); }
  return {
    unavailable,
    accept(value: unknown) {
      if (sealed || invalid) return;
      try {
        const event = bedrockObject(value), keys = Object.keys(event);
        size += new TextEncoder().encode(JSON.stringify(event)).length;
        requireBedrock(size <= bedrockConverseLimit && keys.length === 1, "event_limit");
        const kind = keys[0], data = bedrockRecord(event[kind]);
        requireBedrock(data, "event");
        if (errors.has(kind)) { fail(`bedrock_${kind}`); stopped = true; return; }
        if (error) { requireBedrock(kind === "metadata", "after_error"); }
        if (kind === "messageStart") {
          requireBedrock(!started && !stopped && data.role === "assistant", "message_start"); started = true; return;
        }
        requireBedrock(started, "missing_start");
        if (kind === "metadata") {
          requireBedrock(!metadata, "duplicate_metadata"); metadata = true; tokens = extractBedrockConverseUsage(data.usage); return;
        }
        requireBedrock(!stopped, "after_stop");
        if (kind === "messageStop") {
          stopped = true; stop = bedrockConverseStop(data.stopReason);
          if (stop === "error" || stop === "refusal") { fail(stop === "refusal" ? "bedrock_refusal" : "bedrock_stop_reason"); return; }
          const calls = [...blocks.values()].filter(block => block.arguments !== undefined);
          // Validate every sibling before exposing any executable tool input.
          const parsed = calls.map(block => {
            requireBedrock(block.closed, "incomplete_tool_call");
            const input: unknown = JSON.parse(block.arguments || "{}");
            requireBedrock(bedrockRecord(input) && bedrockJson(input), "tool_arguments");
            return input as BedrockObject;
          });
          calls.forEach((block, index) => { (block.content.toolUse as BedrockObject).input = parsed[index]; });
          for (const block of blocks.values()) {
            if (block.opaque) {
              const bytes = block.opaque.map(chunk => atob(chunk)).join("");
              block.content.reasoningContent = { redactedContent: btoa(bytes) };
            }
          }
          return;
        }
        const index = data.contentBlockIndex;
        requireBedrock(count(index) && index < 4096, "block_index");
        let block = blocks.get(index);
        if (kind === "contentBlockStart") {
          const start = bedrockRecord(data.start), tool = bedrockRecord(start?.toolUse);
          requireBedrock(!block && tool && identifier(tool.toolUseId) && identifier(tool.name), "block_start");
          blocks.set(index, { content: { toolUse: { toolUseId: tool.toolUseId, name: tool.name, input: {} } }, arguments: "", closed: false }); return;
        }
        if (kind === "contentBlockStop") {
          requireBedrock(block && !block.closed, "block_stop"); block.closed = true; return;
        }
        requireBedrock(kind === "contentBlockDelta" && !block?.closed, "block_delta");
        const delta = bedrockRecord(data.delta);
        requireBedrock(delta && Object.keys(delta).length === 1, "delta_union");
        if (typeof delta.text === "string") {
          if (!block) { block = { content: { text: "" }, closed: false }; blocks.set(index, block); }
          requireBedrock(typeof block.content.text === "string", "delta_kind"); block.content.text += delta.text;
        } else if (bedrockRecord(delta.toolUse)) {
          const tool = bedrockRecord(delta.toolUse)!;
          requireBedrock(block && block.arguments !== undefined && typeof tool.input === "string", "tool_delta"); block.arguments += tool.input;
        } else {
          const reasoning = bedrockRecord(delta.reasoningContent);
          requireBedrock(reasoning && Object.keys(reasoning).length === 1, "reasoning_delta");
          if (!block) { block = { content: { reasoningContent: { reasoningText: { text: "", signature: "" } } }, closed: false }; blocks.set(index, block); }
          const content = bedrockRecord(block.content.reasoningContent), text = bedrockRecord(content?.reasoningText);
          requireBedrock(text, "reasoning_kind");
          if (reasoning.redactedContent !== undefined) {
            requireBedrock(!text.text && !text.signature, "mixed_reasoning");
            (block.opaque ??= []).push(bedrockBase64(reasoning.redactedContent));
          } else {
            requireBedrock(!block.opaque, "mixed_reasoning");
            if (typeof reasoning.text === "string") text.text = (text.text as string) + reasoning.text;
            else { requireBedrock(typeof reasoning.signature === "string", "reasoning_signature"); text.signature = (text.signature as string) + reasoning.signature; }
          }
        }
      } catch { unavailable(); }
    },
    result(ended = true): BedrockConverseResult {
      sealed = true;
      if (!ended || invalid || !stopped) { blocks.clear(); return { content: [], stop: null, inspection: { tokens: null, outcome: null }, error: null }; }
      const content = error ? [] : [...blocks.values()].map(block => block.content);
      return { content, stop, inspection: { tokens, outcome: error ? "provider_error" : "success" }, error };
    },
  };
}
