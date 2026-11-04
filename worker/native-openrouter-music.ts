import { jsonBodyBytes, utf8Length } from "./json-body.ts";
import { mediaObject } from "./managed-media-json.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { openRouterMusicModels, prepareOpenRouterMusic, readOpenRouterMusic } from "./openrouter-music.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { createSseFrames } from "./token-usage.ts";
import { HttpError } from "./utils.ts";

const wireLimit = 4 * 1024 * 1024, audioLimit = 2 * 1024 * 1024, transcriptLimit = 128 * 1024;
const readLimit = 8192, eventLimit = 8192, frameLimit = 256 * 1024;
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
  return {
    origin: "https://openrouter.ai", path: prepared.path,
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding"), length = response.headers.get("content-length");
      if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
        || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream"
        || encoding !== null && encoding.trim().toLowerCase() !== "identity"
        || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > wireLimit)) {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      try {
        const wire = await quarantine(response.body, signal);
        if (length !== null && Number(length) !== wire.byteLength) invalid();
        // Decode only after the smaller wire/audio bounds are established. The
        // native codec still owns model/ID, base64, usage and terminal validation.
        // This is local validation, never a second upstream request.
        const headers = new Headers({ "content-type": "text/event-stream", "content-length": String(wire.byteLength) });
        const observed = await readOpenRouterMusic(new Response(replay(wire), { headers }), prepared, signal);
        if (observed.audio.byteLength > audioLimit) invalid();
        signal.throwIfAborted();
        headers.set("cache-control", "no-store"); headers.set("x-content-type-options", "nosniff");
        return { response: new Response(replay(wire), { status: 200, headers }),
          usage: { tokens: null, outcome: "success" as const } };
      } catch { invalid(); }
    },
  };
}

async function quarantine(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const wire = new Uint8Array(wireLimit);
  let size = 0, reads = 0, events = 0, encodedAudio = 0, audioTail = "", transcriptBytes = 0, done = false, carriage = false;
  const frames = createSseFrames(frame => {
    if (frame === null || ++events > eventLimit || frame.length > frameLimit || utf8Length(frame) > frameLimit
      || done && frame.trim()) invalid();
    // Bound split/JSON allocations as well as bytes. The shared framer's 2 MiB
    // scratch bound alone does not bound the number of tiny SSE header strings.
    let lines = 0;
    for (let index = 0; index < frame.length; index++) if (frame[index] === "\n" && ++lines > 32) invalid();
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      // The common pre-stream error sniffer must never turn paid music into a
      // free rejection, including an error event with an otherwise valid body.
      if (line.startsWith("event:") && line.slice(6).trim() === "error") invalid();
    }
    // The frozen client parses each data line independently, unlike multiline SSE.
    if (data.length > 1) invalid();
    if (!data.length) return;
    if (data[0] === "[DONE]") {
      const padding = audioTail.endsWith("==") ? 2 : audioTail.endsWith("=") ? 1 : 0;
      if (Math.floor((encodedAudio - padding) * 3 / 4) > audioLimit) invalid();
      done = true; return;
    }
    const value: unknown = JSON.parse(data[0]);
    if (!mediaObject(value) || Object.hasOwn(value, "error")) invalid();
    const choice = Array.isArray(value.choices) ? value.choices[0] : null;
    const delta = mediaObject(choice) && mediaObject(choice.delta) ? choice.delta : null;
    const audio = delta && mediaObject(delta.audio) ? delta.audio : null;
    if (audio?.data !== undefined) {
      if (typeof audio.data !== "string" || (encodedAudio += audio.data.length) > Math.ceil(audioLimit / 3) * 4) invalid();
      audioTail = (audioTail + audio.data.slice(-2)).slice(-2);
    }
    if (audio?.transcript !== undefined) {
      if (typeof audio.transcript !== "string" || (transcriptBytes += utf8Length(audio.transcript)) > transcriptLimit) invalid();
    }
  }, true);
  const reader = body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      if (++reads > readLimit) invalid();
      const part = await reader.read(); signal.throwIfAborted();
      if (part.done) invalid(); // Only native [DONE], never socket EOF, completes music.
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > wireLimit - size) invalid();
      // Require LF or CRLF so the original client can parse the unchanged bytes.
      for (const byte of part.value) {
        if (carriage && byte !== 10) invalid();
        carriage = byte === 13;
      }
      wire.set(part.value, size); size += part.value.byteLength;
      frames.push(part.value);
      if (frames.overflowed()) invalid();
      if (done) {
        const tail = frames.pending();
        if (carriage || tail === null || tail.trim()) invalid();
        return wire.subarray(0, size);
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    signal.removeEventListener("abort", abort); reader.releaseLock();
  }
}

function replay(wire: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === wire.byteLength) { controller.close(); return; }
      const end = Math.min(offset + 64 * 1024, wire.byteLength);
      controller.enqueue(wire.subarray(offset, end)); offset = end;
    },
    cancel() { offset = wire.byteLength; },
  }, { highWaterMark: 0 });
}

function invalid(): never { throw new Error("invalid_native_openrouter_music_response"); }
