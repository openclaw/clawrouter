import { mediaObject } from "./managed-media-json.ts";
import { prepareOpenRouterImage, observeOpenRouterImage } from "./openrouter-images.ts";
import type { OpenRouterImageRequest, OpenRouterImageAsset } from "./openrouter-images.ts";
import { readNativeJson } from "./native-json.ts";

type Json = Record<string, unknown>;
const encoder = new TextEncoder(), maxEnvelope = 64 * 1024 * 1024, maxOutput = 32 * 1024 * 1024;
export interface OpenRouterChatImageGrant { selectedBaseUrl: string; chatImagesQualified: boolean }
export interface OpenRouterChatImageRequest {
  selectedOrigin: string; path: string; body: Json; headers: Headers; count: number;
  // Validation only; never dispatch this native-image request to the custom host.
  imageContract: OpenRouterImageRequest;
}
export function prepareOpenRouterChatImages(model: string, value: unknown, grant: OpenRouterChatImageGrant): OpenRouterChatImageRequest {
  let base: URL; try { base = new URL(grant.selectedBaseUrl); } catch { fail("grant"); }
  if (grant.chatImagesQualified !== true || base.protocol !== "https:" || base.username || base.password || base.search || base.hash
    || ["openrouter.ai", "www.openrouter.ai"].includes(base.hostname) || !/^\/[a-zA-Z0-9_/-]*$/.test(base.pathname)) fail("grant");
  const body = object(value); keys(body, ["model", "messages", "modalities", "n", "image_config"]);
  if (body.model !== model || JSON.stringify(body.modalities) !== '["image","text"]'
    || typeof body.n !== "number" || !Number.isSafeInteger(body.n) || body.n < 1 || body.n > 4
    || !Array.isArray(body.messages) || body.messages.length !== 1) fail("request");
  const message = object(body.messages[0]); keys(message, ["role", "content"]);
  if (message.role !== "user") fail("role");
  let prompt: unknown = message.content, references: unknown[] | undefined;
  if (Array.isArray(message.content)) {
    if (message.content.length < 2 || message.content.length > 6) fail("content");
    const text = object(message.content[0]); keys(text, ["type", "text"]);
    if (text.type !== "text") fail("content"); prompt = text.text; references = message.content.slice(1);
  }
  const config = body.image_config === undefined ? {} : object(body.image_config); keys(config, ["aspect_ratio", "image_size"]);
  const imageContract = prepareOpenRouterImage(model, { model, prompt, n: 1,
    ...(references ? { input_references: references } : {}),
    ...(config.aspect_ratio !== undefined ? { aspect_ratio: config.aspect_ratio } : {}),
    ...(config.image_size !== undefined ? { resolution: config.image_size } : {}) });
  return { selectedOrigin: base.origin, path: `${base.pathname.replace(/\/+$/, "")}/chat/completions`,
    body: structuredClone(body), count: body.n, imageContract,
    headers: new Headers({ "content-type": "application/json", accept: "application/json" }) };
}
export function observeOpenRouterChatImages(value: unknown, request: OpenRouterChatImageRequest): {
  body: Json; images: OpenRouterImageAsset[]; selectedModel: string; servingModel: string | null;
  delivery: "complete" | "partial"; usage: Json | null; upstreamCostMicros: null;
} {
  const body = object(value), model = request.imageContract.model;
  if (encoder.encode(JSON.stringify(body)).length > maxEnvelope || body.error != null || body.model != null && body.model !== model
    || !Array.isArray(body.choices) || !body.choices.length || body.choices.length > request.count) fail("response");
  const images: OpenRouterImageAsset[] = [], indexes = new Set(); let decodedBytes = 0;
  const append = (item: Json) => {
    if (images.length >= request.count) fail("output_count");
    const image = observeOpenRouterImage({ data: [item] }, request.imageContract, true).images[0];
    decodedBytes += image.decodedBytes; if (decodedBytes > maxOutput) fail("output_limit"); images.push(image);
  };
  const dataUrl = (value: unknown) => {
    if (typeof value !== "string") fail("data_url");
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=_-]+)$/.exec(value);
    if (!match) fail("data_url"); append({ b64_json: match[2], media_type: match[1] });
  };
  const urlEntry = (value: unknown) => {
    const entry = object(value);
    if (entry.image_url !== undefined && entry.imageUrl !== undefined) fail("ambiguous_image");
    dataUrl(object(entry.image_url ?? entry.imageUrl).url);
  };
  for (const raw of body.choices) {
    const choice = object(raw);
    if (choice.finish_reason != null && choice.finish_reason !== "stop" || choice.error != null) fail("partial_choice");
    if (choice.index !== undefined) {
      if (typeof choice.index !== "number" || !Number.isSafeInteger(choice.index) || choice.index < 0 || choice.index >= request.count || indexes.has(choice.index)) fail("choice_index");
      indexes.add(choice.index);
    }
    const message = object(choice.message);
    if (message.refusal != null || message.tool_calls != null || message.function_call != null) fail("unexpected_output");
    if (message.images != null) {
      if (!Array.isArray(message.images) || message.images.length > request.count) fail("images");
      for (const image of message.images) urlEntry(image);
    }
    if (typeof message.content === "string") {
      for (const match of message.content.matchAll(/data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+/g)) dataUrl(match[0]);
    } else if (Array.isArray(message.content)) {
      if (message.content.length > 128) fail("content_limit");
      for (const rawPart of message.content) {
        const part = object(rawPart);
        if (part.type === "text") continue;
        if (part.type === "image_url") { urlEntry(part); continue; }
        if (part.b64_json !== undefined) { append({ b64_json: part.b64_json, mime_type: part.mime_type, media_type: part.media_type }); continue; }
        if (part.inlineData != null || part.inline_data != null) {
          if (part.inlineData != null && part.inline_data != null) fail("ambiguous_image");
          const inline = object(part.inlineData ?? part.inline_data);
          append({ b64_json: inline.data, mime_type: inline.mimeType, media_type: inline.mime_type });
        }
      }
    } else if (message.content != null) fail("content");
  }
  if (!images.length || body.usage != null && !mediaObject(body.usage)) fail("response");
  const usage = mediaObject(body.usage) ? body.usage : null;
  if (usage?.cost != null && (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0)) fail("usage");
  return { body, images, selectedModel: model, servingModel: typeof body.model === "string" ? model : null,
    delivery: images.length === request.count ? "complete" : "partial", usage, upstreamCostMicros: null };
}
export async function readOpenRouterChatImages(response: Response, request: OpenRouterChatImageRequest, signal: AbortSignal) {
  return readNativeJson(response, signal, maxEnvelope, body => observeOpenRouterChatImages(body, request), fail);
}
function object(value: unknown): Json { if (!mediaObject(value)) fail("object"); return value; }
function keys(value: Json, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("fields"); }
function fail(reason: string): never { throw new Error(`invalid_openrouter_chat_image_${reason}`); }
