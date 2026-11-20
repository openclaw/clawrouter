import { googleImageModels, observeGoogleImage, prepareGoogleImage } from "./google-images.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const jsonLimit = 8 * 1024 * 1024, outputLimit = 4 * 1024 * 1024;
const path = "/v1beta/models/${model}:generateContent";

export function prepareNativeGoogleImage(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "google.image_generate") return;
  if (provider.id !== "google-gemini" || !model || !googleImageModels.some(value => value === model.upstream)
    || selection.pathParams.model !== model.upstream || Object.keys(selection.pathParams).length !== 1
    || selection.capability !== "image.generate" || selection.method !== "POST" || endpoint.method !== "POST"
    || endpoint.path !== path || endpoint.upstreamPath !== undefined || endpoint.response_format !== "google.image"
    || endpoint.path_params.length !== 1 || endpoint.path_params[0] !== "model" || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.lifecycle || endpoint.responsesLifecycle
    || endpoint.websocket || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_google_image_route", "Google images require a qualified native model and unary route");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > jsonLimit) invalid();
    prepared = prepareGoogleImage(model.upstream, body);
    const config = object(prepared.body.generationConfig);
    if (config.imageConfig !== undefined) {
      const image = object(config.imageConfig);
      for (const field of ["aspectRatio", "imageSize"]) if (image[field] !== undefined && typeof image[field] !== "string") invalid();
    }
    for (const content of list(prepared.body.contents)) for (const part of list(object(content).parts)) {
      const inline = object(part).inlineData;
      if (inline !== undefined) validateImage(inline, jsonLimit);
    }
  } catch {
    throw new HttpError(400, "invalid_native_google_image_request", "Google images require bounded native JSON and qualified inline images");
  }
  return {
    origin: "https://generativelanguage.googleapis.com", path: prepared.path,
    // BodyLease charges twice this amount, before dispatch, through delivery.
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding");
      if (response.status !== 200 || response.redirected || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      // Identity still needs the reader's exact declared-length comparison.
      if (encoding !== null) {
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        response = new Response(response.body, { status: response.status, headers });
      }
      return readNativeJson(response, signal, jsonLimit, original => {
        const observed = observeGoogleImage(original, true);
        let bytes = 0, count = 0;
        const candidates = list(observed.body.candidates).map(value => {
          const candidate = object(value), content = object(candidate.content);
          const parts = list(content.parts).filter(value => object(value).thought !== true);
          for (const value of parts) {
            const part = object(value), inline = part.inlineData ?? part.inline_data;
            if (part.fileData !== undefined || part.file_data !== undefined) invalid();
            if (inline === undefined) continue;
            bytes += validateImage(inline, outputLimit);
            if (++count > 4 || bytes > outputLimit) invalid();
          }
          return { ...candidate, content: { ...content, parts } };
        });
        if (!count) invalid();
        const output = { ...observed.body, candidates };
        return { response: nativeJsonResponse(output, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens: null, outcome: "success" as const } };
      }, invalid);
    },
  };
}

// Bounded signatures qualify the declared container, not full image decoding.
// Never infer MIME from bytes: the codec's missing-MIME PNG default is excluded.
function validateImage(value: unknown, limit: number): number {
  const inline = object(value);
  if (inline.mimeType !== undefined && inline.mime_type !== undefined) invalid();
  const mime = inline.mimeType ?? inline.mime_type;
  if (typeof mime !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(mime)) invalid();
  const encoded = canonicalMediaBase64(inline.data, limit, invalid);
  if (inline.data !== encoded.base64) invalid();
  const prefix = atob(encoded.base64.slice(0, 44));
  if (mime === "image/png") {
    if (encoded.decodedBytes < 33 || prefix.slice(0, 8) !== "\x89PNG\r\n\x1a\n"
      || uint32(prefix, 8) !== 13 || prefix.slice(12, 16) !== "IHDR"
      || !uint32(prefix, 16) || !uint32(prefix, 20)) invalid();
  } else if (mime === "image/jpeg") {
    const tail = atob(encoded.base64.slice(-8));
    if (encoded.decodedBytes < 4 || prefix.slice(0, 3) !== "\xff\xd8\xff" || tail.slice(-2) !== "\xff\xd9") invalid();
  } else {
    const size = prefix.charCodeAt(4) + prefix.charCodeAt(5) * 256 + prefix.charCodeAt(6) * 65536 + prefix.charCodeAt(7) * 16777216;
    if (encoded.decodedBytes < 20 || prefix.slice(0, 4) !== "RIFF" || prefix.slice(8, 12) !== "WEBP"
      || !["VP8 ", "VP8L", "VP8X"].includes(prefix.slice(12, 16)) || size !== encoded.decodedBytes - 8) invalid();
  }
  return encoded.decodedBytes;
}
function uint32(bytes: string, offset: number): number {
  return bytes.charCodeAt(offset) * 16777216 + bytes.charCodeAt(offset + 1) * 65536 + bytes.charCodeAt(offset + 2) * 256 + bytes.charCodeAt(offset + 3);
}
function object(value: unknown): Record<string, unknown> { if (!mediaObject(value)) invalid(); return value; }
function list(value: unknown): unknown[] { if (!Array.isArray(value)) invalid(); return value; }
function invalid(): never { throw new Error("invalid_native_google_image_response"); }
