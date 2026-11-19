import { assertFalRunDispatch } from "./fal-dispatch.ts";
import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";

export const falImageModels = ["fal-ai/flux/dev", "fal-ai/flux/dev/image-to-image",
  "krea/v2/medium/text-to-image", "krea/v2/large/text-to-image"] as const;
type Json = Record<string, unknown>;
const encoder = new TextEncoder(), maxInput = 16 * 1024 * 1024, maxEnvelope = 1024 * 1024;
const ratios = ["1:1", "4:3", "3:2", "16:9", "2.35:1", "4:5", "2:3", "9:16"];
const sizes = ["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"];
export interface FalImageRequest { model: string; path: string; body: Json; count: number; inputImages: number; inputBytes: number; headers: Headers }
export function prepareFalImage(model: string, value: unknown): FalImageRequest {
  if (!(falImageModels as readonly string[]).includes(model) || !mediaObject(value)) fail("request");
  const krea = model.startsWith("krea/"), edit = model === falImageModels[1];
  keys(value, krea ? ["prompt", "creativity", "aspect_ratio", "image_style_references"]
    : ["prompt", "num_images", "output_format", ...(edit ? ["image_url"] : ["image_size"])]);
  if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > (krea ? 5000 : 32768)) fail("prompt");
  for (const character of value.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  let count = 1, inputImages = 0, inputBytes = 0;
  const reference = (input: unknown) => {
    if (typeof input !== "string") fail("inline_image");
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=_-]+)$/.exec(input);
    if (!match) fail("inline_image");
    const encoded = canonicalMediaBase64(match[2], 8 * 1024 * 1024, () => fail("image_base64"));
    inputImages++; inputBytes += encoded.decodedBytes;
    if (inputBytes > maxInput) fail("input_size");
  };
  if (krea) {
    if (value.creativity !== undefined && (typeof value.creativity !== "string" || !["raw", "low", "medium", "high"].includes(value.creativity))) fail("creativity");
    if (value.aspect_ratio !== undefined && (typeof value.aspect_ratio !== "string" || !ratios.includes(value.aspect_ratio))) fail("aspect_ratio");
    if (value.image_style_references !== undefined) {
      if (!Array.isArray(value.image_style_references) || value.image_style_references.length > 10) fail("references");
      for (const item of value.image_style_references) {
        if (!mediaObject(item)) fail("references"); keys(item, ["image_url"]); reference(item.image_url);
      }
    }
  } else {
    if (value.num_images !== undefined) {
      if (typeof value.num_images !== "number" || !Number.isInteger(value.num_images) || value.num_images < 1 || value.num_images > 4) fail("count");
      count = value.num_images;
    }
    if (value.output_format !== undefined && value.output_format !== "png" && value.output_format !== "jpeg") fail("format");
    if (edit) reference(value.image_url);
    if (value.image_size !== undefined) {
      if (typeof value.image_size === "string") { if (!sizes.includes(value.image_size)) fail("size"); }
      else {
        if (!mediaObject(value.image_size)) fail("size");
        keys(value.image_size, ["width", "height"]);
        for (const field of ["width", "height"]) dimension(value.image_size[field]);
      }
    }
  }
  return { model, path: "/" + model, body: structuredClone(value), count, inputImages, inputBytes,
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}
export function assertFalImageDispatch(request: Request, prepared: FalImageRequest): void {
  assertFalRunDispatch(request, prepared, falImageModels, fail);
}
export interface FalImageAsset { url: string; mimeType: string | null; width: number | null; height: number | null; flagged: boolean | null }
export function observeFalImage(value: unknown, prepared: FalImageRequest): {
  body: Json; selectedModel: string; images: FalImageAsset[]; partial: boolean; upstreamCostMicros: null;
} {
  if (!mediaObject(value) || encoder.encode(JSON.stringify(value)).length > maxEnvelope || value.error != null || value.detail != null
    || value.request_id !== undefined || value.response_url !== undefined || value.status_url !== undefined
    || value.status != null && value.status !== "completed" || value.model != null && value.model !== prepared.model
    || !Array.isArray(value.images) || !value.images.length || value.images.length > prepared.count) fail("response");
  const flags = value.has_nsfw_concepts;
  if (flags !== undefined && (!Array.isArray(flags) || flags.length !== value.images.length || flags.some(flag => typeof flag !== "boolean"))) fail("flags");
  const images = value.images.map((item, index) => {
    if (!mediaObject(item) || typeof item.url !== "string" || !item.url || item.url.length > 2048 || /[\s\\]/.test(item.url)) fail("image");
    let url: URL; try { url = new URL(item.url); } catch { fail("url"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443"
      || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) fail("url");
    if (item.content_type !== undefined && (typeof item.content_type !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(item.content_type))) fail("mime");
    if (item.width !== undefined) dimension(item.width);
    if (item.height !== undefined) dimension(item.height);
    if (item.file_size !== undefined && (typeof item.file_size !== "number" || !Number.isSafeInteger(item.file_size) || item.file_size <= 0 || item.file_size > 16 * 1024 * 1024)) fail("file_size");
    return { url: item.url, mimeType: item.content_type as string ?? null, width: item.width as number ?? null,
      height: item.height as number ?? null, flagged: flags ? flags[index] as boolean : null };
  });
  // Native flags and partial batches are outcome evidence, never a refund or
  // a dollar tariff. File URLs have no credential or fetch authority here.
  return { body: value, selectedModel: prepared.model, images, partial: images.length < prepared.count, upstreamCostMicros: null };
}
export async function readFalImage(response: Response, prepared: FalImageRequest, signal: AbortSignal) {
  return readNativeJson(response, signal, maxEnvelope, value => observeFalImage(value, prepared), fail);
}
function dimension(value: unknown): void { if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 14142) fail("dimension"); }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error("invalid_fal_image_" + reason); }
