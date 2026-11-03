import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";

export const openRouterTranscriptionModels = ["openai/whisper-large-v3-turbo"] as const;
export const openRouterTranscriptionFormats = ["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"] as const;
type Json = Record<string, unknown>;
const encoder = new TextEncoder(), maxAudio = 16 * 1024 * 1024, maxResponse = 1024 * 1024;
export interface OpenRouterTranscriptionRequest {
  model: string; path: "/api/v1/audio/transcriptions"; body: Json; headers: Headers;
  audioBytes: number; format: string;
}
export function prepareOpenRouterTranscription(model: string, value: unknown): OpenRouterTranscriptionRequest {
  if (!(openRouterTranscriptionModels as readonly string[]).includes(model) || !mediaObject(value)
    || Object.keys(value).some(key => !["model", "input_audio", "language", "temperature"].includes(key))
    || value.model !== model || !mediaObject(value.input_audio)) fail("request");
  const input = value.input_audio;
  if (Object.keys(input).some(key => !["data", "format"].includes(key))
    || typeof input.format !== "string" || !(openRouterTranscriptionFormats as readonly string[]).includes(input.format)) fail("audio");
  const audio = canonicalMediaBase64(input.data, maxAudio, () => fail("base64"));
  // Frozen Buffer.toString("base64") emits canonical padded base64. Preserve
  // these exact bytes rather than silently converting another wire encoding.
  if (input.data !== audio.base64 || !audio.decodedBytes) fail("base64");
  if (value.language !== undefined && (typeof value.language !== "string" || !/^[a-z]{2}$/.test(value.language))) fail("language");
  if (value.temperature !== undefined && (typeof value.temperature !== "number" || !Number.isFinite(value.temperature)
    || value.temperature < 0 || value.temperature > 1)) fail("temperature");
  return { model, path: "/api/v1/audio/transcriptions", body: structuredClone(value), audioBytes: audio.decodedBytes,
    format: input.format, headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}
export interface OpenRouterTranscriptionObservation {
  body: Json; text: string; model: string; observedModel: string | null;
  audioSeconds: number | null; nativeCost: number | null;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  generationId: string | null; upstreamCostMicros: null;
}
export function observeOpenRouterTranscription(value: unknown, model: string): OpenRouterTranscriptionObservation {
  if (!(openRouterTranscriptionModels as readonly string[]).includes(model) || !mediaObject(value)
    || encoder.encode(JSON.stringify(value)).length > maxResponse || value.error != null
    || typeof value.text !== "string" || value.text.length > 262144
    || value.model != null && value.model !== model
    || value.finish_reason != null && value.finish_reason !== "stop") fail("result");
  for (const character of value.text) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("text"); }
  const usage = value.usage == null ? {} : value.usage;
  if (!mediaObject(usage) || encoder.encode(JSON.stringify(usage)).length > 65536) fail("usage");
  return { body: value, text: value.text.trim(), model, observedModel: value.model == null ? null : model,
    audioSeconds: number(usage.seconds), nativeCost: number(usage.cost),
    inputTokens: number(usage.input_tokens, true), outputTokens: number(usage.output_tokens, true), totalTokens: number(usage.total_tokens, true),
    generationId: null, upstreamCostMicros: null };
}
export async function readOpenRouterTranscription(response: Response, model: string, signal: AbortSignal): Promise<OpenRouterTranscriptionObservation> {
  const generationId = response.headers.get("x-generation-id");
  if (generationId !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(generationId)) {
    void response.body?.cancel().catch(() => undefined); fail("generation_id");
  }
  return readNativeJson(response, signal, maxResponse, body => ({ ...observeOpenRouterTranscription(body, model), generationId }), fail);
}
function number(value: unknown, integer = false): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || integer && !Number.isSafeInteger(value)) fail("usage");
  return value;
}
function fail(reason: string): never { throw new Error(`invalid_openrouter_transcription_${reason}`); }
