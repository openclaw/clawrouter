import { mediaObject } from "./managed-media-json.ts";

export const miniMaxMusicModels = ["music-2.6", "music-2.6-free", "music-cover", "music-cover-free"] as const;
export const miniMaxMusicAvailability = {
  checkedAt: "2026-11-03", paid: "existing_paying_users_only", free: "discontinuation_announced_date_unspecified",
} as const;
const origins = { global: "https://api.minimax.io", cn: "https://api.minimaxi.com" } as const;
const maxAudio = 8 * 1024 * 1024, maxEnvelope = maxAudio * 5 + 64 * 1024, encoder = new TextEncoder();
type Json = Record<string, unknown>;
export interface MiniMaxMusicRequest { origin: string; path: "/v1/music_generation"; body: Json; model: string; headers: Headers }
export interface MiniMaxMusicObservation {
  audio: Uint8Array; frames: Json[]; model: string; mimeType: "audio/mpeg";
  durationMillis: number | null; upstreamCostMicros: null;
}
export function prepareMiniMaxMusic(region: keyof typeof origins, value: unknown): MiniMaxMusicRequest {
  if (region !== "global" && region !== "cn") fail("region");
  const body = object(value); keys(body, ["model", "prompt", "lyrics", "lyrics_optimizer", "is_instrumental", "stream", "output_format", "audio_setting", "audio_url", "audio_base64"]);
  if (typeof body.model !== "string" || !(miniMaxMusicModels as readonly string[]).includes(body.model)
    || body.stream !== true && body.stream !== false || body.output_format !== "hex") fail("request");
  if (body.stream === false && (region !== "global" || !["music-2.6", "music-2.6-free"].includes(body.model)
    || Object.hasOwn(body, "audio_url") || Object.hasOwn(body, "audio_base64"))) fail("unary_request");
  const settings = object(body.audio_setting); keys(settings, ["sample_rate", "bitrate", "format"]);
  if (settings.sample_rate !== 44100 || settings.bitrate !== 256000 || settings.format !== "mp3") fail("audio_settings");
  const cover = body.model.startsWith("music-cover");
  const prompt = text(body.prompt, cover ? 300 : 2000);
  if (!prompt.trim() || cover && prompt.length < 10) fail("prompt");
  if (cover) {
    if (body.lyrics_optimizer !== undefined || body.is_instrumental !== undefined
      || (body.audio_url !== undefined) === (body.audio_base64 !== undefined)) fail("cover_reference");
    if (body.lyrics !== undefined && text(body.lyrics, 1000).length < 10) fail("lyrics");
    if (body.audio_url !== undefined) {
      const source = text(body.audio_url, 8192); let url: URL;
      try { url = new URL(source); } catch { fail("audio_url"); }
      if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("audio_url");
    } else {
      const audio = text(body.audio_base64, Math.ceil(maxAudio / 3) * 4);
      if (!audio || audio.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) fail("audio_base64");
      let raw: string; try { raw = atob(audio); } catch { fail("audio_base64"); }
      if (!raw.length || raw.length > maxAudio || btoa(raw) !== audio) fail("audio_base64");
    }
  } else {
    if (body.audio_url !== undefined || body.audio_base64 !== undefined) fail("unexpected_reference");
    if (body.is_instrumental !== undefined && body.is_instrumental !== true
      || body.lyrics_optimizer !== undefined && body.lyrics_optimizer !== true) fail("options");
    if (body.is_instrumental === true) {
      if (body.lyrics !== undefined || body.lyrics_optimizer !== undefined) fail("instrumental_lyrics");
    } else if (body.lyrics !== undefined) {
      if (!text(body.lyrics, 3500).trim() || body.lyrics_optimizer !== undefined) fail("lyrics");
    } else if (body.lyrics_optimizer !== true) fail("lyrics");
  }
  return { origin: origins[region], path: "/v1/music_generation", body, model: body.model,
    headers: new Headers({ "content-type": "application/json", accept: body.stream === false ? "application/json" : "text/event-stream, application/json" }) };
}
export function observeMiniMaxMusic(values: unknown[], request: MiniMaxMusicRequest, complete: boolean): MiniMaxMusicObservation {
  if (!complete || values.length < 1 || values.length > 2048 || encoder.encode(JSON.stringify(values)).length > maxEnvelope) fail("frames");
  if (request.body.stream === false && values.length !== 1) fail("unary_frames");
  let audioHex = "", terminal = false, durationMillis: number | null = null;
  const frames: Json[] = [];
  for (const value of values) {
    const frame = object(value);
    if (terminal || !mediaObject(frame.base_resp) || frame.base_resp.status_code !== 0 || frame.error !== undefined
      || frame.model !== undefined && frame.model !== request.model || frame.task_id !== undefined || frame.audio_url !== undefined) fail("frame");
    const data = object(frame.data);
    if (data.audio_url !== undefined || data.status !== 1 && data.status !== 2 && data.status !== "1" && data.status !== "2") fail("status");
    const chunk = data.audio === undefined || data.audio === "" ? "" : hex(data.audio);
    if (String(data.status) === "2") {
      terminal = true;
      // The frozen consumer suppresses terminal aggregate audio after deltas.
      // Verify the prefix before accepting a terminal full-file replacement.
      // An ambiguous final delta is rejected, never appended speculatively.
      if (chunk) {
        if (audioHex && !chunk.startsWith(audioHex)) fail("terminal_audio_mismatch");
        audioHex = chunk;
      }
      const extra = frame.extra_info === undefined ? undefined : object(frame.extra_info);
      if (extra) {
        if (extra.music_size !== undefined && extra.music_size !== audioHex.length / 2
          || extra.music_sample_rate !== undefined && extra.music_sample_rate !== 44100
          || extra.bitrate !== undefined && extra.bitrate !== 256000) fail("metadata");
        if (extra.music_duration !== undefined) {
          if (typeof extra.music_duration !== "number" || !Number.isFinite(extra.music_duration) || extra.music_duration < 0) fail("duration");
          durationMillis = extra.music_duration;
        }
      }
    } else {
      if (audioHex.length + chunk.length > maxAudio * 2) fail("audio_size");
      audioHex += chunk;
    }
    frames.push(frame);
  }
  if (!terminal || !audioHex) fail("incomplete_audio");
  const audio = new Uint8Array(audioHex.length / 2);
  for (let index = 0; index < audio.length; index++) audio[index] = Number.parseInt(audioHex.slice(index * 2, index * 2 + 2), 16);
  return { audio, frames, model: request.model, mimeType: "audio/mpeg", durationMillis, upstreamCostMicros: null };
}
export async function readMiniMaxMusic(response: Response, request: MiniMaxMusicRequest, signal: AbortSignal): Promise<MiniMaxMusicObservation> {
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase(), length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || mime !== "application/json" && mime !== "text/event-stream"
    || request.body.stream === false && mime !== "application/json"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxEnvelope)) {
    void response.body?.cancel().catch(() => undefined); fail("http");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true }); let size = 0, body = "";
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > maxEnvelope) fail("size"); body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    if (!response.headers.has("content-encoding") && length !== null && Number(length) !== size) fail("truncated");
    return observeMiniMaxMusic(mime === "application/json" ? [JSON.parse(body)] : events(body), request, true);
  } catch { void reader.cancel().catch(() => undefined); fail("response"); }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
function events(body: string): unknown[] {
  const frames: unknown[] = []; let data: string[] = [], done = false;
  const flush = () => {
    if (!data.length) return;
    const payload = data.join("\n"); data = [];
    if (done) fail("after_done");
    if (payload === "[DONE]") { done = true; return; }
    if (frames.length >= 2048) fail("frame_limit");
    frames.push(JSON.parse(payload));
  };
  for (const line of body.split(/\r\n|\n|\r/)) {
    if (!line) { flush(); continue; }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":"); const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (!["event", "id", "retry"].includes(field)) fail("sse_field");
  }
  if (data.length) fail("incomplete_event");
  return frames;
}
function hex(value: unknown): string {
  const result = text(value, maxAudio * 2 + 2).trim();
  if (!result || result.length > maxAudio * 2 || result.length % 2 || !/^[0-9a-f]+$/i.test(result)) fail("hex");
  return result.toLowerCase();
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit) fail("text");
  for (const character of value) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("text"); }
  return value;
}
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_minimax_music_${reason}`); }

