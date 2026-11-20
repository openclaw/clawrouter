import { mediaObject } from "./managed-media-json.ts";

export const kieGrokModels = ["grok-imagine/text-to-video", "grok-imagine/image-to-video"] as const;

// This validates native wire data, not asset ownership. The managed image
// route stays closed until the runtime can bind each input to the original job.
export function prepareKieGrokWire(value: unknown): {
  body: Record<string, unknown>; model: string; mode: "text" | "image";
  requestedDurationSeconds: number | null; upstreamCostMicros: null;
} {
  if (!mediaObject(value) || typeof value.model !== "string" || !(kieGrokModels as readonly string[]).includes(value.model)
    || Object.keys(value).some(key => key !== "model" && key !== "input") || !mediaObject(value.input)) fail("request");
  const image = value.model === kieGrokModels[1], input = value.input;
  const allowed = ["prompt", "duration", "resolution", ...(image ? ["image_urls"] : ["aspect_ratio"])];
  if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.prompt !== "string" || !input.prompt.trim()
    || Array.from(input.prompt).length > 5000) fail("input");
  for (const character of input.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  let duration: number | null = null;
  if (input.duration !== undefined) {
    // Kie's published schema and the frozen client agree on this asymmetry.
    // The text endpoint's string-valued example is not its schema contract.
    if (image) {
      if (typeof input.duration !== "string" || !/^(?:[6-9]|[12][0-9]|30)$/.test(input.duration)) fail("duration");
      duration = Number(input.duration);
    } else {
      if (typeof input.duration !== "number" || !Number.isInteger(input.duration) || input.duration < 6 || input.duration > 30) fail("duration");
      duration = input.duration;
    }
  }
  if (input.resolution !== undefined && (typeof input.resolution !== "string" || !["480p", "720p", "1080p"].includes(input.resolution))) fail("resolution");
  if (input.aspect_ratio !== undefined && (typeof input.aspect_ratio !== "string" || !["16:9", "2:3", "3:2", "1:1", "9:16"].includes(input.aspect_ratio))) fail("aspect_ratio");
  if (image) {
    if (!Array.isArray(input.image_urls) || input.image_urls.length !== 1) fail("image");
    const value = input.image_urls[0];
    if (typeof value !== "string" || !value || value.length > 2048 || /[\s\\]/.test(value)) fail("image_url");
    let url: URL; try { url = new URL(value); } catch { fail("image_url"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443"
      || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) fail("image_url");
  }
  return { body: structuredClone(value), model: value.model, mode: image ? "image" : "text",
    requestedDurationSeconds: duration, upstreamCostMicros: null };
}
function fail(reason: string): never { throw new Error("invalid_kie_grok_" + reason); }
