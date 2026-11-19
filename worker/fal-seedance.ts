import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";

export const falSeedanceModels = ["bytedance/seedance-2.0/fast/text-to-video", "bytedance/seedance-2.0/fast/image-to-video",
  "bytedance/seedance-2.0/text-to-video", "bytedance/seedance-2.0/image-to-video",
  "bytedance/seedance-2.0/fast/reference-to-video", "bytedance/seedance-2.0/reference-to-video"] as const;
const ratios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
export function isFalSeedanceModel(model: string): boolean { return (falSeedanceModels as readonly string[]).includes(model); }
export function prepareFalSeedance(model: string, value: unknown): {
  model: string; path: string; body: Record<string, unknown>; inputFiles: number; inputBytes: number;
  requestedDurationSeconds: number | null; upstreamCostMicros: null;
} {
  if (!isFalSeedanceModel(model) || !mediaObject(value)) fail("request");
  const fast = model.includes("/fast/"), image = model.endsWith("/image-to-video"), reference = model.endsWith("/reference-to-video");
  const allowed = ["prompt", "duration", "resolution", "aspect_ratio", "generate_audio",
    ...(image ? ["image_url"] : reference ? ["image_urls", "video_urls", "audio_urls"] : [])];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.prompt !== "string" || !value.prompt.trim()
    || Array.from(value.prompt).length > 32000) fail("fields");
  for (const character of value.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  if (value.duration !== undefined && (typeof value.duration !== "string" || !/^(?:[4-9]|1[0-5])$/.test(value.duration))) fail("duration");
  if (value.resolution !== undefined && (typeof value.resolution !== "string"
    || !(fast ? ["480p", "720p"] : ["480p", "720p", "1080p", "4k"]).includes(value.resolution))) fail("resolution");
  if (value.aspect_ratio !== undefined && (typeof value.aspect_ratio !== "string" || !ratios.includes(value.aspect_ratio))) fail("aspect_ratio");
  if (value.generate_audio !== undefined && typeof value.generate_audio !== "boolean") fail("audio");
  let inputFiles = 0, inputBytes = 0;
  const inline = (url: unknown, kind: "image" | "video" | "audio") => {
    if (typeof url !== "string") fail("inline_reference");
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=_-]+)$/.exec(url);
    const mimes = kind === "image" ? ["image/png", "image/jpeg", "image/webp"] : kind === "video" ? ["video/mp4"] : ["audio/mpeg", "audio/wav"];
    if (!match || !mimes.includes(match[1])) fail("reference_mime");
    inputBytes += canonicalMediaBase64(match[2], 8 * 1024 * 1024, () => fail("reference_base64")).decodedBytes;
    inputFiles++;
    if (inputBytes > 16 * 1024 * 1024 || inputFiles > 12) fail("reference_limit");
  };
  if (image) inline(value.image_url, "image");
  if (reference) {
    const counts = { image: 0, video: 0, audio: 0 };
    for (const [key, kind, limit] of [["image_urls", "image", 9], ["video_urls", "video", 3], ["audio_urls", "audio", 3]] as const) {
      const urls = value[key]; if (urls === undefined) continue;
      if (!Array.isArray(urls) || urls.length > limit) fail("reference_count");
      counts[kind] = urls.length;
      for (const url of urls) inline(url, kind);
    }
    if (counts.audio && !counts.image && !counts.video) fail("audio_only_reference");
  }
  // Omitted duration remains native auto, never a claimed billable duration.
  return { model, path: "/" + model, body: structuredClone(value), inputFiles, inputBytes,
    requestedDurationSeconds: value.duration === undefined ? null : Number(value.duration), upstreamCostMicros: null };
}
function fail(reason: string): never { throw new Error("invalid_fal_seedance_" + reason); }
