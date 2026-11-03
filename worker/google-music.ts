import { mediaObject } from "./managed-media-json.ts";

export const googleMusicModels = ["lyria-3-clip-preview", "lyria-3-pro-preview"] as const;
const encoder = new TextEncoder();
const maxRequest = 20 * 1024 * 1024, maxResponse = 24 * 1024 * 1024, maxAudio = 16 * 1024 * 1024;
export interface GoogleMusicRequest { model: string; body: Record<string, unknown>; path: string; headers: Headers }

// Input is the native JSON serialized by the frozen SDK, not its shorthand
// Content[] argument. Prompt/lyrics/instrumental composition stays client-owned.
export function prepareGoogleMusic(model: string, body: unknown): GoogleMusicRequest {
  if (!(googleMusicModels as readonly string[]).includes(model) || !mediaObject(body)
    || encoder.encode(JSON.stringify(body)).byteLength > maxRequest) fail();
  keys(body, ["contents", "generationConfig"]);
  const content = object(list(body.contents, 1, 1)[0]); keys(content, ["parts", "role"]);
  if (content.role !== "user") fail();
  let text = 0, bytes = 0;
  for (const value of list(content.parts, 1, 11)) {
    const part = object(value); keys(part, ["text", "inlineData"]);
    if (Object.keys(part).length !== 1) fail();
    if (part.text !== undefined) {
      if (++text > 1 || typeof part.text !== "string" || !part.text.trim() || part.text.length > 65536) fail();
    } else {
      const image = object(part.inlineData); keys(image, ["mimeType", "data"]);
      if (!["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"].includes(String(image.mimeType))) fail();
      bytes += encoded(image.data, 14 * 1024 * 1024).decodedBytes;
      if (bytes > 14 * 1024 * 1024) fail();
    }
  }
  if (text !== 1) fail();
  const config = object(body.generationConfig); keys(config, ["responseModalities"]);
  if (JSON.stringify(config.responseModalities) !== '["AUDIO","TEXT"]') fail();
  return { model, body, path: "/v1beta/models/" + model + ":generateContent",
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

export function observeGoogleMusic(body: unknown, request: GoogleMusicRequest, complete: boolean): {
  body: Record<string, unknown>; track: { base64: string; decodedBytes: number; mimeType: string }; lyrics: string[];
} {
  if (!complete || !mediaObject(body) || body.error !== undefined) fail();
  if (mediaObject(body.promptFeedback) && body.promptFeedback.blockReason !== undefined
    && body.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED") fail();
  const candidate = object(list(body.candidates, 1, 1)[0]);
  if (candidate.finishReason !== "STOP") fail();
  let track: { base64: string; decodedBytes: number; mimeType: string } | undefined;
  const lyrics: string[] = [];
  let textLength = 0;
  for (const value of list(object(candidate.content).parts, 1, 64)) {
    const part = object(value);
    if (part.thought !== undefined && typeof part.thought !== "boolean") fail();
    if (part.thought === true) continue;
    if (part.inlineData !== undefined && part.inline_data !== undefined) fail();
    const data = part.inlineData ?? part.inline_data;
    if (part.text !== undefined) {
      if (data !== undefined || typeof part.text !== "string" || (textLength += part.text.length) > 65536) fail();
      if (part.text.trim()) lyrics.push(part.text);
      continue;
    }
    const inline = object(data);
    if (track || inline.mimeType !== undefined && inline.mime_type !== undefined) fail();
    const mimeType = inline.mimeType ?? inline.mime_type ?? "audio/mpeg";
    if (mimeType !== "audio/mpeg" && !(request.model === "lyria-3-pro-preview" && mimeType === "audio/wav")) fail();
    track = { ...encoded(inline.data, maxAudio), mimeType: String(mimeType) };
  }
  // Text-only or incomplete output cannot authorize automatic POST replay.
  if (!track) fail();
  return { body, track, lyrics };
}

export async function readGoogleMusic(response: Response, request: GoogleMusicRequest, signal: AbortSignal): Promise<ReturnType<typeof observeGoogleMusic>> {
  if (signal.aborted || response.redirected || response.status !== 200 || !response.body
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || Number(response.headers.get("content-length")) > maxResponse) {
    void response.body?.cancel().catch(() => undefined); fail();
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) fail();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxResponse) fail();
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return observeGoogleMusic(JSON.parse(text), request, true);
  } catch {
    void reader.cancel().catch(() => undefined); fail();
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

function encoded(value: unknown, limit: number): { base64: string; decodedBytes: number } {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(limit / 3) * 4
    || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) fail();
  const standard = value.replace(/-/g, "+").replace(/_/g, "/"), unpadded = standard.replace(/=+$/, "");
  if (unpadded.length % 4 === 1 || standard.includes("=") && standard.length % 4) fail();
  const canonical = unpadded + "=".repeat((4 - unpadded.length % 4) % 4), tail = canonical.slice(-4);
  if (standard.includes("=") && standard !== canonical || btoa(atob(tail)) !== tail) fail();
  const decodedBytes = Math.floor(unpadded.length * 3 / 4);
  if (decodedBytes > limit) fail();
  return { base64: canonical, decodedBytes };
}
function object(value: unknown): Record<string, unknown> { if (!mediaObject(value)) fail(); return value; }
function list(value: unknown, min: number, max: number): unknown[] { if (!Array.isArray(value) || value.length < min || value.length > max) fail(); return value; }
function keys(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail(); }
function fail(): never { throw new Error("invalid_google_music_contract"); }
