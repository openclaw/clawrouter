import { googleUnderstandingModel, observeGoogleUnderstanding, prepareGoogleUnderstanding } from "./google-media-understanding.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { canonicalMediaBase64, mediaObject } from "./managed-media-json.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

export function prepareNativeGoogleMediaUnderstanding(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "google.audio_understanding" && endpoint.request_format !== "google.video_understanding") return;
  const mode = endpoint.request_format === "google.audio_understanding" ? "audio" : "video";
  if (provider.id !== "google-gemini" || model?.upstream !== googleUnderstandingModel
    || selection.capability !== (mode === "audio" ? "audio.transcription" : "video.understanding")
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/v1beta/models/${model}:generateContent"
    || endpoint.response_format !== "google.generate_content" || endpoint.upstreamPath !== undefined || Object.keys(endpoint.query).length
    || endpoint.path_params.length !== 1 || endpoint.path_params[0] !== "model"
    || Object.keys(selection.pathParams).length !== 1 || selection.pathParams.model !== model.upstream
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.lifecycle || endpoint.responsesLifecycle
    || endpoint.websocket || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_google_understanding_route", "Google inline media requires its selected model, modality and native path");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > 8 * 1024 * 1024) invalid();
    prepared = prepareGoogleUnderstanding(model.upstream, mode, body);
    const contents = list(prepared.body.contents, 1), parts = list(object(contents[0]).parts, 2), inline = object(object(parts[1]).inline_data);
    // The pure codec has a wider MIME allowlist; this wrapper qualifies these containers only.
    if (inline.mime_type !== (mode === "audio" ? "audio/wav" : "video/mp4")) invalid();
    const data = canonicalMediaBase64(inline.data, 4 * 1024 * 1024, invalid);
    if (inline.data !== data.base64) invalid();
    const bytes = Uint8Array.from(atob(data.base64), value => value.charCodeAt(0));
    if (mode === "audio") wav(bytes); else mp4(bytes);
  } catch {
    throw new HttpError(400, "invalid_native_google_understanding_request", "Google inline media input or container is not qualified");
  }
  return {
    origin: "https://generativelanguage.googleapis.com", path: prepared.path,
    acquire: () => nativeResponseLease(16 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding");
      if (response.status !== 200 || response.redirected || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      if (encoding !== null) {
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        response = new Response(response.body, { status: response.status, headers });
      }
      return readNativeJson(response, signal, 1024 * 1024, original => {
        const root = observeGoogleUnderstanding(original, true).body;
        const candidate = object(list(root.candidates, 1)[0]), content = object(candidate.content);
        const parts = list(content.parts, 64).map(object).filter(part => part.thought !== true);
        for (const part of parts) if (part.file_data !== undefined || part.function_call !== undefined || part.functionResponse !== undefined) invalid();
        const output = { ...root, candidates: [{ ...candidate, content: { ...content, parts } }] };
        return { response: nativeJsonResponse(output, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens: null, outcome: "success" as const } };
      }, invalid);
    },
  };
}

function wav(bytes: Uint8Array): void {
  if (bytes.length < 44 || ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) invalid();
  let at = 12, count = 0, align = 0, data = false;
  while (at + 8 <= bytes.length && count++ < 256) {
    const name = ascii(bytes, at), size = view.getUint32(at + 4, true), start = at + 8, end = start + size;
    if (end > bytes.length) invalid();
    if (name === "fmt ") {
      if (align || size !== 16 || view.getUint16(start, true) !== 1) invalid();
      const channels = view.getUint16(start + 2, true), rate = view.getUint32(start + 4, true);
      align = channels * 2;
      if (![1, 2].includes(channels) || rate < 8000 || rate > 96000 || view.getUint16(start + 14, true) !== 16
        || view.getUint16(start + 12, true) !== align || view.getUint32(start + 8, true) !== rate * align) invalid();
    } else if (name === "data") {
      if (!align || data || !size || size % align) invalid(); data = true;
    }
    at = end + size % 2;
  }
  if (at !== bytes.length || !align || !data) invalid();
}

function mp4(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0, fileType = false, movie = false, media = false, video = false;
  function boxes(start: number, end: number, depth: number): void {
    let at = start;
    while (at + 8 <= end && ++count <= 512) {
      const size = view.getUint32(at), kind = ascii(bytes, at + 4), payload = at + 8, stop = at + size;
      // Extended/unbounded boxes are outside this bounded inline qualification.
      if (size < 8 || stop > end) invalid();
      if (!depth && kind === "ftyp") {
        if (at || fileType || size < 20 || size % 4 || !["isom", "iso5", "iso6", "mp41", "mp42", "avc1"].includes(ascii(bytes, payload))) invalid();
        fileType = true;
      } else if (!depth && kind === "moov") {
        if (movie) invalid(); movie = true; boxes(payload, stop, 1);
      } else if (!depth && kind === "mdat") {
        if (size <= 8) invalid(); media = true;
      } else if (depth === 1 && kind === "trak" || depth === 2 && kind === "mdia") boxes(payload, stop, depth + 1);
      else if (depth === 3 && kind === "hdlr") {
        if (size < 32) invalid(); if (ascii(bytes, payload + 8) === "vide") video = true;
      }
      at = stop;
    }
    if (at !== end) invalid();
  }
  boxes(0, bytes.length, 0);
  if (!fileType || !movie || !media || !video) invalid();
}
function ascii(bytes: Uint8Array, at: number): string { return String.fromCharCode(...bytes.subarray(at, at + 4)); }
function object(value: unknown): Record<string, unknown> { if (!mediaObject(value)) invalid(); return value; }
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) invalid(); return value; }
function invalid(): never { throw new Error("invalid_native_google_media_understanding_response"); }
