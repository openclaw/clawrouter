import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { observeFalImage, readFalImage, type FalImageRequest } from "./fal-images.ts";

export const falGptImageModels = ["openai/gpt-image-2.5/flare/text-to-image", "openai/gpt-image-2.5/flare/edit",
  "openai/gpt-image-2.5/sunburst/text-to-image", "openai/gpt-image-2.5/sunburst/edit"] as const;
const sizes = ["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9", "auto"];
export function prepareFalGptImage(model: string, value: unknown): FalImageRequest {
  if (!(falGptImageModels as readonly string[]).includes(model) || !mediaObject(value)) fail("request");
  const edit = model.endsWith("/edit"), allowed = ["prompt", "num_images", "output_format", "quality", "background", "image_size", ...(edit ? ["image_urls"] : [])];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.prompt !== "string" || !value.prompt.trim()
    || value.prompt.length > 32000) fail("fields");
  for (const character of value.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  const count = value.num_images === undefined ? 1 : value.num_images;
  // The frozen OpenClaw capability caps batches at four even though fal permits ten.
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 4) fail("count");
  if (value.output_format !== undefined && (typeof value.output_format !== "string" || !["png", "jpeg", "webp"].includes(value.output_format))
    || value.quality !== undefined && (typeof value.quality !== "string" || !["low", "medium", "high", "xhigh", "max", "auto"].includes(value.quality))
    || value.background !== undefined && (typeof value.background !== "string" || !["transparent", "opaque", "auto"].includes(value.background))) fail("options");
  if (value.image_size !== undefined) {
    if (typeof value.image_size === "string") { if (!sizes.includes(value.image_size)) fail("size"); }
    else {
      const size = value.image_size;
      if (!mediaObject(size) || Object.keys(size).some(key => key !== "width" && key !== "height")) fail("size");
      const width = size.width, height = size.height;
      if (typeof width !== "number" || typeof height !== "number" || !Number.isInteger(width) || !Number.isInteger(height)
        || width <= 0 || height <= 0 || width % 16 || height % 16 || Math.max(width, height) > 3840
        || width * height < 655360 || width * height > 8294400 || width > height * 3 || height > width * 3) fail("geometry");
    }
  }
  if (value.background === "transparent" && value.output_format === "jpeg") fail("transparent_jpeg");
  let inputImages = 0, inputBytes = 0;
  if (edit) {
    if (!Array.isArray(value.image_urls) || !value.image_urls.length || value.image_urls.length > 16) fail("references");
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
export function assertFalGptImageDispatch(request: Request, prepared: FalImageRequest): void {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.origin !== "https://fal.run" || url.pathname !== prepared.path
    || !(falGptImageModels as readonly string[]).includes(prepared.model) || prepared.path !== "/" + prepared.model
    || url.username || url.password || url.search || url.hash
    || !/^Key [\x21-\x7e]{1,4096}$/.test(request.headers.get("authorization") ?? "")
    || request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") fail("dispatch");
}
export const observeFalGptImage = observeFalImage;
export const readFalGptImage = readFalImage;
function fail(reason: string): never { throw new Error("invalid_fal_gpt_image_" + reason); }
