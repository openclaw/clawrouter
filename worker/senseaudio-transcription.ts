export const senseAudioModel = "senseaudio-asr-pro-1.5-260319";
// Decimal bytes conservatively implement the vendor's 10 MB direct-file limit.
export const senseAudioFileLimit = 10_000_000;
const fieldsAllowed = new Set(["model", "language", "prompt", "response_format", "stream"]);
const mimeByExtension: Record<string, readonly string[]> = {
  wav: ["audio/wav", "audio/wave", "audio/x-wav"],
  mp3: ["audio/mpeg", "audio/mp3"], ogg: ["audio/ogg", "application/ogg"],
  flac: ["audio/flac", "audio/x-flac"], aac: ["audio/aac"],
  m4a: ["audio/mp4", "audio/x-m4a"], mp4: ["audio/mp4", "video/mp4"],
};

// The shared controller must authenticate and bound multipart framing first.
// This adapter never reads a network stream or chooses credentials/origins.
export function prepareSenseAudioUpload(upload: { file: File; fields: Record<string, string> }): FormData {
  const { file, fields } = upload;
  if (!(file instanceof File) || !file.size || file.size > senseAudioFileLimit) throw new Error("SenseAudio direct audio must contain 1 to 10000000 bytes");
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,126}$/.test(file.name) || file.name.includes("..")) throw new Error("SenseAudio requires a safe audio filename");
  const formats = mimeByExtension[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!formats || file.type !== "application/octet-stream" && !formats.includes(file.type)) throw new Error("SenseAudio audio filename and MIME are unsupported");
  if (fields.model !== senseAudioModel && fields.model !== `senseaudio/${senseAudioModel}`) throw new Error("SenseAudio transcription model is unqualified");
  for (const [name, value] of Object.entries(fields)) {
    if (!fieldsAllowed.has(name) || typeof value !== "string") throw new Error("SenseAudio transcription field is unsupported");
  }
  if (fields.response_format !== undefined && fields.response_format !== "json" || fields.stream !== undefined && fields.stream !== "false") throw new Error("SenseAudio slice requires unary JSON transcription");
  if (fields.language !== undefined && !/^[a-z]{2,3}$/.test(fields.language)) throw new Error("SenseAudio language must be ISO-639-1 or ISO-639-3");
  if (fields.prompt !== undefined && new TextEncoder().encode(fields.prompt).length > 16_384) throw new Error("SenseAudio prompt exceeds router byte limit");
  const form = new FormData();
  form.set("file", file, file.name);
  for (const [name, value] of Object.entries(fields)) form.set(name, name === "model" ? senseAudioModel : value);
  return form;
}

export interface SenseAudioObservation { text: string; durationSeconds: number | null }

// Duration is diagnostic vendor evidence, not a token count or dollar charge.
export function observeSenseAudioTranscription(value: unknown, complete: boolean): SenseAudioObservation | null {
  if (!complete || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (typeof root.text !== "string" || Object.hasOwn(root, "error")) return null;
  const seconds = duration(root.duration);
  const info = root.audio_info && typeof root.audio_info === "object" && !Array.isArray(root.audio_info) ? root.audio_info as Record<string, unknown> : null;
  const ms = duration(info?.duration);
  // Do not prefer one conflicting counter, coerce strings, or treat malformed
  // supplied evidence as absent. Native audio_info.duration uses milliseconds.
  let durationSeconds: number | null = null;
  if ((root.duration === undefined || seconds !== null) && (info?.duration === undefined || ms !== null)) {
    if (seconds !== null && ms !== null) durationSeconds = Math.abs(seconds - ms / 1000) < 0.000001 ? seconds : null;
    else durationSeconds = seconds ?? (ms === null ? null : ms / 1000);
  }
  return { text: root.text, durationSeconds };
}
function duration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 1000 ? value : null;
}
