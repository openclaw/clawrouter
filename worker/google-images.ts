import { readGoogleJson } from "./google-json.ts";
import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";

export const googleImageModels = ["gemini-3.1-flash-image", "gemini-3-pro-image"] as const;
const ratios = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const encoder = new TextEncoder();
export const googleImageLimits = { requestBytes: 20 * 1024 * 1024, responseBytes: 24 * 1024 * 1024,
  decodedInputBytes: 14 * 1024 * 1024, decodedOutputBytes: 16 * 1024 * 1024, inputImages: 5, outputImages: 4 } as const;
export interface GoogleImageRequest { model: string; body: Record<string, unknown>; path: string; headers: Headers }
export interface GoogleImageAsset { base64: string; mimeType: string; decodedBytes: number }

// Preserve the frozen consumer's native generateContent wire. The runtime owns
// the original credential, body-memory reservation, deadline and cost policy.
export function prepareGoogleImage(model: string, body: unknown): GoogleImageRequest {
  if (!(googleImageModels as readonly string[]).includes(model) || !mediaObject(body)
    || encoder.encode(JSON.stringify(body)).byteLength > googleImageLimits.requestBytes) fail();
  keys(body, ["contents", "generationConfig"]);
  const content = object(list(body.contents, 1, 1)[0]); keys(content, ["role", "parts"]);
  if (content.role !== "user") fail();
  let images = 0, bytes = 0, prompts = 0;
  for (const value of list(content.parts, 1, 6)) {
    const part = object(value); keys(part, ["text", "inlineData"]);
    if (Object.keys(part).length !== 1) fail();
    if (part.text !== undefined) {
      if (typeof part.text !== "string" || !part.text.trim() || part.text.length > 65536 || ++prompts > 1) fail();
    } else {
      const inline = object(part.inlineData); keys(inline, ["mimeType", "data"]);
      if (!["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"].includes(String(inline.mimeType))) fail();
      bytes += canonicalMediaBase64(inline.data, googleImageLimits.decodedInputBytes, fail).decodedBytes;
      if (++images > googleImageLimits.inputImages || bytes > googleImageLimits.decodedInputBytes) fail();
    }
  }
  if (prompts !== 1) fail();
  const config = object(body.generationConfig); keys(config, ["responseModalities", "imageConfig"]);
  if (JSON.stringify(config.responseModalities) !== '["TEXT","IMAGE"]') fail();
  if (config.imageConfig !== undefined) {
    const image = object(config.imageConfig); keys(image, ["aspectRatio", "imageSize"]);
    if (image.aspectRatio !== undefined && !ratios.has(String(image.aspectRatio))) fail();
    if (image.imageSize !== undefined && !["1K", "2K", "4K"].includes(String(image.imageSize))) fail();
  }
  return { model, body, path: "/v1beta/models/" + model + ":generateContent",
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

// All assets validate before any are returned. Thought images and text are not
// generated-image results; a blocked or incomplete sibling invalidates the batch.
export function observeGoogleImage(body: unknown, complete: boolean): {
  body: Record<string, unknown>; images: GoogleImageAsset[];
} {
  if (!complete || !mediaObject(body) || body.error !== undefined) fail();
  if (mediaObject(body.promptFeedback) && body.promptFeedback.blockReason !== undefined
    && body.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED") fail();
  const images: GoogleImageAsset[] = [];
  let bytes = 0;
  for (const value of list(body.candidates, 1, 4)) {
    const candidate = object(value);
    if (candidate.finishReason !== "STOP") fail();
    for (const value of list(object(candidate.content).parts, 1, 64)) {
      const part = object(value);
      if (part.thought !== undefined && typeof part.thought !== "boolean") fail();
      if (part.thought === true) continue;
      if (part.inlineData !== undefined && part.inline_data !== undefined) fail();
      const data = part.inlineData ?? part.inline_data;
      if (data === undefined) {
        if (typeof part.text !== "string" || part.text.length > 65536) fail();
        continue;
      }
      if (part.text !== undefined) fail();
      const inline = object(data);
      if (inline.mimeType !== undefined && inline.mime_type !== undefined) fail();
      const mimeType = inline.mimeType ?? inline.mime_type ?? "image/png";
      if (!["image/png", "image/jpeg", "image/webp"].includes(String(mimeType))) fail();
      const encoded = canonicalMediaBase64(inline.data, googleImageLimits.decodedOutputBytes, fail);
      bytes += encoded.decodedBytes;
      if (bytes > googleImageLimits.decodedOutputBytes || images.length >= googleImageLimits.outputImages) fail();
      images.push({ ...encoded, mimeType: String(mimeType) });
    }
  }
  if (!images.length) fail();
  // Native usage remains in body; image count and bytes are not token/dollar
  // observations. Pricing must qualify each modality plus thinking separately.
  return { body, images };
}

export async function readGoogleImage(response: Response, signal: AbortSignal): Promise<ReturnType<typeof observeGoogleImage>> {
  return readGoogleJson(response, signal, googleImageLimits.responseBytes, body => observeGoogleImage(body, true), fail);
}

function object(value: unknown): Record<string, unknown> { if (!mediaObject(value)) fail(); return value; }
function keys(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail(); }
function list(value: unknown, min: number, max: number): unknown[] { if (!Array.isArray(value) || value.length < min || value.length > max) fail(); return value; }
function fail(): never { throw new Error("invalid_google_image_contract"); }
