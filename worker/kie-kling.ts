import { mediaObject } from "./managed-media-json.ts";

export const kieKlingModels = ["kling-2.6/text-to-video", "kling-2.6/image-to-video"] as const;
// Wire qualification only. In particular, a valid image URL grants no asset,
// upload, credential or create authority; the managed route keeps it closed.
export function prepareKieKlingWire(value: unknown): {
  body: Record<string, unknown>; model: string; mode: "text" | "image";
  requestedDurationSeconds: number | null; sound: boolean | null; upstreamCostMicros: null;
} {
  if (!mediaObject(value) || typeof value.model !== "string" || !(kieKlingModels as readonly string[]).includes(value.model)
    || Object.keys(value).some(key => key !== "model" && key !== "input") || !mediaObject(value.input)) fail("request");
  const image = value.model === kieKlingModels[1], input = value.input;
  const allowed = ["prompt", "duration", "sound", ...(image ? ["image_urls"] : ["aspect_ratio"])];
  if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.prompt !== "string" || !input.prompt.trim()
    || Array.from(input.prompt).length > 1000) fail("input");
  for (const character of input.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  if (input.duration !== undefined && input.duration !== "5" && input.duration !== "10") fail("duration");
  if (input.sound !== undefined && typeof input.sound !== "boolean") fail("sound");
  if (input.aspect_ratio !== undefined && (typeof input.aspect_ratio !== "string" || !["16:9", "1:1", "9:16"].includes(input.aspect_ratio))) fail("aspect_ratio");
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
    requestedDurationSeconds: input.duration === undefined ? null : Number(input.duration),
    sound: input.sound === undefined ? null : input.sound as boolean, upstreamCostMicros: null };
}
function fail(reason: string): never { throw new Error("invalid_kie_kling_" + reason); }
