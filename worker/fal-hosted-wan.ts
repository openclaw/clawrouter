import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";

export const falHostedWanModels = ["fal-ai/wan/v2.2-a14b/text-to-video", "fal-ai/wan/v2.2-a14b/image-to-video"] as const;
export const falRetiredKlingModel = "fal-ai/kling-video/v2.1/master/text-to-video";
export function isFalHostedWanModel(model: string): boolean { return (falHostedWanModels as readonly string[]).includes(model); }
export function prepareFalHostedWan(model: string, value: unknown): {
  model: string; path: string; body: Record<string, unknown>; inputImages: number; inputBytes: number; upstreamCostMicros: null;
} {
  if (model === falRetiredKlingModel) fail("unsupported_kling_endpoint");
  if (!isFalHostedWanModel(model) || !mediaObject(value)) fail("request");
  const edit = model === falHostedWanModels[1], allowed = ["prompt", "resolution", "aspect_ratio", ...(edit ? ["image_url"] : [])];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.prompt !== "string"
    || !value.prompt.trim() || Array.from(value.prompt).length > 32000) fail("fields");
  for (const character of value.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  if (value.resolution !== undefined && (typeof value.resolution !== "string" || !["480p", "580p", "720p"].includes(value.resolution))) fail("resolution");
  if (value.aspect_ratio !== undefined && (typeof value.aspect_ratio !== "string" || !["16:9", "9:16", "1:1"].includes(value.aspect_ratio))) fail("aspect_ratio");
  let inputBytes = 0;
  if (edit) {
    if (typeof value.image_url !== "string") fail("inline_image");
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=_-]+)$/.exec(value.image_url);
    if (!match) fail("inline_image");
    inputBytes = canonicalMediaBase64(match[2], 8 * 1024 * 1024, () => fail("image_base64")).decodedBytes;
  }
  // No synthetic duration-to-frames conversion or native default cost estimate.
  return { model, path: "/" + model, body: structuredClone(value), inputImages: edit ? 1 : 0, inputBytes, upstreamCostMicros: null };
}
function fail(reason: string): never { throw new Error("invalid_fal_hosted_wan_" + reason); }
