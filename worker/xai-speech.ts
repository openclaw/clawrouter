import { mediaObject } from "./managed-media-json.ts";

export const xaiSpeechFormats = { mp3: "audio/mpeg", wav: "audio/wav", pcm: "audio/pcm", mulaw: "audio/basic", alaw: "audio/alaw" } as const;
export const xaiSpeechFallbackVoices = ["ara", "eve", "leo", "rex", "sal"] as const;
type Codec = keyof typeof xaiSpeechFormats;
type Json = Record<string, unknown>;
export interface XaiSpeechRequest { path: "/v1/tts"; body: Json; codec: Codec; headers: Headers }
export function prepareXaiSpeech(value: unknown): XaiSpeechRequest {
  if (!mediaObject(value) || Object.keys(value).some(key => !["text", "voice_id", "language", "output_format", "speed"].includes(key))) fail("fields");
  if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 60000) fail("text");
  for (const character of value.text) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("text"); }
  if (typeof value.voice_id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(value.voice_id)) fail("voice");
  if (typeof value.language !== "string" || !/^(?:auto|[a-z]{2,3}(?:-[a-z]{2,4})?)$/i.test(value.language)) fail("language");
  if (value.speed !== undefined && (typeof value.speed !== "number" || !Number.isFinite(value.speed) || value.speed < 0.7 || value.speed > 1.5)) fail("speed");
  const format = value.output_format;
  if (!mediaObject(format) || Object.keys(format).some(key => key !== "codec")
    || typeof format.codec !== "string" || !Object.hasOwn(xaiSpeechFormats, format.codec)) fail("format");
  const codec = format.codec as Codec;
  // No model field exists on this native service. Preserve resolved client
  // voice/language/codec choices; do not invent an OpenAI speech model.
  return { path: "/v1/tts", body: value, codec,
    headers: new Headers({ "content-type": "application/json", accept: xaiSpeechFormats[codec] }) };
}
export async function readXaiSpeech(response: Response, request: XaiSpeechRequest, signal: AbortSignal) {
  const audio = await readBytes(response, xaiSpeechFormats[request.codec], 16 * 1024 * 1024, signal);
  if (!audio.length || request.codec === "pcm" && audio.length % 2) fail("audio");
  return { audio, codec: request.codec, mimeType: xaiSpeechFormats[request.codec],
    sampleRate: 24000, sampleRateBasis: "service_default" as const, upstreamCostMicros: null };
}
export function prepareXaiSpeechVoices() {
  return { method: "GET", path: "/v1/tts/voices", headers: new Headers({ accept: "application/json" }) };
}
export async function readXaiSpeechVoices(response: Response, signal: AbortSignal) {
  const bytes = await readBytes(response, "application/json", 1024 * 1024, signal);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("voices_json"); }
  if (!mediaObject(body) || body.error !== undefined || !Array.isArray(body.voices) || body.voices.length > 512) fail("voices");
  const ids = new Set<string>();
  const voices = body.voices.map(value => {
    if (!mediaObject(value) || typeof value.voice_id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(value.voice_id)
      || ids.has(value.voice_id.toLowerCase())) fail("voice");
    ids.add(value.voice_id.toLowerCase());
    return { id: value.voice_id, name: optionalText(value.name, 256), locale: optionalText(value.language, 64), gender: optionalText(value.gender, 64) };
  });
  return { body, voices };
}
async function readBytes(response: Response, mime: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== mime
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
    void response.body?.cancel().catch(() => undefined); fail("http");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener("abort", abort, { once: true }); let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > limit) fail("size"); chunks.push(chunk.value);
    }
    if (!response.headers.has("content-encoding") && length !== null && Number(length) !== size) fail("truncated");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch { void reader.cancel().catch(() => undefined); fail("response"); }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
function optionalText(value: unknown, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > limit) fail("voice_metadata");
  return value;
}
function fail(reason: string): never { throw new Error(`invalid_xai_speech_${reason}`); }

