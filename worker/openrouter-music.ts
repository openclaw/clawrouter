import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { createSseFrames } from "./token-usage.ts";
import { createJsonTokenizer } from "./json-tokens.ts";
import { utf8Length } from "./json-body.ts";

export const openRouterMusicModels = ["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"] as const;
const maxAudio = 16 * 1024 * 1024, maxEnvelope = 32 * 1024 * 1024, maxTranscript = 1024 * 1024;
const encoder = new TextEncoder();
type Json = Record<string, unknown>;
export interface OpenRouterMusicRequest { model: string; path: "/api/v1/chat/completions"; body: Json; format: "mp3" | "wav"; headers: Headers }
// Response metadata only; accepting this context grants no input-asset authority.
// Existing prepared requests remain structurally compatible.
export interface OpenRouterMusicContext { readonly model: string; readonly format: "mp3" | "wav" }
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
export interface OpenRouterMusicInspection { audioBytes: number; transcriptBytes: number; format: "mp3" | "wav";
  usage: Json | null; responseId: string | null; upstreamCostMicros: null }

export class OpenRouterMusicStream {
  private readonly state: MusicState;
  constructor(context: OpenRouterMusicContext) { this.state = new MusicState(context.model, context.format, true); }
  accept(data: string): void { this.state.accept(data); }
  isDone(): boolean { return this.state.isDone(); }
  result(): OpenRouterMusicObservation { return this.state.result(); }
}

// Inspection keeps scalar evidence only. It does not retain/return audio,
// base64 or transcript and does not grant capacity or input-image authority.
export function createOpenRouterMusicInspector(context: OpenRouterMusicContext): {
  accept(data: string): void; isDone(): boolean; result(): OpenRouterMusicInspection;
} {
  return musicInspector(new MusicState(context.model, context.format, false));
}

// Returned closures are created in a scope that never receives a caller's
// prepared request. State owns primitive metadata, not a request/body reference.
function musicInspector(state: MusicState) {
  return { accept: (data: string) => state.accept(data), isDone: () => state.isDone(), result: () => state.inspection() };
}

class MusicState {
  private audioBase64 = "";
  private audioCharacters = 0;
  private readonly audioCounter = new Base64Counter();
  private transcript = "";
  private transcriptBytes = 0;
  private transcriptHigh = false;
  private frames = 0;
  private usage: Json | null = null;
  private responseId: string | null = null;
  private stopped = false;
  private done = false;
  private failed = false;
  private readonly model: string;
  private readonly format: "mp3" | "wav";
  private readonly retain: boolean;
  constructor(model: string, format: "mp3" | "wav", retain: boolean) { this.model = model; this.format = format; this.retain = retain; }

  // Called only with a decoded SSE data payload; never execute embedded text.
  accept(data: string): void {
    try {
      if (this.failed || this.done || ++this.frames > 8192 || data.length > 2 * 1024 * 1024
        || (this.retain ? encoder.encode(data).length : utf8Length(data)) > 2 * 1024 * 1024) fail("state");
      if (data === "[DONE]") { this.done = true; return; }
      if (!this.retain) inspectStructure(data);
      const frame = object(JSON.parse(data));
      if (frame.error != null || frame.model != null && frame.model !== this.model) fail("frame");
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
            || this.audioCharacters + audio.data.length > Math.ceil(maxAudio / 3) * 4) fail("audio");
          this.audioCharacters += audio.data.length;
          if (this.retain) this.audioBase64 += audio.data;
          else this.audioCounter.accept(audio.data);
        }
        if (audio.transcript !== undefined) {
          if (typeof audio.transcript !== "string") fail("transcript");
          this.transcriptBytes += this.retain ? encoder.encode(audio.transcript).length : utf8Length(audio.transcript);
          if (this.transcriptBytes > maxTranscript) fail("transcript_limit");
          if (this.retain) this.transcript += audio.transcript;
          else for (let index = 0; index < audio.transcript.length; index++) {
            const code = audio.transcript.charCodeAt(index);
            if (this.transcriptHigh) {
              if (code < 0xdc00 || code > 0xdfff) fail("transcript_unicode");
              this.transcriptHigh = false;
            } else if (code >= 0xd800 && code <= 0xdbff) this.transcriptHigh = true;
            else if (code >= 0xdc00 && code <= 0xdfff) fail("transcript_unicode");
          }
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
    return { audio, transcript: this.transcript, format: this.format,
      usage: this.usage, responseId: this.responseId, upstreamCostMicros: null };
  }
  inspection(): OpenRouterMusicInspection {
    if (this.retain || this.failed || !this.done || !this.audioCharacters) fail("incomplete_audio");
    if (this.transcriptHigh) fail("transcript_unicode");
    return { audioBytes: this.audioCounter.result(), transcriptBytes: this.transcriptBytes, format: this.format,
      usage: this.usage, responseId: this.responseId, upstreamCostMicros: null };
  }
}

