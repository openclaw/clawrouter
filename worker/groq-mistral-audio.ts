import { inputRetirement } from "./input-retirement.ts";
import { mediaObject } from "./managed-media-json.ts";
import type { TranscriptionUpload } from "./transcription-body.ts";

export const groqMistralAudio = {
  groq: { model: "whisper-large-v3-turbo", origin: "https://api.groq.com", path: "/openai/v1/audio/transcriptions" },
  mistral: { model: "voxtral-mini-latest", origin: "https://api.mistral.ai", path: "/v1/audio/transcriptions" },
} as const;
type Provider = keyof typeof groqMistralAudio;
const encoder = new TextEncoder(), maxResponse = 1024 * 1024;
const formats: Record<string, readonly string[]> = {
  flac: ["audio/flac", "audio/x-flac"], mp3: ["audio/mpeg", "audio/mp3"], mp4: ["audio/mp4", "video/mp4"],
  mpeg: ["audio/mpeg"], mpga: ["audio/mpeg"], m4a: ["audio/mp4", "audio/x-m4a"],
  ogg: ["audio/ogg", "application/ogg"], wav: ["audio/wav", "audio/wave", "audio/x-wav"], webm: ["audio/webm", "video/webm"],
};

// Shared runtime owns authentication and bounded multipart parsing BEFORE this
// adapter. It must freshly admit the selected model after the upload finishes.
export function prepareGroqMistralAudio(provider: Provider, upload: TranscriptionUpload): {
  model: string; path: string; body: FormData; headers: Headers;
} {
  const contract = select(provider), { file, fields } = upload;
  if (!(file instanceof File) || !file.size || file.size > 25_000_000
    || !/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,126}$/.test(file.name) || file.name.includes("..")
    || !mediaObject(fields) || fields.model !== contract.model) fail();
  const types = formats[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!types || file.type !== "application/octet-stream" && !types.includes(file.type)) fail();
  if (Object.keys(fields).some(key => !["model", "language", "prompt"].includes(key))) fail("option");
  if (fields.language !== undefined && !/^[a-z]{2}$/.test(fields.language)) fail("language");
  if (fields.prompt !== undefined) {
    // Mistral's native API has context_bias, not a qualified Whisper prompt field.
    // Do not silently drop or translate the frozen generic client's optional prompt.
    if (provider === "mistral") fail("mistral_prompt_unqualified");
    if (typeof fields.prompt !== "string" || !fields.prompt.trim() || encoder.encode(fields.prompt).length > 4096) fail("prompt");
  }
  const body = new FormData();
  for (const key of ["model", "language", "prompt"]) if (fields[key] !== undefined) body.append(key, fields[key]);
  body.append("file", file, file.name);
  // FormData owns Content-Type/boundary. Credentials are supplied only by the runtime.
  return { model: contract.model, path: contract.path, body, headers: new Headers({ accept: "application/json" }) };
}

export function observeGroqMistralAudio(provider: Provider, body: unknown, complete: boolean): {
  body: Record<string, unknown>; text: string; requestedModel: string; observedModel: string | null;
  observedAudioSeconds: number | null;
} {
  const contract = select(provider);
  if (!complete || !mediaObject(body) || encoder.encode(JSON.stringify(body)).length > maxResponse
    || body.error !== undefined || typeof body.text !== "string" || !body.text.trim() || body.text.length > 262144) fail("result");
  if (body.model !== undefined && (typeof body.model !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.model))) fail("model");
  if (body.finish_reason !== undefined && body.finish_reason !== null && body.finish_reason !== "stop") fail("partial");
  const seconds = provider === "groq" ? body.duration : mediaObject(body.usage) ? body.usage.prompt_audio_seconds : undefined;
  // Diagnostic provider duration is not a qualified billable duration or tariff.
  const observedAudioSeconds = typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400 ? seconds : null;
  return { body, text: body.text.trim(), requestedModel: contract.model,
    observedModel: typeof body.model === "string" ? body.model : null, observedAudioSeconds };
}

export async function readGroqMistralAudio(response: Response, provider: Provider, signal: AbortSignal): Promise<ReturnType<typeof observeGroqMistralAudio>> {
  select(provider);
  const length = response.headers.get("content-length");
  if (!response.body) fail("response");
  const reader = response.body.getReader(), input = inputRetirement(reader);
  if (response.status !== 200 || response.redirected
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxResponse)) {
    await input.retire("cancel"); fail("response");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void input.retire("cancel", signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  let bytes = 0, json = "", eof = false;
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await input.read(() => reader.read()); signal.throwIfAborted();
      if (chunk.done) { eof = true; break; }
      bytes += chunk.value.byteLength; if (bytes > maxResponse) fail("size");
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
    if (!response.headers.has("content-encoding") && length !== null && Number(length) !== bytes) fail("truncated");
    return observeGroqMistralAudio(provider, JSON.parse(json), true);
  } catch {
    await input.retire("cancel", signal.reason); return fail("response");
  } finally { signal.removeEventListener("abort", abort); await input.retire(eof ? "eof" : "cancel", signal.reason); }
}

function select(provider: Provider): (typeof groqMistralAudio)[Provider] {
  if (provider !== "groq" && provider !== "mistral") fail("provider");
  return groqMistralAudio[provider];
}
function fail(reason = "request"): never { throw new Error(`invalid_native_audio_${reason}`); }
