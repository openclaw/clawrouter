import { inputRetirement } from "./input-retirement.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";
import { prepareXaiSpeech, readXaiSpeech, xaiSpeechFormats } from "./xai-speech.ts";

const outputLimit = 16 * 1024 * 1024, chunkLimit = 8192;

// Credential authority, admission and settlement belong to common dispatch.
export function prepareNativeXaiSpeech(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, body } = selection;
  if (endpoint.request_format !== "xai.tts") return;
  if (provider.id !== "xai" || provider.base_urls.default !== "https://api.x.ai"
    || selection.model !== null || selection.capability !== "audio.speech"
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/v1/tts"
    || endpoint.response_format !== "audio.binary" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_xai_speech_route", "xAI speech requires its qualified model-less native binary route");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > 512 * 1024) invalid();
    prepared = prepareXaiSpeech(body);
  } catch {
    throw new HttpError(400, "invalid_native_xai_speech_request", "xAI speech requires bounded native text, voice, language and codec settings");
  }
  const mime = xaiSpeechFormats[prepared.codec];
  return {
    origin: "https://api.x.ai", path: prepared.path,
    // 64 MiB charged for bounded transport chunks, codec assembly and delivery.
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding");
      if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
        || response.headers.get("content-type")?.trim().toLowerCase() !== mime
        || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        if (response.body) await inputRetirement(response.body.getReader()).retire("cancel");
        invalid();
      }
      const headers = new Headers(response.headers);
      // The codec skips length comparison when encoding exists. Identity must
      // be removed from its view while the original Content-Length is retained.
      headers.delete("content-encoding");
      let chunks = 0, bytes = 0;
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          // Empty chunks count too: the codec retains one object per chunk.
          if (++chunks > chunkLimit || !(chunk instanceof Uint8Array)
            || (bytes += chunk.byteLength) > outputLimit) invalid();
          controller.enqueue(chunk);
        },
      });
      const pipe = response.body.pipeTo(transform.writable);
      void pipe.catch(() => undefined);
      const bounded = transform.readable;
      try {
        const observed = await readXaiSpeech(new Response(bounded, { status: 200, headers }), prepared, signal);
        await pipe;
        signal.throwIfAborted();
        const audio = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(observed.audio); controller.close();
        } });
        return { response: new Response(audio, { status: 200, headers: {
          "content-type": mime, "content-length": String(observed.audio.byteLength),
          "cache-control": "no-store", "x-content-type-options": "nosniff",
        } }), usage: { tokens: null, outcome: "success" as const } };
      } catch { invalid(); }
      finally { await pipe.catch(() => undefined); }
    },
  };
}

function invalid(): never { throw new Error("invalid_native_xai_speech_response"); }

