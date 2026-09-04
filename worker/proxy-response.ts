import { extractSseUsageTokens, extractUsageTokens, type UsageTokens } from "./token-usage.ts";

// Accounting observes the delivered stream; a tee would drain upstream ahead of
// the client and buffer arbitrary output. Inspection alone is capped at 2 MiB.
export function observeUsage(response: Response): { response: Response; tokens: Promise<UsageTokens | null> } {
  if (!response.body) return { response, tokens: Promise.resolve(null) };
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  let inspect = contentType.includes("json") || contentType.includes("text/event-stream");
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let text = "", bytes = 0, finished = false;
  let resolve!: (tokens: UsageTokens | null) => void;
  const tokens = new Promise<UsageTokens | null>(done => { resolve = done; });
  function finish(complete: boolean) {
    if (finished) return;
    finished = true;
    let measured: UsageTokens | null = null;
    if (complete && inspect) {
      try {
        text += decoder.decode();
        measured = contentType.includes("json") ? extractUsageTokens(JSON.parse(text)) : extractSseUsageTokens(text);
      } catch { /* Incomplete usage keeps the conservative reservation. */ }
    }
    text = "";
    reader.releaseLock();
    resolve(measured);
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { finish(true); controller.close(); return; }
        if (inspect) {
          bytes += next.value.byteLength;
          if (bytes > 2 * 1024 * 1024) { inspect = false; text = ""; }
          else text += decoder.decode(next.value, { stream: true });
        }
        controller.enqueue(next.value);
      } catch (error) { finish(false); controller.error(error); }
    },
    cancel(reason) {
      const canceled = reader.cancel(reason);
      finish(false);
      return canceled;
    },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), tokens };
}

export async function normalizePreStreamError(response: Response, streamingRequested: boolean): Promise<Response> {
  if (!streamingRequested) return response;
  const eventStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
  if (response.status >= 400) {
    if (eventStream && response.body) return normalizeFirstSseEvent(response, response.status);
    const body = await readLimited(response, 64 * 1024).catch(() => "");
    return mappedUpstreamError(response, upstreamError(body), response.status);
  }
  if (!response.ok || !eventStream || !response.body) return response;
  return normalizeFirstSseEvent(response, null);
}

const FIRST_SSE_EVENT_LIMIT = 8 * 1024;

async function normalizeFirstSseEvent(response: Response, errorStatus: number | null): Promise<Response> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  const sniffed = new Uint8Array(FIRST_SSE_EVENT_LIMIT);
  let sniffedLength = 0;
  let eventStart = 0;
  while (true) {
    const { done, value } = await reader.read();
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
      if (errorStatus !== null || event.kind === "error") {
        await reader.cancel().catch(() => undefined);
        const upstream = event.upstream;
        const status = errorStatus ?? (typeof upstream.code === "number" && Number.isInteger(upstream.code) && upstream.code >= 400 && upstream.code <= 599 ? upstream.code : 502);
        return mappedUpstreamError(response, upstream, status);
      }
      return replayResponse(response, reader, chunks, done);
    }
    if (done || sniffedLength === FIRST_SSE_EVENT_LIMIT) {
      if (errorStatus === null) return replayResponse(response, reader, chunks, done);
      if (!done) await reader.cancel().catch(() => undefined);
      return mappedUpstreamError(response, {}, errorStatus);
    }
  }
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
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function sseEventBoundary(bytes: Uint8Array, start: number, length: number): { start: number; end: number } | null {
  let lineStart = start;
  for (let index = start; index < length; index += 1) {
    if (bytes[index] !== 10 && bytes[index] !== 13) continue;
    const next = bytes[index] === 13 && index + 1 < length && bytes[index + 1] === 10 ? index + 2 : index + 1;
    if (index === lineStart) return { start: lineStart, end: next };
    lineStart = next;
    index = next - 1;
  }
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

function mappedUpstreamError(response: Response, upstream: ReturnType<typeof upstreamError>, status: number): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  return Response.json({ error: {
    message: upstream.message ?? (response.ok ? "upstream request failed" : response.statusText || "upstream request failed"),
    type: upstream.type ?? "upstream_error",
    code: upstream.code ?? status,
  } }, { status, statusText: status === response.status ? response.statusText : "", headers });
}

function upstreamError(body: string): { message?: string; type?: string; code?: string | number } {
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
    code: typeof error.code === "string" || typeof error.code === "number" ? error.code : undefined,
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

async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("usage payload exceeds inspection limit");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { if (size > limit) await reader.cancel(); }
}
