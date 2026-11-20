import { assertFalRunDispatch } from "./fal-dispatch.ts";
import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { observeFalImage, readFalImage, type FalImageRequest } from "./fal-images.ts";

export const falGrokImageModels = ["xai/grok-imagine-image", "xai/grok-imagine-image/edit", "xai/grok-imagine-image/quality/edit"] as const;
const ratios = ["2:1", "20:9", "19.5:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "9:19.5", "9:20", "1:2"];
export function prepareFalGrokImage(model: string, value: unknown): FalImageRequest {
  // A missing public schema does not prove retirement. It also cannot qualify
  // generation by borrowing direct xAI's distinct low-quality alias contract.
  if (model === "xai/grok-imagine-image/quality") fail("unqualified_quality_generate");
  if (!(falGrokImageModels as readonly string[]).includes(model) || !mediaObject(value)) fail("request");
  const edit = model.endsWith("/edit"), allowed = ["prompt", "num_images", "output_format", "aspect_ratio", "resolution", ...(edit ? ["image_urls"] : [])];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.prompt !== "string"
    || !value.prompt.trim() || Array.from(value.prompt).length > 8000) fail("fields");
  for (const character of value.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  const count = value.num_images === undefined ? 1 : value.num_images;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 4) fail("count");
  if (value.output_format !== undefined && value.output_format !== "png" && value.output_format !== "jpeg") fail("format");
  if (value.aspect_ratio !== undefined && (typeof value.aspect_ratio !== "string" || !ratios.includes(value.aspect_ratio))) fail("aspect_ratio");
  if (value.resolution !== undefined && value.resolution !== "1k" && value.resolution !== "2k") fail("resolution");
  let inputImages = 0, inputBytes = 0;
  if (edit) {
    if (!Array.isArray(value.image_urls) || !value.image_urls.length || value.image_urls.length > 3) fail("references");
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
export function assertFalGrokImageDispatch(request: Request, prepared: FalImageRequest): void {
  assertFalRunDispatch(request, prepared, falGrokImageModels, fail);
}
export const observeFalGrokImage = observeFalImage;
export const readFalGrokImage = readFalImage;
function fail(reason: string): never { throw new Error("invalid_fal_grok_image_" + reason); }
