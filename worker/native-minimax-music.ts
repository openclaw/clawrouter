import { jsonBodyBytes } from "./json-body.ts";
import { mediaObject } from "./managed-media-json.ts";
import { observeMiniMaxMusic, prepareMiniMaxMusic, readMiniMaxMusicStream, type MiniMaxMusicRequest } from "./minimax-music.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const audioLimit = 4 * 1024 * 1024, responseLimit = audioLimit * 2 + 65536;

// Common dispatch must separately qualify original global music authority.
// A speech grant, OAuth/Plan/CN credential or this leaf supplies no entitlement.
export function prepareNativeMiniMaxMusic(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "minimax.music") return;
  const streaming = mediaObject(body) && body.stream === true;
  if (provider.id !== "minimax" || provider.base_urls.default !== "https://api.minimax.io"
    || selection.capability !== "music.generate" || !model || !model.capabilities.includes("music.generate")
    || !["music-2.6", "music-2.6-free"].includes(model.upstream)
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/v1/music_generation"
    || endpoint.response_format !== "minimax.music" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || (streaming ? endpoint.streaming !== "sse" : !!endpoint.streaming) || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_minimax_music_route", "MiniMax music requires its selected model and qualified global native path");
  }
  try {
    if (jsonBodyBytes(body) > 65536 || !mediaObject(body) || body.model !== model.upstream || body.stream !== false && body.stream !== true) invalid();
    if (streaming && ["audio_url", "audio_base64"].some(key => Object.hasOwn(body, key))) invalid();
    prepareMiniMaxMusic("global", body);
  } catch {
    throw new HttpError(400, "invalid_native_minimax_music_request", "MiniMax music input must match its frozen native model and explicit hex mode");
  }
  return musicResponse(model.upstream, streaming);
}

// Separate closure scope: retain primitive response context, never selection/body.
function musicResponse(model: string, streaming: boolean): NativeResponse {
  const origin = "https://api.minimax.io", path = "/v1/music_generation";
  return {
    origin, path,
    // BodyLease charges 64 MiB for JSON, hex and decoded-audio copies.
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      if (streaming) {
        try {
          const observed = await readMiniMaxMusicStream(response, model, signal);
          signal.throwIfAborted();
          return { response: new Response(musicReplay(observed.audio, observed.terminal, signal), { status: 200, headers: {
            "content-type": "text/event-stream", "cache-control": "no-store", "x-content-type-options": "nosniff",
          } }), usage: { tokens: null, outcome: "success" as const } };
        } catch { invalid(); }
      }
      const encoding = response.headers.get("content-encoding"), mime = response.headers.get("content-type");
      if (response.status !== 200 || response.redirected
        || !mime || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
        || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      if (encoding !== null) {
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        response = new Response(response.body, { status: response.status, headers });
      }
      return readNativeJson(response, signal, responseLimit, value => {
        // Bound full-file hex before the codec allocates decoded bytes.
        if (!mediaObject(value) || !mediaObject(value.data) || typeof value.data.audio !== "string"
          || value.data.audio.length > audioLimit * 2 + 2 || value.data.audio.trim().length > audioLimit * 2) invalid();
        for (const envelope of [value, value.data]) {
          if (["audio_url", "audio_base64", "file_id", "file", "url", "task_id"].some(key => Object.hasOwn(envelope, key))) invalid();
        }
        const context: MiniMaxMusicRequest = { origin, path, model, body: { stream: false }, headers: new Headers() };
        const observed = observeMiniMaxMusic([value], context, true);
        if (observed.audio.length > audioLimit) invalid();
        return { response: nativeJsonResponse(observed.frames[0], new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens: null, outcome: "success" as const } };
      }, invalid);
    },
  };
}

// Replay one complete native terminal aggregate: the frozen consumer otherwise
// drops a longer terminal aggregate after deltas. Never retain full-file hex.
function musicReplay(audio: Uint8Array<ArrayBuffer>, terminal: Record<string, unknown>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const { data, ...rest } = terminal;
  if (!mediaObject(data)) invalid();
  const metadata = JSON.stringify({ ...rest, data: { ...data, status: 2 } });
  const encoder = new TextEncoder(), hex = "0123456789abcdef", window = 64 * 1024;
  let prefix: Uint8Array | null = encoder.encode("data: " + metadata.slice(0, -2) + ',"audio":"');
  if (prefix.byteLength > 1024 * 1024) invalid();
  const suffix = encoder.encode('"}}\n\ndata: [DONE]\n\n');
  let retained: Uint8Array | null = audio, before = 0, offset = 0, after = 0;
  // Do not keep an additional parameter reference after the owned slot retires.
  audio = new Uint8Array(0);
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  const retire = () => { retained = null; prefix = null; control = undefined; signal.removeEventListener("abort", abort); };
  const abort = () => { control?.error(signal.reason); retire(); };
  return new ReadableStream<Uint8Array>({
    start(controller) { control = controller; if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); },
    pull(controller) {
      if (!retained || !prefix) { controller.close(); retire(); return; }
      if (before < prefix.length) {
        const end = Math.min(prefix.length, before + window); controller.enqueue(prefix.slice(before, end)); before = end; return;
      }
      if (offset < retained.length) {
        const count = Math.min(window / 2, retained.length - offset), chunk = new Uint8Array(count * 2);
        for (let i = 0; i < count; i++) { const byte = retained[offset++]; chunk[i * 2] = hex.charCodeAt(byte >>> 4); chunk[i * 2 + 1] = hex.charCodeAt(byte & 15); }
        controller.enqueue(chunk); return;
      }
      if (!after) { after = suffix.length; controller.enqueue(suffix); }
      controller.close(); retire();
    },
    cancel() { retire(); },
  }, { highWaterMark: 0 });
}

function invalid(): never { throw new Error("invalid_native_minimax_music_response"); }

