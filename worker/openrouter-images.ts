import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";

export const openRouterImageModels = ["google/gemini-3.1-flash-image-preview", "google/gemini-3-pro-image-preview", "openai/gpt-5.4-image-2"] as const;
const ratios = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const maxEnvelope = 24 * 1024 * 1024, maxInput = 14 * 1024 * 1024, maxOutput = 16 * 1024 * 1024;
const encoder = new TextEncoder();
type Json = Record<string, unknown>;
export interface OpenRouterImageRequest { model: string; body: Json; path: "/api/v1/images"; headers: Headers; inputImages: number }
export function prepareOpenRouterImage(model: string, value: unknown): OpenRouterImageRequest {
  if (!(openRouterImageModels as readonly string[]).includes(model) || !mediaObject(value)
    || encoder.encode(JSON.stringify(value)).length > maxEnvelope) fail("request");
  keys(value, ["model", "prompt", "n", "aspect_ratio", "resolution", "input_references"]);
  if (value.model !== model || value.n !== 1 || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 32768) fail("request");
  for (const character of value.prompt) { const code = character.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) fail("prompt"); }
  if (!model.startsWith("google/") && (value.aspect_ratio !== undefined || value.resolution !== undefined)) fail("model_options");
  if (value.aspect_ratio !== undefined && (typeof value.aspect_ratio !== "string" || !ratios.has(value.aspect_ratio))
    || value.resolution !== undefined && !["1K", "2K", "4K"].includes(String(value.resolution))) fail("geometry");
  let inputImages = 0, inputBytes = 0;
  if (value.input_references !== undefined) {
    if (!Array.isArray(value.input_references) || !value.input_references.length || value.input_references.length > 5) fail("references");
    for (const raw of value.input_references) {
      const ref = object(raw); keys(ref, ["type", "image_url"]);
      const image = object(ref.image_url); keys(image, ["url"]);
      if (ref.type !== "image_url" || typeof image.url !== "string") fail("reference");
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=_-]+)$/.exec(image.url);
      if (!match) fail("inline_reference_required");
      inputBytes += canonicalMediaBase64(match[2], maxInput, () => fail("reference_base64")).decodedBytes;
      if (inputBytes > maxInput) fail("input_limit");
      inputImages++;
    }
  }
  return { model, body: structuredClone(value), path: "/api/v1/images", inputImages,
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}

export interface OpenRouterImageAsset { base64: string; decodedBytes: number; mimeType: "image/png" | "image/jpeg" | "image/webp" }
export function observeOpenRouterImage(value: unknown, request: OpenRouterImageRequest, complete: boolean): {
  body: Json; images: OpenRouterImageAsset[]; selectedModel: string; servingModel: string | null; usage: Json | null; upstreamCostMicros: null;
} {
  if (!complete || !mediaObject(value) || encoder.encode(JSON.stringify(value)).length > maxEnvelope
    || value.error != null || !Array.isArray(value.data) || value.data.length !== 1
    || value.model != null && value.model !== request.model || value.status != null && value.status !== "completed") fail("response");
  const item = object(value.data[0]);
  if (item.error != null || item.url !== undefined || item.finish_reason != null && item.finish_reason !== "stop") fail("image");
  const encoded = canonicalMediaBase64(item.b64_json, maxOutput, () => fail("base64"));
  const mimeType = sniff(encoded.base64);
  if (item.media_type != null && item.media_type !== mimeType || item.mime_type != null && item.mime_type !== mimeType) fail("mime");
  if (value.usage != null && !mediaObject(value.usage)) fail("usage");
  const usage = mediaObject(value.usage) ? value.usage : null;
  if (usage?.cost != null && (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0)) fail("usage_cost");
  // Usage/cost is native evidence, not a qualified preflight bound. Each paid
  // request settles separately even when the client's multi-image batch fails.
  return { body: value, images: [{ ...encoded, mimeType }], selectedModel: request.model,
    servingModel: typeof value.model === "string" ? value.model : null, usage, upstreamCostMicros: null };
}
export async function readOpenRouterImage(response: Response, request: OpenRouterImageRequest, signal: AbortSignal) {
  return readNativeJson(response, signal, maxEnvelope, body => observeOpenRouterImage(body, request, true), fail);
}
function sniff(base64: string): OpenRouterImageAsset["mimeType"] {
  const bytes = Uint8Array.from(atob(base64.slice(0, 32)), character => character.charCodeAt(0));
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  fail("image_signature");
}
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_openrouter_image_${reason}`); }
