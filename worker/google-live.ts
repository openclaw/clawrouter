import { mediaObject } from "./managed-media-json.ts";

export const googleLiveModels = [
  "gemini-3.1-flash-live-preview", "gemini-3.8-live", "gemini-3.8-live-extended-thinking",
  "gemini-2.5-flash-native-audio-preview-12-2025",
] as const;
export const googleLivePath = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const previewCutoff = Date.parse("2026-11-17T00:00:00Z");
const encoder = new TextEncoder();
const maxFrame = 1024 * 1024, maxSetup = 128 * 1024, maxCalls = 1024;
type Json = Record<string, unknown>;
type Tool = { name: string; nonBlocking: boolean };

export interface GoogleLiveSetup {
  body: Json; model: string; tools: readonly Tool[]; manualActivity: boolean;
  realtimeText: boolean; completeInputTranscripts: boolean; extendedThinking: boolean;
  toolContinuation: boolean; audioStreamEndsTurn: boolean;
}

// This validates native SDK-serialized setup, not the SDK's shorthand config.
// Auth, admission and all transport/session ownership remain runtime-owned.
export function prepareGoogleLiveSetup(body: unknown, now = Date.now()): GoogleLiveSetup {
  const frame = object(body); bound(frame, maxSetup); keys(frame, ["setup"]);
  const setup = object(frame.setup); keys(setup, ["model", "generationConfig", "systemInstruction", "tools",
    "realtimeInputConfig", "inputAudioTranscription", "outputAudioTranscription", "sessionResumption", "contextWindowCompression"]);
  if (typeof setup.model !== "string" || !setup.model.startsWith("models/")) fail();
  const model = setup.model.slice(7);
  if (!(googleLiveModels as readonly string[]).includes(model) || !Number.isFinite(now)
    || model.includes("preview") && now >= previewCutoff) fail("model_unqualified");
  const realtimeText = model === googleLiveModels[0], extendedThinking = model === googleLiveModels[2];
  const v38 = model === googleLiveModels[1] || extendedThinking;
  const config = object(setup.generationConfig);
  keys(config, ["responseModalities", "speechConfig", "temperature", "thinkingConfig", "enableAffectiveDialog"]);
  if (JSON.stringify(config.responseModalities) !== '["AUDIO"]') fail();
  if (config.temperature !== undefined && (typeof config.temperature !== "number"
    || !Number.isFinite(config.temperature) || config.temperature <= 0 || config.temperature > 2)) fail();
  const speech = object(config.speechConfig); keys(speech, ["voiceConfig"]);
  const voice = object(speech.voiceConfig); keys(voice, ["prebuiltVoiceConfig"]);
  const prebuilt = object(voice.prebuiltVoiceConfig); keys(prebuilt, ["voiceName"]);
  if (typeof prebuilt.voiceName !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(prebuilt.voiceName)) fail();
  if (config.enableAffectiveDialog !== undefined && (realtimeText || typeof config.enableAffectiveDialog !== "boolean")) fail();
  if (config.thinkingConfig !== undefined) {
    const thinking = object(config.thinkingConfig);
    if (model === googleLiveModels[1]) fail("thinking_unsupported");
    if (realtimeText || extendedThinking) {
      keys(thinking, ["thinkingLevel"]);
      if (!(extendedThinking ? ["LOW", "MEDIUM", "HIGH"] : ["MINIMAL", "LOW", "MEDIUM", "HIGH"]).includes(String(thinking.thinkingLevel))) fail();
    } else {
      keys(thinking, ["thinkingBudget"]); integer(thinking.thinkingBudget, -1, 24576);
    }
  }
  if (setup.systemInstruction !== undefined) textContent(setup.systemInstruction, ["system", "user"]);
  for (const name of ["inputAudioTranscription", "outputAudioTranscription"]) if (setup[name] !== undefined) keys(object(setup[name]), []);
  // A raw resume handle is not caller authority. The runtime must resolve the
  // original connection's credential/policy before any separate resume egress.
  if (setup.sessionResumption !== undefined) keys(object(setup.sessionResumption), []);
  if (setup.contextWindowCompression !== undefined) {
    const compression = object(setup.contextWindowCompression); keys(compression, ["slidingWindow"]);
    keys(object(compression.slidingWindow), []);
  }
  const tools: Tool[] = [];
  if (setup.tools !== undefined) for (const entry of list(setup.tools, 1, 1)) {
    const tool = object(entry); keys(tool, ["functionDeclarations"]);
    for (const value of list(tool.functionDeclarations, 1, 32)) {
      const declaration = object(value); keys(declaration, ["name", "description", "parameters", "behavior"]);
      const name = toolName(declaration.name);
      if (tools.some(tool => tool.name === name)) fail();
      if (declaration.description !== undefined) text(declaration.description, 4096, true);
      if (declaration.parameters !== undefined) object(declaration.parameters);
      if (declaration.behavior !== undefined && !["BLOCKING", "NON_BLOCKING"].includes(String(declaration.behavior))) fail();
      const nonBlocking = declaration.behavior === "NON_BLOCKING";
      if (realtimeText && nonBlocking || extendedThinking && !nonBlocking) fail("tool_behavior");
      tools.push({ name, nonBlocking });
    }
  }
  let manualActivity = false;
  if (setup.realtimeInputConfig !== undefined) {
    const input = object(setup.realtimeInputConfig); keys(input, ["automaticActivityDetection", "activityHandling", "turnCoverage"]);
    if (input.activityHandling !== undefined && !["START_OF_ACTIVITY_INTERRUPTS", "NO_INTERRUPTION"].includes(String(input.activityHandling))) fail();
    if (input.turnCoverage !== undefined && !["TURN_INCLUDES_ONLY_ACTIVITY", "TURN_INCLUDES_ALL_INPUT", "TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO"].includes(String(input.turnCoverage))) fail();
    if (input.automaticActivityDetection !== undefined) {
      const vad = object(input.automaticActivityDetection);
      keys(vad, ["disabled", "startOfSpeechSensitivity", "endOfSpeechSensitivity", "prefixPaddingMs", "silenceDurationMs"]);
      bool(vad.disabled); manualActivity = vad.disabled === true;
      for (const [name, prefix] of [["startOfSpeechSensitivity", "START"], ["endOfSpeechSensitivity", "END"]]) {
        if (vad[name] !== undefined && ![`${prefix}_SENSITIVITY_HIGH`, `${prefix}_SENSITIVITY_LOW`].includes(String(vad[name]))) fail();
      }
      for (const name of ["prefixPaddingMs", "silenceDurationMs"]) if (vad[name] !== undefined) integer(vad[name], 0, 60000);
    }
  }
  return { body: frame, model, tools, manualActivity, realtimeText, extendedThinking,
    completeInputTranscripts: realtimeText || v38, toolContinuation: !realtimeText && !extendedThinking, audioStreamEndsTurn: !v38 };
}

