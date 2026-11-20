import { mediaObject } from "./managed-media-json.ts";

function requireVeo(value: unknown, field: string): asserts value { if (!value) throw new Error(`invalid_google_veo_${field}`); }
export type GoogleVeoAsset = { kind: "inline"; base64: string; mimeType: string; decodedBytes: number }
  | { kind: "file"; resource: string; mimeType: string };

/** ProtoJSON bytes: one alphabet, optional padding/whitespace, canonical pad bits. */
export function canonicalGoogleVeoBytes(value: unknown, maxBytes: number): { base64: string; decodedBytes: number } {
  requireVeo(Number.isSafeInteger(maxBytes) && maxBytes > 0, "byte_limit");
  requireVeo(typeof value === "string" && value.length <= Math.ceil(maxBytes / 3) * 4 + 4096, "bytes");
  let encoded = value.replace(/[\t\n\r ]/g, "");
  requireVeo(!(/[+/]/.test(encoded) && /[-_]/.test(encoded)), "base64_alphabet");
  encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  requireVeo(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded), "base64");
  const data = encoded.replace(/=+$/, ""), remainder = data.length % 4;
  requireVeo(remainder !== 1 && (!encoded.includes("=") || encoded.length % 4 === 0), "base64");
  const decodedBytes = Math.floor(data.length * 6 / 8);
  requireVeo(decodedBytes > 0 && decodedBytes <= maxBytes, "byte_limit");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (remainder) requireVeo((alphabet.indexOf(data[data.length - 1]) & (remainder === 2 ? 15 : 3)) === 0, "base64_pad_bits");
  return { base64: data + "=".repeat((4 - remainder) % 4), decodedBytes };
}

function videoMime(value: unknown): string {
  if (value === undefined || value === "") return "video/mp4";
  requireVeo(typeof value === "string" && /^video\/[A-Za-z0-9.+-]{1,64}$/.test(value), "mime_type");
  return value;
}
function safeFileResource(value: unknown): string {
  requireVeo(typeof value === "string" && value.length <= 8192, "file_resource");
  if (/^files\/[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_google_veo_file_resource"); }
  requireVeo(url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port
    && !/[\\%\s]/.test(value) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
    && /\/files\/[A-Za-z0-9_-]{1,128}:download$/.test(url.pathname)
    && [...url.searchParams].every(([key, val]) => key === "alt" && val === "media") && url.searchParams.size <= 1, "file_resource");
  return url.toString();
}

/** SDK and native REST result envelopes from the frozen Google implementation. */
export function googleVeoAssets(body: Record<string, unknown>, maxBytes: number): GoogleVeoAsset[] {
  requireVeo(Number.isSafeInteger(maxBytes) && maxBytes > 0, "byte_limit");
  requireVeo(mediaObject(body.response), "missing_output");
  const sdk = body.response.generatedVideos;
  const rest = mediaObject(body.response.generateVideoResponse) ? body.response.generateVideoResponse.generatedSamples : undefined;
  const entries = Array.isArray(sdk) && sdk.length > 0 ? sdk : rest;
  // Frozen metadata requests one result; this local envelope bound tolerates
  // upstream partial/multiple results without inventing a larger model capability.
  requireVeo(Array.isArray(entries) && entries.length > 0 && entries.length <= 64, "missing_output");
  return entries.map(entry => {
    requireVeo(mediaObject(entry) && mediaObject(entry.video), "output");
    const video = entry.video;
    requireVeo(!(video.videoBytes !== undefined && video.encodedVideo !== undefined), "ambiguous_bytes");
    const mimeType = videoMime(video.mimeType ?? video.encoding);
    const bytes = video.videoBytes ?? video.encodedVideo;
    if (bytes !== undefined) return { kind: "inline", ...canonicalGoogleVeoBytes(bytes, maxBytes), mimeType };
    return { kind: "file", resource: safeFileResource(video.uri ?? video.name), mimeType };
  });
}

/** Trusted server configuration only, never a base supplied by a job response. */
export function googleVeoApiBase(value: string): string {
  requireVeo(typeof value === "string" && value.length <= 8192, "api_base");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_google_veo_api_base"); }
  requireVeo(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && !url.port
    && !/[\\%\s]/.test(value) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value), "api_base");
  let path = url.pathname.replace(/\/+$/, "");
  if (!/(?:^|\/)v\d+(?:alpha\d*|beta\d*)?(?:\/|$)/.test(path)) path += "/v1beta";
  requireVeo(path.startsWith("/") && path.slice(1).split("/").every(segment => /^[A-Za-z0-9_-]+$/.test(segment)), "api_base");
  return url.origin + path;
}

/** No secret input/output. Runtime must authorize the original M02 job first. */
export function prepareGoogleVeoFileDownload(asset: GoogleVeoAsset, trustedApiBase: string): {
  url: string; method: "GET"; redirect: "error"; credential: "original_job";
} {
  requireVeo(asset.kind === "file", "file_resource");
  const base = googleVeoApiBase(trustedApiBase), resource = safeFileResource(asset.resource);
  const url = new URL(resource.startsWith("files/") ? `${base}/${resource}:download` : resource);
  const root = new URL(base);
  // A proxy credential must not migrate to Google's origin (or the reverse).
  requireVeo(url.origin === root.origin && url.pathname.startsWith(`${root.pathname}/files/`), "file_origin");
  url.searchParams.set("alt", "media");
  return { url: url.toString(), method: "GET", redirect: "error", credential: "original_job" };
}

/** Byte reader shared only by this focused codec's JSON and file surfaces. */
export async function readGoogleVeoBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  requireVeo(Number.isSafeInteger(maxBytes) && maxBytes > 0, "byte_limit");
  const length = response.headers.get("content-length");
  if (response.redirected || !response.ok || !response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_google_veo_response");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      requireVeo(size <= maxBytes, "response_limit"); chunks.push(next.value);
    }
    requireVeo(size > 0 && (length === null || size === Number(length)), "response_length");
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new Error("invalid_google_veo_response");
  } finally { reader.releaseLock(); }
}

export async function readGoogleVeoFile(response: Response, maxBytes: number): Promise<Uint8Array> {
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (response.status !== 200 || (mime !== undefined && !/^video\/[a-z0-9.+-]+$/.test(mime) && mime !== "application/octet-stream" && mime !== "binary/octet-stream")) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_google_veo_file_content");
  }
  return readGoogleVeoBytes(response, maxBytes);
}
