import { mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";

export const falMusicModels = ["fal-ai/minimax-music/v2.6", "fal-ai/ace-step/prompt-to-audio", "fal-ai/stable-audio-25/text-to-audio"] as const;
type Json = Record<string, unknown>;
const maxEnvelope = 1024 * 1024, maxAudio = 16 * 1024 * 1024, encoder = new TextEncoder();
export interface FalMusicRequest { model: string; path: string; body: Json; format: "mp3" | "wav"; headers: Headers }
export function prepareFalMusic(model: string, value: unknown): FalMusicRequest {
  if (!(falMusicModels as readonly string[]).includes(model) || !mediaObject(value)) fail("request");
  const minimax = model === falMusicModels[0], stable = model === falMusicModels[2];
  keys(value, minimax ? ["prompt", "lyrics", "lyrics_optimizer", "is_instrumental", "audio_setting"]
    : stable ? ["prompt", "seconds_total"] : ["prompt", "instrumental", "duration"]);
  text(value.prompt, minimax ? 10 : 1, minimax ? 2000 : 32768);
  if (minimax) {
    if (value.lyrics !== undefined) text(value.lyrics, 0, 3500);
    for (const key of ["lyrics_optimizer", "is_instrumental"]) if (value[key] !== undefined && typeof value[key] !== "boolean") fail("mode");
    const lyrics = typeof value.lyrics === "string" && !!value.lyrics.trim();
    if (value.is_instrumental === true && lyrics || value.lyrics_optimizer === true && (lyrics || value.is_instrumental === true)
      || !lyrics && value.is_instrumental !== true && value.lyrics_optimizer !== true) fail("lyrics");
    const setting = value.audio_setting;
    if (!mediaObject(setting)) fail("audio_setting");
    keys(setting, ["sample_rate", "bitrate", "format"]);
    if (setting.sample_rate !== 44100 || setting.bitrate !== 256000 || setting.format !== "mp3") fail("audio_setting");
  } else {
    if (value.instrumental !== undefined && typeof value.instrumental !== "boolean") fail("instrumental");
    const duration = stable ? value.seconds_total : value.duration;
    if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration)
      || duration < (stable ? 1 : 5) || duration > (stable ? 190 : 240) || stable && !Number.isInteger(duration))) fail("duration");
  }
  return { model, path: "/" + model, body: structuredClone(value), format: minimax ? "mp3" : "wav",
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

export function assertFalMusicDispatch(request: Request, prepared: FalMusicRequest): void {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.origin !== "https://fal.run" || url.pathname !== prepared.path
    || !(falMusicModels as readonly string[]).includes(prepared.model) || prepared.path !== "/" + prepared.model
    || url.username || url.password || url.search || url.hash
    || !/^Key [\x21-\x7e]{1,4096}$/.test(request.headers.get("authorization") ?? "")
    || request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") fail("dispatch");
}

export interface FalMusicObservation {
  body: Json; selectedModel: string; audio: { url: string; format: "mp3" | "wav"; mimeType: string | null; declaredBytes: number | null };
  upstreamCostMicros: null;
}
export function observeFalMusic(value: unknown, prepared: FalMusicRequest): FalMusicObservation {
  if (!mediaObject(value) || encoder.encode(JSON.stringify(value)).length > maxEnvelope
    || value.error != null || value.detail != null || value.request_id !== undefined || value.response_url !== undefined || value.status_url !== undefined
    || value.status != null && value.status !== "completed" || value.model != null && value.model !== prepared.model) fail("response");
  const audio = typeof value.audio === "string" ? { url: value.audio } : value.audio;
  if (!mediaObject(audio) || typeof audio.url !== "string" || !audio.url || audio.url.length > 2048 || /[\s\\]/.test(audio.url)) fail("audio");
  let url: URL; try { url = new URL(audio.url); } catch { fail("audio_url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443"
    || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) fail("audio_url");
  const mime = audio.content_type ?? null, size = audio.file_size ?? null;
  if (mime !== null && !(prepared.format === "mp3" ? ["audio/mpeg", "audio/mp3"] : ["audio/wav", "audio/x-wav", "audio/wave"]).includes(String(mime))) fail("mime");
  if (size !== null && (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > maxAudio)) fail("size");
  if (value.lyrics !== undefined) text(value.lyrics, 0, 32768);
  if (value.tags !== undefined) text(value.tags, 0, 8192);
  if (value.seed !== undefined && (typeof value.seed !== "number" || !Number.isSafeInteger(value.seed))) fail("seed");
  // Opaque descriptor only: no provider key, file fetch or dollar settlement.
  return { body: value, selectedModel: prepared.model, audio: { url: audio.url, format: prepared.format,
    mimeType: mime as string | null, declaredBytes: size as number | null }, upstreamCostMicros: null };
}
export async function readFalMusic(response: Response, prepared: FalMusicRequest, signal: AbortSignal) {
  return readNativeJson(response, signal, maxEnvelope, value => observeFalMusic(value, prepared), fail);
}
function text(value: unknown, min: number, max: number): void {
  if (typeof value !== "string" || value.length < min || value.length > max || min > 0 && !value.trim()) fail("text");
  for (const character of value) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
}
function keys(body: Json, allowed: string[]): void { if (Object.keys(body).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error("invalid_fal_music_" + reason); }
