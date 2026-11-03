import { mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";
import type { TranscriptionUpload } from "./transcription-body.ts";

export const xaiTranscriptionPath = "/v1/stt";
export const xaiTranscriptionServiceDefault = "grok-voice-transcribe-2.0";
const encoder = new TextEncoder(), maxJson = 1024 * 1024;
const formats: Record<string, readonly string[]> = {
  wav: ["audio/wav", "audio/wave", "audio/x-wav"], mp3: ["audio/mpeg", "audio/mp3"],
  ogg: ["audio/ogg", "application/ogg"], opus: ["audio/opus", "audio/ogg"], flac: ["audio/flac", "audio/x-flac"],
  aac: ["audio/aac"], mp4: ["audio/mp4", "video/mp4"], m4a: ["audio/mp4", "audio/x-m4a"],
  mkv: ["video/x-matroska", "audio/x-matroska"], webm: ["audio/webm", "video/webm"],
  avi: ["video/x-msvideo"], mov: ["video/quicktime"],
};

// The runtime must authenticate and bound the native multipart upload first,
// then freshly admit the model-less STT service before dispatching its file.
export function prepareXaiTranscription(upload: TranscriptionUpload) {
  const { file, fields } = upload;
  if (!(file instanceof File) || !file.size || file.size > 25_000_000
    || !/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,126}$/.test(file.name) || file.name.includes("..")
    || !mediaObject(fields) || Object.keys(fields).some(key => key !== "language")) fail("upload");
  const types = formats[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!types || file.type !== "application/octet-stream" && !types.includes(file.type)) fail("format");
  if (fields.language !== undefined && (typeof fields.language !== "string" || fields.language.length > 64
    || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(fields.language))) fail("language");
  const body = new FormData();
  if (fields.language !== undefined) body.append("language", fields.language);
  body.append("file", file, file.name);
  // FormData owns its boundary. No fabricated model, provider secret, raw URL,
  // ignored prompt or newer feature is added to the native frozen request.
  return { path: xaiTranscriptionPath, body, headers: new Headers({ accept: "application/json" }) };
}

export function observeXaiTranscription(value: unknown, complete: boolean) {
  if (!complete || !mediaObject(value) || encoder.encode(JSON.stringify(value)).length > maxJson
    || value.error !== undefined || typeof value.text !== "string" || encoder.encode(value.text).length > 256 * 1024
    || value.channels !== undefined && value.channels !== null
    || value.finish_reason !== undefined && value.finish_reason !== null && value.finish_reason !== "stop") fail("result");
  for (const character of value.text) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("text"); }
  if (value.model !== undefined && value.model !== null && value.model !== xaiTranscriptionServiceDefault) fail("model_drift");
  if (value.language !== undefined && (typeof value.language !== "string" || value.language.length > 64
    || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value.language))) fail("language");
  const duration = value.duration === undefined ? null : seconds(value.duration);
  if (value.words !== undefined) {
    if (!Array.isArray(value.words) || value.words.length > 16384) fail("words");
    for (const word of value.words) {
      if (!mediaObject(word) || typeof word.text !== "string" || encoder.encode(word.text).length > 4096
        || seconds(word.start) > seconds(word.end)
        || word.speaker !== undefined) fail("word");
    }
  }
  // Empty text is valid silence. It does not establish a free transcription.
  return { body: value, text: value.text.trim(), observedModel: typeof value.model === "string" ? value.model : null,
    nativeDurationSeconds: duration, upstreamCostMicros: null };
}

export async function readXaiTranscription(response: Response, signal: AbortSignal): Promise<ReturnType<typeof observeXaiTranscription>> {
  return readNativeJson(response, signal, maxJson, body => observeXaiTranscription(body, true), fail);
}
function seconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 86400) fail("duration");
  return value;
}
function fail(reason: string): never { throw new Error(`invalid_xai_transcription_${reason}`); }
