import type { ImageTokenPricing } from "./types";
import { validateImageGeneration } from "./image-generation.ts";
import { decisionImageBytes } from "./provider-decision-images.ts";
import { HttpError } from "./utils.ts";

// Deliberately narrower than OpenAI's edit API: uploaded bytes only. Never fetch
// caller URLs or forward cross-account File IDs. The shared byte validator checks
// canonical base64, a matching PNG/JPEG/WebP signature and a 4 MiB per-image cap;
// pixel decoding remains upstream. These transport caps are not token ceilings.
export function validateImageEdit(body: Record<string, unknown>, pricing: ImageTokenPricing): void {
  const { images, ...options } = body;
  try { validateImageGeneration(options, pricing); }
  catch (error) {
    if (error instanceof HttpError) throw new HttpError(error.status, "invalid_image_edit", error.message);
    throw error;
  }
  if (!Array.isArray(images) || images.length < 1 || images.length > 16) fail();
  for (const image of images) {
    if (!image || typeof image !== "object" || Array.isArray(image) || Object.keys(image).some(key => key !== "image_url")) fail();
    const url = (image as Record<string, unknown>).image_url;
    if (typeof url !== "string") fail();
    const prefix = /^data:(image[/](?:png|jpeg|webp));base64,/.exec(url);
    if (!prefix) fail();
    try { decisionImageBytes(url.slice(prefix[0].length), prefix[1]); }
    catch { fail(); }
  }
}
function fail(): never { throw new HttpError(400, "invalid_image_edit", "image edits require 1 to 16 inline PNG/JPEG/WebP references, at most 4 MiB each within the 8 MiB JSON request limit"); }
