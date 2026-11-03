import { readGoogleJson } from "./google-json.ts";
import { mediaObject } from "./managed-media-json.ts";

export const googleUnderstandingModel = "gemini-3-flash-preview";
const mimes = {
  audio: new Set(["audio/wav", "audio/mp3", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac", "audio/mpeg", "audio/m4a", "audio/l16", "audio/opus", "audio/alaw", "audio/mulaw", "audio/webm"]),
  video: new Set(["video/mp4", "video/mpeg", "video/mov", "video/avi", "video/x-flv", "video/mpg", "video/webm", "video/wmv", "video/3gpp"]),
};
type Mode = keyof typeof mimes;
const encoder = new TextEncoder(), maxDecoded = 16 * 1024 * 1024, maxRequest = 24 * 1024 * 1024, maxResponse = 1024 * 1024;

// Native snake-case inline_data matches the frozen audio/video provider. The
// consumer owns MIME detection and prompt selection; runtime owns admission.
export function prepareGoogleUnderstanding(model: string, mode: Mode, body: unknown): {
  model: string; mode: Mode; body: Record<string, unknown>; path: string; headers: Headers; decodedBytes: number;
} {
  if (model !== googleUnderstandingModel || !["audio", "video"].includes(mode) || !mediaObject(body)
    || encoder.encode(JSON.stringify(body)).byteLength > maxRequest) fail();
  keys(body, ["contents"]);
  const content = object(list(body.contents, 1, 1)[0]); keys(content, ["role", "parts"]);
  if (content.role !== "user") fail();
  const parts = list(content.parts, 2, 2), prompt = object(parts[0]), media = object(parts[1]);
  keys(prompt, ["text"]); keys(media, ["inline_data"]);
  if (typeof prompt.text !== "string" || !prompt.text.trim() || prompt.text.length > 65536) fail();
  const inline = object(media.inline_data); keys(inline, ["mime_type", "data"]);
  if (typeof inline.mime_type !== "string" || !mimes[mode].has(inline.mime_type)) fail();
  const data = inline.data;
  if (typeof data !== "string" || !data.length || data.length > Math.ceil(maxDecoded / 3) * 4
    || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail();
  const tail = data.slice(-4);
  if (btoa(atob(tail)) !== tail) fail();
  const decodedBytes = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (decodedBytes > maxDecoded) fail();
  return { model, mode, body, decodedBytes, path: "/v1beta/models/" + model + ":generateContent",
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

export function observeGoogleUnderstanding(body: unknown, complete: boolean): { body: Record<string, unknown>; text: string } {
  if (!complete || !mediaObject(body) || body.error !== undefined) fail();
  if (body.promptFeedback !== undefined) {
    const prompt = object(body.promptFeedback);
    if (prompt.blockReason !== undefined && prompt.blockReason !== "BLOCK_REASON_UNSPECIFIED") fail();
  }
  const candidate = object(list(body.candidates, 1, 1)[0]);
  if (candidate.finishReason !== "STOP") fail();
  const values: string[] = [];
  let length = 0;
  for (const value of list(object(candidate.content).parts, 1, 64)) {
    const part = object(value);
    if (part.thought !== undefined && typeof part.thought !== "boolean") fail();
    if (part.thought === true) continue;
    if (part.inlineData !== undefined || part.inline_data !== undefined || part.functionCall !== undefined || part.fileData !== undefined) fail();
    if (typeof part.text !== "string" || (length += part.text.length) > 65536) fail();
    if (part.text.trim()) values.push(part.text.trim());
  }
  if (!values.length) fail();
  // Keep all native usage unchanged; bytes/MIME are not duration or token proof.
  return { body, text: values.join("\n") };
}

export async function readGoogleUnderstanding(response: Response, signal: AbortSignal): Promise<ReturnType<typeof observeGoogleUnderstanding>> {
  return readGoogleJson(response, signal, maxResponse, body => observeGoogleUnderstanding(body, true), fail);
}

function object(value: unknown): Record<string, unknown> { if (!mediaObject(value)) fail(); return value; }
function list(value: unknown, min: number, max: number): unknown[] { if (!Array.isArray(value) || value.length < min || value.length > max) fail(); return value; }
function keys(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail(); }
function fail(): never { throw new Error("invalid_google_understanding_contract"); }
