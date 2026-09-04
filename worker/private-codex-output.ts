import { boundedJson, cancel, read } from "./private-codex-io";
import { privateFold, record, type PrivateUpstream } from "./private-codex-config";
import { PrivateResponseProjection } from "./private-codex-response";
import type { PrivateContinuationProjection } from "./private-codex-continuation";

const encoder = new TextEncoder();
const frameLimit = 256 * 1024;
const queueLimit = 1024 * 1024;
const streamLimit = 64 * 1024 * 1024;
const errorBody = { type: "error", error: { code: "private_upstream_error", message: "Private upstream request failed." } };
const denialCodes = new Set(["cyber_policy", "misalignment_policy_violation", "bio_policy", "invalid_prompt", "context_length_exceeded", "insufficient_quota", "usage_not_included", "rate_limit_exceeded"]);
const eventTypes = new Set([
  "response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed", "response.metadata",
  "response.output_item.added", "response.output_item.done", "response.content_part.added", "response.content_part.done",
  "response.output_text.delta", "response.output_text.done", "response.refusal.delta", "response.refusal.done",
  "response.reasoning_text.delta", "response.reasoning_text.done", "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done", "codex.response.metadata", "codex.rate_limits", "responsesapi.websocket_timing",
]);

function headers(contentType: string, ignoredMaxOutputTokens = false): HeadersInit {
  return {
    "content-type": contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    "x-clawrouter-content-retention": "off", "x-clawrouter-accounting": "private-unmetered",
    ...(ignoredMaxOutputTokens ? { "x-clawrouter-ignored-parameters": "max_output_tokens" } : {}),
  };
}

export function privateJson(value: unknown, status = 200, ignoredMaxOutputTokens = false): Response {
  return new Response(JSON.stringify(value), { status, headers: headers("application/json; charset=utf-8", ignoredMaxOutputTokens) });
}

export function privateError(status: number, ignoredMaxOutputTokens = false): Response {
  const error = status === 404 ? { code: "route_not_found", message: "route not found" }
    : status === 400 ? { code: "invalid_request", message: "Unsupported private request." } : errorBody.error;
  return privateJson({ error }, status, ignoredMaxOutputTokens);
}

export async function containResponse(response: Response, alias: string, upstream: PrivateUpstream, streaming: boolean, signal: AbortSignal, abort: () => void, ignoredMaxOutputTokens = false, continuation?: PrivateContinuationProjection): Promise<Response> {
  const discard = () => { void response.body?.cancel().catch(() => {}); abort(); };
  if (!response.ok) {
    discard();
    // An upstream 400 is a provider denial, never a local request-validation error.
    return privateJson({ error: errorBody.error }, response.status >= 400 && response.status < 500 ? response.status : 502, ignoredMaxOutputTokens);
  }
  const encoding = response.headers.get("content-encoding");
  const contentType = response.headers.get("content-type") ?? "";
  if ((encoding && encoding !== "identity") || response.status !== 200) { discard(); return privateError(502, ignoredMaxOutputTokens); }
  const projection = new PrivateResponseProjection(alias, upstream, continuation);
  const outputHeaders = async () => {
    const result = new Headers(headers(streaming ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8", ignoredMaxOutputTokens));
    for (const [key, value] of Object.entries(await projection.headers(response.headers))) result.set(key, value as string);
    projection.inspect([...result]);
    return result;
  };
  const failure = () => {
    const result = privateError(502, ignoredMaxOutputTokens);
    try { projection.inspect(errorBody); projection.inspect([...result.headers]); return result; }
    catch { return new Response(null, { status: 502 }); }
  };
  try { await outputHeaders(); } catch { discard(); return failure(); }
  if (streaming) {
    // Native subscription SSE can omit Content-Type; the frame parser still validates every byte.
    if ((contentType && !/^text\/event-stream(?:;\s*charset=utf-8)?$/i.test(contentType)) || !response.body) { discard(); return privateError(502, ignoredMaxOutputTokens); }
    const reader = containStream(response.body, projection, signal, abort).getReader();
    try {
      // Learn the initial reporting identity before releasing opaque HTTP affinity headers.
      // Priming uses the same bounded parser/queue and cancellation as subsequent reads.
      let first: ReadableStreamReadResult<Uint8Array> | undefined = await reader.read();
      const projectedHeaders = await outputHeaders();
      projection.seal();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = first ?? await reader.read();
          first = undefined;
          if (next.done) controller.close(); else controller.enqueue(next.value);
        },
        cancel() { first = undefined; cancel(reader); abort(); },
      }, { highWaterMark: 0 });
      return new Response(body, { headers: projectedHeaders });
    } catch { cancel(reader); abort(); return failure(); }
  }
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)) { discard(); return privateError(502, ignoredMaxOutputTokens); }
  try {
    const value = await boundedJson(response.body, 4 * 1024 * 1024, signal);
    if (!record(value) || value.object !== "response" || !["completed", "incomplete"].includes(String(value.status))) throw new Error("private response invalid");
    const projected = await projection.response(value);
    return new Response(JSON.stringify(projected), { headers: await outputHeaders() });
  } catch { return failure(); } finally { abort(); }
}