export interface GoogleLiveObservation {
  // Transient native data, including usage/resume handles: never routine logs or public receipts.
  body: Json; ready: boolean; responseDone: boolean; interrupted: boolean;
  audio: { base64: string; decodedBytes: number; mimeType: string }[];
  transcripts: { role: "user" | "assistant"; text: string; complete: boolean }[];
  calls: { id: string; name: string; args: Json }[]; canceledCalls: string[];
  usage: Json | null;
}

// Connection-local protocol state only. This neither opens sockets nor grants
// durable caller/credential authority, reconnection, retries or billing rights.
export class GoogleLiveConnection {
  private ready = false;
  private closed = false;
  private interrupted = false;
  private frames = 0;
  private seen = new Map<string, string>();
  private pending = new Map<string, string>();
  private readonly setup: GoogleLiveSetup;
  constructor(setup: GoogleLiveSetup) { this.setup = structuredClone(setup); }

  client(wire: string): Json {
    if (!this.ready || this.closed) fail("not_ready");
    const body = parse(wire); keys(body, ["realtimeInput", "clientContent", "toolResponse"]);
    if (Object.keys(body).length !== 1) fail();
    const pending = new Map(this.pending);
    if (body.realtimeInput !== undefined) {
      const input = object(body.realtimeInput); keys(input, ["audio", "text", "audioStreamEnd", "activityStart", "activityEnd"]);
      if (Object.keys(input).length !== 1) fail();
      if (input.audio !== undefined) pcm(input.audio, 16000, 64 * 1024);
      if (input.text !== undefined) { if (!this.setup.realtimeText) fail(); text(input.text, 65536); }
      if (input.audioStreamEnd !== undefined && (input.audioStreamEnd !== true || this.setup.manualActivity || !this.setup.audioStreamEndsTurn)) fail();
      for (const name of ["activityStart", "activityEnd"]) if (input[name] !== undefined) {
        if (!this.setup.manualActivity) fail(); keys(object(input[name]), []);
      }
    } else if (body.clientContent !== undefined) {
      if (this.setup.realtimeText) fail();
      const content = object(body.clientContent); keys(content, ["turns", "turnComplete"]);
      if (content.turnComplete !== true) fail();
      textContent(list(content.turns, 1, 1)[0], ["user"]);
    } else {
      const response = object(body.toolResponse); keys(response, ["functionResponses"]);
      const ids = new Set<string>();
      for (const value of list(response.functionResponses, 1, 32)) {
        const result = object(value); keys(result, ["id", "name", "response", "willContinue", "scheduling"]);
        const id = identity(result.id), name = toolName(result.name);
        if (ids.has(id) || pending.get(id) !== name) fail("tool_owner"); ids.add(id);
        object(result.response); bool(result.willContinue);
        if (result.scheduling !== undefined || result.willContinue === true) {
          if (!this.setup.toolContinuation || !this.setup.tools.some(tool => tool.name === name && tool.nonBlocking)
            || result.scheduling !== undefined && result.scheduling !== "WHEN_IDLE") fail("tool_continuation");
        }
        if (result.willContinue !== true) pending.delete(id);
      }
    }
    this.tick(); this.pending = pending;
    return body;
  }

