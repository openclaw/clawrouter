import type { ManagedObservation, ManagedPublicPaths } from "./managed-lifecycle-types.ts";
import { canonicalMediaBase64, mediaObject, mediaPublicPath } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";

type Json = Record<string, unknown>;
export const openRouterVideoProtocol = "openrouter.video";
export const openRouterVideoModels = ["google/veo-3.1-fast"] as const;
const encoder = new TextEncoder(), maxJson = 1024 * 1024, maxVideo = 64 * 1024 * 1024;
const active = ["pending", "in_progress", "queued", "processing", "running"];
export interface OpenRouterVideoPolicy {
  // Trusted admission, never read from the request body. Video is not ZDR.
  retentionAllowed: boolean;
  referenceInputsQualified?: boolean;
}
export function validateOpenRouterVideoId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) fail("id");
  return value;
}
export function prepareOpenRouterVideo(model: string, value: unknown, policy: OpenRouterVideoPolicy) {
  const body = object(value);
  keys(body, ["model", "prompt", "duration", "resolution", "aspect_ratio", "size", "generate_audio", "seed", "frame_images", "input_references"]);
  if (!(openRouterVideoModels as readonly string[]).includes(model) || body.model !== model || policy.retentionAllowed !== true
    || typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 32768) fail("request");
  for (const character of body.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("prompt"); }
  if (body.duration !== undefined && ![4, 6, 8].includes(body.duration as number)
    || body.resolution !== undefined && !["720p", "1080p"].includes(body.resolution as string)
    || body.aspect_ratio !== undefined && !["16:9", "9:16"].includes(body.aspect_ratio as string)
    || body.generate_audio !== undefined && typeof body.generate_audio !== "boolean"
    || body.seed !== undefined && (typeof body.seed !== "number" || !Number.isSafeInteger(body.seed))) fail("options");
  const sizes: Record<string, [string, string]> = { "1280x720": ["720p", "16:9"], "720x1280": ["720p", "9:16"], "1920x1080": ["1080p", "16:9"], "1080x1920": ["1080p", "9:16"] };
  if (body.size !== undefined) {
    if (typeof body.size !== "string" || !Object.hasOwn(sizes, body.size)) fail("size");
    const [resolution, aspect] = sizes[body.size];
    if (body.resolution !== undefined && body.resolution !== resolution || body.aspect_ratio !== undefined && body.aspect_ratio !== aspect) fail("geometry");
  }
  let images = 0, imageBytes = 0;
  for (const field of ["frame_images", "input_references"]) {
    if (body[field] === undefined) continue;
    const values = body[field];
    if (!Array.isArray(values) || !values.length || values.length > (field === "frame_images" ? 2 : 4)) fail("images");
    if (field === "input_references" && !policy.referenceInputsQualified) fail("reference_capability");
    const roles = new Set();
    for (const value of values) {
      const part = object(value); keys(part, field === "frame_images" ? ["type", "image_url", "frame_type"] : ["type", "image_url"]);
      const source = object(part.image_url); keys(source, ["url"]);
      if (part.type !== "image_url" || typeof source.url !== "string") fail("image");
      if (field === "frame_images") {
        if (!["first_frame", "last_frame"].includes(part.frame_type as string) || roles.has(part.frame_type)) fail("frame_role");
        roles.add(part.frame_type);
      }
      if (source.url.startsWith("data:")) {
        const match = /^data:image\/(?:png|jpeg|webp);base64,(.+)$/.exec(source.url);
        if (!match) fail("image_data");
        imageBytes += canonicalMediaBase64(match[1], 8 * 1024 * 1024, () => fail("image_data")).decodedBytes;
      } else https(source.url);
      if (++images > 4 || imageBytes > 16 * 1024 * 1024) fail("image_limit");
    }
  }
  if (encoder.encode(JSON.stringify(body)).length > 24 * 1024 * 1024) fail("request_limit");
  return { path: "/api/v1/videos", body: structuredClone(body), requestedVersion: model,
    mode: body.frame_images ? "image" : body.input_references ? "reference" : "text",
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}
export function prepareOpenRouterVideoControl(action: string, id: unknown) {
  if (action !== "retrieve") fail("unsupported_control");
  return { method: "GET", path: `/api/v1/videos/${validateOpenRouterVideoId(id)}`,
    query: new URLSearchParams(), headers: new Headers({ accept: "application/json" }) };
}
export interface OpenRouterVideoObservation extends ManagedObservation {
  contentAvailable: boolean;
  generationId: string | null;
  nativeCost: number | null;
  isByok: boolean | null;
  upstreamCostMicros: null;
}
export function observeOpenRouterVideo(value: unknown, action: "create" | "retrieve", model: string, expectedId?: string): OpenRouterVideoObservation {
  if (!(openRouterVideoModels as readonly string[]).includes(model) || !["create", "retrieve"].includes(action)) fail("context");
  const body = object(value);
  if (encoder.encode(JSON.stringify(body)).length > maxJson) fail("envelope_limit");
  const id = action === "create" ? validateOpenRouterVideoId(body.id) : validateOpenRouterVideoId(expectedId);
  if (body.id !== undefined && validateOpenRouterVideoId(body.id) !== id || body.model != null && body.model !== model) fail("identity");
  const status = action === "create" && body.status === undefined ? "pending" : body.status;
  if (typeof status !== "string" || ![...active, "completed", "failed", "cancelled", "expired"].includes(status)) fail("status");
  if (body.error != null && (typeof body.error !== "string" || body.error.length > 8192 || !["failed", "cancelled", "expired"].includes(status))) fail("error");
  const path = `/api/v1/videos/${id}`;
  if (body.polling_url != null) nativeUrl(body.polling_url, path);
  if (body.unsigned_urls != null) {
    if (!Array.isArray(body.unsigned_urls) || body.unsigned_urls.length > 1 || body.unsigned_urls.length && status !== "completed") fail("outputs");
    for (const url of body.unsigned_urls) nativeUrl(url, `${path}/content?index=0`);
  }
  const generationId = body.generation_id == null ? null : validateOpenRouterVideoId(body.generation_id);
  let nativeCost: number | null = null, isByok: boolean | null = null;
  if (body.usage != null) {
    const usage = object(body.usage);
    if (usage.cost != null) {
      if (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0) fail("usage");
      nativeCost = usage.cost;
    }
    if (usage.is_byok != null) { if (typeof usage.is_byok !== "boolean") fail("usage"); isByok = usage.is_byok; }
  }
  const result: OpenRouterVideoObservation = { id, body, nativeStatus: status, terminal: null,
    contentAvailable: status === "completed", generationId, nativeCost, isByok, upstreamCostMicros: null };
  if (status === "completed") result.terminal = "succeeded";
  else if (status === "failed") result.terminal = "failed";
  else if (status === "cancelled") result.terminal = "canceled";
  else if (status === "expired") result.observationUnavailable = "expired_or_unknown";
  else if (action === "create") result.followUp = "retrieve";
  return result;
}
export async function readOpenRouterVideo(response: Response, action: "create" | "retrieve", model: string, expectedId: string | undefined, signal: AbortSignal): Promise<OpenRouterVideoObservation> {
  if (response.redirected || response.status !== 200 && !(action === "create" && response.status === 202)) {
    void response.body?.cancel().catch(() => undefined); fail("http");
  }
  // Validate the real 202 before using the shared complete-JSON reader. This
  // internal view neither changes the native observation nor replays a POST.
  const view = response.status === 202 ? new Response(response.body, { status: 200, headers: response.headers }) : response;
  return readNativeJson(view, signal, maxJson, body => observeOpenRouterVideo(body, action, model, expectedId), fail);
}
export function prepareOpenRouterVideoContent(observation: OpenRouterVideoObservation, originalId: string) {
  const id = validateOpenRouterVideoId(originalId);
  if (observation.id !== id || observation.terminal !== "succeeded" || !observation.contentAvailable) fail("content_state");
  return { method: "GET", path: `/api/v1/videos/${id}/content`, query: new URLSearchParams({ index: "0" }),
    headers: new Headers({ accept: "video/mp4, video/webm" }) };
}
export function rewriteOpenRouterVideo(observation: OpenRouterVideoObservation, paths: ManagedPublicPaths): Json {
  const retrieve = mediaPublicPath(paths.retrieve);
  const result = observation.contentAvailable ? mediaPublicPath(paths.result) : undefined;
  // Signed native URLs are bearer capabilities; retain none in public output.
  const { polling_url: _poll, unsigned_urls: _unsigned, urls: _signed, expires_at: _expiry, ...body } = observation.body;
  return { ...body, id: observation.id, polling_url: retrieve,
    ...(observation.contentAvailable ? { unsigned_urls: [result] } : {}) };
}
export async function readOpenRouterVideoContent(response: Response, signal: AbortSignal): Promise<{ video: Uint8Array; mimeType: string; upstreamCostMicros: null }> {
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase(), length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || !mime || !["video/mp4", "video/webm"].includes(mime)
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxVideo)) {
    void response.body?.cancel().catch(() => undefined); fail("content_http");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > maxVideo) fail("content_limit"); chunks.push(chunk.value.slice());
    }
    if (!size || !response.headers.has("content-encoding") && length !== null && Number(length) !== size) fail("content_incomplete");
    const video = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { video.set(chunk, offset); offset += chunk.length; }
    return { video, mimeType: mime, upstreamCostMicros: null };
  } catch { void reader.cancel().catch(() => undefined); throw new Error("invalid_openrouter_video_content"); }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
function nativeUrl(value: unknown, path: string): void {
  // Public OpenRouter slice only. Custom origins need a distinct selected grant.
  if (value !== `https://openrouter.ai${path}` && value !== path) fail("control_url");
}
function https(value: string): void {
  let url: URL; try { url = new URL(value); } catch { fail("image_url"); }
  if (value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value) || url.protocol !== "https:" || url.username || url.password || url.hash) fail("image_url");
  // Opaque upstream input. Never fetched here or used as a secret destination.
}
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_openrouter_video_${reason}`); }
