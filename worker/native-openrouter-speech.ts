import { jsonBodyBytes } from "./json-body.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { prepareOpenRouterSpeech, readOpenRouterSpeech } from "./openrouter-speech.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const models = new Set(["hexgrad/kokoro-82m", "elevenlabs/eleven-turbo-v2", "mistralai/voxtral-mini-tts-2603"]);
const outputLimit = 16 * 1024 * 1024, readLimit = 8192;

// Common dispatch owns the original OpenRouter grant, admission and settlement.
export function prepareNativeOpenRouterSpeech(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (provider.id !== "openrouter" || endpoint.request_format !== "openai.audio_speech") return;
  if (provider.base_urls.default !== "https://openrouter.ai/api"
    || !model || !models.has(model.upstream) || !model.capabilities.includes("audio.speech") || selection.capability !== "audio.speech"
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/v1/audio/speech"
    || endpoint.response_format !== "audio.binary" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_openrouter_speech_route", "OpenRouter speech requires its qualified model and fixed MP3 route");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > 256 * 1024) invalid();
    prepared = prepareOpenRouterSpeech(model.upstream, body);
    if (prepared.format !== "mp3") invalid();
  } catch {
    throw new HttpError(400, "invalid_native_openrouter_speech_request", "OpenRouter speech requires bounded text, explicit voice and MP3 format");
  }
  return {
    // The configured base already contains /api; the selected endpoint is /v1/audio/speech.
    origin: "https://openrouter.ai", path: prepared.path,
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding");
      if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
        || response.headers.get("content-type")?.trim().toLowerCase() !== "audio/mpeg"
        || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      const headers = new Headers(response.headers);
      // Identity must not trigger the codec's encoded-body length exemption.
      headers.delete("content-encoding");
      let reads = 0, bytes = 0;
      const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (++reads > readLimit || !(chunk instanceof Uint8Array) || (bytes += chunk.byteLength) > outputLimit) invalid();
          controller.enqueue(chunk);
        },
        // Count the EOF read as well as every data/empty read.
        flush() { if (++reads > readLimit) invalid(); },
      }));
      try {
        const observed = await readOpenRouterSpeech(new Response(bounded, { status: 200, headers }), prepared, signal);
        signal.throwIfAborted();
        const outputHeaders = new Headers({
          "content-type": "audio/mpeg", "content-length": String(observed.audio.byteLength),
          "cache-control": "no-store", "x-content-type-options": "nosniff",
        });
        if (observed.generationId !== null) outputHeaders.set("x-generation-id", observed.generationId);
        const audio = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(observed.audio); controller.close();
        } });
        return { response: new Response(audio, { status: 200, headers: outputHeaders }),
          usage: { tokens: null, outcome: "success" as const } };
      } catch { invalid(); }
    },
  };
}

function invalid(): never { throw new Error("invalid_native_openrouter_speech_response"); }
