import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { createSseFrames } from "./token-usage.ts";

export const openRouterMusicModels = ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"] as const;
const maxAudio = 16 * 1024 * 1024, maxEnvelope = 32 * 1024 * 1024, maxTranscript = 1024 * 1024;
const encoder = new TextEncoder();
type Json = Record<string, unknown>;
export interface OpenRouterMusicRequest { model: string; path: "/api/v1/chat/completions"; body: Json; format: "mp3" | "wav"; headers: Headers }
export function prepareOpenRouterMusic(model: string, value: unknown): OpenRouterMusicRequest {
  const body = object(value); keys(body, ["model", "messages", "modalities", "audio", "stream"]);
  if (!(openRouterMusicModels as readonly string[]).includes(model) || body.model !== model || body.stream !== true
    || JSON.stringify(body.modalities) !== '["text","audio"]' || !Array.isArray(body.messages) || body.messages.length !== 1) fail("request");
  const message = object(body.messages[0]); keys(message, ["role", "content"]);
  if (message.role !== "user") fail("role");
  if (typeof message.content === "string") prompt(message.content);
  else {
    if (!Array.isArray(message.content) || message.content.length !== 2) fail("content");
    const text = object(message.content[0]); keys(text, ["type", "text"]);
    if (text.type !== "text") fail("text"); prompt(text.text);
    const image = object(message.content[1]); keys(image, ["type", "image_url"]);
    const source = object(image.image_url); keys(source, ["url"]);
    if (image.type !== "image_url" || typeof source.url !== "string") fail("image");
    if (source.url.startsWith("data:")) {
      const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=_-]+)$/.exec(source.url);
      if (!match) fail("image"); canonicalMediaBase64(match[1], 8 * 1024 * 1024, () => fail("image"));
    } else {
      let url: URL; try { url = new URL(source.url); } catch { fail("image_url"); }
      if (url.protocol !== "https:" || url.username || url.password || url.hash || source.url.length > 2048) fail("image_url");
      // Opaque upstream input, never a router fetch or credential destination.
    }
  }
  const audio = object(body.audio); keys(audio, ["format"]);
  if (audio.format !== "mp3" && audio.format !== "wav" || encoder.encode(JSON.stringify(body)).length > 12 * 1024 * 1024) fail("format");
  return { model, body: structuredClone(body), path: "/api/v1/chat/completions", format: audio.format,
    headers: new Headers({ "content-type": "application/json", accept: "text/event-stream" }) };
}
export interface OpenRouterMusicObservation { audio: Uint8Array; transcript: string; format: "mp3" | "wav";
  usage: Json | null; responseId: string | null; upstreamCostMicros: null }

export class OpenRouterMusicStream {
  private audioBase64 = "";
  private transcript = "";
  private transcriptBytes = 0;
  private frames = 0;
  private usage: Json | null = null;
  private responseId: string | null = null;
  private stopped = false;
  private done = false;
  private failed = false;
  private readonly request: OpenRouterMusicRequest;
  constructor(request: OpenRouterMusicRequest) { this.request = request; }

  // Called only with a decoded SSE data payload; never execute embedded text.
  accept(data: string): void {
    try {
      if (this.failed || this.done || ++this.frames > 8192 || data.length > 2 * 1024 * 1024
        || encoder.encode(data).length > 2 * 1024 * 1024) fail("state");
      if (data === "[DONE]") { this.done = true; return; }
      const frame = object(JSON.parse(data));
      if (frame.error != null || frame.model != null && frame.model !== this.request.model) fail("frame");
      if (frame.id !== undefined) {
        if (typeof frame.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(frame.id)
          || this.responseId !== null && frame.id !== this.responseId) fail("identity");
        this.responseId = frame.id;
      }
      if (frame.usage != null) {
        const usage = object(frame.usage);
        if (encoder.encode(JSON.stringify(usage)).length > 65536
          || usage.cost != null && (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0)) fail("usage");
        this.usage = usage;
      }
      if (!Array.isArray(frame.choices) || frame.choices.length > 1) fail("choices");
      if (!frame.choices.length) { if (!frame.usage) fail("empty_frame"); return; }
      const choice = object(frame.choices[0]);
      if (choice.index !== undefined && choice.index !== 0 || choice.finish_reason != null && choice.finish_reason !== "stop") fail("finish_reason");
      const delta = object(choice.delta);
      if (delta.tool_calls !== undefined || delta.function_call !== undefined || delta.refusal != null) fail("unexpected_output");
      if (delta.audio != null) {
        if (this.stopped) fail("after_stop");
        const audio = object(delta.audio);
        if (audio.data !== undefined) {
          if (typeof audio.data !== "string" || !/^[A-Za-z0-9+/=]*$/.test(audio.data)
            || this.audioBase64.length + audio.data.length > Math.ceil(maxAudio / 3) * 4) fail("audio");
          this.audioBase64 += audio.data;
        }
        if (audio.transcript !== undefined) {
          if (typeof audio.transcript !== "string") fail("transcript");
          this.transcriptBytes += encoder.encode(audio.transcript).length;
          if (this.transcriptBytes > maxTranscript) fail("transcript_limit");
          this.transcript += audio.transcript;
        }
      }
      if (choice.finish_reason === "stop") this.stopped = true;
    } catch { this.failed = true; throw new Error("invalid_openrouter_music_frame"); }
  }
  isDone(): boolean { return this.done && !this.failed; }
  result(): OpenRouterMusicObservation {
    if (this.failed || !this.done || !this.audioBase64) fail("incomplete_audio");
    for (const character of this.transcript) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("transcript_unicode"); }
    const encoded = canonicalMediaBase64(this.audioBase64, maxAudio, () => fail("base64"));
    const audio = Uint8Array.from(atob(encoded.base64), character => character.charCodeAt(0));
    return { audio, transcript: this.transcript, format: this.request.format,
      usage: this.usage, responseId: this.responseId, upstreamCostMicros: null };
  }
}
export async function readOpenRouterMusic(response: Response, request: OpenRouterMusicRequest, signal: AbortSignal): Promise<OpenRouterMusicObservation> {
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxEnvelope)) {
    void response.body?.cancel().catch(() => undefined); fail("http");
  }
  const stream = new OpenRouterMusicStream(request);
  const consume = (frame: string | null) => {
    if (frame === null) fail("frame_bound_or_utf8");
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      else if (!["event", "id", "retry"].includes(field)) fail("sse_field");
    }
    if (data.length) stream.accept(data.join("\n"));
  };
  const frames = createSseFrames(consume, true), reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener("abort", abort, { once: true }); let bytes = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read(); signal.throwIfAborted();
      if (part.done) {
        const tail = frames.pending();
        if (tail === null) fail("frame_limit");
        if (tail.trim()) consume(tail);
        break;
      }
      bytes += part.value.length; if (bytes > maxEnvelope) fail("stream_limit");
      frames.push(part.value); if (frames.overflowed()) fail("frame_limit");
      if (stream.isDone()) {
        if (frames.pending()?.trim()) fail("after_done");
        break;
      }
    }
    if (!response.headers.has("content-encoding") && length !== null && Number(length) !== bytes) fail("truncated");
    return stream.result();
  } catch { throw new Error("invalid_openrouter_music_response"); }
  finally {
    void reader.cancel().catch(() => undefined); signal.removeEventListener("abort", abort); reader.releaseLock();
  }
}
function prompt(value: unknown): void {
  if (typeof value !== "string" || !value.trim() || value.length > 32768) fail("prompt");
  for (const character of value) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("prompt"); }
}
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_openrouter_music_${reason}`); }
