import { googleMusicModels, observeGoogleMusic, prepareGoogleMusic } from "./google-music.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const jsonLimit = 8 * 1024 * 1024, audioLimit = 4 * 1024 * 1024;

export function prepareNativeGoogleMusic(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "google.music_generate") return;
  if (provider.id !== "google-gemini" || !model || !googleMusicModels.some(value => value === model.upstream)
    || selection.pathParams.model !== model.upstream || Object.keys(selection.pathParams).length !== 1
    || selection.capability !== "audio.generate" || selection.method !== "POST" || endpoint.method !== "POST"
    || endpoint.path !== "/v1beta/models/${model}:generateContent" || endpoint.upstreamPath !== undefined
    || endpoint.response_format !== "google.music" || endpoint.path_params.length !== 1 || endpoint.path_params[0] !== "model"
    || Object.keys(endpoint.query).length || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.websocket || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_google_music_route", "Google music requires a qualified frozen model and unary route");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > jsonLimit) invalid();
    prepared = prepareGoogleMusic(model.upstream, body);
    for (const content of list(prepared.body.contents)) for (const part of list(object(content).parts)) {
      const inline = object(part).inlineData;
      if (inline !== undefined) imageInput(inline);
    }
  } catch {
    throw new HttpError(400, "invalid_native_google_music_request", "Google music requires bounded native text and qualified inline images");
  }
  return {
    origin: "https://generativelanguage.googleapis.com", path: prepared.path,
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding");
      if (response.status !== 200 || response.redirected || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      if (encoding !== null) {
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        response = new Response(response.body, { status: response.status, headers });
      }
      return readNativeJson(response, signal, jsonLimit, original => {
        const observed = observeGoogleMusic(original, prepared, true);
        const candidate = object(list(observed.body.candidates)[0]), content = object(candidate.content);
        const parts = list(content.parts).filter(value => object(value).thought !== true);
        for (const value of parts) {
          const part = object(value), data = part.inlineData ?? part.inline_data;
          if (part.fileData !== undefined || part.file_data !== undefined) invalid();
          if (data === undefined) continue;
          const inline = object(data), mime = inline.mimeType ?? inline.mime_type;
          if (mime !== "audio/mpeg" && !(prepared.model === "lyria-3-pro-preview" && mime === "audio/wav")) invalid();
          const encoded = canonicalMediaBase64(inline.data, audioLimit, invalid);
          if (inline.data !== encoded.base64) invalid();
          const bytes = atob(encoded.base64);
          if (mime === "audio/mpeg") mp3(bytes); else wav(bytes);
        }
        const output = { ...observed.body, candidates: [{ ...candidate, content: { ...content, parts } }] };
        return { response: nativeJsonResponse(output, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens: null, outcome: "success" as const } };
      }, invalid);
    },
  };
}

// Qualify complete framing, not decoded samples, duration or an upstream bill.
function mp3(bytes: string): void {
  let offset = 0, end = bytes.length, frames = 0, layout: string | undefined;
  if (bytes.startsWith("ID3")) {
    const version = bytes.charCodeAt(3), flags = bytes.charCodeAt(5);
    if (bytes.length < 10 || ![2, 3, 4].includes(version) || bytes.charCodeAt(4) === 255) invalid();
    let size = 0;
    for (let i = 6; i < 10; i++) { const value = bytes.charCodeAt(i); if (value > 127) invalid(); size = size * 128 + value; }
    offset = 10 + size + (version === 4 && (flags & 16) ? 10 : 0);
    if (offset > end) invalid();
  }
  if (end - offset >= 128 && bytes.slice(end - 128, end - 125) === "TAG") end -= 128;
  while (offset < end) {
    const a = bytes.charCodeAt(offset), b = bytes.charCodeAt(offset + 1), c = bytes.charCodeAt(offset + 2), d = bytes.charCodeAt(offset + 3);
    const version = (b >> 3) & 3, rateIndex = (c >> 2) & 3, bitrateIndex = c >> 4;
    if (offset + 4 > end || a !== 255 || (b & 224) !== 224 || version === 1 || (b & 6) !== 2
      || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) invalid();
    const rates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const identity = `${version}:${sampleRate}:${(d >> 6) === 3 ? 1 : 2}`;
    if (layout !== undefined && layout !== identity) invalid();
    layout = identity;
    const size = Math.floor((version === 3 ? 144000 : 72000) * rates[bitrateIndex] / sampleRate) + ((c >> 1) & 1);
    if (offset + size > end) invalid();
    offset += size; frames++;
  }
  if (!frames || offset !== end) invalid();
}

function wav(bytes: string): void {
  if (bytes.length < 44 || bytes.slice(0, 4) !== "RIFF" || bytes.slice(8, 12) !== "WAVE" || u32(bytes, 4) !== bytes.length - 8) invalid();
  let offset = 12, align = 0, dataSize = 0, formatSeen = false, dataSeen = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid();
    const kind = bytes.slice(offset, offset + 4), size = u32(bytes, offset + 4), start = offset + 8;
    if (start + size + size % 2 > bytes.length) invalid();
    if (kind === "fmt ") {
      if (formatSeen || size < 16 || u16(bytes, start) !== 1 || u16(bytes, start + 14) !== 16) invalid();
      const channels = u16(bytes, start + 2), rate = u32(bytes, start + 4);
      align = u16(bytes, start + 12);
      if (![1, 2].includes(channels) || rate < 8000 || rate > 192000 || align !== channels * 2 || u32(bytes, start + 8) !== rate * align) invalid();
      formatSeen = true;
    } else if (kind === "data") {
      if (dataSeen || !size) invalid();
      dataSeen = true; dataSize = size;
    }
    offset = start + size + size % 2;
  }
  if (!formatSeen || !dataSeen || dataSize % align || offset !== bytes.length) invalid();
}

function imageInput(value: unknown): void {
  const image = object(value), mime = image.mimeType;
  if (typeof mime !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(mime)) invalid();
  const encoded = canonicalMediaBase64(image.data, jsonLimit, invalid);
  if (image.data !== encoded.base64) invalid();
  const prefix = atob(encoded.base64.slice(0, 44));
  if (mime === "image/png" && (encoded.decodedBytes < 33 || prefix.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || prefix.slice(12, 16) !== "IHDR")) invalid();
  if (mime === "image/jpeg" && (prefix.slice(0, 3) !== "\xff\xd8\xff" || atob(encoded.base64.slice(-8)).slice(-2) !== "\xff\xd9")) invalid();
  if (mime === "image/webp" && (encoded.decodedBytes < 20 || prefix.slice(0, 4) !== "RIFF" || prefix.slice(8, 12) !== "WEBP"
    || !["VP8 ", "VP8L", "VP8X"].includes(prefix.slice(12, 16)) || u32(prefix, 4) !== encoded.decodedBytes - 8)) invalid();
}
function u16(bytes: string, offset: number): number { return bytes.charCodeAt(offset) + bytes.charCodeAt(offset + 1) * 256; }
function u32(bytes: string, offset: number): number { return u16(bytes, offset) + u16(bytes, offset + 2) * 65536; }
function object(value: unknown): Record<string, unknown> { if (!mediaObject(value)) invalid(); return value; }
function list(value: unknown): unknown[] { if (!Array.isArray(value)) invalid(); return value; }
function invalid(): never { throw new Error("invalid_native_google_music_response"); }
