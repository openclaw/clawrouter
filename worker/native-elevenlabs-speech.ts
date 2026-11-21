import { nativeMp3ResponseLimit as outputLimit, readNativeMp3Response } from "./native-mp3-response.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { nativeQuerySearch } from "./native-query.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const responseErrors = { invalid: "invalid_elevenlabs_binary_response", limit: "elevenlabs_binary_limit", incomplete: "elevenlabs_binary_incomplete" };
const speechPath = "/v1/text-to-speech/${voice_id}";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, min: number, max: number): boolean => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

function validateBody(body: unknown): void {
  const invalid = () => { throw new HttpError(400, "invalid_native_elevenlabs_request", "ElevenLabs speech requires bounded native text and settings"); };
  if (!object(body) || Object.keys(body).some(key => !["text", "model_id", "voice_settings", "seed", "apply_text_normalization", "language_code"].includes(key))) return invalid();
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 20_000 || [...body.text].length > 10_000
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body.text)) return invalid();
  if (body.model_id !== undefined && (typeof body.model_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.model_id))) return invalid();
  if (body.seed !== undefined && (!finite(body.seed, 0, 4_294_967_295) || !Number.isSafeInteger(body.seed))) return invalid();
  if (body.apply_text_normalization !== undefined && (typeof body.apply_text_normalization !== "string" || !["auto", "on", "off"].includes(body.apply_text_normalization))) return invalid();
  if (body.language_code !== undefined && (typeof body.language_code !== "string" || !/^[a-z]{2}$/.test(body.language_code))) return invalid();
  if (body.voice_settings !== undefined) {
    const voice = body.voice_settings;
    if (!object(voice) || Object.keys(voice).some(key => !["stability", "similarity_boost", "style", "use_speaker_boost", "speed"].includes(key))) return invalid();
    for (const key of ["stability", "similarity_boost", "style"]) if (voice[key] !== undefined && !finite(voice[key], 0, 1)) return invalid();
    if (voice.speed !== undefined && !finite(voice.speed, 0.5, 2)
      || voice.use_speaker_boost !== undefined && typeof voice.use_speaker_boost !== "boolean") return invalid();
  }
}

export function prepareNativeElevenLabsSpeech(selection: ProxySelection): NativeResponse | undefined {
  const { endpoint, body, nativeQuery } = selection;
  if (endpoint.request_format !== "elevenlabs.speech") return;
  if (selection.provider.id !== "elevenlabs" || selection.model !== null || selection.method !== "POST" || endpoint.method !== "POST"
    || selection.capability !== "audio.speech" || endpoint.path !== speechPath || endpoint.upstreamPath !== undefined
    || endpoint.response_format !== "audio.binary" || endpoint.path_params.length !== 1 || endpoint.path_params[0] !== "voice_id"
    || Object.keys(selection.pathParams).length !== 1 || typeof selection.pathParams.voice_id !== "string"
    || !/^[A-Za-z0-9]{10,40}$/.test(selection.pathParams.voice_id) || Object.keys(endpoint.query).length
    || endpoint.streaming || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.websocket || endpoint.modelPassthrough) {
    throw new HttpError(400, "invalid_native_elevenlabs_route", "ElevenLabs unary speech requires its qualified model-less voice route");
  }
  if (!nativeQuery || nativeQuery.protocol !== "elevenlabs.speech" || nativeQuery.outputFormat !== "mp3_44100_128" || !Object.isFrozen(nativeQuery)) {
    throw new HttpError(400, "invalid_native_elevenlabs_query", "ElevenLabs unary speech requires its qualified MP3 query binding");
  }
  nativeQuerySearch(nativeQuery); // Reuse the published strict query validator, never caller query passthrough.
  validateBody(body);
  return {
    origin: "https://api.elevenlabs.io", path: `/v1/text-to-speech/${selection.pathParams.voice_id}`, query: nativeQuery,
    acquire: () => nativeResponseLease(outputLimit),
    read: (response, signal) => readNativeMp3Response(response, signal, responseErrors),
  };
}