// At most one unfinished quartet, represented by its position and final sextet.
// No atob, aggregate string, decoded array or caller-owned audio is retained.
class Base64Counter {
  private position = 0;
  private last = 0;
  private secondPadding = false;
  private closed = false;
  private bytes = 0;
  accept(data: string): void {
    for (let index = 0; index < data.length; index++) {
      if (this.closed) fail("base64");
      const code = data.charCodeAt(index), padding = code === 61;
      const value = code >= 65 && code <= 90 ? code - 65 : code >= 97 && code <= 122 ? code - 71
        : code >= 48 && code <= 57 ? code + 4 : code === 43 ? 62 : code === 47 ? 63 : -1;
      if (!padding && value < 0 || padding && this.position < 2) fail("base64");
      if (this.position === 2 && padding) {
        if (this.last & 15) fail("base64");
        this.secondPadding = true;
      } else if (this.position === 3) {
        if (this.secondPadding && !padding || padding && !this.secondPadding && (this.last & 3)) fail("base64");
        this.bytes += this.secondPadding ? 1 : padding ? 2 : 3;
        this.closed = padding;
        this.secondPadding = false;
        if (this.bytes > maxAudio) fail("audio");
      }
      this.last = value; this.position = (this.position + 1) % 4;
    }
  }
  result(): number {
    if (this.position === 1 || this.secondPadding || this.position === 2 && (this.last & 15)
      || this.position === 3 && (this.last & 3)) fail("base64");
    const bytes = this.bytes + (this.position ? this.position - 1 : 0);
    if (!bytes || bytes > maxAudio) fail("audio");
    return bytes;
  }
}

// Bound object amplification before JSON.parse in inspection mode. The default
// reader retains its existing behavior; this is not a new JSON parsing framework.
function inspectStructure(data: string): void {
  const stack: Array<{ object: boolean; count: number }> = [];
  let nodes = 0, properties = 0, units = 0, scalar = 0, key = false, number = false;
  const node = () => {
    if (++nodes > 4096) fail("structure");
    const parent = stack.at(-1);
    if (parent && !parent.object && ++parent.count > 4096) fail("structure");
  };
  const tokens = createJsonTokenizer(token => {
    switch (token.name) {
      case "startObject": case "startArray":
        node(); if (stack.length >= 32) fail("structure"); stack.push({ object: token.name === "startObject", count: 0 }); break;
      case "endObject": case "endArray": stack.pop(); break;
      case "startKey": key = true; number = false; scalar = 0; break;
      case "startString": key = false; number = false; scalar = 0; node(); break;
      case "startNumber": key = false; number = true; scalar = 0; node(); break;
      case "stringChunk": case "numberChunk":
        scalar += token.value.length; units += token.value.length;
        if (units > 2 * 1024 * 1024 || key && scalar > 256 || number && scalar > 128) fail("structure"); break;
      case "endKey":
        if (!stack.at(-1)?.object || ++stack.at(-1)!.count > 128 || ++properties > 4096) fail("structure");
        key = false; break;
      case "nullValue": case "trueValue": case "falseValue": node(); break;
    }
  });
  for (let offset = 0; offset < data.length; offset += 1024) tokens.push(data.slice(offset, offset + 1024));
  tokens.end();
}
export function readOpenRouterMusic(response: Response, context: OpenRouterMusicContext, signal: AbortSignal): Promise<OpenRouterMusicObservation> {
  // Do not carry the caller's request into the pending async frame or its
  // callbacks. Keep the public Promise-rejection behavior on preparation errors.
  try { return readMusicResponse(response, new OpenRouterMusicStream(context), signal); }
  catch (error) { return Promise.reject(error); }
}

async function readMusicResponse(response: Response, stream: OpenRouterMusicStream, signal: AbortSignal): Promise<OpenRouterMusicObservation> {
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxEnvelope)) {
    void response.body?.cancel().catch(() => undefined); fail("http");
  }
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
