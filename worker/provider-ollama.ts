import type { UsageInspection, UsageTokens } from "./token-usage.ts";

export const ollamaInspectionLimit = 2 * 1024 * 1024;
export const ollamaChatFormat = "ollama.chat";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
const counter = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export interface OllamaChatRequest extends JsonRecord { model: string; messages: JsonRecord[] }

// Native bodies keep Ollama's tool, thinking, image and generation-option shapes.
// The caller must supply a model already selected through the scoped catalog.
export function prepareOllamaChatRequest(value: unknown, upstreamModel: string): OllamaChatRequest {
  const body = record(value);
  if (!body || !upstreamModel.trim() || !Array.isArray(body.messages) || !body.messages.length) throw new Error("invalid_ollama_chat_request");
  const messages = body.messages.map(value => {
    const message = record(value);
    if (!message || !["system", "user", "assistant", "tool"].includes(message.role as string) || typeof message.content !== "string") throw new Error("invalid_ollama_chat_message");
    if (message.images !== undefined && (!Array.isArray(message.images) || message.images.some(image => typeof image !== "string"))) throw new Error("invalid_ollama_chat_images");
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error("invalid_ollama_tool_calls");
    return message;
  });
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw new Error("invalid_ollama_stream");
  if (body.think !== undefined && body.think !== null && typeof body.think !== "boolean" && typeof body.think !== "string") throw new Error("invalid_ollama_think");
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new Error("invalid_ollama_tools");
  if (body.options !== undefined && !record(body.options)) throw new Error("invalid_ollama_options");
  return { ...body, model: upstreamModel, messages };
}

function tokens(root: JsonRecord): UsageTokens | null {
  const input = counter(root.prompt_eval_count), output = counter(root.eval_count);
  if (input === null || output === null || !Number.isSafeInteger(input + output)) return null;
  const cached = counter(root.prompt_eval_cached_count);
  return { input, output, total: input + output, cached: cached !== null && cached <= input ? cached : null,
    cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
}

export function inspectOllamaChatResponse(value: unknown): UsageInspection {
  const root = record(value);
  if (!root) return { tokens: null, outcome: null };
  if (typeof root.error === "string" && root.error.length) return { tokens: tokens(root), outcome: "provider_error" };
  if (root.done !== true || !record(root.message)) return { tokens: null, outcome: null };
  return { tokens: tokens(root), outcome: "success" };
}

// Observation only: callers forward the original bytes and retain their reader's
// backpressure/cancellation. An oversized line is discarded, not accumulated.
export function createOllamaChatInspector(format: "ndjson" | "json" = "ndjson") {
  let buffer = new Uint8Array(4096), length = 0, overflow = false, closed = false, terminal = false, invalid = false;
  let inspection: UsageInspection = { tokens: null, outcome: null };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  function invalidate() { invalid = true; inspection = { tokens: null, outcome: null }; }
  function append(bytes: Uint8Array) {
    if (overflow) return;
    if (length + bytes.byteLength > ollamaInspectionLimit) { overflow = true; length = 0; return; }
    if (length + bytes.byteLength > buffer.byteLength) {
      const next = new Uint8Array(Math.min(ollamaInspectionLimit, Math.max(buffer.byteLength * 2, length + bytes.byteLength)));
      next.set(buffer.subarray(0, length)); buffer = next;
    }
    buffer.set(bytes, length); length += bytes.byteLength;
  }
  function frame() {
    if (overflow) {
      // A later terminal can restore authoritative cumulative usage after a
      // large output chunk, but extra data after a terminal is never accepted.
      if (terminal) invalidate();
    } else if (length) {
      try {
        const text = decoder.decode(buffer.subarray(0, length));
        if (text.trim()) {
          const value: unknown = JSON.parse(text), root = record(value);
          if (terminal || !root || (root.done !== false && root.done !== true && typeof root.error !== "string")) invalidate();
          else {
            const next = inspectOllamaChatResponse(root);
            if (next.outcome) { terminal = true; if (!invalid) inspection = next; }
            else if (root.done !== false || !record(root.message)) invalidate();
          }
        }
      } catch { invalidate(); }
    }
    length = 0; overflow = false;
  }
  return {
    push(bytes: Uint8Array) {
      if (closed) return;
      if (format === "json") { append(bytes); return; }
      let start = 0;
      while (start < bytes.byteLength) {
        const end = bytes.indexOf(10, start);
        if (end < 0) { append(bytes.subarray(start)); break; }
        append(bytes.subarray(start, end)); frame(); start = end + 1;
      }
    },
    result(ended = true): UsageInspection {
      if (!closed) {
        if (ended) frame();
        else if (length || overflow) invalidate();
        closed = true; buffer = new Uint8Array(0); length = 0;
      }
      return { ...inspection };
    },
  };
}

export interface OllamaModelList extends JsonRecord { models: JsonRecord[] }

// The policy owner supplies the predicate; native metadata stays native.
export function filterOllamaModels(value: unknown, allowed: (model: string) => boolean): OllamaModelList {
  const root = record(value);
  if (!root || !Array.isArray(root.models)) throw new Error("invalid_ollama_model_list");
  const models = root.models.filter(value => {
    const model = record(value), id = model?.model ?? model?.name;
    if (!model || typeof id !== "string" || !id || (model.name !== undefined && model.name !== id)) throw new Error("invalid_ollama_model");
    return allowed(id);
  });
  return { ...root, models };
}
