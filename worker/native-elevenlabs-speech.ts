import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { nativeQuerySearch } from "./native-query.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const outputLimit = 16 * 1024 * 1024;
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
    async read(response, signal) {
      const bytes = await readAudio(response, signal);
      const audio = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      return { response: new Response(audio, { status: 200, headers: {
        "content-type": "audio/mpeg", "content-length": String(bytes.byteLength), "cache-control": "no-store", "x-content-type-options": "nosniff",
      } }), usage: { tokens: null, outcome: "success" } };
    },
  };
}

async function readAudio(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || response.headers.get("content-type")?.trim().toLowerCase() !== "audio/mpeg"
    || encoding !== null && encoding.trim().toLowerCase() !== "identity"
    || declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > outputLimit)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_elevenlabs_binary_response");
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  try {
    signal.throwIfAborted();
    const bytes = new Uint8Array(declared === null ? outputLimit : Number(declared));
    for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > bytes.byteLength) throw new Error("elevenlabs_binary_limit");
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    if (!size || declared !== null && Number(declared) !== size) throw new Error("elevenlabs_binary_incomplete");
    return bytes.subarray(0, size);
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new Error("invalid_elevenlabs_binary_response");
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