interface Pending { sequence: number; frame: string; bytes: number }
interface DeltaState { matches: number[]; holdFrom: number; tool: boolean; toolFrom: number; arguments: string; argumentBytes: number; done: boolean; custom: boolean }

function prefixTable(pattern: string): number[] {
  const table = Array<number>(pattern.length).fill(0);
  for (let index = 1, length = 0; index < pattern.length; index++) {
    while (length && pattern[index] !== pattern[length]) length = table[length - 1];
    if (pattern[index] === pattern[length]) length++;
    table[index] = length;
  }
  return table;
}

function matchDelta(text: string, pattern: string, table: number[], length: number): number {
  for (let index = 0; index < text.length; index++) {
    while (length && text[index] !== pattern[length]) length = table[length - 1];
    if (text[index] === pattern[length]) length++;
    if (length === pattern.length) throw new Error("private split content rejected");
  }
  return length;
}

function containStream(body: ReadableStream<Uint8Array>, projection: PrivateResponseProjection, signal: AbortSignal, abort: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const secrets = projection.sensitiveValues;
  let patterns = secrets.map(privateFold), tables = patterns.map(prefixTable);
  const states = new Map<string, DeltaState>(), items = new Map<number, string>(), itemIndexes = new Map<string, number>();
  const identityModes = new Map<string, "identified" | "anonymous">();
  const calls = new Map<string, string>(), callOwners = new Map<string, string>(), customItems = new Map<string, string>();
  // Codex's OutputTextDelta drops item IDs. Guard its combined text as well as each item.
  const outputText = { matches: secrets.map(() => 0), holdFrom: Infinity };
  let buffer = "", bytes = 0, sequence = 0, pending: Pending[] = [], pendingSize = 0;
  let terminal: string | null = null, ended = false, canceled = false;
  let failure = `event: error\ndata: ${JSON.stringify(errorBody)}\n\n`;

  function flush(controller: ReadableStreamDefaultController<Uint8Array>, force = false): boolean {
    const hold = force ? Infinity : Math.min(outputText.holdFrom, ...[...states.values()].map((state) => state.holdFrom));
    let emitted = false;
    while (pending.length && pending[0].sequence < hold) {
      const next = pending.shift()!;
      pendingSize -= next.bytes;
      projection.seal();
      controller.enqueue(encoder.encode(next.frame));
      emitted = true;
    }
    return emitted;
  }

  function delta(event: Record<string, unknown>): void {
    const type = event.type as string;
    if (type === "response.output_item.done" && record(event.item)) {
      const item = event.item;
      const family = item.type === "function_call" ? "response.function_call_arguments" : item.type === "custom_tool_call" ? "response.custom_tool_call_input" : null;
      if (family) {
        const itemId = typeof item.id === "string" ? item.id : undefined;
        const id = item.type === "custom_tool_call" ? customIdentity(itemId, typeof item.call_id === "string" ? item.call_id : undefined) : itemId;
        const state = states.get(JSON.stringify([family, id, 0]));
        if (state && !state.done) finishTool(state, state.custom ? item.input : item.arguments);
      }
      return;
    }
    if (["response.content_part.done", "response.reasoning_summary_part.done"].includes(type)) return;
    if (!type.endsWith(".delta") && !type.endsWith(".done")) return;
    const family = type.replace(/\.(delta|done)$/, "");
    if (!["response.output_text", "response.refusal", "response.function_call_arguments", "response.custom_tool_call_input", "response.reasoning_text", "response.reasoning_summary_text"].includes(family)) throw new Error("private delta unsupported");
    projection.seal();
    const custom = family === "response.custom_tool_call_input", tool = custom || family === "response.function_call_arguments";
    const validId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256;
    if (event.item_id !== undefined && !validId(event.item_id) || event.call_id !== undefined && !validId(event.call_id)) throw new Error("private delta identity");
    let id = event.item_id as string | undefined;
    if (custom) id = customIdentity(id, event.call_id as string | undefined);
    if (event.output_index !== undefined) {
      if (!Number.isSafeInteger(event.output_index) || Number(event.output_index) < 0) throw new Error("private delta index");
      const index = event.output_index as number;
      id ??= items.get(index);
      if (id) {
        if (items.has(index) && items.get(index) !== id || itemIndexes.has(id) && itemIndexes.get(id) !== index) throw new Error("private item mismatch");
        items.set(index, id); itemIndexes.set(id, index);
      }
    }
    const mode = identityModes.get(family) ?? (id ? "identified" : "anonymous");
    if (type.endsWith(".delta") && mode !== (id ? "identified" : "anonymous") || tool && !id) throw new Error("private delta identity changed");
    identityModes.set(family, mode);
    if (mode === "anonymous") id = "anonymous";
    const part = family === "response.reasoning_summary_text" ? event.summary_index : tool ? 0 : event.content_index ?? 0;
    if (!Number.isSafeInteger(part) || Number(part) < 0) throw new Error("private delta index");
    const key = JSON.stringify([family, id, part]);
    const state = states.get(key) ?? { matches: secrets.map(() => 0), holdFrom: Infinity, tool, custom, toolFrom: sequence, arguments: "", argumentBytes: 0, done: false };
    if (state.done) throw new Error("private delta after done");
    if (type.endsWith(".done")) {
      if (tool && !states.has(key)) {
        const value = custom ? event.input : event.arguments;
        if (typeof value !== "string") throw new Error("private tool completion invalid");
        state.arguments = value;
      }
      if (state.tool) finishTool(state, state.custom ? event.input : event.arguments);
      state.done = true;
      state.matches.fill(0);
      state.holdFrom = Infinity;
    } else {
      if (typeof event.delta !== "string") throw new Error("private delta invalid");
      const text = privateFold(event.delta);
      if (family === "response.output_text") {
        outputText.matches = patterns.map((secret, index) => matchDelta(text, secret, tables[index], outputText.matches[index]));
        const suffix = Math.max(...outputText.matches);
        outputText.holdFrom = suffix ? suffix > text.length ? outputText.holdFrom : sequence : Infinity;
      }
      state.matches = patterns.map((secret, index) => matchDelta(text, secret, tables[index], state.matches[index]));
      const suffix = Math.max(...state.matches);
      state.holdFrom = suffix ? suffix > event.delta.length ? state.holdFrom : sequence : Infinity;
      if (state.tool) {
        state.holdFrom = state.toolFrom;
        state.arguments += event.delta;
        state.argumentBytes += encoder.encode(event.delta).byteLength;
        if (state.argumentBytes > queueLimit) throw new Error("private arguments limit");
      }
    }
    states.set(key, state);
    if (states.size > 128 || items.size > 128) throw new Error("private stream count");
  }

  function customIdentity(itemId: string | undefined, callId: string | undefined): string | undefined {
    const itemKey = itemId ? customItems.get(itemId) : undefined;
    const callKey = callId ? calls.get(callId) : undefined;
    const owner = callId ? callOwners.get(callId) : undefined;
    if (owner && itemId && owner !== itemId || itemKey && callKey && itemKey !== callKey) throw new Error("private tool identity mismatch");
    const key = itemKey ?? callKey ?? itemId ?? (callId ? `call:${callId}` : undefined);
    if (key && itemId) customItems.set(itemId, key);
    if (key && callId) calls.set(callId, key);
    if (callId && itemId) callOwners.set(callId, itemId);
    if (customItems.size > 128 || calls.size > 128) throw new Error("private stream count");
    return key;
  }

  function finishTool(state: DeltaState, value: unknown): void {
    if (typeof value !== "string" || value !== state.arguments) throw new Error("private tool content mismatch");
    if (state.custom) projection.inspect(value);
    else projection.inspect(JSON.parse(value));
    state.arguments = ""; state.done = true; state.holdFrom = Infinity; state.matches.fill(0);
  }

  async function eventFrame(frame: string, controller: ReadableStreamDefaultController<Uint8Array>): Promise<boolean> {
    if (encoder.encode(frame).byteLength > frameLimit || frame.includes("\r") && !frame.includes("\r\n")) throw new Error("private SSE frame");
    let eventName = "", data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:") && !eventName) eventName = line.slice(6).replace(/^ /, "");
      else throw new Error("private SSE field");
    }
    if (!data.length) { if (eventName) throw new Error("private SSE data missing"); return false; }
    const text = data.join("\n");
    if (text === "[DONE]") {
      if (!terminal || eventName) throw new Error("private SSE premature done");
      flush(controller, true);
      controller.enqueue(encoder.encode(terminal + "data: [DONE]\n\n"));
      ended = true;
      return true;
    }
    if (terminal) throw new Error("private SSE after terminal");
    const event: unknown = JSON.parse(text);
    if (!record(event) || typeof event.type !== "string" || !eventTypes.has(event.type) || eventName && eventName !== event.type) throw new Error("private SSE event type");
    if (["codex.rate_limits", "responsesapi.websocket_timing"].includes(event.type)) {
      // Codex consumes common model/safety envelopes before dispatching by event type.
      const protocol = await projection.event({ type: event.type, response: event.response, headers: event.headers, safety_buffering: event.safety_buffering });
      if (event.response != null || event.safety_buffering !== undefined || record(protocol.headers) && Object.keys(protocol.headers).length) throw new Error("private observation protocol unsupported");
      return false;
    }
    if (event.type === "response.failed") {
      const error = record(event.response) && record(event.response.error) ? event.response.error : null;
      if (error && typeof error.code === "string" && denialCodes.has(error.code)) {
        failure = `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: error.code, message: errorBody.error.message } } })}\n\n`;
      }
      await projection.event(event);
      throw new Error("private upstream failed");
    }
    const safe = await projection.event(event);
    if (tables.length !== secrets.length) {
      // Learning is sealed before any delta state or output exists; no prefix is discarded.
      patterns = secrets.map(privateFold);
      tables = patterns.map(prefixTable);
      outputText.matches = secrets.map(() => 0);
    }
    const serialized = `${eventName ? `event: ${eventName}\n` : ""}data: ${JSON.stringify(safe)}\n\n`;
    if (["response.completed", "response.incomplete"].includes(event.type)) {
      if (!record(event.response) || typeof event.response.id !== "string" || !event.response.id
        || event.response.status !== undefined && event.response.status !== event.type.slice("response.".length)) throw new Error("private terminal status");
      for (const state of states.values()) if (state.tool && !state.done) throw new Error("private tool unfinished");
      terminal = serialized;
      return false;
    }
    delta(event);
    const frameBytes = encoder.encode(serialized).byteLength;
    pending.push({ sequence: sequence++, frame: serialized, bytes: frameBytes });
    pendingSize += frameBytes;
    if (pendingSize > queueLimit || pending.length > 1024) throw new Error("private holdback limit");
    return flush(controller);
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!ended && !canceled) {
          const separator = /\r?\n\r?\n/.exec(buffer);
          if (separator) {
            const frame = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator[0].length);
            if (await eventFrame(frame, controller)) {
              if (ended) { cancel(reader); abort(); controller.close(); }
              return;
            }
            continue;
          }
          if (buffer.length > frameLimit) throw new Error("private frame limit");
          const result = await read(reader, signal);
          if (canceled) return;
          if (result.done) {
            buffer += decoder.decode();
            if (buffer.trim() || !terminal) throw new Error("private truncated stream");
            flush(controller, true);
            controller.enqueue(encoder.encode(terminal));
            ended = true;
            abort();
            controller.close();
            return;
          }
          bytes += result.value.byteLength;
          if (bytes > streamLimit || result.value.byteLength > queueLimit) throw new Error("private stream limit");
          buffer += decoder.decode(result.value, { stream: true });
        }
      } catch {
        pending = []; states.clear(); buffer = ""; terminal = null;
        cancel(reader); abort(); ended = true;
        if (!canceled) {
          // Even a local denial code/message must not echo a newly learned identity.
          try { projection.inspect(failure); controller.enqueue(encoder.encode(failure)); } catch { /* close without content */ }
          controller.close();
        }
      }
    },
    cancel() { canceled = true; pending = []; states.clear(); buffer = ""; cancel(reader); abort(); },
  }, { highWaterMark: 0 });
}
