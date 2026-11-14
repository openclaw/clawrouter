import { inputRetirement } from "./input-retirement.ts";
import { jsonBodyBytes, utf8Length } from "./json-body.ts";
import { createJsonTokenizer } from "./json-tokens.ts";
import { mediaObject } from "./managed-media-json.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { createOpenRouterMusicInspector, openRouterMusicModels, prepareOpenRouterMusic, type OpenRouterMusicContext } from "./openrouter-music.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { createSseFrames } from "./token-usage.ts";
import { HttpError } from "./utils.ts";

const wireLimit = 32 * 1024 * 1024, windowLimit = 64 * 1024;
const readLimit = 262144, eventLimit = 8192, frameLimit = 2 * 1024 * 1024;
const isMusic = (model: unknown) => openRouterMusicModels.some(value => value === model);

// Common selection owns original OpenRouter credentials, admission and pricing.
// Call before generic Chat validation; this leaf grants no image/reference authority.
export function prepareNativeOpenRouterMusic(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (provider.id !== "openrouter" || selection.capability !== "music.generate"
    && !isMusic(model?.upstream) && !(mediaObject(body) && isMusic(body.model))) return;
  if (provider.base_urls.default !== "https://openrouter.ai/api"
    || !model || !isMusic(model.upstream) || !model.capabilities.includes("music.generate") || selection.capability !== "music.generate"
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/v1/chat/completions"
    || endpoint.request_format !== "openai.chat_completions" || endpoint.response_format !== "openai.chat_completions"
    || endpoint.streaming !== "sse" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_openrouter_music_route", "OpenRouter music requires its selected Lyria model and explicit native SSE route");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > 256 * 1024 || !mediaObject(body) || !Array.isArray(body.messages)
      || !mediaObject(body.messages[0]) || typeof body.messages[0].content !== "string") invalid();
    prepared = prepareOpenRouterMusic(model.upstream, body);
  } catch {
    throw new HttpError(400, "invalid_native_openrouter_music_request", "OpenRouter music requires bounded text, explicit MP3 or WAV and native streaming");
  }
  return nativeOpenRouterMusicResponse({ model: prepared.model, format: prepared.format });
}

// Internal response construction only. The caller owns body validation,
// original selection/grants, admission and the full input/response lifetime.
export function nativeOpenRouterMusicResponse(context: OpenRouterMusicContext): NativeResponse {
  const model = context?.model, format = context?.format;
  if (typeof model !== "string" || !isMusic(model) || format !== "mp3" && format !== "wav") {
    throw new HttpError(400, "invalid_native_openrouter_music_context", "OpenRouter music requires its frozen Lyria identity and MP3 or WAV format");
  }
  // Never pass a structurally wider caller object into response closures.
  return musicResponse(Object.freeze({ model, format }));
}

// This closure scope receives only immutable response metadata, never selection
// or the prepared request. Request/body ownership stays outside response lifetime.
function musicResponse(context: OpenRouterMusicContext): NativeResponse {
  return {
    origin: "https://openrouter.ai", path: "/api/v1/chat/completions",
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding"), length = response.headers.get("content-length");
      if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
        || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream"
        || encoding !== null && encoding.trim().toLowerCase() !== "identity"
        || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > wireLimit)) {
        if (response.body) await inputRetirement(response.body.getReader()).retire("cancel");
        invalid();
      }
      try {
        const wire = await quarantine(response.body, context, signal);
        if (length !== null && Number(length) !== wire.byteLength) invalid();
        // The codec's scalar inspector already validated the original 16 MiB
        // audio bound. No aggregate base64, decoded audio or transcript is kept.
        const headers = new Headers({ "content-type": "text/event-stream", "content-length": String(wire.byteLength) });
        signal.throwIfAborted();
        headers.set("cache-control", "no-store"); headers.set("x-content-type-options", "nosniff");
        return { response: new Response(replay(wire), { status: 200, headers }),
          usage: { tokens: null, outcome: "success" as const } };
      } catch { invalid(); }
    },
  };
}

