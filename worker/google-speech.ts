import { mediaObject } from "./managed-media-json.ts";

export const googleSpeechModels = [
  "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts",
  "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts",
] as const;
// Conservative qualification cutoff from the current published shutdown date.
export const googleSpeechPreviewCutoff = "2026-11-17T00:00:00Z";
const encoder = new TextEncoder(), audioLimit = 8 * 1024 * 1024;
export interface GoogleSpeechRequest {
  model: string; transport: "generate_content" | "interactions";
  path: string; body: Record<string, unknown>; headers: Headers;
}

export function prepareGoogleSpeech(model: string, body: unknown, now = Date.now()): GoogleSpeechRequest {
  if (!(googleSpeechModels as readonly string[]).includes(model) || !Number.isFinite(now)) throw new Error("unsupported_google_speech_model");
  const interactions = model.startsWith("gemini-3.8-");
  if (!interactions && now >= Date.parse(googleSpeechPreviewCutoff)) throw new Error("google_speech_model_qualification_expired");
  if (!mediaObject(body) || encoder.encode(JSON.stringify(body)).byteLength > 256 * 1024) throw new Error("invalid_google_speech_request");
  if (interactions) validateInteractions(body, model); else validateGenerateContent(body);
  return { model, transport: interactions ? "interactions" : "generate_content",
    path: interactions ? "/v1beta/interactions" : "/v1beta/models/" + model + ":generateContent",
    body, headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

function validateGenerateContent(body: Record<string, unknown>): void {
  keys(body, ["contents", "generationConfig"]);
  const contents = list(body.contents, 1, 1), content = object(contents[0]);
  keys(content, ["role", "parts"]);
  if (content.role !== "user") throw new Error("invalid_google_speech_role");
  const part = object(list(content.parts, 1, 1)[0]); keys(part, ["text"]); text(part.text, 65536);
  const config = object(body.generationConfig); keys(config, ["responseModalities", "speechConfig"]);
  if (JSON.stringify(config.responseModalities) !== '["AUDIO"]') throw new Error("invalid_google_speech_modalities");
  const speech = object(config.speechConfig); keys(speech, ["voiceConfig"]);
  const voice = object(speech.voiceConfig); keys(voice, ["prebuiltVoiceConfig"]);
  const prebuilt = object(voice.prebuiltVoiceConfig); keys(prebuilt, ["voiceName"]); text(prebuilt.voiceName, 128);
}

function validateInteractions(body: Record<string, unknown>, model: string): void {
  keys(body, ["model", "store", "input", "response_format", "generation_config"]);
  if (body.model !== model || body.store !== false) throw new Error("google_speech_requires_stateless_identity");
  const format = object(body.response_format); keys(format, ["type", "mime_type", "sample_rate"]);
  if (format.type !== "audio" || format.mime_type !== "audio/l16" || format.sample_rate !== 24000) throw new Error("invalid_google_speech_audio_format");
  const config = object(body.generation_config); keys(config, ["speech_config"]);
  const cast = new Set<string>();
  if (Array.isArray(config.speech_config)) {
    const voice = object(list(config.speech_config, 1, 1)[0]); keys(voice, ["voice"]); text(voice.voice, 128);
  } else {
    const speech = object(config.speech_config); keys(speech, ["mode", "speakers"]);
    if (speech.mode !== "conversational") throw new Error("invalid_google_speech_mode");
    for (const entry of list(speech.speakers, 2, 2)) {
      const speaker = object(entry); keys(speaker, ["speaker", "voice"]);
      text(speaker.speaker, 80); text(speaker.voice, 128);
      if (cast.has(speaker.speaker as string)) throw new Error("duplicate_google_speech_speaker");
      cast.add(speaker.speaker as string);
    }
  }
  const input = object(list(body.input, 1, 1)[0]); keys(input, ["type", "content"]);
  if (input.type !== "user_input") throw new Error("invalid_google_speech_role");
  const turns = list(input.content, 1, 256);
  if (!cast.size && turns.length !== 1) throw new Error("invalid_google_speech_turns");
  for (const value of turns) {
    const turn = object(value); keys(turn, ["type", "text", "annotations"]);
    if (turn.type !== "text") throw new Error("invalid_google_speech_input");
    text(turn.text, 65536);
    if (turn.annotations === undefined) {
      if (cast.size) throw new Error("missing_google_speech_speaker");
      continue;
    }
    const annotation = object(list(turn.annotations, 1, 1)[0]); keys(annotation, ["type", "speaker", "style"]);
    if (annotation.type !== "speech_metadata") throw new Error("invalid_google_speech_metadata");
    if (annotation.style !== undefined) text(annotation.style, 16384);
    if (annotation.speaker !== undefined) text(annotation.speaker, 80);
    if (cast.size && !cast.has(String(annotation.speaker))) throw new Error("unbound_google_speech_speaker");
  }
}

export interface GoogleSpeechAudio { base64: string; mimeType: string; decodedBytes: number; pcmBytes: number }
export function observeGoogleSpeech(body: unknown, request: GoogleSpeechRequest, complete: boolean): {
  body: Record<string, unknown>; audio: GoogleSpeechAudio[];
} {
  if (!complete || !mediaObject(body) || body.error !== undefined) throw new Error("invalid_google_speech_response");
  const blocks: unknown[] = [];
  if (request.transport === "interactions") {
    if (body.status !== undefined && body.status !== "completed") throw new Error("incomplete_google_speech_interaction");
    if (body.model !== undefined && body.model !== request.model) throw new Error("google_speech_model_mismatch");
    if (body.output_audio !== undefined && body.outputAudio !== undefined) throw new Error("ambiguous_google_speech_audio");
    const direct = body.output_audio ?? body.outputAudio;
    if (direct !== undefined) blocks.push(direct);
    else for (const value of list(body.steps, 1, 64)) {
      const step = object(value);
      for (const item of list(step.content, 0, 64)) {
        const block = object(item), mime = block.mime_type ?? block.mimeType;
        if (block.type === "audio" || typeof mime === "string" && mime.toLowerCase().startsWith("audio/")) blocks.push(block);
      }
    }
  } else {
    if (mediaObject(body.promptFeedback) && body.promptFeedback.blockReason !== undefined && body.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED") throw new Error("blocked_google_speech_response");
    for (const value of list(body.candidates, 1, 16)) {
      const candidate = object(value);
      if (candidate.finishReason !== "STOP") throw new Error("incomplete_google_speech_candidate");
      const content = object(candidate.content);
      for (const value of list(content.parts, 1, 64)) {
        const part = object(value);
        if (part.thought === true) continue;
        if (part.inlineData !== undefined && part.inline_data !== undefined) throw new Error("ambiguous_google_speech_audio");
        const inline = part.inlineData ?? part.inline_data;
        if (inline !== undefined) blocks.push(inline);
      }
    }
  }
  if (!blocks.length || blocks.length > 32) throw new Error("missing_google_speech_audio");
  const audio: GoogleSpeechAudio[] = [];
  let total = 0;
  for (const value of blocks) {
    const block = object(value);
    if (block.mimeType !== undefined && block.mime_type !== undefined && block.mimeType !== block.mime_type) throw new Error("ambiguous_google_speech_audio_mime");
    const mime = block.mimeType ?? block.mime_type;
    // The frozen Interactions request fixes raw PCM; an omitted MIME inherits
    // that request. GenerateContent must identify the native inline media.
    const mimeType = mime === undefined && request.transport === "interactions" ? "audio/l16" : mime;
    if (typeof mimeType !== "string" || !/^audio\/(?:l16|pcm|wav)(?:;[a-z0-9= ;.-]+)?$/i.test(mimeType)) throw new Error("unsupported_google_speech_audio_mime");
    const parameters = new Map<string, string>();
    for (const item of mimeType.toLowerCase().split(";").slice(1)) {
      const [name, value, extra] = item.trim().split("=");
      if (extra !== undefined || parameters.has(name) || !["codec", "rate", "channels"].includes(name)
        || name === "codec" && value !== "pcm" || name === "rate" && value !== "24000"
        || name === "channels" && value !== "1") throw new Error("unsupported_google_speech_pcm_format");
      parameters.set(name, value);
    }
    const base64 = canonicalBase64(block.data);
    const decodedBytes = base64.length / 4 * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
    total += decodedBytes;
    if (!decodedBytes || total > audioLimit) throw new Error("google_speech_audio_too_large");
    const raw = atob(base64), bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
    if (btoa(raw) !== base64) throw new Error("invalid_google_speech_base64");
    const wav = new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF";
    if (/^audio\/wav/i.test(mimeType) && !wav) throw new Error("invalid_google_speech_wav");
    const pcmBytes = wav ? validateWav(bytes) : bytes.byteLength;
    if (pcmBytes % 2) throw new Error("invalid_google_speech_pcm");
    audio.push({ base64, mimeType, decodedBytes, pcmBytes });
  }
  return { body, audio };
}

function canonicalBase64(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(audioLimit / 3) * 4 + 2
    || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length % 4 === 1
    || value.includes("=") && value.length % 4 !== 0) throw new Error("invalid_google_speech_base64");
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  return standard + "=".repeat((4 - standard.length % 4) % 4);
}
function validateWav(bytes: Uint8Array): number {
  if (bytes.length < 44) throw new Error("invalid_google_speech_wav");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), ascii = (at: number) => new TextDecoder().decode(bytes.subarray(at, at + 4));
  if (ascii(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) throw new Error("invalid_google_speech_wav");
  let offset = 12, chunks = 0, format = false, pcmBytes = 0;
  while (offset + 8 <= bytes.length && chunks++ < 256) {
    const name = ascii(offset), size = view.getUint32(offset + 4, true), start = offset + 8, end = start + size;
    if (end > bytes.length) throw new Error("invalid_google_speech_wav");
    if (name === "fmt ") {
      if (format || size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1
        || view.getUint32(start + 4, true) !== 24000 || view.getUint32(start + 8, true) !== 48000
        || view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16) throw new Error("unsupported_google_speech_wav_format");
      format = true;
    } else if (name === "data") {
      if (!format || pcmBytes || !size) throw new Error("invalid_google_speech_wav");
      pcmBytes = size;
    }
    offset = end + size % 2;
  }
  if (offset !== bytes.length || !format || !pcmBytes) throw new Error("invalid_google_speech_wav");
  return pcmBytes;
}
function object(value: unknown): Record<string, unknown> {
  if (!mediaObject(value)) throw new Error("invalid_google_speech_object"); return value;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("unsupported_google_speech_field");
}
function list(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error("invalid_google_speech_list"); return value;
}
function text(value: unknown, max: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("invalid_google_speech_text");
}
