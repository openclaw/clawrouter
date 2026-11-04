import { parseBoundedJson } from "./json-body.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { extractUsageTokens } from "./token-usage.ts";
import { sseEventBoundary, type SseBoundaryCursor } from "./proxy-response.ts";
import { prepareVeniceChatBinding, validateVeniceReturnedModel, type VeniceChatBinding } from "./venice-chat-binding.ts";
import { HttpError } from "./utils.ts";

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
        if (!authority) invalid();
        return { response: gatedEvents(response, signal, binding, authority), observeUsage: true as const };
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
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== (streaming ? "text/event-stream" : "application/json")
    || encoding !== null && encoding.trim().toLowerCase() !== "identity"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
    void response.body?.cancel().catch(() => undefined); invalid();
  }
  const wire = new Uint8Array(limit), reader = response.body.getReader(); let size = 0, reads = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      if (++reads > maxReads) invalid();
      const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
      if (next.value.byteLength > limit - size) invalid();
      wire.set(next.value, size); size += next.value.byteLength;
    }
    if (!size || length !== null && Number(length) !== size) invalid();
    return wire.subarray(0, size);
  } catch (error) { void reader.cancel(error).catch(() => undefined); throw error; }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

function gatedEvents(response: Response, signal: AbortSignal, binding: VeniceChatBinding,
  authority: { revalidate(signal: AbortSignal): Promise<void>; assertLive(): void }): Response {
  const length = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream"
    || encoding !== null && encoding.trim().toLowerCase() !== "identity"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    void response.body?.cancel().catch(() => undefined); invalid();
  }
  const reader = response.body.getReader(), frame = new Uint8Array(frameLimit);
  let size = 0, pending: Uint8Array | null = null, offset = 0, total = 0, emptyReads = 0;
  const cursor: SseBoundaryCursor = { offset: 0, lineStart: 0 };
  let terminal = false, modelSeen = false, authorityReady = false, closed = false, upstreamDone = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  function finish(reason?: unknown) {
    if (closed) return; closed = true;
    signal.removeEventListener("abort", abort);
    if (reason !== undefined) void reader.cancel(reason).catch(() => undefined);
    reader.releaseLock(); pending = null; size = 0;
  }
  const abort = () => { const error = signal.reason ?? new Error("request canceled"); finish(error); output.error(error); };
  const body = new ReadableStream<Uint8Array>({
    start(controller) { output = controller; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    async pull(controller) {
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
            finish(); controller.close(); return;
          }
          if (size === frameLimit) invalid();
          if (pending && offset < pending.length) {
            const count = Math.min(pending.length - offset, frameLimit - size);
            frame.set(pending.subarray(offset, offset + count), size); size += count; offset += count;
            if (offset === pending.length) { pending = null; offset = 0; }
            continue;
          }
          const next = await reader.read(); if (closed) return; signal.throwIfAborted();
          if (next.done) { upstreamDone = true; cursor.eof = true; continue; }
          if (next.value.byteLength > limit || next.value.buffer.byteLength > limit || !Number.isSafeInteger(total += next.value.byteLength)) invalid();
          if (!next.value.byteLength) { if (++emptyReads > 32) invalid(); continue; }
          emptyReads = 0; pending = next.value; offset = 0;
        }
      } catch (error) { if (!closed) { finish(error); controller.error(error); } }
    },
    cancel(reason) { finish(reason ?? new Error("delivery canceled")); },
  }, { highWaterMark: 0 });
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "etag", "digest", "content-md5"]) headers.delete(name);
  headers.set("cache-control", "private, no-store");
  return new Response(body, { status: 200, headers });
}

function invalid(): never { throw new HttpError(502, "invalid_venice_chat_response", "Venice Chat response could not confirm complete selected-model delivery"); }