  server(wire: string): GoogleLiveObservation {
    if (this.closed) fail("closed");
    const body = parse(wire);
    const messages = ["setupComplete", "serverContent", "toolCall", "toolCallCancellation", "goAway", "sessionResumptionUpdate"];
    keys(body, [...messages, "usageMetadata", "voiceActivity"]);
    if (messages.filter(name => body[name] !== undefined).length > 1 || !Object.keys(body).length) fail();
    if (!this.ready && body.setupComplete === undefined) fail("not_ready");
    const observation: GoogleLiveObservation = { body, ready: this.ready, responseDone: false, interrupted: false,
      audio: [], transcripts: [], calls: [], canceledCalls: [], usage: null };
    const seen = new Map(this.seen), pending = new Map(this.pending);
    let interrupted = this.interrupted;
    if (body.setupComplete !== undefined) {
      if (this.ready) fail("duplicate_setup"); keys(object(body.setupComplete), []); observation.ready = true;
    }
    if (body.usageMetadata !== undefined) observation.usage = object(body.usageMetadata);
    if (body.voiceActivity !== undefined) object(body.voiceActivity);
    if (body.serverContent !== undefined) {
      const content = object(body.serverContent);
      keys(content, ["modelTurn", "turnComplete", "generationComplete", "interrupted", "inputTranscription", "outputTranscription", "waitingForInput", "interactionStatus"]);
      for (const name of ["turnComplete", "generationComplete", "interrupted", "waitingForInput"]) bool(content[name]);
      if (content.interactionStatus !== undefined && !["IDLE", "IN_PROGRESS", "INTERACTION_STATUS_UNSPECIFIED"].includes(String(content.interactionStatus))) fail();
      observation.interrupted = content.interrupted === true; interrupted ||= observation.interrupted;
      for (const [name, role] of [["inputTranscription", "user"], ["outputTranscription", "assistant"]] as const) {
        if (content[name] === undefined) continue;
        const transcript = object(content[name]); keys(transcript, ["text", "finished"]); bool(transcript.finished);
        observation.transcripts.push({ role, text: text(transcript.text, 65536, true),
          complete: role === "user" && this.setup.completeInputTranscripts || transcript.finished === true
            || role === "assistant" && (content.generationComplete === true || content.turnComplete === true || observation.interrupted) });
      }
      if (content.modelTurn !== undefined) {
        const turn = object(content.modelTurn); keys(turn, ["role", "parts"]);
        if (turn.role !== undefined && turn.role !== "model") fail();
        for (const value of list(turn.parts, 1, 64)) {
          const part = object(value); keys(part, ["text", "inlineData", "thought", "thoughtSignature"]); bool(part.thought);
          if (part.thoughtSignature !== undefined) text(part.thoughtSignature, 8192);
          if ((part.text === undefined) === (part.inlineData === undefined)) fail();
          if (part.text !== undefined) text(part.text, 65536, true);
          if (part.inlineData !== undefined) {
            const audio = pcm(part.inlineData, 24000, 768 * 1024);
            if (part.thought !== true) observation.audio.push(audio);
          }
        }
      }
      observation.responseDone = content.turnComplete === true
        && (!this.setup.extendedThinking || interrupted || content.interactionStatus === "IDLE");
      if (observation.responseDone) interrupted = false;
    }
    if (body.toolCall !== undefined) {
      const call = object(body.toolCall); keys(call, ["functionCalls"]);
      for (const value of list(call.functionCalls, 1, 32)) {
        const row = object(value); keys(row, ["id", "name", "args"]);
        const id = identity(row.id), name = toolName(row.name), args = row.args === undefined ? {} : object(row.args);
        if (!this.setup.tools.some(tool => tool.name === name) || seen.has(id) && seen.get(id) !== name) fail("tool_owner");
        if (seen.has(id)) continue;
        if (seen.size >= maxCalls) fail("tool_limit");
        seen.set(id, name); pending.set(id, name); observation.calls.push({ id, name, args });
      }
    }
    if (body.toolCallCancellation !== undefined) {
      const cancellation = object(body.toolCallCancellation); keys(cancellation, ["ids"]);
      for (const raw of list(cancellation.ids, 1, 32)) {
        const id = identity(raw); if (pending.delete(id)) observation.canceledCalls.push(id);
      }
    }
    if (body.goAway !== undefined) {
      const away = object(body.goAway); keys(away, ["timeLeft"]);
      if (typeof away.timeLeft !== "string" || !/^\d{1,6}(?:\.\d{1,9})?s$/.test(away.timeLeft)) fail();
    }
    if (body.sessionResumptionUpdate !== undefined) {
      const update = object(body.sessionResumptionUpdate); keys(update, ["resumable", "newHandle"]);
      if (typeof update.resumable !== "boolean") fail();
      if (update.resumable) text(update.newHandle, 4096);
      else if (update.newHandle !== undefined && update.newHandle !== "") fail();
    }
    this.tick(); this.ready = observation.ready; this.interrupted = interrupted; this.seen = seen; this.pending = pending;
    return observation;
  }

