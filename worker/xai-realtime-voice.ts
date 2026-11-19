import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";

type Json = Record<string, unknown>;
type Outcome = "completed" | "failed" | "incomplete" | "cancelled";
type Call = { itemId: string; callId: string; name: string; arguments: string };
const encoder = new TextEncoder(), maxFrame = 1024 * 1024, maxAudio = 32 * 1024 * 1024;
export const xaiRealtimeVoiceModel = "grok-voice-latest";
export const xaiRealtimeVoices = ["eve", "ara", "rex", "sal", "leo"] as const;
export function prepareXaiRealtimeVoiceQuery(query: URLSearchParams) {
  if ([...query.keys()].some(key => key !== "model") || query.getAll("model").length !== 1 || query.get("model") !== xaiRealtimeVoiceModel) fail("query");
  return { path: "/v1/realtime", query: new URLSearchParams(query), model: xaiRealtimeVoiceModel };
}
export interface XaiRealtimeVoiceSetup { body: Json; bytesPerSecond: 8000 | 48000; tools: readonly string[]; resumption: boolean }
export function prepareXaiRealtimeVoiceSetup(value: unknown): XaiRealtimeVoiceSetup {
  const body = object(value); bound(body, 128 * 1024); keys(body, ["type", "session"]);
  if (body.type !== "session.update") fail("setup");
  const session = object(body.session);
  keys(session, ["instructions", "voice", "output_modalities", "turn_detection", "audio", "reasoning", "resumption", "tools", "tool_choice"]);
  if (session.instructions !== undefined) text(session.instructions, 32768);
  if (!(xaiRealtimeVoices as readonly unknown[]).includes(session.voice) || JSON.stringify(session.output_modalities) !== '["audio"]') fail("voice");
  const vad = object(session.turn_detection); keys(vad, ["type", "threshold", "prefix_padding_ms", "silence_duration_ms"]);
  if (vad.type !== "server_vad" || typeof vad.threshold !== "number" || !Number.isFinite(vad.threshold) || vad.threshold < 0.1 || vad.threshold > 0.9) fail("vad");
  integer(vad.prefix_padding_ms, 0, 10000); integer(vad.silence_duration_ms, 0, 10000);
  const audio = object(session.audio); keys(audio, ["input", "output"]);
  const input = object(audio.input), output = object(audio.output); keys(input, ["format", "transcription"]); keys(output, ["format"]);
  const transcription = object(input.transcription); keys(transcription, ["model"]);
  if (transcription.model !== "grok-transcribe") fail("transcription_model");
  const bytesPerSecond = format(input.format);
  if (format(output.format) !== bytesPerSecond) fail("format_mismatch");
  if (session.reasoning !== undefined) {
    const reasoning = object(session.reasoning); keys(reasoning, ["effort"]);
    if (reasoning.effort !== "high" && reasoning.effort !== "none") fail("reasoning");
  }
  let resumption = false;
  if (session.resumption !== undefined) {
    const resume = object(session.resumption); keys(resume, ["enabled"]);
    if (typeof resume.enabled !== "boolean") fail("resumption"); resumption = resume.enabled;
  }
  const tools: string[] = [];
  if (session.tools !== undefined) {
    if (!Array.isArray(session.tools) || !session.tools.length || session.tools.length > 32 || session.tool_choice !== "auto") fail("tools");
    for (const value of session.tools) {
      const tool = object(value); keys(tool, ["type", "name", "description", "parameters"]);
      const name = toolName(tool.name); if (tool.type !== "function" || tools.includes(name)) fail("tool");
      text(tool.description, 4096); const parameters = object(tool.parameters);
      if (parameters.type !== "object") fail("tool_parameters"); object(parameters.properties); bound(parameters, 65536); tools.push(name);
    }
  } else if (session.tool_choice !== undefined) fail("tool_choice");
  return { body: structuredClone(body), bytesPerSecond, tools, resumption };
}
export interface XaiRealtimeVoiceObservation {
  body: Json; ready: boolean; ignored: boolean; responseId: string | null;
  terminal: Outcome | null; previousUnsettledId: string | null;
  audio: { itemId: string; base64: string; decodedBytes: number } | null;
  transcript: { role: "user" | "assistant"; text: string; mode: "delta" | "snapshot"; complete: boolean; itemId: string | null } | null;
  calls: { itemId: string; callId: string; name: string; args: Json }[];
  usage: Json | null; upstreamCostMicros: null;
}

