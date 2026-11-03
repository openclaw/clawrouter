// Router memory envelope; byte size never establishes billable audio duration.
export const deepgramAudioLimit = 25_000_000;
const booleanOptions = new Set(["smart_format", "punctuate", "diarize", "utterances", "multichannel", "numerals", "detect_entities", "sentiment", "topics", "intents", "filler_words", "paragraphs", "profanity_filter"]);
// Nova-3 supports keyterm; legacy keywords is not a supported substitute.
const repeatedOptions = new Set(["keyterm", "replace", "redact", "tag"]);
const scalarOptions = new Set(["model", "language", "encoding", "sample_rate", "channels", "detect_language", "summarize", "utt_split"]);

export interface DeepgramAudioRequest { body: Uint8Array; contentType: string; query: URLSearchParams }

export function prepareDeepgramPrerecorded(body: Uint8Array, contentType: string, input: URLSearchParams): DeepgramAudioRequest {
  if (!(body instanceof Uint8Array) || !body.byteLength || body.byteLength > deepgramAudioLimit) throw new Error("Deepgram audio exceeds the bounded binary request contract");
  const mime = contentType.toLowerCase().trim();
  if (!/^audio\/[a-z0-9.+-]+$/.test(mime) && mime !== "application/octet-stream") throw new Error("Deepgram prerecorded requires binary audio");
  const query = new URLSearchParams(input);
  // Bound the actual outgoing query, including its default selected model.
  if (!query.has("model")) query.set("model", "nova-3");
  if (query.toString().length > 16_384 || [...query].length > 128) throw new Error("Deepgram query exceeds router bounds");
  const seen = new Set<string>();
  for (const [name, value] of query) {
    if (!booleanOptions.has(name) && !repeatedOptions.has(name) && !scalarOptions.has(name)) throw new Error("Deepgram query option is outside the synchronous file contract");
    if (seen.has(name) && !repeatedOptions.has(name)) throw new Error("Deepgram singleton query option is duplicated");
    seen.add(name);
    if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Deepgram query value is invalid");
    if (booleanOptions.has(name) && value !== "true" && value !== "false") throw new Error("Deepgram boolean option is invalid");
    if (["sample_rate", "channels"].includes(name) && (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error("Deepgram audio format number is invalid");
  }
  if (query.get("model") !== "nova-3") throw new Error("Deepgram prerecorded model is unqualified");
  return { body, contentType: mime, query };
}

export interface DeepgramObservation { text: string; durationSeconds: number | null; channels: number | null }

export function observeDeepgramPrerecorded(value: unknown, complete: boolean): DeepgramObservation | null {
  const root = record(value), results = record(root?.results);
  if (!complete || !root || "err_code" in root || "error" in root || !results || !Array.isArray(results.channels) || !results.channels.length || results.channels.length > 64) return null;
  const transcripts: string[] = [];
  for (const value of results.channels) {
    const channel = record(value);
    if (!channel || !Array.isArray(channel.alternatives)) return null;
    const alternative = record(channel.alternatives[0]);
    if (typeof alternative?.transcript !== "string") return null;
    transcripts.push(alternative.transcript.trim());
  }
  const metadata = record(root.metadata), duration = metadata?.duration, channels = metadata?.channels;
  return {
    // Channels are independent tracks: preserve order and repeated speech.
    text: transcripts.filter(Boolean).join("\n\n"),
    durationSeconds: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 && duration <= Number.MAX_SAFE_INTEGER ? duration : null,
    channels: typeof channels === "number" && Number.isSafeInteger(channels) && channels > 0 && channels <= 64 ? channels : null,
  };
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