async function quarantine(body: ReadableStream<Uint8Array>, context: OpenRouterMusicContext, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  let reader: ReadableStreamBYOBReader;
  try { reader = body.getReader({ mode: "byob" }); }
  catch { if (!body.locked) await inputRetirement(body.getReader()).retire("cancel"); invalid(); }
  const input = inputRetirement(reader);
  const inspection = createOpenRouterMusicInspector(context);
  let size = 0, reads = 0, events = 0, carriage = false;
  const frames = createSseFrames(frame => {
    if (frame === null || ++events > eventLimit || frame.length > frameLimit || utf8Length(frame) > frameLimit
      || inspection.isDone() && frame.trim()) invalid();
    // Bound split/JSON allocations as well as bytes. The shared framer's 2 MiB
    // scratch bound alone does not bound the number of tiny SSE header strings.
    let lines = 0;
    for (let index = 0; index < frame.length; index++) if (frame[index] === "\n" && ++lines > 32) invalid();
    let data: string | undefined;
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") { if (data !== undefined) invalid(); data = value; }
      else if (field !== "event" && field !== "id" && field !== "retry") invalid();
      // The common pre-stream error sniffer must never turn paid music into a
      // free rejection, including an error event with an otherwise valid body.
      if (field === "event" && value.trim() === "error") invalid();
    }
    // The frozen client parses each data line independently, unlike multiline SSE.
    if (data === undefined) return;
    if (data !== "[DONE]") rejectErrorField(data);
    inspection.accept(data);
  }, true);
  const abort = () => { void input.retire("cancel", signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const wire = new Uint8Array(wireLimit);
    let window = new Uint8Array(windowLimit);
    for (;;) {
      if (++reads > readLimit) invalid();
      // Never lend quarantine to BYOB: read() transfers the supplied buffer.
      // No minimum fill: a small native DONE must complete on an open socket.
      const part = await input.read(() => reader.read(window)); signal.throwIfAborted();
      if (part.done) invalid(); // Only native [DONE], never socket EOF, completes music.
      if (!(part.value instanceof Uint8Array) || !part.value.byteLength || part.value.byteLength > windowLimit
        || !(part.value.buffer instanceof ArrayBuffer) || part.value.buffer.byteLength > windowLimit
        || part.value.byteLength > wireLimit - size) invalid();
      // Require LF or CRLF so the original client can parse the unchanged bytes.
      for (const byte of part.value) {
        if (carriage && byte !== 10) invalid();
        carriage = byte === 13;
      }
      wire.set(part.value, size); size += part.value.byteLength;
      frames.push(part.value);
      if (frames.overflowed()) invalid();
      // CR completes an SSE line in the shared parser, but the frozen client
      // needs its paired LF. Keep reading when that pair crosses a chunk.
      if (inspection.isDone() && !carriage) {
        const tail = frames.pending();
        if (tail === null || tail.trim()) invalid();
        inspection.result(); // Final quartet/padding, transcript and nonempty-audio checks.
        return wire.subarray(0, size);
      }
      // Only the returned view owns the transferred window now.
      window = new Uint8Array(part.value.buffer);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    // Preserve the codec's cleanup call on EOF rejection too. Native DONE
    // requires cancellation of the open source, not an EOF retirement claim.
    await input.retire("cancel", signal.reason);
  }
}

// Scan root keys without a second JSON.parse/object graph. The codec permits
// error:null; common pre-stream rejection does not. Escaped keys also count.
function rejectErrorField(data: string): void {
  let depth = 0, key = false, name = "";
  const tokens = createJsonTokenizer(token => {
    if (token.name === "startObject" || token.name === "startArray") depth++;
    else if (token.name === "endObject" || token.name === "endArray") depth--;
    else if (token.name === "startKey") { key = depth === 1; name = ""; }
    else if (token.name === "stringChunk" && key) name = (name + token.value.slice(0, 6)).slice(0, 6);
    else if (token.name === "endKey") { if (key && name === "error") invalid(); key = false; }
  });
  for (let offset = 0; offset < data.length; offset += 1024) tokens.push(data.slice(offset, offset + 1024));
  tokens.end();
}

function replay(wire: Uint8Array): ReadableStream<Uint8Array> {
  let retained: Uint8Array | null = wire, offset = 0;
  return new ReadableStream<Uint8Array>({ type: "bytes",
    pull(controller) {
      if (!("byobRequest" in controller)) invalid();
      if (!retained || offset === retained.byteLength) {
        retained = null; controller.close(); controller.byobRequest?.respond(0); return;
      }
      const requested = controller.byobRequest?.view;
      const size = Math.min(windowLimit, retained.byteLength - offset, requested?.byteLength ?? windowLimit);
      const chunk = requested ? new Uint8Array(requested.buffer, requested.byteOffset, size) : new Uint8Array(size);
      chunk.set(retained.subarray(offset, offset + size)); offset += size;
      // Byte controllers detach enqueued buffers. Only a delivery copy, never a
      // borrowed quarantine view, may cross this boundary.
      if (requested) controller.byobRequest!.respond(size); else controller.enqueue(chunk);
    },
    cancel() { retained = null; },
  }, { highWaterMark: 0 });
}

function invalid(): never { throw new Error("invalid_native_openrouter_music_response"); }