// One connection's protocol state, not durable authority or a transport. The
// bridge owns real 101 validation, caller/grant/budget admission and all I/O.
export class XaiRealtimeVoiceConnection {
  private phase: "connecting" | "setup" | "waiting" | "ready" | "closed" = "connecting";
  private setup: XaiRealtimeVoiceSetup | null = null;
  private response: { id: string; ended: boolean; outcome: Outcome | null } | null = null;
  private createPending = false;
  private cancelPending = false;
  private vadInterrupted = false;
  private truncateAllowed = false;
  private conversationId: string | null = null;
  private readonly seenResponses = new Set<string>();
  private readonly calls = new Map<string, Call>();
  private readonly pendingCalls = new Map<string, Call>();
  private readonly completedCalls = new Set<string>();
  private readonly playback = new Map<string, { responseId: string; bytes: number; playedMs: number; retired: boolean }>();
  private sentAudio = 0;
  private receivedAudio = 0;
  private textMessages = 0;
  private frames = 0;
  constructor(query: URLSearchParams) { prepareXaiRealtimeVoiceQuery(query); }
  opened(): void { if (this.phase !== "connecting") this.reject("open_order"); this.phase = "setup"; }
  client(wire: string): Json {
    try {
      const body = parse(wire); this.tick();
      if (this.phase === "setup") { this.setup = prepareXaiRealtimeVoiceSetup(body); this.phase = "waiting"; return this.setup.body; }
      if (this.phase !== "ready" || !this.setup) fail("not_ready");
      switch (body.type) {
        case "input_audio_buffer.append": {
          keys(body, ["type", "audio"]); const audio = this.audio(body.audio, 65536);
          this.sentAudio += audio.decodedBytes; if (this.sentAudio > maxAudio) fail("input_limit"); break;
        }
        case "conversation.item.create": {
          keys(body, ["type", "item"]); const item = object(body.item);
          if (item.type === "message") {
            keys(item, ["type", "role", "content"]);
            if (item.role !== "user" || !Array.isArray(item.content) || item.content.length !== 1) fail("user_message");
            const content = object(item.content[0]); keys(content, ["type", "text"]);
            if (content.type !== "input_text") fail("user_message"); text(content.text, 32768);
            this.textMessages++;
          } else if (item.type === "function_call_output") {
            keys(item, ["type", "call_id", "output"]); const callId = id(item.call_id);
            if (!this.pendingCalls.has(callId)) fail("unbound_tool_result");
            text(item.output, 65536); JSON.parse(item.output as string);
            this.pendingCalls.delete(callId); this.completedCalls.add(callId);
          } else fail("item_type");
          break;
        }
        case "response.create":
          keys(body, ["type"]);
          if (this.response && !this.response.ended || this.createPending || this.cancelPending || this.pendingCalls.size || this.hasPlayback()) fail("response_gate");
          this.createPending = true; break;
        case "response.cancel":
          keys(body, ["type"]);
          if (this.cancelPending || (!this.response || this.response.ended) && !this.createPending && !this.hasPlayback()) fail("cancel_state");
          this.cancelPending = true; this.truncateAllowed = true; break;
        case "conversation.item.truncate": {
          keys(body, ["type", "item_id", "content_index", "audio_end_ms"]); const itemId = id(body.item_id), item = this.playback.get(itemId);
          if (!this.truncateAllowed || !item || item.retired || body.content_index !== 0) fail("unbound_truncate");
          integer(body.audio_end_ms, 0, Math.floor(item.bytes * 1000 / this.setup.bytesPerSecond));
          item.retired = true; break;
        }
        default: fail("client_event");
      }
      return body;
    } catch { this.reject("client_frame"); }
  }
  // Called by the trusted playback sink. This bounds the next-response gate;
  // validation is not proof of actual playback or a vendor billable duration.
  acknowledgePlayback(itemId: string, playedMs: number): void {
    const item = this.playback.get(id(itemId));
    if (this.phase !== "ready" || !item || item.retired || !this.setup) this.reject("playback_owner");
    const duration = Math.ceil(item.bytes * 1000 / this.setup.bytesPerSecond);
    integer(playedMs, item.playedMs, duration); item.playedMs = playedMs;
  }
  server(wire: string): XaiRealtimeVoiceObservation {
    try {
      const body = parse(wire); this.tick();
      if (this.phase === "connecting" || this.phase === "closed") fail("server_order");
      const result: XaiRealtimeVoiceObservation = { body, ready: this.phase === "ready", ignored: false, responseId: null,
        terminal: null, previousUnsettledId: null, audio: null, transcript: null, calls: [], usage: null, upstreamCostMicros: null };
      if (body.type === "session.created") return result;
      if (body.type === "conversation.created") {
        const conversationId = id(object(body.conversation).id);
        if (this.conversationId && this.conversationId !== conversationId) fail("conversation"); this.conversationId = conversationId; return result;
      }
      if (body.type === "session.updated") {
        if (this.phase !== "waiting") fail("setup_ack"); this.phase = "ready"; result.ready = true; return result;
      }
      if (body.type === "error") {
        const error = typeof body.error === "string" ? body.error : object(body.error).message;
        if (this.cancelPending && error === "Cancellation failed: no active response found") {
          this.cancelPending = false; return result;
        }
        this.phase = "closed"; result.ready = false; return result;
      }
      if (this.phase !== "ready" || !this.setup) fail("not_ready");
      if (body.type === "input_audio_buffer.speech_started") {
        this.vadInterrupted = true; this.truncateAllowed = true; return result;
      }
      if (body.type === "response.created") {
        const responseId = id(object(body.response).id);
        if (this.seenResponses.has(responseId)) { result.ignored = true; return result; }
        if (this.response && !this.response.ended) {
          if (!this.vadInterrupted && !this.cancelPending) fail("overlapping_response");
          result.previousUnsettledId = this.response.id;
        }
        if (this.seenResponses.size >= 1024) fail("response_limit");
        this.seenResponses.add(responseId); this.response = { id: responseId, ended: false, outcome: null };
        this.calls.clear(); this.createPending = false; this.cancelPending = false; this.vadInterrupted = false; this.truncateAllowed = false;
        result.responseId = responseId; return result;
      }
      if (typeof body.type !== "string") fail("event");
      if (body.type.startsWith("response.")) {
        const nested = body.response == null ? null : object(body.response), responseId = body.response_id ?? nested?.id;
        if (body.response_id != null && nested?.id != null && body.response_id !== nested.id) fail("response_id");
        if (responseId !== undefined) id(responseId);
        if (!this.response) fail("missing_response");
        if (this.response.ended || responseId !== undefined && responseId !== this.response.id) { result.ignored = true; return result; }
        result.responseId = this.response.id;
        if (body.type === "response.output_audio.delta") {
          if (this.cancelPending || this.vadInterrupted) { result.ignored = true; return result; }
          if (body.delta !== undefined && body.data !== undefined && body.delta !== body.data) fail("audio_conflict");
          const audio = this.audio(body.delta ?? body.data, 512 * 1024), itemId = id(body.item_id);
          const item = this.playback.get(itemId);
          if (item && (item.responseId !== this.response.id || item.retired) || !item && this.playback.size >= 1024) fail("playback_item");
          this.receivedAudio += audio.decodedBytes; if (this.receivedAudio > maxAudio) fail("output_limit");
          this.playback.set(itemId, { responseId: this.response.id, bytes: (item?.bytes ?? 0) + audio.decodedBytes, playedMs: item?.playedMs ?? 0, retired: false });
          result.audio = { itemId, ...audio }; return result;
        }
        if (body.type === "response.function_call_arguments.delta" || body.type === "response.function_call_arguments.done") {
          const itemId = id(body.item_id), prior = this.calls.get(itemId);
          const name = body.name === undefined ? prior?.name ?? "" : toolName(body.name);
          const callId = body.call_id === undefined ? prior?.callId ?? "" : id(body.call_id);
          if (prior && (prior.name && name !== prior.name || prior.callId && callId !== prior.callId)) fail("tool_identity");
          const args = body.type.endsWith(".delta") ? (prior?.arguments ?? "") + text(body.delta, 65536) : text(body.arguments ?? prior?.arguments, 65536);
          this.buffer({ itemId, name, callId, arguments: text(args, 65536) }); return result;
        }
        if (body.type === "response.output_item.done") {
          const item = object(body.item); if (item.type === "function_call") this.buffer(this.call(item)); return result;
        }
        if (body.type === "response.done") {
          if (responseId === undefined || !nested || !["completed", "failed", "incomplete", "cancelled"].includes(String(nested.status))) fail("terminal");
          const outcome = nested.status as Outcome;
          if (nested.usage != null) result.usage = object(nested.usage);
          if (outcome === "completed") {
            if (nested.output !== undefined) {
              if (!Array.isArray(nested.output) || nested.output.length > 128) fail("output");
              for (const raw of nested.output) { const item = object(raw); if (item.type === "function_call") this.buffer(this.call(item)); }
            }
            const unique = new Map<string, Call>();
            for (const call of this.calls.values()) {
              id(call.callId); if (!this.setup.tools.includes(call.name) || this.completedCalls.has(call.callId) || this.pendingCalls.has(call.callId)) fail("tool_owner");
              const prior = unique.get(call.callId);
              if (prior && (prior.name !== call.name || prior.arguments !== call.arguments || prior.itemId !== call.itemId)) fail("tool_conflict");
              unique.set(call.callId, call); const args = object(JSON.parse(call.arguments));
              if (!prior) result.calls.push({ itemId: call.itemId, callId: call.callId, name: call.name, args });
            }
            if (this.pendingCalls.size + unique.size > 128 || this.completedCalls.size + unique.size > 1024) fail("tool_limit");
            for (const [key, call] of unique) this.pendingCalls.set(key, call);
          } else for (const item of this.playback.values()) if (item.responseId === this.response.id) item.retired = true;
          this.response.ended = true; this.response.outcome = outcome; this.calls.clear(); this.cancelPending = false;
          result.terminal = outcome; return result;
        }
      }
      const inputTranscript = body.type.startsWith("conversation.item.input_audio_transcription.");
      const assistantTranscript = /^(?:response\.(?:text|output_text|output_audio_transcript))\.(?:delta|done)$/.test(body.type);
      if (inputTranscript || assistantTranscript) {
        if (body.type.endsWith(".failed")) return result;
        const delta = body.type.endsWith(".delta"), value = delta ? body.delta : body.transcript ?? body.text;
        result.transcript = { role: inputTranscript ? "user" : "assistant", text: text(value, 262144), mode: delta ? "delta" : "snapshot",
          complete: !inputTranscript && !delta, itemId: body.item_id === undefined ? null : id(body.item_id) };
        return result;
      }
      if (["conversation.item.created", "conversation.item.added", "conversation.item.truncated", "input_audio_buffer.speech_stopped", "input_audio_buffer.committed",
        "response.output_item.added", "response.content_part.added", "response.content_part.done", "response.output_audio.done"].includes(body.type)) return result;
      fail("server_event");
    } catch { this.reject("server_frame"); }
  }
  close() {
    this.phase = "closed";
    const outcome = this.response?.ended && !this.createPending ? this.response.outcome : "incomplete";
    const result = { outcome, responseId: this.response?.id ?? null, unresolvedCalls: this.pendingCalls.size,
      validatedInputBytes: this.sentAudio, observedOutputBytes: this.receivedAudio, validatedTextMessages: this.textMessages, upstreamCostMicros: null };
    this.calls.clear(); this.pendingCalls.clear(); this.playback.clear(); return result;
  }
  private call(item: Json): Call {
    if (item.status !== undefined && item.status !== "completed") fail("partial_tool");
    return { itemId: id(item.id), callId: id(item.call_id), name: toolName(item.name), arguments: text(item.arguments, 65536) };
  }
  private buffer(call: Call): void {
    if (!this.calls.has(call.itemId) && this.calls.size >= 128) fail("tool_limit");
    const prior = this.calls.get(call.itemId);
    if (prior && (prior.callId && call.callId !== prior.callId || prior.name && call.name !== prior.name)) fail("tool_identity");
    this.calls.set(call.itemId, call);
  }
  private audio(value: unknown, limit: number) {
    const audio = canonicalMediaBase64(value, limit, () => fail("audio"));
    if (!audio.decodedBytes || this.setup?.bytesPerSecond === 48000 && audio.decodedBytes % 2) fail("pcm_alignment"); return audio;
  }
  private hasPlayback(): boolean {
    return [...this.playback.values()].some(item => !item.retired && item.playedMs < Math.ceil(item.bytes * 1000 / (this.setup?.bytesPerSecond ?? 8000)));
  }
  private tick(): void { if (++this.frames > 32768) this.reject("frame_limit"); }
  private reject(reason: string): never { this.phase = "closed"; fail(reason); }
}
function format(value: unknown): 8000 | 48000 {
  const format = object(value);
  if (format.type === "audio/pcmu") { keys(format, ["type"]); return 8000; }
  keys(format, ["type", "rate"]); if (format.type !== "audio/pcm" || format.rate !== 24000) fail("format"); return 48000;
}
function parse(wire: string): Json { if (typeof wire !== "string" || wire.length > maxFrame || encoder.encode(wire).length > maxFrame) fail("frame"); return object(JSON.parse(wire)); }
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) fail("text");
  for (const character of value) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); } return value;
}
function id(value: unknown): string { if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) fail("id"); return value; }
function toolName(value: unknown): string { if (typeof value !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(value)) fail("tool_name"); return value; }
function integer(value: unknown, min: number, max: number): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail("integer"); return value; }
function bound(value: Json, max: number): void { if (encoder.encode(JSON.stringify(value)).length > max) fail("size"); }
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_xai_realtime_voice_${reason}`); }
