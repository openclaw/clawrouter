import { assertFalRunDispatch } from "./fal-dispatch.ts";
import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { observeFalImage, readFalImage, type FalImageRequest } from "./fal-images.ts";

export const falNanoImageModels = ["fal-ai/nano-banana", "fal-ai/nano-banana/edit",
  "fal-ai/nano-banana-2", "fal-ai/nano-banana-2/edit",
  "google/nano-banana-2-lite", "google/nano-banana-2-lite/edit"] as const;
const legacyRatios = ["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"];
const extendedRatios = [...legacyRatios, "4:1", "1:4", "8:1", "1:8"];
export function prepareFalNanoImage(model: string, value: unknown): FalImageRequest {
  if (!(falNanoImageModels as readonly string[]).includes(model) || !mediaObject(value)) fail("request");
  const edit = model.endsWith("/edit"), legacy = model === falNanoImageModels[0] || model === falNanoImageModels[1];
  const resolution = model === falNanoImageModels[2] || model === falNanoImageModels[3];
  const allowed = ["prompt", "num_images", "output_format", "aspect_ratio", ...(resolution ? ["resolution"] : []), ...(edit ? ["image_urls"] : [])];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.prompt !== "string"
    || !value.prompt.trim() || Array.from(value.prompt).length < 3 || Array.from(value.prompt).length > 50000) fail("fields");
  for (const character of value.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  const count = value.num_images === undefined ? 1 : value.num_images;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 4) fail("count");
  if (value.output_format !== undefined && value.output_format !== "png" && value.output_format !== "jpeg") fail("format");
  // Omitted geometry preserves the upstream default. The frozen consumer does
  // not expose explicit auto/null, WebP, 0.5K or newer multimodal references.
  if (value.aspect_ratio !== undefined && (typeof value.aspect_ratio !== "string"
    || !(legacy ? legacyRatios : extendedRatios).includes(value.aspect_ratio))) fail("aspect_ratio");
  if (value.resolution !== undefined && (typeof value.resolution !== "string" || !["1K", "2K", "4K"].includes(value.resolution))) fail("resolution");
  let inputImages = 0, inputBytes = 0;
  if (edit) {
    if (!Array.isArray(value.image_urls) || !value.image_urls.length || value.image_urls.length > (legacy ? 3 : 14)) fail("references");
    for (const url of value.image_urls) {
      if (typeof url !== "string") fail("inline_image");
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=_-]+)$/.exec(url);
      if (!match) fail("inline_image");
      inputBytes += canonicalMediaBase64(match[2], 8 * 1024 * 1024, () => fail("image_base64")).decodedBytes;
      if (inputBytes > 16 * 1024 * 1024) fail("input_limit");
      inputImages++;
    }
  }
  return { model, path: "/" + model, body: structuredClone(value), count, inputImages, inputBytes,
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}
export function assertFalNanoImageDispatch(request: Request, prepared: FalImageRequest): void {
  assertFalRunDispatch(request, prepared, falNanoImageModels, fail);
}
export const observeFalNanoImage = observeFalImage;
export const readFalNanoImage = readFalImage;
function fail(reason: string): never { throw new Error("invalid_fal_nano_image_" + reason); }
