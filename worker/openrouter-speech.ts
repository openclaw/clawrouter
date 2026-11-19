import { inputRetirement } from "./input-retirement.ts";
import { mediaObject } from "./managed-media-json.ts";

export const openRouterSpeechModels = ["hexgrad/kokoro-82m", "elevenlabs/eleven-turbo-v2",
  "google/gemini-3.1-flash-tts-preview", "mistralai/voxtral-mini-tts-2603"] as const;
export const openRouterSpeechFormats = { mp3: "audio/mpeg", pcm: "audio/pcm" } as const;
type Format = keyof typeof openRouterSpeechFormats;
type Json = Record<string, unknown>;
const maxBytes = 16 * 1024 * 1024;
export interface OpenRouterSpeechRequest { path: "/api/v1/audio/speech"; body: Json; model: string; format: Format; headers: Headers }

export function prepareOpenRouterSpeech(model: string, value: unknown): OpenRouterSpeechRequest {
  if (!(openRouterSpeechModels as readonly string[]).includes(model) || !mediaObject(value)
    || Object.keys(value).some(key => !["model", "input", "voice", "response_format", "speed", "provider"].includes(key))
    || value.model !== model || typeof value.input !== "string" || !value.input.trim() || value.input.length > 32768
    || typeof value.voice !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.voice)
    || typeof value.response_format !== "string" || !Object.hasOwn(openRouterSpeechFormats, value.response_format)) fail("request");
  for (const character of value.input) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("text"); }
  const format = value.response_format as Format;
  if (model.startsWith("google/") && format !== "pcm") fail("gemini_requires_pcm");
  if (value.speed !== undefined && (typeof value.speed !== "number" || !Number.isFinite(value.speed) || value.speed < 0.25 || value.speed > 4)) fail("speed");
  if (value.provider !== undefined) {
    const provider = value.provider;
    if (!mediaObject(provider) || Object.keys(provider).some(key => !["zdr", "data_collection"].includes(key))
      || provider.zdr !== undefined && typeof provider.zdr !== "boolean"
      || provider.data_collection !== undefined && provider.data_collection !== "allow" && provider.data_collection !== "deny") fail("provider_policy");
  }
  // Existing runtime selects origin and OPENROUTER_API_KEY as one grant.
  // No client origin, secret, downstream credential or provider fallback here.
  return { path: "/api/v1/audio/speech", model, body: structuredClone(value), format,
    headers: new Headers({ "content-type": "application/json", accept: openRouterSpeechFormats[format] }) };
}

export async function readOpenRouterSpeech(response: Response, request: OpenRouterSpeechRequest, signal: AbortSignal): Promise<{
  audio: Uint8Array; mimeType: string; format: Format; generationId: string | null;
  sampleRate: null; billableCharacters: null; upstreamCostMicros: null;
}> {
  const mime = openRouterSpeechFormats[request.format], length = response.headers.get("content-length");
  const generationId = response.headers.get("x-generation-id");
  if (!response.body) fail("http");
  const reader = response.body.getReader(), input = inputRetirement(reader);
  if (response.status !== 200 || response.redirected || response.headers.has("content-range")
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== mime
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)
    || generationId !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(generationId)) {
    await input.retire("cancel"); fail("http");
  }
  const chunks: Uint8Array[] = [];
  const abort = () => { void input.retire("cancel", signal.reason); }; signal.addEventListener("abort", abort, { once: true });
  let size = 0, eof = false;
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await input.read(() => reader.read()); signal.throwIfAborted(); if (chunk.done) { eof = true; break; }
      size += chunk.value.byteLength; if (size > maxBytes) fail("size"); chunks.push(chunk.value.slice());
    }
    if (!size || !response.headers.has("content-encoding") && length !== null && Number(length) !== size) fail("incomplete");
    const audio = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
    // The endpoint documents raw PCM without a uniform rate/sample-width
    // promise across these providers. Do not derive duration or character fees.
    return { audio, mimeType: mime, format: request.format, generationId,
      sampleRate: null, billableCharacters: null, upstreamCostMicros: null };
  } catch { await input.retire("cancel", signal.reason); throw new Error("invalid_openrouter_speech_response"); }
  finally { signal.removeEventListener("abort", abort); await input.retire(eof ? "eof" : "cancel", signal.reason); }
}
function fail(reason: string): never { throw new Error(`invalid_openrouter_speech_${reason}`); }
