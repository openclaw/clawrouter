import { mediaObject } from "./managed-media-json.ts";

export const mistralRealtimeModel = "voxtral-mini-transcribe-realtime-2602";
export const mistralRealtimePath = "/v1/audio/transcriptions/realtime";
const widths = { pcm_s16le: 2, pcm_s32le: 4, pcm_f16le: 2, pcm_f32le: 4, pcm_mulaw: 1, pcm_alaw: 1 } as const;
type Encoding = keyof typeof widths;
type Json = Record<string, unknown>;
const encoder = new TextEncoder(), maxPartial = 256 * 1024, maxFrame = 1024 * 1024;

export interface MistralRealtimeRequest {
  path: string; query: URLSearchParams; model: string; encoding: Encoding; sampleRate: number; setup: Json;
}

export function prepareMistralRealtime(config: { model?: string; encoding?: Encoding; sampleRate?: number; targetStreamingDelayMs?: number } = {}): MistralRealtimeRequest {
  keys(config, ["model", "encoding", "sampleRate", "targetStreamingDelayMs"]);
  const model = config.model ?? mistralRealtimeModel, encoding = config.encoding ?? "pcm_mulaw";
  const sampleRate = config.sampleRate ?? 8000, delay = config.targetStreamingDelayMs ?? 800;
  if (model !== mistralRealtimeModel || !Object.hasOwn(widths, encoding) || !Number.isSafeInteger(sampleRate)
    || sampleRate < 8000 || sampleRate > 48000 || !Number.isSafeInteger(delay) || delay < 1 || delay > 10000) fail("setup");
  return { model, path: mistralRealtimePath, query: new URLSearchParams({ model, target_streaming_delay_ms: String(delay) }), encoding, sampleRate,
    setup: { type: "session.update", session: { audio_format: { encoding, sample_rate: sampleRate } } } };
}

export interface MistralRealtimeObservation {
  body: Json; ready: boolean; partial: string | null; final: string | null;
  terminal: "done" | "error" | null; usage: Json | null;
}

// A single socket's bounded decoder, not a second session/credential store.
// Runtime must own actual dispatch acknowledgment, lifetime and settlement.
export class MistralRealtimeConnection {
  private phase: "connecting" | "created" | "configured" | "ready" | "ended" | "closed" = "connecting";
  private partial = "";
  private hadFinalSegment = false;
  private events = 0;
  private requestId: string | undefined;
  private readonly request: MistralRealtimeRequest;
  constructor(request: MistralRealtimeRequest) {
    this.request = { ...request, query: new URLSearchParams(request.query), setup: structuredClone(request.setup) };
  }

  client(wire: string): Json {
    const body = parse(wire);
    if (body.type === "session.update") {
      if (this.phase !== "created") fail("setup_order");
      keys(body, ["type", "session"]); const session = object(body.session); keys(session, ["audio_format"]);
      const audio = object(session.audio_format); keys(audio, ["encoding", "sample_rate"]);
      if (audio.encoding !== this.request.encoding || audio.sample_rate !== this.request.sampleRate) fail("format_mismatch");
      this.tick(); this.phase = "configured"; return body;
    }
    if (this.phase !== "ready") fail("not_ready");
    if (body.type === "input_audio.append") {
      keys(body, ["type", "audio"]); audioBytes(body.audio, widths[this.request.encoding]);
    } else if (body.type === "input_audio.flush" || body.type === "input_audio.end") keys(body, ["type"]);
    else fail("client_event");
    this.tick(); if (body.type === "input_audio.end") this.phase = "ended";
    return body;
  }

  server(wire: string): MistralRealtimeObservation {
    if (this.phase === "closed") fail("closed");
    const body = parse(wire), observation: MistralRealtimeObservation = {
      body, ready: this.phase === "ready", partial: null, final: null, terminal: null,
      usage: mediaObject(body.usage) ? body.usage : null,
    };
    if (body.error !== undefined && body.type !== "error") fail("embedded_error");
    if (body.type === "error") {
      object(body.error); this.tick(); this.close(); observation.ready = false; observation.terminal = "error"; return observation;
    }
    if (body.type === "session.created" || body.type === "session.updated") {
      const session = object(body.session);
      if (session.model !== this.request.model) fail("model_mismatch");
      if (typeof session.request_id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(session.request_id)) fail("session_id");
      if (body.type === "session.created") {
        if (this.phase !== "connecting") fail("duplicate_session");
        const format = object(session.audio_format);
        if (typeof format.encoding !== "string" || !Object.hasOwn(widths, format.encoding)
          || !Number.isSafeInteger(format.sample_rate) || Number(format.sample_rate) < 8000 || Number(format.sample_rate) > 48000) fail("format_mismatch");
        this.tick(); this.requestId = session.request_id; this.phase = "created";
      } else {
        if (this.phase !== "configured") fail("setup_order");
        if (session.request_id !== this.requestId) fail("session_mismatch");
        const format = object(session.audio_format);
        if (format.encoding !== this.request.encoding || format.sample_rate !== this.request.sampleRate) fail("format_mismatch");
        this.tick(); this.phase = "ready"; observation.ready = true;
      }
      return observation;
    }
    if (this.phase !== "ready" && this.phase !== "ended") fail("not_ready");
    if (body.model !== undefined && body.model !== this.request.model) fail("model_mismatch");
    if (body.type === "transcription.text.delta") {
      const next = this.partial + text(body.text);
      if (encoder.encode(next).length > maxPartial) { this.close(); fail("transcript_limit"); }
      this.tick(); this.partial = next; observation.partial = next;
    } else if (body.type === "transcription.segment") {
      const segment = text(body.text);
      this.tick();
      if (segment.trim()) { observation.final = segment; this.hadFinalSegment = true; this.partial = ""; }
    } else if (body.type === "transcription.done") {
      const terminal = text(body.text);
      // Segments already own completed speech. A repeated whole transcript or
      // punctuation-only tail cannot replay those finalized words.
      const final = this.hadFinalSegment ? this.partial : terminal.trim() ? terminal : this.partial;
      if (final.trim() && (!this.hadFinalSegment || /[\p{L}\p{N}]/u.test(final))) observation.final = final;
      this.tick(); this.close(); observation.ready = false; observation.terminal = "done";
    } else if (body.type === "transcription.language") {
      if (body.language !== null && (typeof body.language !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(body.language))) fail("language");
      this.tick();
    } else fail("server_event");
    return observation;
  }

  // No implicit partial finalization, replay, vendor cancellation or free claim.
  close(): void { this.phase = "closed"; this.partial = ""; }
  private tick(): void { if (++this.events > 8192) { this.close(); fail("event_limit"); } }
}

function audioBytes(value: unknown, width: number): void {
  if (typeof value !== "string" || !value.length || value.length > 87384 || value.length % 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("audio");
  const bytes = atob(value);
  if (!bytes.length || bytes.length > 65536 || bytes.length % width || btoa(bytes) !== value) fail("audio");
}
function parse(wire: string): Json {
  if (typeof wire !== "string" || encoder.encode(wire).length > maxFrame) fail("frame");
  let body: unknown; try { body = JSON.parse(wire); } catch { fail("json"); }
  return object(body);
}
function text(value: unknown): string { if (typeof value !== "string" || encoder.encode(value).length > maxPartial) fail("text"); return value; }
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_mistral_realtime_${reason}`); }