  // Closing stops local forwarding; it proves neither free generation nor a refund.
  close(): void { this.closed = true; this.ready = false; this.pending.clear(); this.seen.clear(); }
  private tick(): void { if (++this.frames > 4096) { this.close(); fail("frame_limit"); } }
}

function pcm(value: unknown, rate: number, max: number): { base64: string; decodedBytes: number; mimeType: string } {
  const audio = object(value); keys(audio, ["mimeType", "data"]);
  const mimeType = `audio/pcm;rate=${rate}`;
  if (audio.mimeType !== mimeType || typeof audio.data !== "string" || !audio.data.length || audio.data.length > Math.ceil(max / 3) * 4
    || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(audio.data) || /[+/]/.test(audio.data) && /[_-]/.test(audio.data)) fail("pcm");
  const data = audio.data.replace(/-/g, "+").replace(/_/g, "/"), bare = data.replace(/=+$/, "");
  if (bare.length % 4 === 1 || data.includes("=") && (data.length % 4 || data !== bare + "=".repeat((4 - bare.length % 4) % 4))) fail("pcm");
  const normalized = bare + "=".repeat((4 - bare.length % 4) % 4);
  const decoded = atob(normalized);
  if (btoa(decoded) !== normalized || !decoded.length || decoded.length > max || decoded.length % 2) fail("pcm");
  return { base64: normalized, decodedBytes: decoded.length, mimeType };
}
function textContent(value: unknown, roles: string[]): void {
  const content = object(value); keys(content, ["role", "parts"]);
  if (content.role !== undefined && !roles.includes(String(content.role))) fail();
  for (const value of list(content.parts, 1, 8)) { const part = object(value); keys(part, ["text"]); text(part.text, 65536); }
}
function parse(wire: string): Json {
  if (typeof wire !== "string" || encoder.encode(wire).length > maxFrame) fail("frame");
  let body: unknown; try { body = JSON.parse(wire); } catch { fail("json"); }
  return object(body);
}
function bound(value: Json, max: number): void { if (encoder.encode(JSON.stringify(value)).length > max) fail("size"); }
function object(value: unknown): Json { if (!mediaObject(value)) fail(); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail(); }
function list(value: unknown, min: number, max: number): unknown[] { if (!Array.isArray(value) || value.length < min || value.length > max) fail(); return value; }
function text(value: unknown, max: number, empty = false): string { if (typeof value !== "string" || !empty && !value.trim() || value.length > max) fail(); return value; }
function bool(value: unknown): void { if (value !== undefined && typeof value !== "boolean") fail(); }
function integer(value: unknown, min: number, max: number): void { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(); }
function identity(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) fail("tool_id"); return value; }
function toolName(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail("tool_name"); return value; }
function fail(reason = "protocol"): never { throw new Error(`invalid_google_live_${reason}`); }
