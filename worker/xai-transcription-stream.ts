import { mediaObject } from "./managed-media-json.ts";

type Json = Record<string, unknown>;
const encoder = new TextEncoder();
const maxText = 256 * 1024;
const maxAudio = 16 * 1024 * 1024;
export interface XaiTranscriptionRequest {
  path: "/v1/stt";
  query: URLSearchParams;
  encoding: "pcm" | "mulaw" | "alaw";
  sampleRate: number;
}

export function prepareXaiTranscriptionStream(query: URLSearchParams): XaiTranscriptionRequest {
  const allowed = ["sample_rate", "encoding", "interim_results", "endpointing", "language"];
  for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) fail("query");
  const sampleRate = integer(query.get("sample_rate"), 48000);
  if (![8000, 16000, 22050, 24000, 44100, 48000].includes(sampleRate)) fail("sample_rate");
  const encoding = query.get("encoding");
  if (encoding !== "pcm" && encoding !== "mulaw" && encoding !== "alaw") fail("encoding");
  if (!["true", "false"].includes(query.get("interim_results") ?? "")) fail("interim_results");
  integer(query.get("endpointing"), 5000);
  const language = query.get("language");
  if (language !== null && (language.length > 64 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language))) fail("language");
  return { path: "/v1/stt", query: new URLSearchParams(query), encoding, sampleRate };
}

export interface XaiTranscriptionObservation {
  body: Json;
  ready: boolean;
  partial: string | null;
  utterance: string | null;
  // A whole-session replacement, never append it to already emitted utterances.
  transcript: string | null;
  terminal: "done" | "error" | null;
  nativeDurationSeconds: number | null;
  upstreamCostMicros: null;
}

export class XaiTranscriptionStreamConnection {
  private phase: "connecting" | "waiting" | "ready" | "ending" | "closed" = "connecting";
  private outcome: "incomplete" | "done" | "error" = "incomplete";
  private locked = "";
  private events = 0;
  private sentBytes = 0;
  private readonly request: XaiTranscriptionRequest;
  constructor(query: URLSearchParams) { this.request = prepareXaiTranscriptionStream(query); }

  // The shared bridge, not this parser, qualifies the real 101 upgrade.
  opened(): void {
    if (this.phase !== "connecting") this.reject("open_order");
    this.phase = "waiting";
  }
  clientAudio(bytes: Uint8Array): Uint8Array {
    if (this.phase !== "ready" || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 65536
      || this.request.encoding === "pcm" && bytes.length % 2 || this.sentBytes + bytes.length > maxAudio) this.reject("audio");
    this.tick(); this.sentBytes += bytes.length;
    // Byte identity without sharing mutable caller storage across validation/I/O.
    return bytes.slice();
  }
  client(wire: string): Json {
    try {
      const body = parse(wire);
      if (this.phase !== "ready" || body.type !== "audio.done" || Object.keys(body).length !== 1) fail("client_event");
      this.tick(); this.phase = "ending"; return body;
    } catch { this.reject("client_frame"); }
  }
  server(wire: string): XaiTranscriptionObservation {
    try {
      if (this.phase === "connecting" || this.phase === "closed") fail("server_order");
      const body = parse(wire);
      const result: XaiTranscriptionObservation = { body, ready: this.phase === "ready", partial: null, utterance: null,
        transcript: null, terminal: null, nativeDurationSeconds: null, upstreamCostMicros: null };
      if (body.channel_index !== undefined && body.channel_index !== 0) fail("channel");
      this.tick();
      if (body.type === "error") {
        if (typeof body.message !== "string" && !mediaObject(body.error)) fail("error");
        this.outcome = "error"; this.phase = "closed"; this.locked = "";
        result.ready = false; result.terminal = "error"; return result;
      }
      if (body.error !== undefined) fail("embedded_error");
      if (body.type === "transcript.created") {
        if (this.phase !== "waiting") fail("duplicate_ready");
        this.phase = "ready"; result.ready = true; return result;
      }
      if (this.phase !== "ready" && this.phase !== "ending") fail("not_ready");
      if (body.type === "transcript.partial") {
        if (!this.sentBytes || typeof body.is_final !== "boolean" || typeof body.speech_final !== "boolean"
          || body.speech_final && !body.is_final) fail("partial_state");
        const value = transcript(body);
        if (body.start !== undefined) duration(body.start);
        if (body.duration !== undefined) duration(body.duration);
        if (body.speech_final) {
          // The vendor already stitches the entire utterance, including locked chunks.
          result.utterance = value; this.locked = "";
        } else {
          result.partial = text([this.locked, value].filter(Boolean).join(" "));
          if (body.is_final) this.locked = result.partial;
        }
      } else if (body.type === "transcript.done") {
        if (this.phase !== "ending") fail("terminal_order");
        result.transcript = transcript(body); result.nativeDurationSeconds = duration(body.duration);
        this.outcome = "done"; this.phase = "closed"; this.locked = "";
        result.ready = false; result.terminal = "done";
      } else fail("server_event");
      return result;
    } catch { this.reject("server_frame"); }
  }
  // Lost sockets discard incomplete transcript state. No reconnect replay or
  // synthetic final is authorized; these bytes only describe validated input.
  close() {
    this.phase = "closed"; this.locked = "";
    return { outcome: this.outcome, validatedAudioBytes: this.sentBytes, upstreamCostMicros: null };
  }
  private tick(): void { if (++this.events > 32768) this.reject("event_limit"); }
  private reject(reason: string): never { this.phase = "closed"; this.locked = ""; fail(reason); }
}

function transcript(body: Json): string {
  if (body.text !== undefined && body.transcript !== undefined && body.text !== body.transcript) fail("transcript_conflict");
  return text(body.text ?? body.transcript);
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > maxText || encoder.encode(value).length > maxText) fail("text");
  for (const character of value) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("text"); }
  return value;
}
function parse(wire: string): Json {
  if (typeof wire !== "string" || wire.length > 1024 * 1024 || encoder.encode(wire).length > 1024 * 1024) fail("frame");
  let value: unknown; try { value = JSON.parse(wire); } catch { fail("json"); }
  if (!mediaObject(value)) fail("object"); return value;
}
function integer(value: string | null, max: number): number {
  if (value === null || !/^(?:0|[1-9][0-9]{0,5})$/.test(value) || Number(value) > max) fail("integer");
  return Number(value);
}
function duration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 86400) fail("duration");
  return value;
}
function fail(reason: string): never { throw new Error(`invalid_xai_transcription_stream_${reason}`); }
