import { inputRetirement } from "./input-retirement.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { prepareOpenRouterSpeech, readOpenRouterSpeech } from "./openrouter-speech.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const modelId = "google/gemini-3.1-flash-tts-preview";
const outputLimit = 16 * 1024 * 1024, readLimit = 8192;

// Common dispatch must select this leaf before the MP3 factory and retain the
// original OpenRouter grant, admission, deadline and conservative settlement.
export function prepareNativeOpenRouterPcmSpeech(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (provider.id !== "openrouter" || endpoint.request_format !== "openai.audio_speech"
    || model?.upstream !== modelId) return;
  if (provider.base_urls.default !== "https://openrouter.ai/api"
    || !model.capabilities.includes("audio.speech") || selection.capability !== "audio.speech"
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/v1/audio/speech"
    || endpoint.response_format !== "audio.binary" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_openrouter_pcm_speech_route", "OpenRouter PCM speech requires its qualified model and fixed route");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > 256 * 1024 || Object.hasOwn(body, "speed")) invalid();
    prepared = prepareOpenRouterSpeech(model.upstream, body);
    if (prepared.format !== "pcm") invalid();
  } catch {
    throw new HttpError(400, "invalid_native_openrouter_pcm_speech_request", "OpenRouter PCM speech requires bounded text, explicit voice and PCM without speed");
  }
  return {
    origin: "https://openrouter.ai", path: prepared.path,
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding");
      if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
        || response.headers.get("content-type")?.trim().toLowerCase() !== "audio/pcm"
        || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        if (response.body) await inputRetirement(response.body.getReader()).retire("cancel");
        invalid();
      }
      const headers = new Headers(response.headers);
      // Preserve Content-Length; identity must not exempt the codec's EOF check.
      headers.delete("content-encoding");
      let reads = 0, bytes = 0;
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (++reads > readLimit || !(chunk instanceof Uint8Array) || !(chunk.buffer instanceof ArrayBuffer)
            || chunk.buffer.byteLength > outputLimit || (bytes += chunk.byteLength) > outputLimit) invalid();
          // A plain view makes the existing codec's slice() a copy even for a
          // Node Buffer. Tiny views cannot retain an oversized backing buffer.
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        },
        // Bound every empty/data read and EOF. Samples may span HTTP chunks.
        flush() { if (++reads > readLimit || bytes % 2 !== 0) invalid(); },
      }, { highWaterMark: 1 }, { highWaterMark: 0 });
      const pipe = response.body.pipeTo(transform.writable);
      void pipe.catch(() => undefined);
      const bounded = transform.readable;
      try {
        const observed = await readOpenRouterSpeech(new Response(bounded, { status: 200, headers }), prepared, signal);
        await pipe;
        signal.throwIfAborted();
        const outputHeaders = new Headers({
          "content-type": "audio/pcm", "content-length": String(observed.audio.byteLength),
          "cache-control": "no-store", "x-content-type-options": "nosniff",
        });
        if (observed.generationId !== null) outputHeaders.set("x-generation-id", observed.generationId);
        const audio = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(observed.audio); controller.close();
        } });
        return { response: new Response(audio, { status: 200, headers: outputHeaders }),
          usage: { tokens: null, outcome: "success" as const } };
      } catch { invalid(); }
      finally { await pipe.catch(() => undefined); }
    },
  };
}

function invalid(): never { throw new Error("invalid_native_openrouter_pcm_speech_response"); }
