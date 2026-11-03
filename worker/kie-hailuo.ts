import { mediaObject } from "./managed-media-json.ts";

export const kieHailuoModels = [
  "hailuo/02-text-to-video-standard", "hailuo/02-image-to-video-standard",
  "hailuo/02-text-to-video-pro", "hailuo/02-image-to-video-pro",
  "hailuo/2-3-image-to-video-standard", "hailuo/2-3-image-to-video-pro",
] as const;

// A qualified image wire is not an owned asset. Managed image creates remain
// closed until the runtime supplies original caller/model/credential binding.
export function prepareKieHailuoWire(value: unknown): {
  body: Record<string, unknown>; model: string; mode: "text" | "image";
  requestedDurationSeconds: number | null; upstreamCostMicros: null;
} {
  if (!mediaObject(value) || typeof value.model !== "string" || !(kieHailuoModels as readonly string[]).includes(value.model)
    || Object.keys(value).some(key => key !== "model" && key !== "input") || !mediaObject(value.input)) fail("request");
  const model = value.model, input = value.input, image = model.includes("-image-to-video-");
  const newer = model.startsWith("hailuo/2-3-"), duration = newer || model.endsWith("-standard");
  const allowed = ["prompt", ...(duration ? ["duration"] : []), ...(image ? ["image_url", ...(duration ? ["resolution"] : [])] : [])];
  if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.prompt !== "string"
    || !input.prompt.trim() || Array.from(input.prompt).length > (newer ? 5000 : 1500)) fail("input");
  for (const character of input.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  if (duration && input.duration !== "6" && input.duration !== "10") fail("duration");
  if (image && duration) {
    const resolutions = newer ? ["768P", "1080P"] : ["512P", "768P"];
    if (typeof input.resolution !== "string" || !resolutions.includes(input.resolution)) fail("resolution");
    if (newer && input.resolution === "1080P" && input.duration !== "6") fail("duration_resolution");
  }
  if (image) {
    const value = input.image_url;
    if (typeof value !== "string" || !value || value.length > 2048 || /[\s\\]/.test(value)) fail("image_url");
    let url: URL; try { url = new URL(value); } catch { fail("image_url"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443"
      || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) fail("image_url");
  }
  return { body: structuredClone(value), model, mode: image ? "image" : "text",
    requestedDurationSeconds: duration ? Number(input.duration) : null, upstreamCostMicros: null };
}
function fail(reason: string): never { throw new Error("invalid_kie_hailuo_" + reason); }
