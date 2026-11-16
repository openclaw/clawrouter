import { mediaObject } from "./managed-media-json.ts";
import { prepareXaiSpeech, xaiSpeechFormats } from "./xai-speech.ts";

type Json = Record<string, unknown>;
type Codec = keyof typeof xaiSpeechFormats;
const encoder = new TextEncoder();
const maxAudio = 16 * 1024 * 1024;
const maxFrame = Math.ceil(maxAudio / 3) * 4 + 1024;
export interface XaiSpeechStreamRequest {
  path: "/v1/tts";
  query: URLSearchParams;
  codec: Codec;
  // Transient admitted text, not durable accounting or log content.
  frames: readonly Json[];
}

export function prepareXaiSpeechStream(value: unknown): XaiSpeechStreamRequest {
  const request = prepareXaiSpeech(value);
  const query = new URLSearchParams({ language: String(request.body.language), voice: String(request.body.voice_id), codec: request.codec });
  if (request.body.speed !== undefined) query.set("speed", String(request.body.speed));
  const text = String(request.body.text), frames: Json[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 15000, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    frames.push({ type: "text.delta", delta: text.slice(offset, end) }); offset = end;
  }
  frames.push({ type: "text.done" });
  return { path: "/v1/tts", query, codec: request.codec, frames };
}

export interface XaiSpeechStreamObservation {
  body: Json;
  audio: Uint8Array | null;
  terminal: "done" | "error" | null;
  upstreamCostMicros: null;
}

// One frozen-client utterance per socket. The shared bridge owns real I/O,
// policy, credentials, dispatch acknowledgment, deadlines and settlement.
export class XaiSpeechStreamConnection {
  private phase: "connecting" | "open" | "awaiting" | "closed" = "connecting";
  private outcome: "incomplete" | "done" | "error" = "incomplete";
  private sent = 0;
  private events = 0;
  private audioBytes = 0;
  private textUnits = 0;
  private readonly request: XaiSpeechStreamRequest;
  constructor(value: unknown) { this.request = prepareXaiSpeechStream(value); }

  // Invoke only after runtime has qualified the upstream 101 upgrade and grant.
  opened(): void {
    if (this.phase !== "connecting") this.reject("open_order");
    this.phase = "open";
  }

  client(wire: string): Json {
    try {
      if (this.phase !== "open") fail("client_order");
      const body = parse(wire, 96 * 1024), expected = this.request.frames[this.sent];
      if (!expected || Object.keys(body).some(key => !Object.hasOwn(expected, key))
        || body.type !== expected.type || body.delta !== expected.delta) fail("admitted_text");
      this.tick(); this.sent++;
      if (body.type === "text.done") this.phase = "awaiting";
      else this.textUnits += String(body.delta).length;
      // Validated for dispatch, not evidence that a remote socket received it.
      return body;
    } catch { this.reject("client_frame"); }
  }

  server(wire: string): XaiSpeechStreamObservation {
    try {
      if (this.phase === "connecting" || this.phase === "closed") fail("server_order");
      const body = parse(wire, maxFrame);
      const result: XaiSpeechStreamObservation = { body, audio: null, terminal: null, upstreamCostMicros: null };
      if (body.error !== undefined) fail("embedded_error");
      this.tick();
      if (body.type === "error") {
        if (typeof body.message !== "string" || body.message.length > 4096) fail("error");
        this.outcome = "error"; this.phase = "closed"; result.terminal = "error";
      } else if (body.type === "audio.delta") {
        if (!this.sent || typeof body.delta !== "string") fail("audio_order");
        const bytes = audio(body.delta);
        if (this.audioBytes + bytes.length > maxAudio) fail("audio_limit");
        this.audioBytes += bytes.length; result.audio = bytes;
      } else if (body.type === "audio.done") {
        if (this.phase !== "awaiting" || !this.audioBytes || this.request.codec === "pcm" && this.audioBytes % 2) fail("incomplete");
        if (body.trace_id !== undefined && (typeof body.trace_id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(body.trace_id))) fail("trace_id");
        this.outcome = "done"; this.phase = "closed"; result.terminal = "done";
      } else fail("server_event");
      return result;
    } catch { this.reject("server_frame"); }
  }

  // Local closure is not a provider cancel acknowledgment, refund or replay grant.
  // Diagnostic lengths are not authoritative upstream character usage.
  close() {
    this.phase = "closed";
    return { outcome: this.outcome, receivedAudioBytes: this.audioBytes,
      validatedTextUtf16Units: this.textUnits, upstreamCostMicros: null };
  }
  private tick(): void { if (++this.events > 8192) fail("event_limit"); }
  private reject(reason: string): never { this.phase = "closed"; fail(reason); }
}

function parse(wire: string, limit: number): Json {
  if (typeof wire !== "string" || wire.length > limit || encoder.encode(wire).length > limit) fail("frame_limit");
  let value: unknown; try { value = JSON.parse(wire); } catch { fail("json"); }
  if (!mediaObject(value)) fail("object");
  return value;
}
function audio(value: string): Uint8Array {
  if (!value.length || value.length > Math.ceil(maxAudio / 3) * 4 || value.length % 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail("audio");
  const binary = atob(value);
  if (!binary.length || binary.length > maxAudio || btoa(binary) !== value) fail("audio");
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
function fail(reason: string): never { throw new Error(`invalid_xai_speech_stream_${reason}`); }
