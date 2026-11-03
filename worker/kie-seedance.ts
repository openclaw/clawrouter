import { mediaObject } from "./managed-media-json.ts";

export const KIE_SEEDANCE_FROZEN_MODEL = "bytedance/seedance-1.5-pro";

// Compatibility evidence for the frozen client, not a current native API grant.
// prepareKieTask denies this identity until an exact native contract qualifies.
export function prepareKieSeedanceFrozenWire(value: unknown): {
  body: Record<string, unknown>; model: string; mode: "text" | "image";
  requestedDurationSeconds: number; upstreamCostMicros: null;
} {
  if (!mediaObject(value) || value.model !== KIE_SEEDANCE_FROZEN_MODEL || !mediaObject(value.input)
    || Object.keys(value).some(key => key !== "model" && key !== "input")) fail("request");
  const input = value.input, image = Object.hasOwn(input, "input_urls");
  const allowed = ["prompt", "duration", "aspect_ratio", "resolution", "generate_audio", "input_urls"];
  // Match the frozen consumer's UTF-16 length bounds; do not infer a larger
  // current provider limit from a stale playground counter or search cache.
  if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.prompt !== "string"
    || input.prompt.trim().length < 3 || input.prompt.length > 20000) fail("input");
  for (const character of input.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  if (typeof input.duration !== "number" || !Number.isInteger(input.duration) || input.duration < 4 || input.duration > 12) fail("duration");
  if (typeof input.aspect_ratio !== "string" || !["16:9", "1:1", "4:3", "3:4", "9:16", "21:9"].includes(input.aspect_ratio)) fail("aspect_ratio");
  if (input.resolution !== "720p" && input.resolution !== "480p" && input.resolution !== "1080p") fail("resolution");
  if (typeof input.generate_audio !== "boolean") fail("generate_audio");
  if (image) {
    if (!Array.isArray(input.input_urls) || input.input_urls.length !== 1) fail("image");
    const value = input.input_urls[0];
    if (typeof value !== "string" || !value || value.length > 2048 || /[\s\\]/.test(value)) fail("image_url");
    let url: URL; try { url = new URL(value); } catch { fail("image_url"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443"
      || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) fail("image_url");
  }
  return { body: structuredClone(value), model: KIE_SEEDANCE_FROZEN_MODEL, mode: image ? "image" : "text",
    requestedDurationSeconds: input.duration, upstreamCostMicros: null };
}
function fail(reason: string): never { throw new Error("invalid_kie_seedance_frozen_" + reason); }
