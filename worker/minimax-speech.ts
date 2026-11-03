import { readNativeJson } from "./native-json.ts";
import { mediaObject } from "./managed-media-json.ts";

export const miniMaxSpeechModels = [
  "speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo",
  "speech-02-hd", "speech-02-turbo", "speech-01-hd", "speech-01-turbo",
] as const;
export const miniMaxSpeechPath = "/v1/t2a_v2";
const maxAudio = 8 * 1024 * 1024, maxEnvelope = maxAudio * 2 + 65536;
const encoder = new TextEncoder();
type Json = Record<string, unknown>;

export interface MiniMaxSpeechRequest { model: string; path: string; body: Json; headers: Headers }
export function prepareMiniMaxSpeech(model: string, value: unknown): MiniMaxSpeechRequest {
  modelId(model);
  const body = object(value); keys(body, ["model", "text", "stream", "output_format", "voice_setting", "audio_setting"]);
  if (body.model !== model || body.stream !== false || body.output_format !== "hex") fail("identity_or_mode");
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length >= 10000
    || encoder.encode(JSON.stringify(body)).length > 65536) fail("text");
  const voice = object(body.voice_setting); keys(voice, ["voice_id", "speed", "vol", "pitch"]);
  if (typeof voice.voice_id !== "string" || !voice.voice_id.trim() || voice.voice_id.length > 256
    || /[\u0000-\u001f\u007f]/.test(voice.voice_id)) fail("voice");
  number(voice.speed, 0.5, 2); number(voice.vol, Number.MIN_VALUE, 10); number(voice.pitch, -12, 12);
  if (!Number.isInteger(voice.pitch)) fail("pitch");
  const audio = object(body.audio_setting); keys(audio, ["format", "sample_rate"]);
  if (audio.format !== "mp3" || audio.sample_rate !== 32000) fail("audio_format");
  // Runtime supplies the original qualified native media credential, never a
  // caller key or an Anthropic OAuth/plan substitution selected by this codec.
  return { model, path: miniMaxSpeechPath, body, headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

export function observeMiniMaxSpeech(value: unknown, request: MiniMaxSpeechRequest, complete: boolean): {
  body: Json; audio: Uint8Array; mimeType: "audio/mpeg"; model: string;
  usageCharacters: number | null; observedAudioMilliseconds: number | null;
} {
  modelId(request.model);
  if (!complete) fail("incomplete");
  const body = object(value);
  if (encoder.encode(JSON.stringify(body)).length > maxEnvelope || body.error !== undefined
    || object(body.base_resp).status_code !== 0) fail("response");
  if (body.model !== undefined && body.model !== request.model) fail("model");
  const data = object(body.data);
  if (data.status !== 2 || typeof data.audio !== "string" || data.audio.length > maxAudio * 2 + 4096) fail("audio");
  const hex = data.audio.trim();
  if (!hex.length || hex.length % 2 || hex.length > maxAudio * 2 || !/^[0-9a-f]+$/i.test(hex)) fail("hex");
  const audio = new Uint8Array(hex.length / 2);
  for (let i = 0; i < audio.length; i++) audio[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const extra = body.extra_info === undefined ? {} : object(body.extra_info);
  if (extra.audio_format !== undefined && extra.audio_format !== "mp3"
    || extra.audio_sample_rate !== undefined && extra.audio_sample_rate !== 32000
    || extra.audio_channel !== undefined && extra.audio_channel !== 1
    || extra.audio_size !== undefined && extra.audio_size !== audio.length) fail("audio_metadata");
  // Native billable characters differ from word_count, input text length and
  // usage_voice_count. Missing/invalid usage is unknown, never zero or free.
  const usageCharacters = counter(extra.usage_characters);
  return { body, audio, mimeType: "audio/mpeg", model: request.model, usageCharacters,
    observedAudioMilliseconds: counter(extra.audio_length) };
}

export async function readMiniMaxSpeech(response: Response, request: MiniMaxSpeechRequest, signal: AbortSignal): Promise<ReturnType<typeof observeMiniMaxSpeech>> {
  modelId(request.model);
  return readNativeJson(response, signal, maxEnvelope, body => observeMiniMaxSpeech(body, request, true), fail);
}
function modelId(value: string): void { if (!(miniMaxSpeechModels as readonly string[]).includes(value)) fail("model"); }
function counter(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function number(value: unknown, min: number, max: number): void { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail("setting"); }
function fail(reason: string): never { throw new Error(`invalid_minimax_speech_${reason}`); }

