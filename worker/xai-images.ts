import { mediaObject } from "./managed-media-json.ts";

export const xaiImageModels = ["grok-imagine-image", "grok-imagine-image-2.0", "grok-imagine-image-quality"] as const;
export const xaiImageAliasEffectiveAt = "2026-11-02";
const alias = "grok-imagine-image-quality", replacement = "grok-imagine-image-2.0";
const aspects = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20"]);
const maxImage = 8 * 1024 * 1024, maxImagesBytes = 16 * 1024 * 1024, maxEnvelope = 24 * 1024 * 1024;
const encoder = new TextEncoder();
type Json = Record<string, unknown>;
type Mode = "generate" | "edit";
export interface XaiImageRequest {
  model: string; servingModel: string; mode: Mode; path: string; body: Json; headers: Headers;
  count: number; inputImages: number; resolution: "1k" | "2k";
  quality: "low" | "medium" | null; qualityBasis: "retired_alias" | "explicit" | "service_default" | "legacy";
}
export function prepareXaiImage(model: string, mode: Mode, value: unknown): XaiImageRequest {
  if (!(xaiImageModels as readonly string[]).includes(model) || !["generate", "edit"].includes(mode)) fail("model_or_mode");
  const body = object(value); keys(body, ["model", "prompt", "n", "response_format", "aspect_ratio", "resolution", "image", "images", "quality"]);
  if (body.model !== model || body.response_format !== "b64_json" || typeof body.prompt !== "string"
    || !body.prompt.trim() || encoder.encode(body.prompt).length > 32768
    || !Number.isSafeInteger(body.n) || Number(body.n) < 1 || Number(body.n) > 4) fail("request");
  if (body.aspect_ratio !== undefined && (typeof body.aspect_ratio !== "string" || !aspects.has(body.aspect_ratio))) fail("aspect");
  if (body.resolution !== undefined && body.resolution !== "1k" && body.resolution !== "2k") fail("resolution");
  const resolution = body.resolution === "2k" ? "2k" : "1k";
  if (body.quality !== undefined && (model !== replacement || typeof body.quality !== "string" || !["low", "medium", "auto"].includes(body.quality))) fail("quality");
  let inputs: unknown[] = [];
  if (mode === "generate") { if (body.image !== undefined || body.images !== undefined) fail("unexpected_reference"); }
  else {
    if ((body.image !== undefined) === (body.images !== undefined)) fail("references");
    if (body.image !== undefined) inputs = [body.image];
    else {
      if (!Array.isArray(body.images) || body.images.length < 2 || body.images.length > 3) fail("references");
      inputs = body.images;
    }
  }
  let inputBytes = 0;
  for (const input of inputs) {
    const image = object(input); keys(image, ["url", "type"]);
    if (image.type !== "image_url" || typeof image.url !== "string") fail("image");
    if (image.url.startsWith("data:")) {
      const data = /^data:image\/(?:png|jpeg|webp);base64,(.+)$/.exec(image.url);
      if (!data) fail("image");
      inputBytes += bytes(data[1]).length; if (inputBytes > maxImagesBytes) fail("input_limit");
    } else {
      let url: URL; try { url = new URL(image.url); } catch { fail("image_url"); }
      if (image.url.length > 8192 || url.protocol !== "https:" || url.username || url.password || url.hash) fail("image_url");
      // Opaque upstream input only; never a router fetch or secret destination.
    }
  }
  if (encoder.encode(JSON.stringify(body)).length > maxEnvelope) fail("request_limit");
  const qualityBasis = model === alias ? "retired_alias" : model !== replacement ? "legacy"
    : body.quality === "low" || body.quality === "medium" ? "explicit" : "service_default";
  const quality = model === alias ? "low" : model !== replacement ? null
    : body.quality === "low" || body.quality === "medium" ? body.quality : mode === "edit" ? "medium" : "low";
  // Preserve the selected retired slug in the request. This is an upstream
  // alias contract, not a router rewrite to 2.0's different auto default.
  return { model, servingModel: model === alias ? replacement : model, mode, body,
    path: mode === "generate" ? "/v1/images/generations" : "/v1/images/edits",
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }),
    count: Number(body.n), inputImages: inputs.length, resolution, quality, qualityBasis };
}
export function observeXaiImage(value: unknown, request: XaiImageRequest, complete: boolean): {
  body: Json; selectedModel: string; servingModel: string; images: Uint8Array[];
  quality: XaiImageRequest["quality"]; qualityBasis: XaiImageRequest["qualityBasis"]; usage: Json | null;
} {
  if (!complete) fail("incomplete");
  const body = object(value);
  if (encoder.encode(JSON.stringify(body)).length > maxEnvelope || body.error !== undefined
    || body.model !== request.servingModel || body.status !== undefined && body.status !== "done") fail("response_identity");
  if (!Array.isArray(body.data) || body.data.length !== request.count) fail("partial_images");
  const images: Uint8Array[] = []; let total = 0;
  for (const raw of body.data) {
    const image = object(raw);
    if (image.url !== undefined || image.error !== undefined || image.respect_moderation === false
      || image.finish_reason !== undefined && image.finish_reason !== "stop") fail("image_result");
    const data = bytes(image.b64_json); total += data.length; if (total > maxImagesBytes) fail("output_limit");
    images.push(data);
  }
  // Service-default quality is a dated qualification, not a new usage counter.
  // Preserve native usage without deriving a dollar charge or assuming a refund.
  return { body, selectedModel: request.model, servingModel: body.model as string, images,
    quality: request.quality, qualityBasis: request.qualityBasis, usage: mediaObject(body.usage) ? body.usage : null };
}
export async function readXaiImage(response: Response, request: XaiImageRequest, signal: AbortSignal): Promise<ReturnType<typeof observeXaiImage>> {
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxEnvelope)) {
    void response.body?.cancel().catch(() => undefined); fail("http");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener("abort", abort, { once: true });
  let size = 0, text = "";
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > maxEnvelope) fail("size");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    if (!response.headers.has("content-encoding") && length !== null && Number(length) !== size) fail("truncated");
    return observeXaiImage(JSON.parse(text), request, true);
  } catch { void reader.cancel().catch(() => undefined); fail("response"); }
  finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
function bytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(maxImage / 3) * 4 || value.length % 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("base64");
  const raw = atob(value);
  if (!raw.length || raw.length > maxImage || btoa(raw) !== value) fail("base64");
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_xai_image_${reason}`); }

