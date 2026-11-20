import { managedMediaEnvelopeBytes, mediaObject } from "./managed-media-json.ts";

export const falPromptVideoModels = ["fal-ai/minimax/video-01-live", "fal-ai/heygen/v2/video-agent"] as const;
export function isFalPromptVideoModel(model: string): boolean { return (falPromptVideoModels as readonly string[]).includes(model); }
export function prepareFalPromptVideo(model: string, body: unknown): { prompt: string } {
  if (!isFalPromptVideoModel(model) || !mediaObject(body) || Object.keys(body).some(key => key !== "prompt")
    || typeof body.prompt !== "string" || !body.prompt.trim()) fail("request");
  // HeyGen has no published prompt maximum; 32k is this adapter's local bound.
  if (Array.from(body.prompt).length > (model === falPromptVideoModels[0] ? 2000 : 32000)) fail("prompt");
  for (const character of body.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("unicode"); }
  return { prompt: body.prompt };
}

// Call after the scoped queue result has been observed. Asset validation never
// changes a terminal execution state, retries a POST, or establishes a refund.
export function observeFalPromptVideoOutput(body: unknown, model: string): {
  selectedModel: string; video: { url: string; mimeType: string | null; fileBytes: number | null }; upstreamCostMicros: null;
} {
  if (!isFalPromptVideoModel(model) || !mediaObject(body) || new TextEncoder().encode(JSON.stringify(body)).length > managedMediaEnvelopeBytes
    || body.error != null || body.error_type != null || body.detail != null || body.model != null && body.model !== model
    || body.request_id !== undefined || body.status !== undefined || !mediaObject(body.video)) fail("output");
  const video = body.video;
  if (typeof video.url !== "string" || !video.url || video.url.length > 2048 || /[\s\\]/.test(video.url)) fail("url");
  let url: URL; try { url = new URL(video.url); } catch { fail("url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443"
    || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) fail("url");
  if (video.content_type !== undefined && video.content_type !== null && video.content_type !== "video/mp4") fail("mime");
  if (video.file_size !== undefined && video.file_size !== null && (typeof video.file_size !== "number"
    || !Number.isSafeInteger(video.file_size) || video.file_size <= 0 || video.file_size > 256 * 1024 * 1024)) fail("file_size");
  return { selectedModel: model, video: { url: video.url, mimeType: video.content_type as string ?? null,
    fileBytes: video.file_size as number ?? null }, upstreamCostMicros: null };
}
function fail(reason: string): never { throw new Error("invalid_fal_prompt_video_" + reason); }
