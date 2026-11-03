import { mediaObject } from "./managed-media-json.ts";

export const kieWanModels = ["wan/2-6-text-to-video", "wan/2-6-image-to-video"] as const;

// Native wire validation is separate from durable asset ownership. The managed
// image route remains closed until the runtime qualifies that original binding.
export function prepareKieWanWire(value: unknown): {
  body: Record<string, unknown>; model: string; mode: "text" | "image";
  requestedDurationSeconds: number | null; upstreamCostMicros: null;
} {
  if (!mediaObject(value) || typeof value.model !== "string" || !(kieWanModels as readonly string[]).includes(value.model)
    || Object.keys(value).some(key => key !== "model" && key !== "input") || !mediaObject(value.input)) fail("request");
  const image = value.model === kieWanModels[1], input = value.input;
  const allowed = ["prompt", "duration", "resolution", ...(image ? ["image_urls"] : [])];
  if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.prompt !== "string"
    || Array.from(input.prompt.trim()).length < (image ? 2 : 1) || Array.from(input.prompt).length > 5000) fail("input");
  for (const character of input.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  if (input.duration !== undefined && input.duration !== "5" && input.duration !== "10" && input.duration !== "15") fail("duration");
  // The text contract explicitly requires selecting an output resolution.
  if ((!image || input.resolution !== undefined) && input.resolution !== "720p" && input.resolution !== "1080p") fail("resolution");
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
    requestedDurationSeconds: input.duration === undefined ? null : Number(input.duration), upstreamCostMicros: null };
}
function fail(reason: string): never { throw new Error("invalid_kie_wan_" + reason); }
