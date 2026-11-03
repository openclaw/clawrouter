import type { ManagedObservation } from "./managed-lifecycle-types.ts";
import { mediaObject } from "./managed-media-json.ts";

type Json = Record<string, unknown>;
type Mode = "generate" | "edit" | "extend";
export const xaiVideoProtocol = "xai.video";
export const xaiVideoModels = ["grok-imagine-video", "grok-imagine-video-1.5"] as const;
const paths = { generate: "/v1/videos/generations", edit: "/v1/videos/edits", extend: "/v1/videos/extensions" } as const;
const aspects = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
const encoder = new TextEncoder();
const maxImage = 8 * 1024 * 1024, maxImages = 16 * 1024 * 1024, maxJson = 1024 * 1024;
export interface XaiVideoRequest {
  path: string; body: Json; headers: Headers; requestedVersion: string;
  mode: Mode; duration: number | null; resolution: string | null;
}
export function validateXaiVideoId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(value)) fail("id");
  return value;
}
export function prepareXaiVideo(model: string, mode: Mode, value: unknown, idempotencyKey?: string): XaiVideoRequest {
  if (!(xaiVideoModels as readonly string[]).includes(model) || !Object.hasOwn(paths, mode)) fail("model_or_mode");
  const body = object(value), modern = model === "grok-imagine-video-1.5";
  keys(body, ["model", "prompt", "duration", "aspect_ratio", "resolution", "image", "reference_images", "video"]);
  if (body.model !== model || typeof body.prompt !== "string" || !body.prompt.trim() || encoder.encode(body.prompt).length > 32768) fail("request");
  for (const character of body.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("prompt"); }
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  if (idempotencyKey !== undefined) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(idempotencyKey)) fail("idempotency");
    headers.set("x-idempotency-key", idempotencyKey);
  }
  let duration: number | null = null, resolution: string | null = null;
  if (mode === "generate") {
    if (body.video !== undefined || body.image !== undefined && body.reference_images !== undefined) fail("references");
    let inputs: unknown[] = [];
    if (body.image !== undefined) inputs = [body.image];
    if (body.reference_images !== undefined) {
      if (!Array.isArray(body.reference_images) || !body.reference_images.length || body.reference_images.length > 7) fail("references");
      inputs = body.reference_images;
    }
    // Keep the frozen 1.5 consumer's one-first-frame mode. New native text,
    // keyframe, audio-reference and multi-reference modes are not this slice.
    if (modern && (body.image === undefined || body.reference_images !== undefined)) fail("frozen_model_mode");
    let imageBytes = 0;
    for (const input of inputs) { imageBytes += image(input); if (imageBytes > maxImages) fail("image_limit"); }
    duration = body.duration === undefined ? 8 : boundedDuration(body.duration, 1, body.reference_images !== undefined ? 10 : 15);
    if (body.resolution !== undefined && typeof body.resolution !== "string") fail("resolution");
    resolution = body.resolution === undefined ? "480p" : body.resolution as string;
    if (!(modern ? ["480p", "720p", "1080p"] : ["480p", "720p"]).includes(resolution)) fail("resolution");
    if (body.aspect_ratio !== undefined && (typeof body.aspect_ratio !== "string" || !aspects.includes(body.aspect_ratio))) fail("aspect");
  } else {
    if (modern || body.image !== undefined || body.reference_images !== undefined || body.aspect_ratio !== undefined || body.resolution !== undefined) fail("mode");
    const video = object(body.video); keys(video, ["url"]); https(video.url);
    if (mode === "edit") { if (body.duration !== undefined) fail("edit_duration"); }
    else duration = body.duration === undefined ? 6 : boundedDuration(body.duration, 2, 10);
  }
  if (encoder.encode(JSON.stringify(body)).length > 24 * 1024 * 1024) fail("request_limit");
  return { path: paths[mode], body, headers, requestedVersion: model, mode, duration, resolution };
}
export function prepareXaiVideoControl(action: string, id: unknown) {
  if (action !== "retrieve") fail("unsupported_control");
  return { method: "GET", path: `/v1/videos/${validateXaiVideoId(id)}`, query: new URLSearchParams(), headers: new Headers({ accept: "application/json" }) };
}
export interface XaiVideoObservation extends ManagedObservation {
  delivery: "pending" | "available" | "filtered" | "unavailable";
  outputUrl: string | null;
  nativeDurationSeconds: number | null;
  usage: Json | null;
  upstreamCostMicros: null;
}
export function observeXaiVideo(value: unknown, action: "create" | "retrieve", requestedModel: string, expectedId?: string): XaiVideoObservation {
  if (!(xaiVideoModels as readonly string[]).includes(requestedModel) || !["create", "retrieve"].includes(action)) fail("context");
  const body = object(value);
  if (encoder.encode(JSON.stringify(body)).length > maxJson) fail("envelope_limit");
  const id = action === "create" ? validateXaiVideoId(body.request_id) : validateXaiVideoId(expectedId);
  if (body.request_id !== undefined && validateXaiVideoId(body.request_id) !== id
    || body.model !== undefined && body.model !== null && body.model !== requestedModel) fail("identity");
  const status = action === "create" && body.status === undefined ? "pending" : body.status;
  if (typeof status !== "string" || !["pending", "done", "failed", "expired"].includes(status)) fail("status");
  if (body.error !== undefined && body.error !== null && status !== "failed" && status !== "expired") fail("api_error");
  if (body.error !== undefined && body.error !== null) object(body.error);
  const result: XaiVideoObservation = { id, nativeStatus: status, terminal: null, body,
    delivery: "pending", outputUrl: null, nativeDurationSeconds: null,
    usage: mediaObject(body.usage) ? body.usage : null, upstreamCostMicros: null };
  if (status === "done") {
    const video = object(body.video);
    if (typeof video.respect_moderation !== "boolean") fail("moderation");
    result.terminal = "succeeded";
    if (video.duration !== undefined && video.duration !== null) result.nativeDurationSeconds = boundedDuration(video.duration, 0, 25);
    if (video.respect_moderation) { result.outputUrl = https(video.url); result.delivery = "available"; }
    else {
      if (video.url !== undefined && video.url !== null && video.url !== "") fail("filtered_url");
      result.delivery = "filtered";
    }
  } else {
    if (body.video !== undefined && body.video !== null) fail("premature_output");
    if (status === "failed") { result.terminal = "failed"; result.delivery = "unavailable"; }
    else if (status === "expired") { result.observationUnavailable = "expired_or_unknown"; result.delivery = "unavailable"; }
    else if (action === "create") result.followUp = "retrieve";
  }
  return result;
}
export async function readXaiVideo(response: Response, action: "create" | "retrieve", requestedModel: string, expectedId: string | undefined, signal: AbortSignal): Promise<XaiVideoObservation> {
  const length = response.headers.get("content-length"), mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const pendingHttp = action === "retrieve" && response.status === 202;
  if (![200, 202].includes(response.status) || response.redirected || response.headers.has("content-range")
    || !pendingHttp && mime !== "application/json"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxJson)) {
    void response.body?.cancel().catch(() => undefined); fail("http");
  }
  const reader = response.body?.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader?.cancel().catch(() => undefined); }; signal.addEventListener("abort", abort, { once: true });
  let text = "", size = 0;
  try {
    signal.throwIfAborted();
    if (reader) for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > maxJson) fail("size"); text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode(); signal.throwIfAborted();
    if (size && mime !== "application/json") fail("mime");
    if (!response.headers.has("content-encoding") && length !== null && Number(length) !== size) fail("truncated");
    const body = pendingHttp && !size ? { status: "pending" } : object(JSON.parse(text));
    if (pendingHttp && body.status !== "pending") fail("http_status_mismatch");
    return observeXaiVideo(body, action, requestedModel, expectedId);
  } catch { void reader?.cancel().catch(() => undefined); fail("response"); }
  finally { signal.removeEventListener("abort", abort); reader?.releaseLock(); }
}
function image(value: unknown): number {
  const input = object(value); keys(input, ["url"]);
  if (typeof input.url !== "string") fail("image");
  if (!input.url.startsWith("data:")) { https(input.url); return 0; }
  const match = /^data:image\/(?:png|jpeg|webp);base64,(.+)$/.exec(input.url);
  if (!match || match[1].length > Math.ceil(maxImage / 3) * 4 || match[1].length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(match[1])) fail("image_data");
  const bytes = atob(match[1]); if (!bytes.length || bytes.length > maxImage || btoa(bytes) !== match[1]) fail("image_data");
  return bytes.length;
}
function https(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) fail("url");
  let url: URL; try { url = new URL(value); } catch { fail("url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || /[\u0000-\u0020\u007f]/.test(value)) fail("url");
  // Opaque data only. This codec never fetches inputs/outputs or attaches secrets.
  return value;
}
function boundedDuration(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail("duration");
  return value;
}
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_xai_video_${reason}`); }
